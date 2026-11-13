'use strict';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789-abcdefghijkl';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789-abcdefghijkl';
// Grace period 1 second — isi file mein slow-network reconnection test hota hai.
process.env.PRESENCE_GRACE_SECONDS = '1';

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Redis fake — sirf woh commands jo v1 sockets use karte hain.
// TTL aware strings + sets; scan MATCH prefix filtering.
function fakeSocketRedis() {
  const sets = new Map();
  const strings = new Map();
  return {
    async sadd(key, member) {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key).add(member);
      return 1;
    },
    async srem(key, member) {
      const s = sets.get(key);
      if (s) s.delete(member);
      return 1;
    },
    async scard(key) {
      const s = sets.get(key);
      return s ? s.size : 0;
    },
    async expire() { return 1; },
    async set(key, value, mode, seconds) {
      assert.equal(mode, 'EX');
      strings.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
      return 'OK';
    },
    async get(key) {
      const e = strings.get(key);
      if (!e) return null;
      if (e.expiresAt <= Date.now()) { strings.delete(key); return null; }
      return e.value;
    },
    async del(key) {
      strings.delete(key);
      sets.delete(key);
      return 1;
    },
    async exists(key) { return (await this.get(key)) === null ? 0 : 1; },
    async scan(_cursor, _mode, match) {
      const prefix = match.replace(':*', ':');
      const keys = [...strings.keys()].filter((k) => k.startsWith(prefix));
      return ['0', keys];
    },
    async smembers(key) {
      const s = sets.get(key);
      return s ? [...s] : [];
    },
  };
}

async function withSocketEnv(t, fn) {
  const pool = await createTestPool();
  t.after(async () => { if (pool.end) await pool.end(); });
  const mailer = fakeMailer();
  const app = createApp({ pool, mailer });
  const redis = fakeSocketRedis();
  app.locals.redis = redis; // fake inject — getRedis() ke bajaye
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
    await fn({ app, pool, mailer, redis, connect });
  } finally {
    for (const s of sockets) s.disconnect();
    await wait(50);
    io.close();
    await new Promise((resolve) => server.close(resolve));
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
  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
    [id, a, b]
  );
  return id;
}

function ack(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function nextPresence(socket, userId, online, timeoutMs = 4000) {
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

test('sock:<userId> set: connect SADD, disconnect SREM', async (t) => {
  await withSocketEnv(t, async ({ redis, connect, app, mailer }) => {
    const alice = await registerAndVerify(app, mailer, 'sock_alice');
    const a = await connect(alice.accessToken);
    await wait(150);
    assert.equal(await redis.scard(`sock:${alice.user.id}`), 1, 'connect par socket set mein hona chahiye');
    a.disconnect();
    await wait(250);
    assert.equal(await redis.scard(`sock:${alice.user.id}`), 0, 'disconnect par set se nikal jana chahiye');
  });
});

test('disconnect grace: offline event grace expire ke baad aata hai', async (t) => {
  await withSocketEnv(t, async ({ app, pool, mailer, connect }) => {
    const alice = await registerAndVerify(app, mailer, 'grace_a');
    const bob = await registerAndVerify(app, mailer, 'grace_b');
    await directChat(pool, alice.user.id, bob.user.id);
    const a = await connect(alice.accessToken);
    const online = nextPresence(a, bob.user.id, true);
    const b = await connect(bob.accessToken);
    await online;

    const events = [];
    a.on('presence:update', (p) => { if (p.userId === bob.user.id) events.push(p); });
    b.disconnect();
    await wait(300); // grace (1s) ke andar
    assert.deepEqual(
      events.filter((p) => p.online === false),
      [],
      'grace ke andar offline event nahi aana chahiye (false offline flash nahi)'
    );
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !events.some((p) => p.online === false)) {
      // eslint-disable-next-line no-await-in-loop
      await wait(100);
    }
    assert.ok(events.some((p) => p.online === false), 'grace expire ke baad offline aana chahiye');
  });
});

test('disconnect grace: reconnect within grace → koi offline flash nahi', async (t) => {
  await withSocketEnv(t, async ({ app, pool, mailer, connect }) => {
    const alice = await registerAndVerify(app, mailer, 'grace_c');
    const bob = await registerAndVerify(app, mailer, 'grace_d');
    await directChat(pool, alice.user.id, bob.user.id);
    const a = await connect(alice.accessToken);
    const online = nextPresence(a, bob.user.id, true);
    const b = await connect(bob.accessToken);
    await online;

    const events = [];
    a.on('presence:update', (p) => { if (p.userId === bob.user.id) events.push(p); });
    b.disconnect();
    // Slow-network reconnect grace (1s) ke andar.
    await wait(150);
    await connect(bob.accessToken);
    await wait(2000); // grace se zyada wait — offline kabhi nahi aana chahiye
    assert.deepEqual(
      events.filter((p) => p.online === false),
      [],
      'grace ke andar reconnect par offline kabhi nahi aana chahiye'
    );
  });
});

test('typing: Redis key EX 5 set/delete + join par typingUserIds', async (t) => {
  await withSocketEnv(t, async ({ app, pool, mailer, redis, connect }) => {
    const alice = await registerAndVerify(app, mailer, 'typing_redis_a');
    const bob = await registerAndVerify(app, mailer, 'typing_redis_b');
    const convId = await directChat(pool, alice.user.id, bob.user.id);

    const a = await connect(alice.accessToken);
    const b = await connect(bob.accessToken);

    const joinA = await ack(a, 'conversation:join', { conversationId: convId });
    assert.equal(joinA.error, null);
    assert.deepEqual(joinA.data.typingUserIds, [], 'kisi ka typing nahi — khali list');

    const started = await ack(a, 'typing:start', { conversationId: convId });
    assert.equal(started.error, null);
    await wait(100);
    assert.equal(await redis.get(`typing:${convId}:${alice.user.id}`), '1', 'typing key EX ke saath set honi chahiye');

    // Bob late join kare to current typers milte hain.
    const joinB = await ack(b, 'conversation:join', { conversationId: convId });
    assert.equal(joinB.error, null);
    assert.deepEqual(joinB.data.typingUserIds, [alice.user.id]);

    await ack(a, 'typing:stop', { conversationId: convId });
    await wait(100);
    assert.equal(await redis.get(`typing:${convId}:${alice.user.id}`), null, 'typing stop par key delete honi chahiye');
  });
});
