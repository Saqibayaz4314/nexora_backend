'use strict';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789-abcdefghijkl';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789-abcdefghijkl';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { createCallsRepo } = require('../src/modules/calls/calls.repo');
const { createCallsService } = require('../src/modules/calls/calls.service');
const { createTestPool } = require('./helpers/test-db');

// Only models the Redis commands used by calls, including TTL and atomic ownership checks.
function fakeCallRedis() {
  const entries = new Map();
  let now = Date.now();
  return {
    unavailable: false,
    beforeCompare: null,
    advance(seconds) { now += seconds * 1000; },
    async get(key) {
      if (this.unavailable) throw new Error('Redis unavailable');
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= now) return null;
      return entry.value;
    },
    async exists(key) { return (await this.get(key)) === null ? 0 : 1; },
    async set(key, value, mode, seconds) {
      if (this.unavailable) throw new Error('Redis unavailable');
      assert.equal(mode, 'EX');
      entries.set(key, { value, expiresAt: now + seconds * 1000 });
      return 'OK';
    },
    async del(...keys) {
      if (this.unavailable) throw new Error('Redis unavailable');
      return keys.reduce((count, key) => count + Number(entries.delete(key)), 0);
    },
    async eval(script, numberOfKeys, key, callId) {
      if (this.unavailable) throw new Error('Redis unavailable');
      assert.equal(numberOfKeys, 1);
      assert.equal(script,
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0");
      if (this.beforeCompare) await this.beforeCompare(key);
      const entry = entries.get(key);
      // No await between comparison and deletion: model one atomic Redis operation.
      return entry && entry.expiresAt > now && entry.value === callId
        ? Number(entries.delete(key)) : 0;
    },
  };
}

// Group-call fixture: ek 'group' conversation, N users, emitted-event capture.
async function groupCallFixture(t, { memberCount = 4, maxGroupCallParticipants = 8 } = {}) {
  const pool = await createTestPool();
  t.after(async () => { if (pool.end) await pool.end(); });
  const users = [];
  for (let i = 0; i < memberCount; i += 1) {
    const id = crypto.randomUUID();
    const name = `member${i}`;
    await pool.query(
      `INSERT INTO users (id, username, username_norm, email, email_norm, password_hash, display_name)
       VALUES ($1, $2, $2, $3, $3, 'x', $4)`, [id, name, `${name}@example.com`, `Member ${i}`]
    );
    users.push({ id, username: name, displayName: `Member ${i}`, display_name: `Member ${i}` });
  }
  const conversationId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO conversations (id, kind, name) VALUES ($1, 'group', 'Test Group')`,
    [conversationId]
  );
  for (const user of users) {
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member')`,
      [conversationId, user.id]
    );
  }
  const emitted = [];
  const getIo = () => ({
    to(room) {
      return { emit(event, payload) { emitted.push({ room, event, payload }); } };
    },
  });
  const repo = createCallsRepo({ db: pool });
  const redis = fakeCallRedis();
  const service = createCallsService({
    db: pool,
    repo,
    contactsRepo: { async isBlocked() { return false; } },
    redis,
    getIo,
    config: {
      callRingTimeoutSeconds: 60,
      callActiveTtlSeconds: 7200,
      callRateLimitPerMinute: 100,
      maxGroupCallParticipants,
    },
  });
  const roomOf = (user) => `user:${user.id}`;
  const eventsFor = (event, room = null) =>
    emitted.filter((e) => e.event === event && (room === null || e.room === room));
  return {
    pool, repo, redis, service, users, conversationId, emitted, roomOf, eventsFor,
  };
}

test('group calls: initiate ring-all + ongoing + participation', async (t) => {
  await t.test('group initiate sab members ko ring karta hai, call turant ongoing', async (t) => {
    const { redis, service, users, conversationId, eventsFor } = await groupCallFixture(t);
    const [initiator, ...others] = users;
    const { call, participants } = await service.initiateCall(
      initiator, conversationId, { callType: 'voice' }
    );
    assert.equal(call.status, 'ongoing');
    assert.ok(call.startedAt);
    assert.equal(call.callType, 'voice');
    assert.equal(call.initiatorUserId, initiator.id);
    assert.equal(participants.length, 1);
    assert.equal(participants[0].userId, initiator.id);
    assert.equal(participants[0].displayName, initiator.displayName);
    for (const other of others) {
      const rings = eventsFor('call:group:incoming', `user:${other.id}`);
      assert.equal(rings.length, 1);
      assert.equal(rings[0].payload.call.id, call.id);
      assert.equal(rings[0].payload.groupName, 'Test Group');
      assert.equal(rings[0].payload.callerName, initiator.displayName);
      assert.equal(rings[0].payload.callType, 'voice');
    }
    assert.equal(eventsFor('call:group:incoming', `user:${initiator.id}`).length, 0);
    assert.equal(await redis.get(`call:active:${initiator.id}`), call.id);
  });

  await t.test('akela member group mein call nahi kar sakta (NO_OTHER_MEMBER)', async (t) => {
    const { service, users, conversationId } = await groupCallFixture(t, { memberCount: 1 });
    await assert.rejects(
      service.initiateCall(users[0], conversationId, { callType: 'voice' }),
      { code: 'NO_OTHER_MEMBER' }
    );
  });

  await t.test('initiator dobara call dabaye to wahi call (idempotent, nayi nahi)', async (t) => {
    const { service, users, conversationId, pool } = await groupCallFixture(t, { memberCount: 3 });
    const [initiator] = users;
    const first = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    const again = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    assert.equal(again.joined, true);
    assert.equal(again.call.id, first.call.id);
    assert.equal(again.participants.length, 1);
    const { rows } = await pool.query(
      `SELECT id FROM call_sessions WHERE conversation_id = $1`, [conversationId]
    );
    assert.equal(rows.length, 1);
  });

  await t.test('call chal rahi ho to doosra member call dabaye → usi mein join (group nahi bat-ta)', async (t) => {
    const { service, users, conversationId, pool, eventsFor } = await groupCallFixture(t);
    const [initiator, b, c] = users;
    const first = await service.initiateCall(initiator, conversationId, { callType: 'video' });
    const ringsBefore = eventsFor('call:group:incoming').length;
    const second = await service.initiateCall(b, conversationId, { callType: 'voice' });
    assert.equal(second.joined, true);
    assert.equal(second.call.id, first.call.id);
    assert.equal(second.call.callType, 'video'); // chalti call ka type
    assert.deepEqual(
      second.participants.map((p) => p.userId).sort(),
      [initiator.id, b.id].sort()
    );
    // Join par dobara ring-all nahi hota; existing participant ko peer-joined.
    assert.equal(eventsFor('call:group:incoming').length, ringsBefore);
    const joinedEvents = eventsFor('call:group:peer-joined', `user:${initiator.id}`);
    assert.equal(joinedEvents.length, 1);
    assert.equal(joinedEvents[0].payload.user.userId, b.id);
    const { rows } = await pool.query(
      `SELECT id FROM call_sessions WHERE conversation_id = $1`, [conversationId]
    );
    assert.equal(rows.length, 1);
    // Teesra bhi usi mein.
    const third = await service.initiateCall(c, conversationId, { callType: 'voice' });
    assert.equal(third.call.id, first.call.id);
    assert.equal(third.participants.length, 3);
  });

  await t.test('ended call ke baad naya initiate nayi call banata hai', async (t) => {
    const { service, users, conversationId } = await groupCallFixture(t);
    const [initiator, b] = users;
    const first = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    await service.leaveGroupCall(initiator, first.call.id);
    const next = await service.initiateCall(b, conversationId, { callType: 'voice' });
    assert.notEqual(next.call.id, first.call.id);
    assert.equal(next.joined, undefined);
  });

  await t.test('REST/socket shape `me` (sirf id) par bhi asli naam jata hai', async (t) => {
    const { service, users, conversationId, eventsFor } = await groupCallFixture(t);
    const [initiator, b] = users;
    const call = await service.initiateCall({ id: initiator.id }, conversationId, { callType: 'voice' });
    const ring = eventsFor('call:group:incoming', `user:${b.id}`)[0];
    assert.equal(ring.payload.callerName, 'Member 0');
    await service.joinGroupCall({ id: b.id }, call.call.id);
    const joined = eventsFor('call:group:peer-joined', `user:${initiator.id}`)[0];
    assert.equal(joined.payload.user.displayName, 'Member 1');
    assert.equal(joined.payload.user.username, 'member1');
  });
});

test('group calls: join idempotency + peer-joined', async (t) => {
  await t.test('join participant add karta hai, existing ko peer-joined milta hai', async (t) => {
    const { service, users, conversationId, eventsFor, repo } = await groupCallFixture(t);
    const [initiator, joiner] = users;
    const { call } = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    const { participants } = await service.joinGroupCall(joiner, call.id);
    assert.equal(participants.length, 2);
    assert.ok(participants.some((p) => p.userId === joiner.id));
    const joined = eventsFor('call:group:peer-joined', `user:${initiator.id}`);
    assert.equal(joined.length, 1);
    assert.equal(joined[0].payload.callId, call.id);
    assert.equal(joined[0].payload.user.userId, joiner.id);
    assert.equal(joined[0].payload.user.displayName, joiner.displayName);
    assert.equal(await repo.isParticipant(call.id, joiner.id), true);
  });

  await t.test('dobara join idempotent hai — koi naya peer-joined emit nahi', async (t) => {
    const { service, users, conversationId, eventsFor } = await groupCallFixture(t);
    const [initiator, joiner] = users;
    const { call } = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    await service.joinGroupCall(joiner, call.id);
    const before = eventsFor('call:group:peer-joined').length;
    const again = await service.joinGroupCall(joiner, call.id);
    assert.equal(again.participants.length, 2);
    assert.equal(eventsFor('call:group:peer-joined').length, before);
  });

  await t.test('non-member join nahi kar sakta (NOT_CONVERSATION_MEMBER)', async (t) => {
    const { pool, service, users, conversationId } = await groupCallFixture(t);
    const [initiator] = users;
    const { call } = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    const strangerId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, username, username_norm, email, email_norm, password_hash)
       VALUES ($1, 'stranger', 'stranger', 'stranger@example.com', 'stranger@example.com', 'x')`,
      [strangerId]
    );
    await assert.rejects(
      service.joinGroupCall({ id: strangerId }, call.id),
      { code: 'NOT_CONVERSATION_MEMBER' }
    );
  });

  await t.test('ended call join nahi hoti (GROUP_CALL_NOT_ACTIVE)', async (t) => {
    const { service, users, conversationId } = await groupCallFixture(t);
    const [initiator, joiner] = users;
    const { call } = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    await service.leaveGroupCall(initiator, call.id);
    await assert.rejects(
      service.joinGroupCall(joiner, call.id),
      { code: 'GROUP_CALL_NOT_ACTIVE' }
    );
  });
});

test('group calls: signaling relay authz + delivery', async (t) => {
  await t.test('offer/answer/ice sirf active participants relay karte hain', async (t) => {
    const { service, users, conversationId, eventsFor } = await groupCallFixture(t);
    const [initiator, joiner, bystander] = users;
    const { call } = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    await service.joinGroupCall(joiner, call.id);

    const offer = await service.relayGroupOffer(joiner, call.id, initiator.id, 'offer-sdp');
    assert.deepEqual(offer, { relayed: true });
    const offers = eventsFor('call:group:offer', `user:${initiator.id}`);
    assert.equal(offers.length, 1);
    assert.equal(offers[0].payload.callId, call.id);
    assert.equal(offers[0].payload.fromUserId, joiner.id);
    assert.equal(offers[0].payload.offerSdp, 'offer-sdp');

    const answer = await service.relayGroupAnswer(initiator, call.id, joiner.id, 'answer-sdp');
    assert.equal(answer.relayed, true);
    const answers = eventsFor('call:group:answer', `user:${joiner.id}`);
    assert.equal(answers.length, 1);
    assert.equal(answers[0].payload.answerSdp, 'answer-sdp');

    const candidate = { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 };
    await service.relayGroupIce(initiator, call.id, joiner.id, candidate);
    const ice = eventsFor('call:group:ice-candidate', `user:${joiner.id}`);
    assert.equal(ice.length, 1);
    assert.deepEqual(ice[0].payload.candidate, candidate);
  });

  await t.test('non-participant relay → 403, non-target → 404', async (t) => {
    const { service, users, conversationId } = await groupCallFixture(t);
    const [initiator, joiner, bystander] = users;
    const { call } = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    await service.joinGroupCall(joiner, call.id);
    // Bystander member hai lekin call mein nahi.
    await assert.rejects(
      service.relayGroupOffer(bystander, call.id, initiator.id, 'sdp'),
      { code: 'NOT_CALL_PARTICIPANT' }
    );
    // Target jo call mein hai hi nahi.
    await assert.rejects(
      service.relayGroupOffer(joiner, call.id, bystander.id, 'sdp'),
      { code: 'PARTICIPANT_NOT_FOUND' }
    );
  });

  await t.test('ended call par relay nahi (GROUP_CALL_NOT_ACTIVE)', async (t) => {
    const { service, users, conversationId } = await groupCallFixture(t);
    const [initiator, joiner] = users;
    const { call } = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    await service.joinGroupCall(joiner, call.id);
    await service.leaveGroupCall(initiator, call.id);
    await service.leaveGroupCall(joiner, call.id);
    await assert.rejects(
      service.relayGroupOffer(joiner, call.id, initiator.id, 'sdp'),
      { code: 'GROUP_CALL_NOT_ACTIVE' }
    );
  });
});

test('group calls: leave — peer-left + last-leaver call end', async (t) => {
  await t.test('beech ka leaver peer-left deta hai, call chalti rehti hai', async (t) => {
    const { service, users, conversationId, eventsFor, repo } = await groupCallFixture(t);
    const [initiator, a, b] = users;
    const { call } = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    await service.joinGroupCall(a, call.id);
    await service.joinGroupCall(b, call.id);

    const res = await service.leaveGroupCall(a, call.id);
    assert.deepEqual(res, { left: true, callEnded: false });
    const left = eventsFor('call:group:peer-left');
    assert.equal(left.length, 2); // initiator + b
    assert.ok(left.every((e) => e.payload.callId === call.id && e.payload.userId === a.id));
    assert.equal(await repo.isParticipant(call.id, a.id), false);
    assert.equal((await repo.findCallById(call.id)).status, 'ongoing');
    assert.equal((await repo.listActiveParticipants(call.id)).length, 2);
  });

  await t.test('aakhri leaver par call end hoti hai', async (t) => {
    const { service, users, conversationId, repo, redis } = await groupCallFixture(t);
    const [initiator, a] = users;
    const { call } = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    await service.joinGroupCall(a, call.id);
    const first = await service.leaveGroupCall(initiator, call.id);
    assert.equal(first.callEnded, false);
    const last = await service.leaveGroupCall(a, call.id);
    assert.equal(last.callEnded, true);
    const row = await repo.findCallById(call.id);
    assert.equal(row.status, 'ended');
    assert.ok(row.ended_at);
    assert.equal(await redis.exists(`call:active:${a.id}`), 0);
  });

  await t.test('non-participant leave nahi kar sakta', async (t) => {
    const { service, users, conversationId } = await groupCallFixture(t);
    const [initiator, bystander] = users;
    const { call } = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    await assert.rejects(
      service.leaveGroupCall(bystander, call.id),
      { code: 'NOT_CALL_PARTICIPANT' }
    );
  });
});

test('group calls: busy across calls + MAX 8 + getCall', async (t) => {
  await t.test('group participant 1:1 call initiate nahi kar sakta (USER_IN_CALL)', async (t) => {
    const { pool, service, users, conversationId } = await groupCallFixture(t);
    const [initiator, joiner, bystander] = users;
    const { call } = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    await service.joinGroupCall(joiner, call.id);
    // Bystander ke saath 1:1 conversation.
    const dmId = crypto.randomUUID();
    await pool.query(`INSERT INTO conversations (id, kind) VALUES ($1, 'one_to_one')`, [dmId]);
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
      [dmId, joiner.id, bystander.id]
    );
    await assert.rejects(
      service.initiateCall(joiner, dmId, { callType: 'voice', offerSdp: 'sdp' }),
      { code: 'USER_IN_CALL' }
    );
  });

  await t.test('group participant doosri group call join nahi kar sakta (USER_IN_CALL)', async (t) => {
    const { pool, service, users, conversationId } = await groupCallFixture(t, { memberCount: 6 });
    const [initiator, joiner, a, b, c, d] = users;
    const { call } = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    await service.joinGroupCall(joiner, call.id);
    // Doosra group conversation jisme joiner member hai.
    const otherConv = crypto.randomUUID();
    await pool.query(
      `INSERT INTO conversations (id, kind, name) VALUES ($1, 'group', 'Other Group')`,
      [otherConv]
    );
    for (const u of [joiner, a, b, c, d]) {
      await pool.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member')`,
        [otherConv, u.id]
      );
    }
    const { call: otherCall } = await service.initiateCall(a, otherConv, { callType: 'voice' });
    await assert.rejects(
      service.joinGroupCall(joiner, otherCall.id),
      { code: 'USER_IN_CALL' }
    );
  });

  await t.test('MAX 8: 9wa participant GROUP_CALL_FULL', async (t) => {
    const { service, repo, users, conversationId } = await groupCallFixture(t, {
      memberCount: 10,
      maxGroupCallParticipants: 8,
    });
    const [initiator, ...others] = users;
    const { call } = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    // 1 initiator + 7 joiners = 8 (full).
    for (const user of others.slice(0, 7)) {
      // eslint-disable-next-line no-await-in-loop
      await service.joinGroupCall(user, call.id);
    }
    assert.equal((await repo.listActiveParticipants(call.id)).length, 8);
    // 8wa joiner = 9wa participant — ab full hai.
    await assert.rejects(
      service.joinGroupCall(others[7], call.id),
      { code: 'GROUP_CALL_FULL' }
    );
  });

  await t.test('getCall group member ko participants ke saath state deta hai', async (t) => {
    const { service, users, conversationId } = await groupCallFixture(t);
    const [initiator, joiner] = users;
    const { call } = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    await service.joinGroupCall(joiner, call.id);
    const view = await service.getCall(joiner, call.id);
    assert.equal(view.call.id, call.id);
    assert.equal(view.participants.length, 2);
  });

  await t.test('getCall non-participant member → NOT_CALL_PARTICIPANT', async (t) => {
    const { service, users, conversationId } = await groupCallFixture(t);
    const [initiator, bystander] = users;
    const { call } = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    await assert.rejects(service.getCall(bystander, call.id), { code: 'NOT_CALL_PARTICIPANT' });
  });

  await t.test('getCall stranger (non-member) → NOT_CALL_PARTICIPANT', async (t) => {
    const { pool, service, users, conversationId } = await groupCallFixture(t);
    const [initiator] = users;
    const { call } = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    const strangerId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, username, username_norm, email, email_norm, password_hash)
       VALUES ($1, 'stranger2', 'stranger2', 'stranger2@example.com', 'stranger2@example.com', 'x')`,
      [strangerId]
    );
    await assert.rejects(
      service.getCall({ id: strangerId }, call.id),
      { code: 'NOT_CALL_PARTICIPANT' }
    );
  });
});

test('group calls: autoEndOngoingCalls group cleanup', async (t) => {
  await t.test('offline user ki participation hat ti hai, peers ko peer-left', async (t) => {
    const { service, users, conversationId, eventsFor, repo } = await groupCallFixture(t);
    const [initiator, a, b] = users;
    const { call } = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    await service.joinGroupCall(a, call.id);
    await service.joinGroupCall(b, call.id);
    const res = await service.autoEndOngoingCalls(a.id);
    assert.equal(res.ended, 0); // call abhi bhi chalti hai
    assert.equal(await repo.isParticipant(call.id, a.id), false);
    const left = eventsFor('call:group:peer-left');
    assert.equal(left.length, 2);
    assert.ok(left.every((e) => e.payload.userId === a.id));
    assert.equal((await repo.findCallById(call.id)).status, 'ongoing');
  });

  await t.test('aakhri offline user par call end + busy keys clear', async (t) => {
    const { service, users, conversationId, repo, redis } = await groupCallFixture(t);
    const [initiator, a] = users;
    const { call } = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    await service.joinGroupCall(a, call.id);
    const first = await service.autoEndOngoingCalls(initiator.id);
    assert.equal(first.ended, 0);
    const last = await service.autoEndOngoingCalls(a.id);
    assert.equal(last.ended, 1);
    const row = await repo.findCallById(call.id);
    assert.equal(row.status, 'ended');
    assert.equal(await redis.exists(`call:active:${a.id}`), 0);
  });

  await t.test('autoEnd ke baad user dobara call kar sakta hai', async (t) => {
    const { service, users, conversationId } = await groupCallFixture(t);
    const [initiator, a] = users;
    await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    await service.autoEndOngoingCalls(initiator.id);
    const again = await service.initiateCall(initiator, conversationId, { callType: 'voice' });
    assert.equal(again.call.status, 'ongoing');
  });
});
