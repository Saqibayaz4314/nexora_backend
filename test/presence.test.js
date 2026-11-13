'use strict';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789-abcdefghijkl';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789-abcdefghijkl';
// Grace 0 = disconnect par turant offline (purana behavior) — grace period
// khud socket-grace.test.js mein alag se test hota hai.
process.env.PRESENCE_GRACE_SECONDS = '0';

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
const { createPresenceTracker } = require('../src/modules/presence/presence.tracker');

async function withSocketEnv(fn) {
  const pool = await createTestPool();
  const mailer = fakeMailer();
  const app = createApp({ pool, mailer });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const io = new Server(server, { transports: ['websocket'] });
  app.set('io', io.of('/v1'));
  initV1Sockets(io, app);
  const sockets = [];
  const connect = async (token) => {
    const s = await new Promise((resolve, reject) => {
      const socket = ioc(`http://127.0.0.1:${port}/v1`, {
        auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false,
      });
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });
    sockets.push(s);
    return s;
  };
  try {
    await fn({ app, pool, mailer, connect });
  } finally {
    for (const s of sockets) s.disconnect();
    await new Promise((r) => setTimeout(r, 50));
    io.close();
    await new Promise((resolve) => server.close(resolve));
    if (pool.end) await pool.end();
  }
}

async function registerAndVerify(app, mailer, name) {
  const email = `${name}@example.com`;
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .set('X-Forwarded-For', uniqueIp())
    .send({ username: name, email, password: 'strongPassword123', displayName: name });
  const mail = mailer.sent.find((m) => m.type === 'email_verify' && m.to === email);
  await request(app).post('/api/v1/auth/email/verify').set('X-Forwarded-For', uniqueIp()).send({ token: mail.token });
  return reg.body.data;
}

async function directChat(pool, a, b) {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO conversations (id, kind) VALUES ($1, 'one_to_one')`, [id]);
  await pool.query(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member')`, [id, a]);
  await pool.query(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member')`, [id, b]);
  return id;
}

function ack(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function nextPresence(socket, userId, online, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('presence:update', handler);
      reject(new Error(`timeout waiting presence ${online}`));
    }, timeoutMs);
    function handler(p) {
      if (p.userId === userId && p.online === online) {
        clearTimeout(timer);
        socket.off('presence:update', handler);
        resolve(p);
      }
    }
    socket.on('presence:update', handler);
  });
}

function collect(socket) {
  const events = [];
  socket.on('presence:update', (p) => events.push(p));
  return events;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('presence tracker counts foreground sockets per user', () => {
  const t = createPresenceTracker();
  assert.deepEqual(t.set('u1', 's1', true), { before: false, after: true });
  assert.deepEqual(t.set('u1', 's2', true), { before: true, after: true });
  assert.deepEqual(t.remove('u1', 's1'), { before: true, after: true });
  assert.deepEqual(t.set('u1', 's2', false), { before: true, after: false });
  assert.equal(t.isOnline('u1'), false);
  assert.deepEqual(t.set('u1', 's2', true), { before: false, after: true });
  assert.deepEqual(t.remove('u1', 's2'), { before: true, after: false });
  assert.deepEqual(t.remove('u1', 'missing'), { before: false, after: false });
});

test('direct peer sees online, offline with last seen, and query results', async () => {
  await withSocketEnv(async ({ app, pool, mailer, connect }) => {
    const alice = await registerAndVerify(app, mailer, 'alice_pres');
    const bob = await registerAndVerify(app, mailer, 'bob_pres');
    await directChat(pool, alice.user.id, bob.user.id);

    const a = await connect(alice.accessToken);
    const online = nextPresence(a, bob.user.id, true);
    const b = await connect(bob.accessToken);
    const onlineEvt = await online;
    assert.equal(typeof onlineEvt.lastSeenAt === 'string' || onlineEvt.lastSeenAt instanceof Object, true);

    const q1 = await ack(a, 'presence:query', { userIds: [bob.user.id] });
    assert.equal(q1.error, null);
    assert.deepEqual(q1.data.presence.map((p) => [p.userId, p.online]), [[bob.user.id, true]]);

    const offline = nextPresence(a, bob.user.id, false);
    b.disconnect();
    const offEvt = await offline;
    assert.ok(offEvt.lastSeenAt, 'lastSeenAt sent on offline');
    assert.ok(Math.abs(Date.now() - new Date(offEvt.lastSeenAt).getTime()) < 60000);

    const q2 = await ack(a, 'presence:query', {});
    assert.equal(q2.data.presence.length, 1);
    assert.equal(q2.data.presence[0].online, false);
    assert.ok(q2.data.presence[0].lastSeenAt);
  });
});

test('background marks offline, foreground online; second device keeps online', async () => {
  await withSocketEnv(async ({ app, pool, mailer, connect }) => {
    const alice = await registerAndVerify(app, mailer, 'alice_bg');
    const bob = await registerAndVerify(app, mailer, 'bob_bg');
    await directChat(pool, alice.user.id, bob.user.id);
    const a = await connect(alice.accessToken);
    const firstOnline = nextPresence(a, bob.user.id, true);
    const b1 = await connect(bob.accessToken);
    await firstOnline;

    const off = nextPresence(a, bob.user.id, false);
    b1.emit('presence:background');
    await off;
    const on = nextPresence(a, bob.user.id, true);
    b1.emit('presence:foreground');
    await on;

    const b2 = await connect(bob.accessToken);
    await wait(100);
    const events = collect(a);
    b2.disconnect();
    await wait(200);
    assert.deepEqual(events.filter((e) => e.userId === bob.user.id && e.online === false), []);
    const q = await ack(a, 'presence:query', { userIds: [bob.user.id] });
    assert.equal(q.data.presence[0].online, true);
  });
});

test('presence hidden from strangers, blocked users, and invalid queries', async () => {
  await withSocketEnv(async ({ app, pool, mailer, connect }) => {
    const alice = await registerAndVerify(app, mailer, 'alice_priv');
    const bob = await registerAndVerify(app, mailer, 'bob_priv');
    const carol = await registerAndVerify(app, mailer, 'carol_priv');
    await directChat(pool, alice.user.id, bob.user.id);
    await directChat(pool, alice.user.id, carol.user.id);
    await pool.query(
      `INSERT INTO blocked_users (blocker_user_id, blocked_user_id) VALUES ($1, $2)`,
      [carol.user.id, alice.user.id]
    );
    const stranger = await registerAndVerify(app, mailer, 'dave_priv');

    const a = await connect(alice.accessToken);
    const events = collect(a);
    const c = await connect(carol.accessToken);
    const d = await connect(stranger.accessToken);
    await wait(200);
    assert.deepEqual(events.filter((e) => e.userId === carol.user.id || e.userId === stranger.user.id), []);

    const q = await ack(a, 'presence:query', { userIds: [bob.user.id, carol.user.id, stranger.user.id] });
    assert.deepEqual(q.data.presence.map((p) => p.userId), [bob.user.id]);
    assert.equal(q.data.presence[0].online, false);

    const qc = await ack(c, 'presence:query', {});
    assert.deepEqual(qc.data.presence, []);
    const qd = await ack(d, 'presence:query', { userIds: [alice.user.id] });
    assert.deepEqual(qd.data.presence, []);

    for (const bad of [{ userIds: 'x' }, { userIds: ['not-a-uuid'] }, { userIds: new Array(501).fill(bob.user.id) }]) {
      const r = await ack(a, 'presence:query', bad);
      assert.equal(r.error.code, 'VALIDATION_ERROR');
    }
  });
});
