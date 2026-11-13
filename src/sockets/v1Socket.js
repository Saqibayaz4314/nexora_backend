'use strict';

// /v1 Socket.IO namespace — reliable messaging (Stage 3).
// Legacy default namespace untouched rehta hai (Mongo prototype).
// Rooms: user:<userId> (personal), conversation:<conversationId> (chat fan-out).
// Acks hamesha { data, error } envelope return karte hain.

const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../shared/logger');
const { AppError } = require('../shared/errors');
const { getRedis } = require('../shared/redis');
const schemas = require('../modules/messages/messages.schemas');
const conversationParamsSchema = schemas.sendMessageSchema.pick({ params: true });
const { createPresenceTracker } = require('../modules/presence/presence.tracker');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const presence = createPresenceTracker();
  app.locals.presenceTracker = presence;

  // Redis (ephemeral socket/presence state) — tests fake inject kar sakte hain.
  const redisClient = app.locals.redis || getRedis();
  const sockTtlSeconds = 3600; // sock:<userId> set TTL (heartbeat refresh hota hai)
  const presenceGraceSeconds = config.presenceGraceSeconds > 0 ? config.presenceGraceSeconds : 0;

  // Best-effort Redis call — fail-open (null return, no crash).
  async function redisCall(fn) {
    if (!redisClient) return null;
    try {
      return await fn(redisClient);
    } catch (err) {
      logger.warn({ err: { message: err.message } }, 'redis call failed (fail-open)');
      return null;
    }
  }

  // Disconnect grace timers: userId -> Timeout. Grace khatam hone par hi
  // presence offline Postgres mein jata hai (false offline flash nahi).
  const graceTimers = new Map();

  // Grace khatam — Redis grace key ab bhi ho (ya Redis down ho) to offline
  // mark karo. Key 0 ho to kisi dyno par reconnect ho chuka hai — skip.
  function scheduleOfflineAfterGrace(userId) {
    if (graceTimers.has(userId)) return;
    const graceMs = presenceGraceSeconds * 1000;
    if (graceMs <= 0) {
      scheduleOfflineCleanup(userId);
      return;
    }
    const timer = setTimeout(() => {
      graceTimers.delete(userId);
      redisCall(async (r) => {
        const still = await r.exists(`grace:${userId}`);
        await r.del(`grace:${userId}`);
        return still;
      })
        .then((still) => {
          if (still === 0) return; // reconnect ho gaya — offline nahi
          scheduleOfflineCleanup(userId);
        })
        .catch(() => {});
    }, graceMs);
    timer.unref();
    graceTimers.set(userId, timer);
    // Grace key cross-dyno "cancel" signal hai — TTL grace se thora lamba
    // taake timer race mein key expire na ho jaye. Timing LOCAL timer se
    // hoti hai, key sirf reconnect detect karne ke liye hai.
    redisCall((r) => r.set(`grace:${userId}`, '1', 'EX', presenceGraceSeconds + 15)).catch(() => {});
  }

  // Per-user transitions serialize hoti hain, taake tez connect/disconnect par
  // "offline" event "online" se pehle na pohnche. Har job current state bhejta hai.
  const presenceChains = new Map();

  function schedulePresenceBroadcast(userId) {
    const previous = presenceChains.get(userId) || Promise.resolve();
    const job = previous
      .then(async () => {
        const repo = app.locals.messagesRepo;
        const online = presence.isOnline(userId);
        const lastSeenAt = await repo.touchLastSeen(userId);
        const peers = await repo.listPresencePeers(userId);
        if (peers.length === 0) return;
        v1.to(peers.map((p) => `user:${p.id}`)).emit('presence:update', {
          userId,
          online,
          lastSeenAt,
        });
      })
      .catch((err) => {
        logger.warn({ err: { message: err.message } }, 'presence broadcast failed');
      });
    presenceChains.set(userId, job);
    job.then(() => {
      if (presenceChains.get(userId) === job) presenceChains.delete(userId);
    });
  }

  function applyPresence(userId, change) {
    if (change.before !== change.after) schedulePresenceBroadcast(userId);
  }

  // Full offline confirmed (grace khatam / grace disabled) — presence
  // broadcast + ongoing calls auto-end. App call ke dauraan kill ho jaye to
  // 'ongoing' row/busy key agle 2h tak naye calls ko 409 se block karti thi;
  // auto-end isay turant heal karta hai (peer ko call:ended milta hai).
  function scheduleOfflineCleanup(userId) {
    schedulePresenceBroadcast(userId);
    const calls = app.locals.callsService;
    if (calls && typeof calls.autoEndOngoingCalls === 'function') {
      calls.autoEndOngoingCalls(userId).catch(() => {});
    }
  }

  function setupPresence(socket) {
    const userId = socket.userId;

    // Connect: active socket set mein add (EX 3600) + grace cancel/delete —
    // slow-network reconnect par false offline flash nahi hota.
    redisCall(async (r) => {
      await r.sadd(`sock:${userId}`, socket.id);
      await r.expire(`sock:${userId}`, sockTtlSeconds);
      await r.del(`grace:${userId}`);
    }).catch(() => {});
    const pendingGrace = graceTimers.get(userId);
    if (pendingGrace) {
      clearTimeout(pendingGrace);
      graceTimers.delete(userId);
    }

    // Heartbeat (engine.io ping/pong) par set TTL refresh — stale sockets
    // kabhi Redis mein leak na hon. Client disconnect ho jaye to set TTL se
    // khud expire ho jata hai.
    if (socket.conn && typeof socket.conn.on === 'function') {
      socket.conn.on('heartbeat', () => {
        redisCall((r) => r.expire(`sock:${userId}`, sockTtlSeconds)).catch(() => {});
      });
    }

    socket.on('disconnect', async () => {
      const change = presence.remove(userId, socket.id);
      // Redis set bookkeeping (fail-open) + cross-dyno socket count check.
      let otherDynoSockets = 0;
      let redisOk = true;
      try {
        if (redisClient) {
          await redisClient.srem(`sock:${userId}`, socket.id);
          otherDynoSockets = await redisClient.scard(`sock:${userId}`);
        }
      } catch (err) {
        redisOk = false;
        logger.warn({ err: { message: err.message } }, 'sock set cleanup failed (fail-open)');
      }
      // Sirf online→offline transition par grace (background hone par offline
      // pehle hi broadcast ho chuka hota hai — dobara nahi).
      if (change.before && !change.after) {
        if (redisOk && otherDynoSockets > 0) return; // doosre dyno par zinda hai
        scheduleOfflineAfterGrace(userId);
      }
    });

    applyPresence(userId, presence.set(userId, socket.id, true));

    // App background/foreground — socket connected rehta hai (calls ke liye)
    // lekin user "online" nahi dikhta.
    socket.on('presence:background', () => {
      applyPresence(userId, presence.set(userId, socket.id, false));
    });
    socket.on('presence:foreground', () => {
      applyPresence(userId, presence.set(userId, socket.id, true));
    });

    // Query: sirf direct-chat peers (block ke baghair) ki presence milti hai.
    socket.on('presence:query', async (payload, ack) => {
      if (typeof ack !== 'function') return;
      try {
        const requested = payload && payload.userIds;
        if (requested !== undefined && (!Array.isArray(requested) || requested.length > 500
          || !requested.every((id) => typeof id === 'string' && UUID_RE.test(id)))) {
          ack({ data: null, error: { code: 'VALIDATION_ERROR', message: 'Invalid request' } });
          return;
        }
        const wanted = requested ? new Set(requested) : null;
        const peers = await app.locals.messagesRepo.listPresencePeers(userId);
        const result = peers
          .filter((p) => !wanted || wanted.has(p.id))
          .map((p) => ({
            userId: p.id,
            online: presence.isOnline(p.id),
            lastSeenAt: p.last_seen_at,
          }));
        ack({ data: { presence: result }, error: null });
      } catch (err) {
        ack(ackError(err));
      }
    });
  }

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

    // Presence handlers synchronously register hote hain (room restore ke await se
    // pehle), taake disconnect ya early query miss na ho.
    setupPresence(socket);

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

    // ===== Group calls (mesh) — per-peer relay, joiner offerer rule =====

    register('call:group:join', (p) => {
      if (!UUID_RE.test(String(p.callId || ''))) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid callId');
      }
      return callsService.joinGroupCall(me(), p.callId);
    });

    register('call:group:offer', (p) => {
      if (!UUID_RE.test(String(p.callId || '')) || !UUID_RE.test(String(p.targetUserId || ''))) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid callId or targetUserId');
      }
      if (typeof p.offerSdp !== 'string' || p.offerSdp.length === 0 || p.offerSdp.length > 100000) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid offerSdp');
      }
      return callsService.relayGroupOffer(me(), p.callId, p.targetUserId, p.offerSdp);
    });

    register('call:group:answer', (p) => {
      if (!UUID_RE.test(String(p.callId || '')) || !UUID_RE.test(String(p.targetUserId || ''))) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid callId or targetUserId');
      }
      if (typeof p.answerSdp !== 'string' || p.answerSdp.length === 0 || p.answerSdp.length > 100000) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid answerSdp');
      }
      return callsService.relayGroupAnswer(me(), p.callId, p.targetUserId, p.answerSdp);
    });

    register('call:group:ice-candidate', (p) => {
      if (!UUID_RE.test(String(p.callId || '')) || !UUID_RE.test(String(p.targetUserId || ''))) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid callId or targetUserId');
      }
      if (!p.candidate || typeof p.candidate !== 'object') {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid candidate');
      }
      return callsService.relayGroupIce(me(), p.callId, p.targetUserId, p.candidate);
    });

    register('call:group:leave', (p) => {
      if (!UUID_RE.test(String(p.callId || ''))) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid callId');
      }
      return callsService.leaveGroupCall(me(), p.callId);
    });

    register('call:reject', (p) => callsService.rejectCall(me(), p.callId));

    register('call:cancel', (p) => callsService.cancelCall(me(), p.callId));

    register('call:end', (p) => callsService.endCall(me(), p.callId));

    register('call:ice-candidate', (p) => callsService.relayIceCandidate(me(), p.callId, p.candidate));

    // Explicit room join (membership verify hoti hai server-side). Join par
    // current typers bhi milte hain (Redis EX 5 state) — app late join par
    // "X is typing" dikha sakti hai. Redis fail-open: [] return hota hai.
    register('conversation:join', async (p) => {
      const membership = await app.locals.messagesRepo.findMembership(p.conversationId, socket.userId);
      if (!membership || membership.left_at) {
        const err = new Error('Not a member of this conversation');
        err.code = 'NOT_CONVERSATION_MEMBER';
        throw err;
      }
      socket.join(`conversation:${p.conversationId}`);
      let typingUserIds = [];
      const scanRes = await redisCall((r) =>
        r.scan('0', 'MATCH', `typing:${p.conversationId}:*`, 'COUNT', 50)
      );
      if (scanRes && Array.isArray(scanRes[1])) {
        typingUserIds = scanRes[1]
          .map((k) => k.slice(k.lastIndexOf(':') + 1))
          .filter((id) => id !== socket.userId && UUID_RE.test(id));
      }
      return { joined: true, conversationId: p.conversationId, typingUserIds };
    });

    // Typing indicators — conversation room mein broadcast (sender ko exclude).
    // Typing state Redis mein ephemeral rehta hai (EX 5) — DB mein kuch nahi
    // likha jata. Key TTL hi authoritative hai (sliding window).
    async function broadcastTyping(p, event) {
      const { params: { conversationId } } = validateMessagePayload(conversationParamsSchema, p);
      const membership = await app.locals.messagesRepo.findMembership(conversationId, userId);
      if (!membership || membership.left_at) {
        throw new AppError(403, 'NOT_CONVERSATION_MEMBER', 'Not a member of this conversation');
      }
      const key = `typing:${conversationId}:${userId}`;
      if (event === 'typing:started') {
        await redisCall((r) => r.set(key, '1', 'EX', 5));
      } else {
        await redisCall((r) => r.del(key));
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
