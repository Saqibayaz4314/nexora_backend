'use strict';

const crypto = require('crypto');
const { AppError } = require('../../shared/errors');

// Calls service — WebRTC call lifecycle (Stage 5).
// - Signaling call IDs par hoti hai; media peer-to-peer hai (server relay nahi karta).
// - Redis ephemeral state: ring TTL (answer window) + active-call busy keys.
//   Redis na ho to DB checks fallback hain (created_at cutoff se).
// - Events user rooms par emit hote hain (call:incoming/answered/rejected/cancelled/ended).

const STUN_DEFAULTS = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

function createCallsService({
  db,
  repo,
  contactsRepo,
  devicesRepo,
  pushDispatcher,
  getIo,
  redis,
  config,
}) {
  if (!repo) {
    throw new Error('calls service ko repo chahiye');
  }
  if (!contactsRepo) {
    throw new Error('calls service ko contactsRepo chahiye (block checks)');
  }

  const ringTimeoutSeconds = (config && config.callRingTimeoutSeconds) || 60;
  const activeTtlSeconds = (config && config.callActiveTtlSeconds) || 2 * 60 * 60;

  function ensureDb() {
    if (!db) {
      throw new AppError(503, 'DB_NOT_CONFIGURED', 'Service temporarily unavailable');
    }
  }

  // Redis best-effort wrapper — unavailable ho to silent null (DB fallback).
  async function redisCall(fn) {
    if (!redis) return null;
    try {
      return await fn(redis);
    } catch {
      return null;
    }
  }

  function activeWindowStart() {
    return new Date(Date.now() - activeTtlSeconds * 1000);
  }

  async function findActiveCallForUser(userId) {
    // DB is authoritative: Redis busy keys can outlive terminal calls or a ring.
    // Atomically expire stale rings before lookup, without a per-row retry loop.
    // Merely filtering by age could let an in-flight answer revive an old ring.
    await repo.expireRingingCallsForUser(
      userId,
      new Date(Date.now() - ringTimeoutSeconds * 1000)
    );
    return repo.findActiveCallForUser(userId, activeWindowStart());
  }

  async function isUserInCall(userId) {
    return Boolean(await findActiveCallForUser(userId));
  }

  async function clearBusyKey(userId, callId) {
    // Compare-and-delete atomically: a newer call may already own this key.
    await redisCall((r) => r.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
      1,
      `call:active:${userId}`,
      callId
    ));
  }

  async function clearRingingState(call) {
    await redisCall((r) => r.del(`call:ring:${call.id}`));
    await clearBusyKey(call.initiator_user_id, call.id);
  }

  async function requireMembership(conversationId, userId) {
    const membership = await repo.findMembership(conversationId, userId);
    if (!membership || membership.left_at) {
      throw new AppError(403, 'NOT_CONVERSATION_MEMBER', 'You are not a member of this conversation');
    }
    return membership;
  }

  async function requireCall(callId) {
    const call = await repo.findCallById(callId);
    if (!call) {
      throw new AppError(404, 'CALL_NOT_FOUND', 'Call not found');
    }
    return call;
  }

  async function isParticipant(call, userId) {
    if (call.initiator_user_id === userId) return true;
    const other = await repo.getOtherMemberId(call.conversation_id, call.initiator_user_id);
    return other === userId;
  }

  async function requireParticipant(call, userId) {
    if (!(await isParticipant(call, userId))) {
      throw new AppError(403, 'NOT_CALL_PARTICIPANT', 'You are not a participant of this call');
    }
  }

  function emitToUser(userId, event, payload) {
    const io = getIo ? getIo() : null;
    if (io) {
      io.to(`user:${userId}`).emit(event, payload);
    }
  }

  async function isUserOnline(userId) {
    const io = getIo ? getIo() : null;
    if (!io) return false;
    try {
      const sockets = await io.in(`user:${userId}`).fetchSockets();
      return sockets.length > 0;
    } catch {
      return false;
    }
  }

  async function pushToUser(userId, payload) {
    if (!pushDispatcher || !devicesRepo) return;
    const tokens = await devicesRepo.findPushTokensByUserId(userId);
    if (tokens.length > 0) {
      await pushDispatcher.sendToUserDevices(tokens, {
        title: 'Nexora',
        body: 'Incoming call',
        data: payload,
      });
    }
  }

  async function ringExpired(call) {
    // The DB deadline also bounds Redis state (which may be delayed or stale).
    const created = call.created_at instanceof Date ? call.created_at : new Date(call.created_at);
    if (Date.now() - created.getTime() >= ringTimeoutSeconds * 1000) return true;
    const alive = await redisCall((r) => r.exists(`call:ring:${call.id}`));
    return alive === 0;
  }

  return {
    // POST /conversations/:id/calls — initiate (ringing) + callee notify.
    async initiateCall(me, conversationId, { callType, offerSdp }) {
      ensureDb();
      const membership = await requireMembership(conversationId, me.id);
      if (membership.kind !== 'one_to_one') {
        throw new AppError(400, 'CALLS_ONLY_ONE_TO_ONE', 'Calls are only available in one-to-one conversations');
      }
      const otherId = await repo.getOtherMemberId(conversationId, me.id);
      if (!otherId) {
        throw new AppError(400, 'NO_OTHER_MEMBER', 'No other member in this conversation');
      }

      const [iBlockedThem, theyBlockedMe, iBusy, theyBusy] = await Promise.all([
        contactsRepo.isBlocked(me.id, otherId),
        contactsRepo.isBlocked(otherId, me.id),
        isUserInCall(me.id),
        isUserInCall(otherId),
      ]);
      if (iBlockedThem || theyBlockedMe) {
        throw new AppError(403, 'CANNOT_CALL_USER', 'You cannot call this user');
      }
      if (iBusy || theyBusy) {
        throw new AppError(409, 'USER_IN_CALL', 'User is already in a call');
      }

      const id = crypto.randomUUID();
      const row = await repo.insertCall({
        id,
        conversationId,
        initiatorUserId: me.id,
        callType,
        status: 'ringing',
        offerSdp,
      });

      // Ephemeral state: ring window + initiator busy key.
      await redisCall((r) => r.set(`call:ring:${id}`, '1', 'EX', ringTimeoutSeconds));
      await redisCall((r) => r.set(`call:active:${me.id}`, id, 'EX', activeTtlSeconds));

      const call = repo.toCall(row);
      emitToUser(otherId, 'call:incoming', { call });

      // Offline callee ko push (best-effort).
      Promise.resolve()
        .then(async () => {
          if (!(await isUserOnline(otherId))) {
            await pushToUser(otherId, {
              type: 'call',
              callId: id,
              conversationId,
              callType,
              initiatorUserId: me.id,
              // Caller ka naam notification title mein (WhatsApp style).
              callerName: me.display_name || me.username || 'Nexora',
            });
          }
        })
        .catch(() => {});

      return { call };
    },

    // GET /calls/:id — reconnect/rejoin ke liye current state.
    async getCall(me, callId) {
      ensureDb();
      const call = await requireCall(callId);
      await requireParticipant(call, me.id);
      return { call: repo.toCall(call) };
    },

    // Socket call:answer — callee accept karta hai.
    async answerCall(me, callId, answerSdp) {
      ensureDb();
      const call = await requireCall(callId);
      await requireParticipant(call, me.id);
      if (call.initiator_user_id === me.id) {
        throw new AppError(400, 'CANNOT_ANSWER_OWN_CALL', 'You cannot answer your own call');
      }
      if (call.status !== 'ringing') {
        throw new AppError(409, 'CALL_NOT_RINGING', 'Call is not ringing');
      }
      if (await ringExpired(call)) {
        const row = await repo.transitionStatus(callId, ['ringing'], 'missed', { endedAt: new Date() });
        if (row) await clearRingingState(call);
        throw new AppError(410, 'CALL_EXPIRED', 'Call has expired');
      }
      // Busy check: koi AUR active call ho to block — yeh call khud allowed hai.
      const activeCallId = await findActiveCallForUser(me.id);
      if (activeCallId && activeCallId !== callId) {
        throw new AppError(409, 'USER_IN_CALL', 'You are already in another call');
      }

      const startedAt = new Date();
      const row = await repo.transitionStatus(callId, ['ringing'], 'ongoing', {
        answerSdp,
        startedAt,
      });
      if (!row) {
        throw new AppError(409, 'CALL_NOT_RINGING', 'Call is not ringing anymore');
      }

      await redisCall((r) => r.del(`call:ring:${callId}`));
      await redisCall((r) => r.set(`call:active:${me.id}`, callId, 'EX', activeTtlSeconds));

      const callOut = repo.toCall(row);
      emitToUser(call.initiator_user_id, 'call:answered', { callId, answerSdp, call: callOut });
      return { call: callOut };
    },

    // Socket call:reject — callee decline karta hai.
    async rejectCall(me, callId) {
      ensureDb();
      const call = await requireCall(callId);
      await requireParticipant(call, me.id);
      if (call.initiator_user_id === me.id) {
        throw new AppError(400, 'CANNOT_REJECT_OWN_CALL', 'You cannot reject your own call');
      }
      if (call.status !== 'ringing') {
        throw new AppError(409, 'CALL_NOT_RINGING', 'Call is not ringing');
      }
      const row = await repo.transitionStatus(callId, ['ringing'], 'rejected', { endedAt: new Date() });
      if (!row) {
        throw new AppError(409, 'CALL_NOT_RINGING', 'Call is not ringing anymore');
      }
      await clearRingingState(call);
      emitToUser(call.initiator_user_id, 'call:rejected', { callId });
      return { call: repo.toCall(row) };
    },

    // Socket call:cancel — initiator answer se pehle chhor deta hai.
    async cancelCall(me, callId) {
      ensureDb();
      const call = await requireCall(callId);
      await requireParticipant(call, me.id);
      if (call.initiator_user_id !== me.id) {
        throw new AppError(400, 'ONLY_INITIATOR_CAN_CANCEL', 'Only the initiator can cancel a ringing call');
      }
      if (call.status !== 'ringing') {
        throw new AppError(409, 'CALL_NOT_RINGING', 'Call is not ringing');
      }
      const row = await repo.transitionStatus(callId, ['ringing'], 'cancelled', { endedAt: new Date() });
      if (!row) {
        throw new AppError(409, 'CALL_NOT_RINGING', 'Call is not ringing anymore');
      }
      await clearRingingState(call);
      const otherId = await repo.getOtherMemberId(call.conversation_id, me.id);
      if (otherId) {
        emitToUser(otherId, 'call:cancelled', { callId });
      }
      return { call: repo.toCall(row) };
    },

    // POST /calls/:id/end ya socket call:end — koi bhi participant.
    async endCall(me, callId) {
      ensureDb();
      const call = await requireCall(callId);
      await requireParticipant(call, me.id);

      let row = null;
      if (call.status === 'ringing') {
        // Initiator end → cancelled; callee end → rejected (decline).
        const toStatus = call.initiator_user_id === me.id ? 'cancelled' : 'rejected';
        row = await repo.transitionStatus(callId, ['ringing'], toStatus, { endedAt: new Date() });
      } else if (call.status === 'ongoing') {
        row = await repo.transitionStatus(callId, ['ongoing'], 'ended', { endedAt: new Date() });
      }
      if (!row) {
        throw new AppError(409, 'CALL_NOT_ACTIVE', 'Call is not active');
      }

      await redisCall((r) => r.del(`call:ring:${callId}`));
      const otherId = await repo.getOtherMemberId(call.conversation_id, me.id);
      if (otherId) {
        await clearBusyKey(otherId, callId);
        emitToUser(otherId, 'call:ended', { callId });
      }
      await clearBusyKey(me.id, callId);

      return { call: repo.toCall(row) };
    },

    // Socket call:ice-candidate — doosre participant ko relay.
    async relayIceCandidate(me, callId, candidate) {
      ensureDb();
      const call = await requireCall(callId);
      await requireParticipant(call, me.id);
      if (call.status !== 'ringing' && call.status !== 'ongoing') {
        throw new AppError(409, 'CALL_NOT_ACTIVE', 'Call is not active');
      }
      const otherId = await repo.getOtherMemberId(call.conversation_id, me.id);
      if (otherId) {
        emitToUser(otherId, 'call:ice-candidate', { callId, candidate, fromUserId: me.id });
      }
      return { relayed: Boolean(otherId) };
    },

    // GET /conversations/:id/calls — call history (newest first).
    async listCalls(me, conversationId, cursor, limit) {
      ensureDb();
      await requireMembership(conversationId, me.id);

      let decodedCursor = null;
      if (cursor) {
        decodedCursor = repo.decodeCursor(cursor);
        if (!decodedCursor) {
          throw new AppError(400, 'INVALID_CURSOR', 'Invalid pagination cursor');
        }
      }

      const rows = await repo.listCalls(conversationId, decodedCursor, limit);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      let nextCursor = null;
      if (hasMore && page.length > 0) {
        const last = page[page.length - 1];
        nextCursor = repo.encodeCursor(last.created_at, last.id);
      }

      return { calls: page.map((r) => repo.toCall(r)), nextCursor };
    },

    // GET /calls/turn — env se configured TURN (koi hardcoded credential nahi).
    getTurnConfig() {
      const turn = (config && config.turn) || {};
      const iceServers = [
        { urls: STUN_DEFAULTS },
        ...(turn.urls && turn.urls.length > 0 && turn.username && turn.credential
          ? [{ urls: turn.urls, username: turn.username, credential: turn.credential }]
          : []),
      ];
      return {
        iceServers,
        turnConfigured: Boolean(turn.urls && turn.urls.length > 0 && turn.username && turn.credential),
      };
    },
  };
}

module.exports = { createCallsService };
