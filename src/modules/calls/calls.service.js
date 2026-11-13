'use strict';

const crypto = require('crypto');
const { AppError } = require('../../shared/errors');
const { claimOnce, incrWithExpiry } = require('../../shared/redis');

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
  const callRateLimitPerMinute = (config && config.callRateLimitPerMinute) || 5;
  // Mesh WebRTC limit — mobile CPU/bandwidth par 8 realistic max hai.
  const maxGroupParticipants = (config && config.maxGroupCallParticipants) || 8;

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

  // User fully offline ho gaya (disconnect grace khatam, koi socket nahi) —
  // uski ongoing calls end karo. App call ke dauraan kill ho jaye (bina
  // call:end socket event ke) to busy key/row agle 2h tak naye calls ko
  // 409 USER_IN_CALL se block karti hai; yeh usay turant heal karta hai.
  // Peer ko call:ended milta hai (WhatsApp style — network drop = call drop).
  async function autoEndOngoingCalls(userId) {
    ensureDb();
    let ended = 0;
    // Group calls: sirf is user ki participation hato (poori call nahi) —
    // baaki participants ko peer-left; aakhri nikla to call end.
    const groupCallIds = await repo.listActiveParticipationsForUser(userId);
    for (const callId of groupCallIds) {
      await repo.removeParticipant(callId, userId);
      await clearBusyKey(userId, callId);
      const remaining = await repo.listActiveParticipants(callId);
      for (const p of remaining) {
        emitToUser(p.user_id, 'call:group:peer-left', { callId, userId });
      }
      if (remaining.length === 0) {
        const row = await repo.transitionStatus(callId, ['ongoing'], 'ended', { endedAt: new Date() });
        if (row) ended++;
      }
    }
    // 1:1 calls: poori call end (existing behavior).
    for (;;) {
      const activeCallId = await findActiveCallForUser(userId);
      if (!activeCallId) break;
      const call = await repo.findCallById(activeCallId);
      // Fresh ringing ko yahan mat chhedo — ring timeout/cleanup sambhalta hai.
      if (!call || call.status !== 'ongoing') break;
      const row = await repo.transitionStatus(activeCallId, ['ongoing'], 'ended', { endedAt: new Date() });
      if (!row) break;
      ended++;
      const otherId = await repo.getOtherMemberId(call.conversation_id, userId);
      if (otherId) {
        await clearBusyKey(otherId, activeCallId);
        emitToUser(otherId, 'call:ended', { callId: activeCallId });
      }
      await clearBusyKey(userId, activeCallId);
    }
    return { ended };
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
    // Group calls: participation call_participants se (initiator bhi wahi hai).
    if (await repo.isParticipant(call.id, userId)) return true;
    if (call.initiator_user_id === userId) return true;
    // 1:1 legacy path: doosra conversation member.
    const other = await repo.getOtherMemberId(call.conversation_id, call.initiator_user_id);
    return other === userId;
  }

  // Active participants ka wire format (app grid render ke liye).
  async function activeParticipantList(callId) {
    const rows = await repo.listActiveParticipants(callId);
    return rows.map((r) => ({
      userId: r.user_id,
      displayName: r.display_name || r.username || 'User',
      username: r.username,
      joinedAt: r.joined_at,
    }));
  }

  // Group signaling relay: offer/answer/ICE — sender participant hona chahiye,
  // target bhi active participant hona chahiye, call active honi chahiye.
  async function relayGroupSignal(me, callId, targetUserId, event, payload) {
    ensureDb();
    const call = await requireCall(callId);
    if (call.status !== 'ongoing') {
      throw new AppError(409, 'GROUP_CALL_NOT_ACTIVE', 'Group call is not active');
    }
    if (!(await repo.isParticipant(callId, me.id))) {
      throw new AppError(403, 'NOT_CALL_PARTICIPANT', 'You are not a participant of this call');
    }
    if (!targetUserId || !(await repo.isParticipant(callId, targetUserId))) {
      throw new AppError(404, 'PARTICIPANT_NOT_FOUND', 'Target participant not in call');
    }
    emitToUser(targetUserId, event, { callId, fromUserId: me.id, ...payload });
    return { relayed: true };
  }

  async function requireParticipant(call, userId) {
    if (!(await isParticipant(call, userId))) {
      throw new AppError(403, 'NOT_CALL_PARTICIPANT', 'You are not a participant of this call');
    }
  }

  // REST/socket `me` mein sirf id hoti hai — push/peer-joined ke liye asli
  // naam DB se lo. Fail par original `me` (fallback 'Nexora'/'User' labels).
  async function withProfile(me) {
    if (!me || me.display_name || me.username) return me;
    if (typeof repo.findUserProfile !== 'function') return me;
    try {
      const profile = await repo.findUserProfile(me.id);
      return profile ? { ...me, display_name: profile.display_name, username: profile.username } : me;
    } catch (_) {
      return me;
    }
  }

  function emitToUser(userId, event, payload) {
    const io = getIo ? getIo() : null;
    if (io) {
      io.to(`user:${userId}`).emit(event, payload);
    }
  }

  async function pushToUser(userId, payload) {
    if (!pushDispatcher || !devicesRepo) return;
    // Push dedup: same event per user sirf ek baar (retry/race par duplicate
    // notification nahi). type+callId event identity hai — ring push aur
    // missed/rejected outcome push alag events hain, dono bhej sakte hain.
    // Redis fail-open: claim error par push phir bhi jata hai.
    const eventId = payload && payload.callId ? `${payload.type || 'call'}:${payload.callId}` : null;
    if (eventId && !(await claimOnce(redis, `push:sent:${userId}:${eventId}`, 60))) {
      return;
    }
    const tokens = await devicesRepo.findPushTokensByUserId(userId);
    if (tokens.length > 0) {
      // dataOnly: FCM ka generic notification block nahi — sirf app ki local
      // notification dikhti hai (caller ka naam + fullScreenIntent + ringtone
      // loop, WhatsApp style). Priority high data-only par khud lagti hai.
      await pushDispatcher.sendToUserDevices(tokens, {
        title: 'Nexora',
        body: 'Incoming call',
        data: payload,
        dataOnly: true,
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
      // Rate limit: max 5 outgoing calls/min — spam DB tak na pohanche.
      // Redis fail-open: error par allow hote hain, sirf limit exceed par 429.
      const callCount = await incrWithExpiry(redis, `rl:call:${me.id}`, 60);
      if (callCount !== null && callCount > callRateLimitPerMinute) {
        throw new AppError(429, 'CALL_RATE_LIMITED', 'Too many outgoing calls. Wait a minute and try again.');
      }
      const membership = await requireMembership(conversationId, me.id);
      me = await withProfile(me);

      // ===== Group call: mesh flow — status ongoing (caller andar), sab
      // members ko ring, per-peer signaling join ke baad relay hoti hai. =====
      if (membership.kind === 'group') {
        // WhatsApp style: group mein call pehle se chal rahi ho to nayi call
        // nahi banti — caller usi mein join hota hai (group do calls mein na bate).
        const ongoingId =
          typeof repo.findOngoingGroupCall === 'function'
            ? await repo.findOngoingGroupCall(conversationId)
            : null;
        if (ongoingId) {
          const joined = await this.joinGroupCall(me, ongoingId);
          return { ...joined, joined: true };
        }
        const memberIds = await repo.listOtherActiveMemberIds(conversationId, me.id);
        if (memberIds.length === 0) {
          throw new AppError(400, 'NO_OTHER_MEMBER', 'No other member in this conversation');
        }
        if (await isUserInCall(me.id)) {
          throw new AppError(409, 'USER_IN_CALL', 'User is already in a call');
        }
        const id = crypto.randomUUID();
        const row = await repo.insertCall({
          id,
          conversationId,
          initiatorUserId: me.id,
          callType,
          status: 'ongoing',
          startedAt: new Date(),
        });
        await repo.addParticipant(id, me.id);
        await redisCall((r) => r.set(`call:active:${me.id}`, id, 'EX', activeTtlSeconds));

        const call = repo.toCall(row);
        const groupName = membership.name || 'Group';
        const callerName = me.display_name || me.username || 'Nexora';
        for (const memberId of memberIds) {
          emitToUser(memberId, 'call:group:incoming', { call, groupName, callerName, callType });
          // Push HAR HAAL mein (background/killed app ring sirf push se).
          // pushToUser andar claimOnce dedup karta hai.
          Promise.resolve()
            .then(async () => {
              await pushToUser(memberId, {
                type: 'group-call',
                callId: id,
                conversationId,
                callType,
                initiatorUserId: me.id,
                callerName,
                groupName,
              });
            })
            .catch(() => {});
        }
        return { call, participants: await activeParticipantList(id) };
      }

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

      // Push HAR HAAL mein bhejo (online ho ya nahi): app background/killed
      // ho to sirf push se ring notification milti hai. Socket event sirf
      // foreground app ke liye live in-app screen kholta hai. App side inCall
      // guard hai — double UI nahi banta. Best-effort fire-and-forget.
      Promise.resolve()
        .then(async () => {
          await pushToUser(otherId, {
            type: 'call',
            callId: id,
            conversationId,
            callType,
            initiatorUserId: me.id,
            // Caller ka naam notification title mein (WhatsApp style).
            callerName: me.display_name || me.username || 'Nexora',
          });
        })
        .catch(() => {});

      return { call };
    },

    // GET /calls/:id — reconnect/rejoin ke liye current state.
    // Group calls mein participants list bhi (app grid restore).
    async getCall(me, callId) {
      ensureDb();
      const call = await requireCall(callId);
      const membership = await repo.findMembership(call.conversation_id, me.id);
      if (membership && !membership.left_at && membership.kind === 'group') {
        if (!(await repo.isParticipant(callId, me.id))) {
          throw new AppError(403, 'NOT_CALL_PARTICIPANT', 'You are not a participant of this call');
        }
        return { call: repo.toCall(call), participants: await activeParticipantList(callId) };
      }
      // 1:1 (ya non-member): requireParticipant — stranger ko bhi
      // NOT_CALL_PARTICIPANT milta hai (existing contract).
      await requireParticipant(call, me.id);
      return { call: repo.toCall(call) };
    },

    // ===== Group calls (mesh) — join/relay/leave =====

    // Socket call:group:join — member call mein aata hai. Idempotent rejoin.
    // Joiner ko existing participants milte hain (wo har peer ko offer bhejta
    // hai — glare-free deterministic rule), baakiyon ko peer-joined.
    async joinGroupCall(me, callId) {
      ensureDb();
      me = await withProfile(me);
      const call = await requireCall(callId);
      const membership = await requireMembership(call.conversation_id, me.id);
      if (membership.kind !== 'group') {
        throw new AppError(400, 'NOT_A_GROUP_CALL', 'This call is not a group call');
      }
      if (call.status !== 'ongoing') {
        throw new AppError(409, 'GROUP_CALL_NOT_ACTIVE', 'Group call is not active');
      }
      if (!(await repo.isParticipant(callId, me.id))) {
        const existing = await repo.listActiveParticipants(callId);
        if (existing.length >= maxGroupParticipants) {
          throw new AppError(409, 'GROUP_CALL_FULL', 'Group call is full');
        }
        const activeCallId = await findActiveCallForUser(me.id);
        if (activeCallId && activeCallId !== callId) {
          throw new AppError(409, 'USER_IN_CALL', 'You are already in another call');
        }
        await repo.addParticipant(callId, me.id);
        await redisCall((r) => r.set(`call:active:${me.id}`, callId, 'EX', activeTtlSeconds));
        for (const p of existing) {
          emitToUser(p.user_id, 'call:group:peer-joined', {
            callId,
            user: {
              userId: me.id,
              displayName: me.display_name || me.username || 'User',
              username: me.username,
            },
          });
        }
      }
      return { call: repo.toCall(call), participants: await activeParticipantList(callId) };
    },

    // Socket call:group:offer — joiner existing peer ko offer deta hai.
    async relayGroupOffer(me, callId, targetUserId, offerSdp) {
      return relayGroupSignal(me, callId, targetUserId, 'call:group:offer', { offerSdp });
    },

    // Socket call:group:answer — existing peer joiner ko answer deta hai.
    async relayGroupAnswer(me, callId, targetUserId, answerSdp) {
      return relayGroupSignal(me, callId, targetUserId, 'call:group:answer', { answerSdp });
    },

    // Socket call:group:ice-candidate — per-peer ICE relay.
    async relayGroupIce(me, callId, targetUserId, candidate) {
      return relayGroupSignal(me, callId, targetUserId, 'call:group:ice-candidate', { candidate });
    },

    // Socket call:group:leave — participant nikal jata hai; aakhri nikle to
    // call end. "End for all" nahi hai — har apna leave khud karta hai.
    async leaveGroupCall(me, callId) {
      ensureDb();
      const call = await requireCall(callId);
      if (!(await repo.isParticipant(callId, me.id))) {
        throw new AppError(403, 'NOT_CALL_PARTICIPANT', 'You are not a participant of this call');
      }
      await repo.removeParticipant(callId, me.id);
      await clearBusyKey(me.id, callId);
      const remaining = await repo.listActiveParticipants(callId);
      for (const p of remaining) {
        emitToUser(p.user_id, 'call:group:peer-left', { callId, userId: me.id });
      }
      let callEnded = false;
      if (remaining.length === 0 && call.status === 'ongoing') {
        const row = await repo.transitionStatus(callId, ['ongoing'], 'ended', { endedAt: new Date() });
        callEnded = Boolean(row);
      }
      return { left: true, callEnded };
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
      me = await withProfile(me);
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
      // Caller ko notification: callee ne decline kar diya (caller ka app
      // background/killed ho to bhi pata chale — error notification gap).
      Promise.resolve()
        .then(async () => {
          await pushToUser(call.initiator_user_id, {
            type: 'call-rejected',
            callId,
            callType: call.call_type,
            rejecterName: me.display_name || me.username || 'Nexora',
          });
        })
        .catch(() => {});
      return { call: repo.toCall(row) };
    },

    // Socket call:cancel — initiator answer se pehle chhor deta hai.
    async cancelCall(me, callId) {
      ensureDb();
      me = await withProfile(me);
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
        // Callee ko "Missed call" push — ring notification hat jati hai aur
        // missed call ka record milta hai (WhatsApp style).
        Promise.resolve()
          .then(async () => {
            await pushToUser(otherId, {
              type: 'call-missed',
              callId,
              callType: call.call_type,
              callerName: me.display_name || me.username || 'Nexora',
            });
          })
          .catch(() => {});
      }
      return { call: repo.toCall(row) };
    },

    // POST /calls/:id/end ya socket call:end — koi bhi participant.
    async endCall(me, callId) {
      ensureDb();
      me = await withProfile(me);
      const call = await requireCall(callId);
      await requireParticipant(call, me.id);

      let row = null;
      let toStatus = null;
      if (call.status === 'ringing') {
        // Initiator end → cancelled; callee end → rejected (decline).
        toStatus = call.initiator_user_id === me.id ? 'cancelled' : 'rejected';
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
        // Ringing end ke dono outcomes doosri side ko push hone chahiye:
        // initiator end → cancelled → callee missed; callee end → rejected →
        // caller declined. Socket event UI ke liye, push notification ke liye.
        const outcome =
          call.status === 'ringing' && toStatus === 'cancelled'
            ? {
                type: 'call-missed',
                callerName: me.display_name || me.username || 'Nexora',
              }
            : call.status === 'ringing' && toStatus === 'rejected'
              ? {
                  type: 'call-rejected',
                  rejecterName: me.display_name || me.username || 'Nexora',
                }
              : null;
        if (outcome) {
          Promise.resolve()
            .then(async () => {
              await pushToUser(otherId, {
                type: outcome.type,
                callId,
                callType: call.call_type,
                ...(outcome.callerName
                  ? { callerName: outcome.callerName }
                  : { rejecterName: outcome.rejecterName }),
              });
            })
            .catch(() => {});
        }
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

    // Offline (grace khatam) par ongoing calls auto-end — socket layer se.
    autoEndOngoingCalls,

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

    // Ring expire (koi answer nahi) — callee ko missed-call push ke saath.
    // Server in-process interval se chalta hai; scripts/cleanup-calls.js bhi
    // independent hai — dono idempotent hain (status guard atomic hai).
    async cleanupStaleRings() {
      if (!repo || !db) return { expired: 0 };
      try {
        const cutoff = new Date(Date.now() - ringTimeoutSeconds * 1000);
        const rows = await repo.listStaleRingingDetails(cutoff, 100);
        let expired = 0;
        for (const row of rows) {
          // Atomic ['ringing'] guard — race mein answer ho chuka ho to skip.
          // eslint-disable-next-line no-await-in-loop
          const updated = await repo.transitionStatus(
            row.id,
            ['ringing'],
            'missed',
            { endedAt: new Date() }
          );
          if (!updated) continue;
          expired++;
          await clearRingingState(updated);
          const otherId = await repo.getOtherMemberId(
            row.conversation_id,
            row.initiator_user_id
          );
          if (otherId) {
            // Callee ko "Missed call" — ring notification bhi isi se hat'ti hai.
            await pushToUser(otherId, {
              type: 'call-missed',
              callId: row.id,
              callType: row.call_type,
              callerName:
                row.initiator_display_name || row.initiator_username || 'Nexora',
            }).catch(() => {});
          }
        }
        return { expired };
      } catch {
        return { expired: 0 };
      }
    },
  };
}

module.exports = { createCallsService };
