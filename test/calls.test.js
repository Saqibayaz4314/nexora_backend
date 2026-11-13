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
