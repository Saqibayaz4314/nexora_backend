'use strict';

// /v1 Socket.IO namespace — reliable messaging (Stage 3).
// Legacy default namespace untouched rehta hai (Mongo prototype).
// Rooms: user:<userId> (personal), conversation:<conversationId> (chat fan-out).
// Acks hamesha { data, error } envelope return karte hain.

const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../shared/logger');
const { AppError } = require('../shared/errors');
const schemas = require('../modules/messages/messages.schemas');
const conversationParamsSchema = schemas.sendMessageSchema.pick({ params: true });

function validateMessagePayload(schema, payload) {
  const parsed = schema.safeParse({
    params: { conversationId: payload.conversationId, messageId: payload.messageId },
    body: payload,
  });
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request');
  }
  return parsed.data;
}

function ackError(error) {
  const err = error || {};
  return {
    data: null,
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || 'Something went wrong',
    },
  };
}

function initV1Sockets(io, app) {
  const v1 = io.of('/v1');

  // Auth: v1 JWT (typ=access) + PG session/user check — Mongo involved nahi.
  v1.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) {
        return next(new Error('Authentication error: token required'));
      }
      let decoded;
      try {
        decoded = jwt.verify(token, config.jwtAccessSecret, { algorithms: ['HS256'] });
      } catch (err) {
        return next(new Error('Authentication error: invalid or expired token'));
      }
      if (decoded.typ !== 'access') {
        return next(new Error('Authentication error: invalid token type'));
      }

      const authRepo = app.locals.authRepo;
      const session = await authRepo.findSessionById(decoded.sid);
      if (!session || session.revoked_at) {
        return next(new Error('Authentication error: session revoked'));
      }
      const user = await authRepo.findUserById(decoded.sub);
      if (!user || user.deleted_at) {
        return next(new Error('Authentication error: account unavailable'));
      }

      socket.userId = user.id;
      socket.sessionDeviceId = session.device_id || null;
      next();
    } catch (err) {
      logger.warn({ err: { message: err.message } }, 'v1 socket auth failed');
      next(new Error('Authentication error: invalid token'));
    }
  });

  v1.on('connection', async (socket) => {
    const userId = socket.userId;
    socket.join(`user:${userId}`);

    // Apni saari conversations ke rooms auto-join karo (reconnect par state restore).
    try {
      const messagesRepo = app.locals.messagesRepo;
      const convRows = await messagesRepo.listUserConversations(userId);
      for (const row of convRows) {
        socket.join(`conversation:${row.conversation_id}`);
      }
    } catch (err) {
      logger.warn({ err: { message: err.message } }, 'v1 socket room restore failed');
    }

    logger.info({ userId }, 'v1 socket connected');

    const me = () => ({ id: socket.userId, sessionDeviceId: socket.sessionDeviceId });
    const service = app.locals.messagesService;

    function register(event, handler) {
      socket.on(event, async (payload, ack) => {
        try {
          const result = await handler(payload || {});
          if (typeof ack === 'function') ack({ data: result, error: null });
        } catch (err) {
          if (typeof ack === 'function') ack(ackError(err));
        }
      });
    }

    register('message:send', (p) => {
      const { params, body } = validateMessagePayload(schemas.sendMessageSchema, p);
      return service.sendMessage(me(), params.conversationId, body);
    });

    register('message:edit', (p) => {
      const { params, body } = validateMessagePayload(schemas.editMessageSchema, p);
      return service.editMessage(me(), params.messageId, body);
    });

    register('message:delete', (p) => {
      const { params } = validateMessagePayload(schemas.messageParamsSchema, p);
      return service.deleteMessage(me(), params.messageId);
    });

    register('message:react', (p) => {
      const { params, body } = validateMessagePayload(schemas.reactionSchema, p);
      return service.setReaction(me(), params.messageId, body.reactionCiphertext);
    });

    register('message:react:remove', (p) => {
      const { params } = validateMessagePayload(schemas.messageParamsSchema, p);
      return service.removeReaction(me(), params.messageId);
    });

    register('message:receipt', (p) => {
      const { params, body } = validateMessagePayload(schemas.receiptSchema, p);
      return service.updateReceipt(me(), params.messageId, body.status);
    });

    // ===== Calls (Stage 5) — signaling call IDs par; media peer-to-peer. =====
    const callsService = app.locals.callsService;

    register('call:answer', (p) => callsService.answerCall(me(), p.callId, p.answerSdp));

    register('call:reject', (p) => callsService.rejectCall(me(), p.callId));

    register('call:cancel', (p) => callsService.cancelCall(me(), p.callId));

    register('call:end', (p) => callsService.endCall(me(), p.callId));

    register('call:ice-candidate', (p) => callsService.relayIceCandidate(me(), p.callId, p.candidate));

    // Explicit room join (membership verify hoti hai server-side).
    register('conversation:join', async (p) => {
      const membership = await app.locals.messagesRepo.findMembership(p.conversationId, socket.userId);
      if (!membership || membership.left_at) {
        const err = new Error('Not a member of this conversation');
        err.code = 'NOT_CONVERSATION_MEMBER';
        throw err;
      }
      socket.join(`conversation:${p.conversationId}`);
      return { joined: true, conversationId: p.conversationId };
    });

    // Typing indicators — conversation room mein broadcast (sender ko exclude).
    async function broadcastTyping(p, event) {
      const { params: { conversationId } } = validateMessagePayload(conversationParamsSchema, p);
      const membership = await app.locals.messagesRepo.findMembership(conversationId, userId);
      if (!membership || membership.left_at) {
        throw new AppError(403, 'NOT_CONVERSATION_MEMBER', 'Not a member of this conversation');
      }
      socket.to(`conversation:${conversationId}`).emit(event, { conversationId, userId });
      return { conversationId };
    }

    register('typing:start', (p) => broadcastTyping(p, 'typing:started'));
    register('typing:stop', (p) => broadcastTyping(p, 'typing:stopped'));

    socket.on('disconnect', () => {
      logger.info({ userId }, 'v1 socket disconnected');
    });
  });
}

module.exports = { initV1Sockets };
