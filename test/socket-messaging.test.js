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

test('v1 socket shared message validation and membership', async (t) => {
  await withSocketEnv(t, async ({ app, pool, mailer, url }) => {
    const alice = await registerAndVerify(app, mailer, { username: 'alice_bounds', email: 'alice_bounds@example.com' });
    const convId = crypto.randomUUID();
    await pool.query(`INSERT INTO conversations (id, kind) VALUES ($1, 'group')`, [convId]);
    await pool.query(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'owner')`, [convId, alice.user.id]);
    const socket = await connectClient(url, alice.accessToken);
    try {
      const body = { conversationId: convId, messageType: 'text', ciphertext: 'c', nonce: 'n', authTag: 't' };
      const sent = await emitWithAck(socket, 'message:send', body);
      assert.equal(sent.error, null);
      const messageId = sent.data.message.id;
      for (const size of [1001, 100000]) {
        const reactionCiphertext = 'r'.repeat(size);
        const event = waitForEvent(socket, 'message:reacted');
        const res = await emitWithAck(socket, 'message:react', { messageId, reactionCiphertext });
        assert.equal(res.error, null);
        assert.equal((await event).reactionCiphertext, reactionCiphertext);
      }
      const invalid = [
        ['message:react', { messageId, reactionCiphertext: 'r'.repeat(100001) }],
        ['message:react', { messageId, reactionCiphertext: '' }],
        ['message:react', { messageId: 'invalid', reactionCiphertext: 'r' }],
        ['message:send', { ...body, conversationId: 'invalid' }],
        ['message:send', { ...body, messageType: 'system' }],
        ['message:send', { ...body, ciphertext: 'c'.repeat(100001) }],
        ['message:send', { ...body, nonce: 'n'.repeat(65) }],
        ['message:send', { ...body, authTag: '' }],
        ['message:send', { ...body, mediaId: 'invalid' }],
        ['message:edit', { messageId, ciphertext: 'c'.repeat(100001), nonce: 'n', authTag: 't' }],
        ['message:edit', { messageId, ciphertext: 'c', nonce: 'n'.repeat(65), authTag: 't' }],
        ['message:edit', { messageId, ciphertext: 'c', nonce: 'n' }],
        ['message:edit', { messageId: 'invalid', ciphertext: 'c', nonce: 'n', authTag: 't' }],
      ];
      for (const [event, payload] of invalid) {
        const res = await emitWithAck(socket, event, payload);
        assert.equal(res.data, null, event);
        assert.equal(res.error.code, 'VALIDATION_ERROR', event);
      }
      const edited = await emitWithAck(socket, 'message:edit', { messageId, ciphertext: 'edited', nonce: 'n2', authTag: 't2' });
      assert.equal(edited.error, null);
      assert.equal(edited.data.message.ciphertext, 'edited');
      const rows = await pool.query('SELECT COUNT(*)::int AS n FROM messages');
      assert.equal(rows.rows[0].n, 1);
      const reaction = await pool.query('SELECT reaction_ciphertext FROM message_reactions WHERE message_id = $1', [messageId]);
      assert.equal(reaction.rows[0].reaction_ciphertext.length, 100000);
      const hidden = await request(app).delete(`/api/v1/conversations/${convId}/self`)
        .set('Authorization', `Bearer ${alice.accessToken}`).set('X-Forwarded-For', uniqueIp());
      assert.equal(hidden.status, 200);
      const received = waitForEvent(socket, 'message:received');
      const restored = await emitWithAck(socket, 'message:send', { ...body, ciphertext: 'new-after-hide' });
      assert.equal(restored.error, null);
      assert.equal((await received).message.id, restored.data.message.id);
      const history = await request(app).get(`/api/v1/conversations/${convId}/messages`)
        .set('Authorization', `Bearer ${alice.accessToken}`).set('X-Forwarded-For', uniqueIp());
      assert.equal(history.status, 200);
      assert.deepEqual(history.body.data.messages.map((m) => m.id), [restored.data.message.id]);
      const membership = (await pool.query('SELECT hidden_at, history_cleared_at, left_at, role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, alice.user.id])).rows[0];
      assert.equal(membership.hidden_at, null);
      assert.ok(membership.history_cleared_at);
      assert.equal(membership.left_at, null);
      assert.equal(membership.role, 'owner');
      await pool.query('UPDATE conversation_members SET left_at = now() WHERE conversation_id = $1 AND user_id = $2', [convId, alice.user.id]);
      for (const [event, payload] of [
        ['message:edit', { messageId, ciphertext: 'forbidden', nonce: 'n', authTag: 't' }],
        ['message:delete', { messageId }],
      ]) {
        const res = await emitWithAck(socket, event, payload);
        assert.equal(res.data, null);
        assert.equal(res.error.code, 'NOT_CONVERSATION_MEMBER');
      }
      const message = await pool.query('SELECT ciphertext, deleted_at FROM messages WHERE id = $1', [messageId]);
      assert.equal(message.rows[0].ciphertext, 'edited');
      assert.equal(message.rows[0].deleted_at, null);
    } finally {
      socket.disconnect();
    }
  });
});

test('v1 socket messaging', async (t) => {
  await t.test('send ack + doosre client ko message:received; duplicate idempotent', async () => {
    await withSocketEnv(t, async ({ app, pool, mailer, url }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });

      const convId = crypto.randomUUID();
      await pool.query(`INSERT INTO conversations (id, kind) VALUES ($1, 'one_to_one')`, [convId]);
      await pool.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
        [convId, alice.user.id, bob.user.id]
      );

      const aliceSocket = await connectClient(url, alice.accessToken);
      const bobSocket = await connectClient(url, bob.accessToken);

      const receivedPromise = waitForEvent(bobSocket, 'message:received');
      const ack = await emitWithAck(aliceSocket, 'message:send', {
        conversationId: convId,
        clientMessageId: 'sock-001',
        messageType: 'text',
        ciphertext: 'socket-cipher',
        nonce: 'nonce',
        authTag: 'tag',
      });
      assert.ok(ack.data, `ack error: ${JSON.stringify(ack.error)}`);
      assert.equal(ack.data.created, true);
      assert.equal(ack.data.message.clientMessageId, 'sock-001');

      const received = await receivedPromise;
      assert.equal(received.message.id, ack.data.message.id);

      // Duplicate send → same message, created false.
      const dup = await emitWithAck(aliceSocket, 'message:send', {
        conversationId: convId,
        clientMessageId: 'sock-001',
        messageType: 'text',
        ciphertext: 'socket-cipher',
        nonce: 'nonce',
        authTag: 'tag',
      });
      assert.equal(dup.data.created, false);
      assert.equal(dup.data.message.id, ack.data.message.id);

      // Non-member socket event → error envelope ack.
      const eve = await registerAndVerify(app, mailer, { username: 'eve_01', email: 'eve@example.com' });
      const eveSocket = await connectClient(url, eve.accessToken);
      const blocked = await emitWithAck(eveSocket, 'message:send', {
        conversationId: convId,
        messageType: 'text',
        ciphertext: 'x',
        nonce: 'n',
        authTag: 't',
      });
      assert.equal(blocked.data, null);
      assert.equal(blocked.error.code, 'NOT_CONVERSATION_MEMBER');

      aliceSocket.disconnect();
      bobSocket.disconnect();
      eveSocket.disconnect();
    });
  });

  await t.test('typing:start → doosre member ko typing:started (userId ke saath)', async () => {
    await withSocketEnv(t, async ({ app, pool, mailer, url }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });

      const convId = crypto.randomUUID();
      await pool.query(`INSERT INTO conversations (id, kind) VALUES ($1, 'one_to_one')`, [convId]);
      await pool.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
        [convId, alice.user.id, bob.user.id]
      );

      const aliceSocket = await connectClient(url, alice.accessToken);
      const bobSocket = await connectClient(url, bob.accessToken);

      const typingPromise = waitForEvent(bobSocket, 'typing:started');
      aliceSocket.emit('typing:start', { conversationId: convId });
      const typing = await typingPromise;
      assert.equal(typing.userId, alice.user.id);
      assert.equal(typing.conversationId, convId);

      aliceSocket.disconnect();
      bobSocket.disconnect();
    });
  });

  await t.test('invalid token → connect_error', async () => {
    await withSocketEnv(t, async ({ url }) => {
      const socket = ioc(`${url}/v1`, {
        auth: { token: 'totally-fake-token' },
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
      });
      const err = await new Promise((resolve) => {
        socket.on('connect_error', (e) => resolve(e));
        socket.on('connect', () => resolve(null));
      });
      assert.ok(err, 'invalid token par connect nahi hona chahiye');
      socket.disconnect();
    });
  });
});

test('v1 socket typing validates UUID and active membership', async (t) => {
  await withSocketEnv(t, async ({ app, pool, mailer, io, url }) => {
    const alice = await registerAndVerify(app, mailer, { username: 'typing_alice', email: 'typing_alice@example.com' });
    const bob = await registerAndVerify(app, mailer, { username: 'typing_bob', email: 'typing_bob@example.com' });
    const outsider = await registerAndVerify(app, mailer, { username: 'typing_outsider', email: 'typing_outsider@example.com' });
    const convId = crypto.randomUUID();
    await pool.query(`INSERT INTO conversations (id, kind) VALUES ($1, 'group')`, [convId]);
    await pool.query(`INSERT INTO conversation_members (conversation_id, user_id, role)
      VALUES ($1, $2, 'owner'), ($1, $3, 'member')`, [convId, alice.user.id, bob.user.id]);
    const sockets = [];
    try {
      for (const user of [alice, bob, outsider]) sockets.push(await connectClient(url, user.accessToken));
      const [a, b, stranger] = sockets;
      await emitWithAck(a, 'conversation:join', { conversationId: convId });
      await emitWithAck(b, 'conversation:join', { conversationId: convId });
      const broadcasts = [];
      b.on('typing:started', (p) => broadcasts.push(p));
      b.on('typing:stopped', (p) => broadcasts.push(p));
      for (const event of ['typing:start', 'typing:stop']) {
        for (const payload of [{}, { conversationId: 'invalid' }, { conversationId: 123 }, null]) {
          const res = await emitWithAck(a, event, payload);
          assert.equal(res.data, null);
          assert.equal(res.error.code, 'VALIDATION_ERROR');
        }
        const denied = await emitWithAck(stranger, event, { conversationId: convId });
        assert.equal(denied.data, null);
        assert.equal(denied.error.code, 'NOT_CONVERSATION_MEMBER');
        const missing = await emitWithAck(a, event, { conversationId: crypto.randomUUID() });
        assert.equal(missing.error.code, 'NOT_CONVERSATION_MEMBER');
      }
      const barrier = waitForEvent(b, 'test:typing-barrier');
      io.of('/v1').to(`user:${bob.user.id}`).emit('test:typing-barrier');
      await barrier;
      assert.deepEqual(broadcasts, [], 'rejected typing never broadcasts');
      for (const [event, receivedEvent] of [['typing:start', 'typing:started'], ['typing:stop', 'typing:stopped']]) {
        const received = waitForEvent(b, receivedEvent);
        const ack = await emitWithAck(a, event, { conversationId: convId });
        assert.equal(ack.error, null);
        assert.deepEqual(await received, { conversationId: convId, userId: alice.user.id });
      }
    } finally {
      sockets.forEach((socket) => socket.disconnect());
    }
  });
});

test('v1 socket former members are evicted before broadcasts', async (t) => {
  for (const action of ['leave', 'remove']) {
    await t.test(action, async () => {
      await withSocketEnv(t, async ({ app, pool, mailer, io, url }) => {
        const alice = await registerAndVerify(app, mailer, { username: 'evict_alice', email: 'evict_alice@example.com' });
        const bob = await registerAndVerify(app, mailer, { username: 'evict_bob', email: 'evict_bob@example.com' });
        const convId = crypto.randomUUID();
        const otherId = crypto.randomUUID();
        for (const id of [convId, otherId]) {
          await pool.query(`INSERT INTO conversations (id, kind, created_by) VALUES ($1, 'group', $2)`, [id, alice.user.id]);
          await pool.query(`INSERT INTO conversation_members (conversation_id, user_id, role)
            VALUES ($1, $2, 'owner'), ($1, $3, 'member')`, [id, alice.user.id, bob.user.id]);
        }
        const sockets = [];
        try {
          for (const user of [alice, bob, bob]) sockets.push(await connectClient(url, user.accessToken));
          const [a, b1, b2] = sockets;
          for (const socket of sockets) {
            assert.equal((await emitWithAck(socket, 'conversation:join', { conversationId: convId })).error, null);
            assert.equal((await emitWithAck(socket, 'conversation:join', { conversationId: otherId })).error, null);
          }
          const formerEvents = [];
          for (const b of [b1, b2]) {
            for (const event of ['conversation:member:left', 'conversation:member:removed', 'message:received', 'typing:started', 'typing:stopped']) {
              b.on(event, (payload) => formerEvents.push({ event, payload }));
            }
          }
          const event = action === 'leave' ? 'conversation:member:left' : 'conversation:member:removed';
          const remainingEvent = waitForEvent(a, event);
          const path = action === 'leave' ? `/api/v1/conversations/${convId}/leave` : `/api/v1/conversations/${convId}/members/${bob.user.id}`;
          const removal = action === 'leave' ? request(app).post(path) : request(app).delete(path);
          const removed = await removal.set('Authorization', `Bearer ${action === 'leave' ? bob.accessToken : alice.accessToken}`)
            .set('X-Forwarded-For', uniqueIp());
          assert.equal(removed.status, 200);
          assert.equal((await remainingEvent).userId, bob.user.id);
          const namespace = io.of('/v1');
          for (const b of [b1, b2]) {
            const serverSocket = namespace.sockets.get(b.id);
            assert.ok(serverSocket.rooms.has(`user:${bob.user.id}`));
            assert.ok(serverSocket.rooms.has(`conversation:${otherId}`), 'unrelated conversations remain joined');
            assert.equal(serverSocket.rooms.has(`conversation:${convId}`), false);
            for (const deniedEvent of ['conversation:join', 'typing:start', 'typing:stop', 'message:send']) {
              const denied = await emitWithAck(b, deniedEvent, {
                conversationId: convId, messageType: 'text', ciphertext: 'c', nonce: 'n', authTag: 't',
              });
              assert.equal(denied.data, null);
              assert.equal(denied.error.code, 'NOT_CONVERSATION_MEMBER');
            }
          }
          assert.ok(namespace.sockets.get(a.id).rooms.has(`conversation:${convId}`), 'remaining members must not be evicted');
          for (const sentEvent of ['typing:start', 'typing:stop']) {
            const ack = await emitWithAck(a, sentEvent, { conversationId: convId });
            assert.equal(ack.error, null);
          }
          const received = waitForEvent(a, 'message:received');
          const sent = await emitWithAck(a, 'message:send', {
            conversationId: convId, messageType: 'text', ciphertext: 'post-removal', nonce: 'n', authTag: 't',
          });
          assert.equal(sent.error, null);
          assert.equal((await received).message.id, sent.data.message.id);
          // A personal-room marker drains prior packets without timing-based absence checks.
          const barriers = [b1, b2].map((b) => waitForEvent(b, 'test:eviction-barrier'));
          namespace.to(`user:${bob.user.id}`).emit('test:eviction-barrier');
          await Promise.all(barriers);
          assert.deepEqual(formerEvents, [], 'former members receive neither removal, messages nor typing');
          const otherReceived = [b1, b2].map((b) => waitForEvent(b, 'typing:started'));
          assert.equal((await emitWithAck(a, 'typing:start', { conversationId: otherId })).error, null);
          for (const received of await Promise.all(otherReceived)) assert.equal(received.conversationId, otherId);
        } finally {
          sockets.forEach((socket) => socket.disconnect());
        }
      });
    });
  }
});
