'use strict';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789-abcdefghijkl';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789-abcdefghijkl';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const request = require('supertest');
const { Server } = require('socket.io');
const { io: ioc } = require('socket.io-client');

const { createApp } = require('../src/app');
const { createTestPool, fakeMailer, uniqueIp } = require('./helpers/test-db');
const { initV1Sockets } = require('../src/sockets/v1Socket');

async function withSocketEnv(t, fn) {
  const pool = await createTestPool();
  const mailer = fakeMailer();
  const app = createApp({ pool, mailer });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const io = new Server(server, { transports: ['websocket'] });
  app.set('io', io.of('/v1'));
  initV1Sockets(io, app);

  try {
    await fn({ app, pool, mailer, server, io, url: `http://127.0.0.1:${port}` });
  } finally {
    io.close();
    await new Promise((resolve) => server.close(resolve));
    if (pool.end) await pool.end();
  }
}

async function registerAndVerify(app, mailer, opts) {
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .set('X-Forwarded-For', uniqueIp())
    .send({ username: opts.username, email: opts.email, password: 'strongPassword123', displayName: opts.username });
  const data = reg.body.data;
  const mail = mailer.sent.find((m) => m.type === 'email_verify' && m.to === opts.email);
  await request(app)
    .post('/api/v1/auth/email/verify')
    .set('X-Forwarded-For', uniqueIp())
    .send({ token: mail.token });
  return data;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

function connectClient(url, token) {
  return new Promise((resolve, reject) => {
    const socket = ioc(`${url}/v1`, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (resp) => resolve(resp));
  });
}

function waitForEvent(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function setupConversation(pool, app, mailer, n = 2) {
  const names = ['alice_01', 'bob_01', 'eve_01'];
  const users = [];
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    users.push(await registerAndVerify(app, mailer, { username: names[i], email: `${names[i]}@example.com` }));
  }
  const convId = crypto.randomUUID();
  await pool.query(`INSERT INTO conversations (id, kind) VALUES ($1, 'one_to_one')`, [convId]);
  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
    [convId, users[0].user.id, users[1].user.id]
  );
  return { users, convId };
}

async function initiate(app, token, convId, overrides = {}) {
  const res = await request(app)
    .post(`/api/v1/conversations/${convId}/calls`)
    .set(auth(token))
    .set('X-Forwarded-For', uniqueIp())
    .send({ callType: 'voice', offerSdp: 'v=0 offer', ...overrides });
  assert.equal(res.status, 201);
  return res.body.data.call;
}

test('v1 socket calls', async (t) => {
  await t.test('initiate → call:incoming; answer → call:answered; ICE relay; end → call:ended', async () => {
    await withSocketEnv(t, async ({ app, pool, mailer, url }) => {
      const { users, convId } = await setupConversation(pool, app, mailer);
      const alice = users[0];
      const bob = users[1];

      const aliceSocket = await connectClient(url, alice.accessToken);
      const bobSocket = await connectClient(url, bob.accessToken);

      // REST initiate → bob ke socket par call:incoming.
      const incomingPromise = waitForEvent(bobSocket, 'call:incoming');
      const call = await initiate(app, alice.accessToken, convId);
      const incoming = await incomingPromise;
      assert.equal(incoming.call.id, call.id);
      assert.equal(incoming.call.initiatorUserId, alice.user.id);
      assert.equal(incoming.call.callType, 'voice');
      assert.ok(incoming.call.offerSdp, 'callee ko offerSdp milta hai');

      // Bob answer karta hai → alice ko call:answered (answerSdp ke saath).
      const answeredPromise = waitForEvent(aliceSocket, 'call:answered');
      const ansAck = await emitWithAck(bobSocket, 'call:answer', { callId: call.id, answerSdp: 'v=0 answer' });
      assert.ok(ansAck.data, `answer ack error: ${JSON.stringify(ansAck.error)}`);
      assert.equal(ansAck.data.call.status, 'ongoing');
      const answered = await answeredPromise;
      assert.equal(answered.callId, call.id);
      assert.equal(answered.answerSdp, 'v=0 answer');

      const row = await pool.query('SELECT status, answer_sdp, started_at FROM call_sessions WHERE id = $1', [call.id]);
      assert.equal(row.rows[0].status, 'ongoing');
      assert.equal(row.rows[0].answer_sdp, 'v=0 answer');
      assert.ok(row.rows[0].started_at);

      // ICE candidate relay: alice → bob.
      const icePromise = waitForEvent(bobSocket, 'call:ice-candidate');
      const iceAck = await emitWithAck(aliceSocket, 'call:ice-candidate', {
        callId: call.id,
        candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
      });
      assert.ok(iceAck.data.relayed);
      const ice = await icePromise;
      assert.equal(ice.callId, call.id);
      assert.equal(ice.fromUserId, alice.user.id);
      assert.equal(ice.candidate.candidate, 'candidate:1');

      // Alice end karta hai → bob ko call:ended; DB ended.
      const endedPromise = waitForEvent(bobSocket, 'call:ended');
      const endAck = await emitWithAck(aliceSocket, 'call:end', { callId: call.id });
      assert.equal(endAck.data.call.status, 'ended');
      const ended = await endedPromise;
      assert.equal(ended.callId, call.id);

      const row2 = await pool.query('SELECT status, ended_at FROM call_sessions WHERE id = $1', [call.id]);
      assert.equal(row2.rows[0].status, 'ended');
      assert.ok(row2.rows[0].ended_at);

      aliceSocket.disconnect();
      bobSocket.disconnect();
    });
  });

  await t.test('reject → call:rejected; cancel → call:cancelled (DB status sahi)', async () => {
    await withSocketEnv(t, async ({ app, pool, mailer, url }) => {
      const { users, convId } = await setupConversation(pool, app, mailer);
      const alice = users[0];
      const bob = users[1];

      const aliceSocket = await connectClient(url, alice.accessToken);
      const bobSocket = await connectClient(url, bob.accessToken);

      // Reject flow.
      const call1 = await initiate(app, alice.accessToken, convId);
      const rejectedPromise = waitForEvent(aliceSocket, 'call:rejected');
      const rejAck = await emitWithAck(bobSocket, 'call:reject', { callId: call1.id });
      assert.equal(rejAck.data.call.status, 'rejected');
      const rejected = await rejectedPromise;
      assert.equal(rejected.callId, call1.id);

      // Cancel flow.
      const call2 = await initiate(app, alice.accessToken, convId);
      const cancelledPromise = waitForEvent(bobSocket, 'call:cancelled');
      const cancelAck = await emitWithAck(aliceSocket, 'call:cancel', { callId: call2.id });
      assert.equal(cancelAck.data.call.status, 'cancelled');
      const cancelled = await cancelledPromise;
      assert.equal(cancelled.callId, call2.id);

      const rows = await pool.query('SELECT id, status FROM call_sessions WHERE id IN ($1, $2)', [call1.id, call2.id]);
      const byId = new Map(rows.rows.map((r) => [r.id, r.status]));
      assert.equal(byId.get(call1.id), 'rejected');
      assert.equal(byId.get(call2.id), 'cancelled');

      aliceSocket.disconnect();
      bobSocket.disconnect();
    });
  });

  await t.test('stale ringing call ka answer → CALL_EXPIRED; DB missed', async () => {
    await withSocketEnv(t, async ({ app, pool, mailer, url }) => {
      const { users, convId } = await setupConversation(pool, app, mailer);
      const alice = users[0];
      const bob = users[1];

      const bobSocket = await connectClient(url, bob.accessToken);

      // Direct SQL se purana ringing call (ring timeout 60s se purana).
      const staleId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO call_sessions (id, conversation_id, initiator_user_id, call_type, status, offer_sdp, created_at)
         VALUES ($1, $2, $3, 'voice', 'ringing', 'v=0 stale', $4)`,
        [staleId, convId, alice.user.id, new Date(Date.now() - 90 * 1000).toISOString()]
      );

      const ack = await emitWithAck(bobSocket, 'call:answer', { callId: staleId, answerSdp: 'v=0 late' });
      assert.equal(ack.data, null);
      assert.equal(ack.error.code, 'CALL_EXPIRED');

      const row = await pool.query('SELECT status FROM call_sessions WHERE id = $1', [staleId]);
      assert.equal(row.rows[0].status, 'missed');

      bobSocket.disconnect();
    });
  });

  await t.test('non-participant ka call:answer → NOT_CALL_PARTICIPANT', async () => {
    await withSocketEnv(t, async ({ app, pool, mailer, url }) => {
      const { users, convId } = await setupConversation(pool, app, mailer);
      const alice = users[0];

      const eve = await registerAndVerify(app, mailer, { username: 'eve_01', email: 'eve_01@example.com' });
      const eveSocket = await connectClient(url, eve.accessToken);

      const call = await initiate(app, alice.accessToken, convId);

      const ack = await emitWithAck(eveSocket, 'call:answer', { callId: call.id, answerSdp: 'v=0 evil' });
      assert.equal(ack.data, null);
      assert.equal(ack.error.code, 'NOT_CALL_PARTICIPANT');

      const ack2 = await emitWithAck(eveSocket, 'call:ice-candidate', {
        callId: call.id,
        candidate: { candidate: 'candidate:9', sdpMid: '0', sdpMLineIndex: 0 },
      });
      assert.equal(ack2.data, null);
      assert.equal(ack2.error.code, 'NOT_CALL_PARTICIPANT');

      eveSocket.disconnect();
    });
  });
});
