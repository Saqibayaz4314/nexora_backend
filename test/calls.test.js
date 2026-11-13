'use strict';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789-abcdefghijkl';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789-abcdefghijkl';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

const { createApp } = require('../src/app');
const { createCallsRepo } = require('../src/modules/calls/calls.repo');
const { createCallsService } = require('../src/modules/calls/calls.service');
const { runCallCleanup } = require('../src/modules/calls/calls.cleanup');
const { createTestPool, fakeMailer, uniqueIp } = require('./helpers/test-db');

async function withApp(t, fn) {
  const pool = await createTestPool();
  const mailer = fakeMailer();
  const app = createApp({ pool, mailer });
  try {
    await fn({ app, pool, mailer });
  } finally {
    if (pool.end) await pool.end();
  }
}

async function register(app, mailer, { username, email, password = 'strongPassword123' }) {
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .set('X-Forwarded-For', uniqueIp())
    .send({ username, email, password, displayName: username });
  return reg.body.data;
}

async function registerAndVerify(app, mailer, opts) {
  const data = await register(app, mailer, opts);
  const mail = mailer.sent.find((m) => m.type === 'email_verify' && m.to === opts.email);
  await request(app)
    .post('/api/v1/auth/email/verify')
    .set('X-Forwarded-For', uniqueIp())
    .send({ token: mail.token });
  return data;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const fwd = () => ({ 'X-Forwarded-For': uniqueIp() });

async function createConversation(pool, userIds) {
  const convId = crypto.randomUUID();
  await pool.query(`INSERT INTO conversations (id, kind) VALUES ($1, 'one_to_one')`, [convId]);
  for (const uid of userIds) {
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member')`,
      [convId, uid]
    );
  }
  return convId;
}

const callBody = (overrides = {}) => ({
  callType: 'voice',
  offerSdp: 'v=0\r\no=- fake offer',
  ...overrides,
});

// Only models the Redis commands used by calls, including TTL and atomic ownership checks.
function fakeCallRedis() {
  const entries = new Map();
  let now = Date.now();
  const redis = {
    unavailable: false,
    beforeCompare: null,
    advance(seconds) { now += seconds * 1000; },
    async get(key) {
      if (redis.unavailable) throw new Error('Redis unavailable');
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= now) return null;
      return entry.value;
    },
    async exists(key) { return (await redis.get(key)) === null ? 0 : 1; },
    async set(key, value, mode, seconds) {
      if (redis.unavailable) throw new Error('Redis unavailable');
      assert.equal(mode, 'EX');
      entries.set(key, { value, expiresAt: now + seconds * 1000 });
      return 'OK';
    },
    async del(...keys) {
      if (redis.unavailable) throw new Error('Redis unavailable');
      return keys.reduce((count, key) => count + Number(entries.delete(key)), 0);
    },
    async eval(script, numberOfKeys, key, callId) {
      if (redis.unavailable) throw new Error('Redis unavailable');
      assert.equal(numberOfKeys, 1);
      assert.equal(script,
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0");
      if (redis.beforeCompare) await redis.beforeCompare(key);
      const entry = entries.get(key);
      // No await between comparison and deletion: model one atomic Redis operation.
      return entry && entry.expiresAt > now && entry.value === callId
        ? Number(entries.delete(key)) : 0;
    },
  };
  return redis;
}

async function callServiceFixture(t, { withoutRedis = false } = {}) {
  const pool = await createTestPool();
  t.after(async () => { if (pool.end) await pool.end(); });
  const users = [];
  for (const name of ['caller', 'callee', 'third']) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, username, username_norm, email, email_norm, password_hash)
       VALUES ($1, $2, $2, $3, $3, 'x')`, [id, name, `${name}@example.com`]
    );
    users.push({ id });
  }
  const [caller, callee, third] = users;
  const conversationId = await createConversation(pool, [caller.id, callee.id]);
  const otherConversationId = await createConversation(pool, [caller.id, third.id]);
  const repo = createCallsRepo({ db: pool });
  const redis = fakeCallRedis();
  const service = createCallsService({
    db: pool, repo, contactsRepo: { async isBlocked() { return false; } },
    redis: withoutRedis ? null : redis,
    config: { callRingTimeoutSeconds: 60, callActiveTtlSeconds: 7200 },
  });
  const initiate = (user = caller, convId = conversationId) => service.initiateCall(user, convId, callBody());
  const ageRing = (id) => pool.query('UPDATE call_sessions SET created_at = $1 WHERE id = $2',
    [new Date(Date.now() - 90000), id]);
  return { pool, repo, redis, service, caller, callee, third, conversationId, otherConversationId, initiate, ageRing };
}

test('calls: Redis busy cleanup regressions', async (t) => {
  await t.test('reject clears caller busy and allows an immediate new call', async (t) => {
    const { redis, service, caller, callee, initiate } = await callServiceFixture(t);
    const { call } = await initiate();
    assert.equal(await redis.get(`call:active:${caller.id}`), call.id);
    assert.equal((await service.rejectCall(callee, call.id)).call.status, 'rejected');
    assert.equal(await redis.exists(`call:ring:${call.id}`), 0);
    assert.equal(await redis.exists(`call:active:${caller.id}`), 0);
    const next = await initiate();
    assert.notEqual(next.call.id, call.id);
    assert.equal(await redis.get(`call:active:${caller.id}`), next.call.id);
  });

  for (const status of ['rejected', 'cancelled', 'ended', 'missed']) {
    await t.test(`DB ${status} ignores leftover busy keys for both participants`, async (t) => {
      const { repo, redis, callee, initiate } = await callServiceFixture(t);
      const { call } = await initiate();
      await repo.transitionStatus(call.id, ['ringing'], status, { endedAt: new Date() });
      await redis.set(`call:active:${callee.id}`, call.id, 'EX', 7200);
      assert.equal((await initiate()).call.status, 'ringing');
    });
  }

  for (const expiry of ['Redis TTL', 'DB deadline with a live ring key']) {
    await t.test(`expired answer clears busy: ${expiry}`, async (t) => {
      const { repo, redis, service, caller, callee, initiate, ageRing } = await callServiceFixture(t);
      const { call } = await initiate();
      if (expiry === 'Redis TTL') redis.advance(61);
      else await ageRing(call.id);
      await assert.rejects(service.answerCall(callee, call.id, 'answer'), { code: 'CALL_EXPIRED' });
      const row = await repo.findCallById(call.id);
      assert.equal(row.status, 'missed');
      assert.ok(row.ended_at);
      assert.equal(await redis.exists(`call:active:${caller.id}`), 0);
      assert.equal(await redis.exists(`call:ring:${call.id}`), 0);
      assert.equal((await initiate()).call.status, 'ringing');
    });
  }

  for (const mode of ['Redis', 'no Redis', 'Redis unavailable']) {
    await t.test(`expired DB rings do not repeatedly block without cleanup: ${mode}`, async (t) => {
      const { repo, redis, initiate, ageRing } = await callServiceFixture(t, { withoutRedis: mode === 'no Redis' });
      redis.unavailable = mode === 'Redis unavailable';
      const first = await initiate();
      await ageRing(first.call.id);
      const second = await initiate();
      await ageRing(second.call.id);
      const third = await initiate();
      assert.equal(third.call.status, 'ringing');
      assert.equal((await repo.findCallById(first.call.id)).status, 'missed');
      assert.equal((await repo.findCallById(second.call.id)).status, 'missed');
      // An answer that read 'ringing' before expiration must lose its status CAS.
      assert.equal(await repo.transitionStatus(first.call.id, ['ringing'], 'ongoing'), null);
      await assert.rejects(initiate(), { code: 'USER_IN_CALL' });
    });
  }

  await t.test('stale rings and terminal Redis pointers cannot hide an ongoing DB call', async (t) => {
    const { repo, redis, service, caller, callee, initiate, ageRing, otherConversationId } = await callServiceFixture(t);
    const stale = await initiate();
    await ageRing(stale.call.id);
    const live = await initiate();
    await service.answerCall(callee, live.call.id, 'answer');
    await repo.transitionStatus(stale.call.id, ['ringing'], 'missed');
    await redis.set(`call:active:${caller.id}`, stale.call.id, 'EX', 7200);
    await redis.del(`call:active:${callee.id}`);
    await assert.rejects(initiate(caller, otherConversationId), { code: 'USER_IN_CALL' });
    await assert.rejects(initiate(callee), { code: 'USER_IN_CALL' });
  });

  for (const operation of ['reject', 'expire', 'cancel', 'end']) {
    await t.test(`${operation} cleanup preserves keys replaced by another call`, async (t) => {
      const { redis, service, caller, callee, initiate } = await callServiceFixture(t);
      const { call } = await initiate();
      if (operation === 'end') await service.answerCall(callee, call.id, 'answer');
      if (operation === 'expire') redis.advance(61);
      const replacementId = crypto.randomUUID();
      redis.beforeCompare = (key) => redis.set(key, replacementId, 'EX', 7200);
      if (operation === 'reject') await service.rejectCall(callee, call.id);
      if (operation === 'cancel') await service.cancelCall(caller, call.id);
      if (operation === 'end') await service.endCall(caller, call.id);
      if (operation === 'expire') {
        await assert.rejects(service.answerCall(callee, call.id, 'answer'), { code: 'CALL_EXPIRED' });
      }
      assert.equal(await redis.get(`call:active:${caller.id}`), replacementId);
      if (operation === 'end') assert.equal(await redis.get(`call:active:${callee.id}`), replacementId);
    });
  }

  await t.test('a lost expiration transition does not clean an answered call', async (t) => {
    const { repo, redis, service, caller, callee, initiate } = await callServiceFixture(t);
    const { call } = await initiate();
    redis.advance(61);
    const transition = repo.transitionStatus.bind(repo);
    repo.transitionStatus = async (id, from, to, fields) => {
      if (to === 'missed') {
        await transition(id, ['ringing'], 'ongoing', { startedAt: new Date() });
      }
      return transition(id, from, to, fields);
    };
    await assert.rejects(service.answerCall(callee, call.id, 'answer'), { code: 'CALL_EXPIRED' });
    assert.equal((await repo.findCallById(call.id)).status, 'ongoing');
    assert.equal(await redis.get(`call:active:${caller.id}`), call.id);
    await assert.rejects(initiate(), { code: 'USER_IN_CALL' });
  });

  await t.test('an answer winning before lazy expiration remains busy', async (t) => {
    const { repo, initiate, ageRing } = await callServiceFixture(t);
    const { call } = await initiate();
    await ageRing(call.id);
    const expire = repo.expireRingingCallsForUser.bind(repo);
    let answer;
    repo.expireRingingCallsForUser = async (...args) => {
      answer ||= repo.transitionStatus(call.id, ['ringing'], 'ongoing', { startedAt: new Date() });
      await answer;
      return expire(...args);
    };
    await assert.rejects(initiate(), { code: 'USER_IN_CALL' });
    assert.equal((await repo.findCallById(call.id)).status, 'ongoing');
  });

  await t.test('fresh ringing DB rows block both participants even without busy keys', async (t) => {
    const { redis, caller, callee, initiate } = await callServiceFixture(t);
    await initiate();
    await redis.del(`call:active:${caller.id}`);
    await assert.rejects(initiate(), { code: 'USER_IN_CALL' });
    await assert.rejects(initiate(callee), { code: 'USER_IN_CALL' });
  });

  for (const operation of ['cancel', 'end']) {
    await t.test(`${operation} removes its own busy keys`, async (t) => {
      const { redis, service, caller, callee, initiate } = await callServiceFixture(t);
      const { call } = await initiate();
      if (operation === 'end') {
        await service.answerCall(callee, call.id, 'answer');
        await service.endCall(caller, call.id);
      } else {
        await service.cancelCall(caller, call.id);
      }
      assert.equal(await redis.exists(`call:ring:${call.id}`), 0);
      assert.equal(await redis.exists(`call:active:${caller.id}`), 0);
      assert.equal(await redis.exists(`call:active:${callee.id}`), 0);
      assert.equal((await initiate()).call.status, 'ringing');
    });
  }

  await t.test('failed Redis cleanup is best-effort and cannot block retry', async (t) => {
    const { redis, service, callee, initiate } = await callServiceFixture(t);
    const { call } = await initiate();
    redis.unavailable = true;
    await service.rejectCall(callee, call.id);
    redis.unavailable = false;
    assert.equal((await initiate()).call.status, 'ringing');
  });
});

test('calls: initiate + get + end', async (t) => {
  await t.test('initiate → 201 ringing row; get → participant ok; end → ended', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const convId = await createConversation(pool, [alice.user.id, bob.user.id]);

      const init = await request(app)
        .post(`/api/v1/conversations/${convId}/calls`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(callBody());
      assert.equal(init.status, 201);
      const call = init.body.data.call;
      assert.ok(call.id);
      assert.equal(call.initiatorUserId, alice.user.id);
      assert.equal(call.callType, 'voice');
      assert.equal(call.status, 'ringing');
      assert.equal(call.conversationId, convId);

      const row = await pool.query('SELECT status, offer_sdp FROM call_sessions WHERE id = $1', [call.id]);
      assert.equal(row.rows[0].status, 'ringing');
      assert.ok(row.rows[0].offer_sdp);

      // Participant get (reconnect ke liye).
      const got = await request(app)
        .get(`/api/v1/calls/${call.id}`)
        .set(auth(bob.accessToken));
      assert.equal(got.status, 200);
      assert.equal(got.body.data.call.id, call.id);

      // End via REST (bob, callee) — ringing end by callee = rejected (decline).
      const ended = await request(app)
        .post(`/api/v1/calls/${call.id}/end`)
        .set(auth(bob.accessToken))
        .set(fwd());
      assert.equal(ended.status, 200);
      assert.equal(ended.body.data.call.status, 'rejected');

      const row2 = await pool.query('SELECT status, ended_at FROM call_sessions WHERE id = $1', [call.id]);
      assert.equal(row2.rows[0].status, 'rejected');
      assert.ok(row2.rows[0].ended_at);
    });
  });

  await t.test('non-member initiate → 403; stranger get/end → 403 NOT_CALL_PARTICIPANT', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const eve = await registerAndVerify(app, mailer, { username: 'eve_01', email: 'eve@example.com' });
      const convId = await createConversation(pool, [alice.user.id, bob.user.id]);

      const init = await request(app)
        .post(`/api/v1/conversations/${convId}/calls`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(callBody());
      const callId = init.body.data.call.id;

      const eveInit = await request(app)
        .post(`/api/v1/conversations/${convId}/calls`)
        .set(auth(eve.accessToken))
        .set(fwd())
        .send(callBody());
      assert.equal(eveInit.status, 403);
      assert.equal(eveInit.body.error.code, 'NOT_CONVERSATION_MEMBER');

      const eveGet = await request(app)
        .get(`/api/v1/calls/${callId}`)
        .set(auth(eve.accessToken));
      assert.equal(eveGet.status, 403);
      assert.equal(eveGet.body.error.code, 'NOT_CALL_PARTICIPANT');

      const eveEnd = await request(app)
        .post(`/api/v1/calls/${callId}/end`)
        .set(auth(eve.accessToken))
        .set(fwd());
      assert.equal(eveEnd.status, 403);
      assert.equal(eveEnd.body.error.code, 'NOT_CALL_PARTICIPANT');
    });
  });

  await t.test('blocked (dono directions) → 403 CANNOT_CALL_USER', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const convId = await createConversation(pool, [alice.user.id, bob.user.id]);

      await request(app)
        .post(`/api/v1/users/${bob.user.id}/block`)
        .set(auth(alice.accessToken))
        .set(fwd());

      const res = await request(app)
        .post(`/api/v1/conversations/${convId}/calls`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(callBody());
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'CANNOT_CALL_USER');
    });
  });

  await t.test('busy: active ringing call ke doran naya call → 409 USER_IN_CALL', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const eve = await registerAndVerify(app, mailer, { username: 'eve_01', email: 'eve@example.com' });
      const convAb = await createConversation(pool, [alice.user.id, bob.user.id]);
      const convBe = await createConversation(pool, [bob.user.id, eve.user.id]);

      const first = await request(app)
        .post(`/api/v1/conversations/${convAb}/calls`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(callBody());
      assert.equal(first.status, 201);

      // Alice dobara call karti hai — khud busy.
      const again = await request(app)
        .post(`/api/v1/conversations/${convAb}/calls`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(callBody());
      assert.equal(again.status, 409);
      assert.equal(again.body.error.code, 'USER_IN_CALL');

      // Bob (ringing callee) kisi aur ko call karta hai — busy.
      const bobCalls = await request(app)
        .post(`/api/v1/conversations/${convBe}/calls`)
        .set(auth(bob.accessToken))
        .set(fwd())
        .send(callBody());
      assert.equal(bobCalls.status, 409);
      assert.equal(bobCalls.body.error.code, 'USER_IN_CALL');
    });
  });
});

test('calls: history + pagination', async (t) => {
  await t.test('list newest-first; cursor walk; invalid cursor 400', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const convId = await createConversation(pool, [alice.user.id, bob.user.id]);

      const ids = [];
      for (let i = 1; i <= 3; i += 1) {
        const id = crypto.randomUUID();
        ids.push(id);
        await pool.query(
          `INSERT INTO call_sessions
             (id, conversation_id, initiator_user_id, call_type, status, created_at)
           VALUES ($1, $2, $3, 'voice', 'ended', $4)`,
          [id, convId, alice.user.id, new Date(Date.now() - (4 - i) * 60000).toISOString()]
        );
      }

      const page1 = await request(app)
        .get(`/api/v1/conversations/${convId}/calls?limit=2`)
        .set(auth(bob.accessToken));
      assert.equal(page1.status, 200);
      assert.equal(page1.body.data.calls.length, 2);
      assert.equal(page1.body.data.calls[0].id, ids[2]);
      assert.equal(page1.body.data.calls[1].id, ids[1]);
      assert.ok(page1.body.data.nextCursor);

      const page2 = await request(app)
        .get(`/api/v1/conversations/${convId}/calls?limit=2&cursor=${page1.body.data.nextCursor}`)
        .set(auth(bob.accessToken));
      assert.equal(page2.status, 200);
      assert.equal(page2.body.data.calls.length, 1);
      assert.equal(page2.body.data.calls[0].id, ids[0]);
      assert.equal(page2.body.data.nextCursor, null);

      const bad = await request(app)
        .get(`/api/v1/conversations/${convId}/calls?cursor=not-a-cursor`)
        .set(auth(bob.accessToken));
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error.code, 'INVALID_CURSOR');
    });
  });
});

test('calls: TURN config + validation', async (t) => {
  await t.test('GET /calls/turn → iceServers (STUN defaults; TURN sirf env se)', async () => {
    await withApp(t, async ({ app, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const res = await request(app)
        .get('/api/v1/calls/turn')
        .set(auth(alice.accessToken));
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data.iceServers));
      assert.ok(res.body.data.iceServers.length >= 1);
      assert.equal(res.body.data.turnConfigured, false); // test env mein TURN env nahi
    });
  });

  await t.test('invalid callType → 400; bad callId → 400; unauth → 401', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const convId = await createConversation(pool, [alice.user.id, bob.user.id]);

      const bad = await request(app)
        .post(`/api/v1/conversations/${convId}/calls`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(callBody({ callType: 'hologram' }));
      assert.equal(bad.status, 400);

      const badId = await request(app)
        .get('/api/v1/calls/not-a-uuid')
        .set(auth(alice.accessToken));
      assert.equal(badId.status, 400);

      const unauth = await request(app)
        .post(`/api/v1/conversations/${convId}/calls`)
        .set(fwd())
        .send(callBody());
      assert.equal(unauth.status, 401);
    });
  });
});

test('calls: cleanup retention', async (t) => {
  await t.test('stale ringing → missed; stale ongoing → ended; fresh rows rehte hain', async () => {
    await withApp(t, async ({ pool }) => {
      // Direct setup: repo + cleanup without HTTP.
      const repo = createCallsRepo({ db: pool });
      const convId = crypto.randomUUID();
      const uid = crypto.randomUUID();
      await pool.query(
        `INSERT INTO users (id, username, username_norm, email, email_norm, password_hash)
         VALUES ($1, 'cleanup_user', 'cleanup_user', 'cleanup@example.com', 'cleanup@example.com', 'x')`,
        [uid]
      );
      await pool.query(`INSERT INTO conversations (id, kind) VALUES ($1, 'one_to_one')`, [convId]);
      await pool.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member')`,
        [convId, uid]
      );

      const staleRing = crypto.randomUUID();
      const staleOngoing = crypto.randomUUID();
      const fresh = crypto.randomUUID();
      const now = Date.now();
      await pool.query(
        `INSERT INTO call_sessions (id, conversation_id, initiator_user_id, call_type, status, created_at)
         VALUES ($1, $2, $3, 'voice', 'ringing', $4)`,
        [staleRing, convId, uid, new Date(now - 90 * 1000).toISOString()]
      );
      await pool.query(
        `INSERT INTO call_sessions (id, conversation_id, initiator_user_id, call_type, status, started_at, created_at)
         VALUES ($1, $2, $3, 'voice', 'ongoing', $4, $5)`,
        [staleOngoing, convId, uid, new Date(now - 25 * 3600 * 1000).toISOString(), new Date(now - 25 * 3600 * 1000).toISOString()]
      );
      await pool.query(
        `INSERT INTO call_sessions (id, conversation_id, initiator_user_id, call_type, status, created_at)
         VALUES ($1, $2, $3, 'voice', 'ringing', $4)`,
        [fresh, convId, uid, new Date(now - 5 * 1000).toISOString()]
      );

      const result = await runCallCleanup({
        db: pool,
        repo,
        logger: { warn() {}, info() {}, error() {} },
        config: { callRingTimeoutSeconds: 60, callMaxDurationSeconds: 24 * 60 * 60 },
        now: new Date(now),
      });
      assert.equal(result.removedRinging, 1);
      assert.equal(result.removedOngoing, 1);

      const rows = await pool.query('SELECT id, status FROM call_sessions ORDER BY id');
      const byId = new Map(rows.rows.map((r) => [r.id, r.status]));
      assert.equal(byId.get(staleRing), 'missed');
      assert.equal(byId.get(staleOngoing), 'ended');
      assert.equal(byId.get(fresh), 'ringing');
    });
  });
});
