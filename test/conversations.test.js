'use strict';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789-abcdefghijkl';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789-abcdefghijkl';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const crypto = require('crypto');

const { createApp } = require('../src/app');
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

async function register(app, mailer, { username, email, password = 'strongPassword123', identityPublicKey }) {
  const res = await request(app)
    .post('/api/v1/auth/register')
    .set('X-Forwarded-For', uniqueIp())
    .send({
      username,
      email,
      password,
      displayName: username,
      ...(identityPublicKey ? { identityPublicKey } : {}),
    });
  return res.body.data;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const fwd = () => ({ 'X-Forwarded-For': uniqueIp() });

const msgBody = () => ({
  messageType: 'text',
  ciphertext: 'ciphertext-placeholder',
  nonce: 'nonce-placeholder',
  authTag: 'authTag-placeholder',
});

test('conversations: hiding preserves membership and clears only my history', async (t) => {
  for (const [kind, role] of [['one_to_one', 'member'], ['group', 'owner'], ['group', 'admin'], ['group', 'member']]) {
    await t.test(`${kind}/${role}`, async () => {
      await withApp(t, async ({ app, pool, mailer }) => {
        const alice = await register(app, mailer, { username: 'alice_hidden', email: 'alice_hidden@example.com' });
        const bob = await register(app, mailer, { username: 'bob_hidden', email: 'bob_hidden@example.com' });
        const former = await register(app, mailer, { username: 'former_hidden', email: 'former_hidden@example.com' });
        const convId = crypto.randomUUID();
        await pool.query('INSERT INTO conversations (id, kind) VALUES ($1, $2)', [convId, kind]);
        await pool.query(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3), ($1, $4, 'member'), ($1, $5, 'member')`,
          [convId, alice.user.id, role, bob.user.id, former.user.id]);
        await pool.query('UPDATE conversation_members SET left_at = now(), hidden_at = now() WHERE conversation_id = $1 AND user_id = $2', [convId, former.user.id]);
        const send = () => request(app).post(`/api/v1/conversations/${convId}/messages`)
          .set(auth(bob.accessToken)).set(fwd()).send(msgBody());
        const old = await send();
        assert.equal(old.status, 201);
        const oldMessage = old.body.data.message;
        const oldCursor = app.locals.messagesRepo.encodeCursor(oldMessage.createdAt, oldMessage.id);
        const events = [];
        app.set('io', { to: (room) => ({ emit: (event, payload) => events.push({ room, event, payload }) }) });
        const hidden = await request(app).delete(`/api/v1/conversations/${convId}/self`)
          .set(auth(alice.accessToken)).set(fwd());
        assert.equal(hidden.status, 200);
        assert.deepEqual(events, [{ room: `user:${alice.user.id}`, event: 'conversation:hidden',
          payload: { userId: alice.user.id, conversationId: convId } }]);
        const membership = (await pool.query('SELECT role, left_at, hidden_at, history_cleared_at FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, alice.user.id])).rows[0];
        assert.equal(membership.role, role);
        assert.equal(membership.left_at, null);
        assert.ok(membership.hidden_at);
        assert.ok(membership.history_cleared_at);
        // Exact-cutoff timestamps are cleared too; use deterministic DB timestamps.
        await pool.query('UPDATE messages SET created_at = $2 WHERE id = $1', [oldMessage.id, membership.history_cleared_at]);
        const list = await request(app).get('/api/v1/conversations').set(auth(alice.accessToken)).set(fwd());
        assert.equal(list.status, 200);
        assert.deepEqual(list.body.data.conversations, []);
        const history = await request(app).get(`/api/v1/conversations/${convId}/messages`).set(auth(alice.accessToken)).set(fwd());
        assert.equal(history.status, 200);
        assert.deepEqual(history.body.data.messages, []);
        assert.deepEqual(await app.locals.messagesRepo.listLastMessages([convId], alice.user.id), []);
        assert.deepEqual(await app.locals.messagesRepo.listUnreadCounts([convId], alice.user.id), []);
        const bobList = await request(app).get('/api/v1/conversations').set(auth(bob.accessToken)).set(fwd());
        assert.equal(bobList.body.data.conversations.length, 1);
        assert.ok(bobList.body.data.conversations[0].lastMessage);
        assert.ok((await app.locals.messagesRepo.listUserConversations(alice.user.id)).some((r) => r.conversation_id === convId));
        const incoming = await send();
        assert.equal(incoming.status, 201);
        const restored = (await pool.query('SELECT hidden_at, history_cleared_at, left_at FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, alice.user.id])).rows[0];
        assert.equal(restored.hidden_at, null);
        assert.equal(restored.left_at, null);
        assert.deepEqual(restored.history_cleared_at, membership.history_cleared_at);
        const formerRow = (await pool.query('SELECT hidden_at, left_at FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, former.user.id])).rows[0];
        assert.ok(formerRow.hidden_at);
        assert.ok(formerRow.left_at);
        const visible = await request(app).get('/api/v1/conversations').set(auth(alice.accessToken)).set(fwd());
        assert.equal(visible.status, 200);
        const conversation = visible.body.data.conversations[0];
        assert.equal(conversation.id, convId);
        assert.equal(conversation.myRole, role);
        assert.equal(conversation.unreadCount, 1);
        assert.equal(conversation.lastMessage.createdAt, incoming.body.data.message.createdAt);
        const after = await request(app).get(`/api/v1/conversations/${convId}/messages?limit=1`).set(auth(alice.accessToken)).set(fwd());
        assert.equal(after.status, 200);
        assert.deepEqual(after.body.data.messages.map((m) => m.id), [incoming.body.data.message.id]);
        assert.equal(after.body.data.nextCursor, null);
        const stale = await request(app).get(`/api/v1/conversations/${convId}/messages?cursor=${oldCursor}`).set(auth(alice.accessToken)).set(fwd());
        assert.equal(stale.status, 200);
        assert.deepEqual(stale.body.data.messages, []);
        const peerHistory = await request(app).get(`/api/v1/conversations/${convId}/messages`).set(auth(bob.accessToken)).set(fwd());
        assert.equal(peerHistory.body.data.messages.length, 2);
      });
    });
  }
});

test('conversations: empty list for new user', async (t) => {
  await withApp(t, async ({ app, mailer }) => {
    const alice = await register(app, mailer, { username: 'alice_c1', email: 'alice_c1@example.com' });
    const res = await request(app)
      .get('/api/v1/conversations')
      .set(auth(alice.accessToken))
      .set(fwd());
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.conversations, []);
  });
});

test('conversations: create one_to_one returns 201 + peer identity key', async (t) => {
  await withApp(t, async ({ app, mailer }) => {
    const pubKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
    const alice = await register(app, mailer, { username: 'alice_c2', email: 'alice_c2@example.com' });
    const bob = await register(app, mailer, {
      username: 'bob_c2',
      email: 'bob_c2@example.com',
      identityPublicKey: pubKey,
    });

    const res = await request(app)
      .post('/api/v1/conversations')
      .set(auth(alice.accessToken))
      .set(fwd())
      .send({ peerUserId: bob.user.id });

    assert.equal(res.status, 201);
    assert.equal(res.body.data.created, true);
    const conv = res.body.data.conversation;
    assert.equal(conv.kind, 'one_to_one');
    assert.equal(conv.peer.id, bob.user.id);
    assert.equal(conv.peer.username, 'bob_c2');
    assert.equal(conv.peer.identityPublicKey, pubKey);
    assert.equal(conv.unreadCount, 0);
    assert.equal(conv.lastMessage, null);
  });
});

test('conversations: create is get-or-create (idempotent, 200)', async (t) => {
  await withApp(t, async ({ app, mailer }) => {
    const alice = await register(app, mailer, { username: 'alice_c3', email: 'alice_c3@example.com' });
    const bob = await register(app, mailer, { username: 'bob_c3', email: 'bob_c3@example.com' });

    const first = await request(app)
      .post('/api/v1/conversations')
      .set(auth(alice.accessToken))
      .set(fwd())
      .send({ peerUserId: bob.user.id });
    assert.equal(first.status, 201);

    const second = await request(app)
      .post('/api/v1/conversations')
      .set(auth(alice.accessToken))
      .set(fwd())
      .send({ peerUserId: bob.user.id });
    assert.equal(second.status, 200);
    assert.equal(second.body.data.created, false);
    assert.equal(second.body.data.conversation.id, first.body.data.conversation.id);
  });
});

test('conversations: list shows last message + unread count, receipt clears it', async (t) => {
  await withApp(t, async ({ app, mailer }) => {
    const alice = await register(app, mailer, { username: 'alice_c4', email: 'alice_c4@example.com' });
    const bob = await register(app, mailer, { username: 'bob_c4', email: 'bob_c4@example.com' });

    const created = await request(app)
      .post('/api/v1/conversations')
      .set(auth(alice.accessToken))
      .set(fwd())
      .send({ peerUserId: bob.user.id });
    const convId = created.body.data.conversation.id;

    // Bob message bhejta hai — alice ke liye unread 1.
    const sent = await request(app)
      .post(`/api/v1/conversations/${convId}/messages`)
      .set(auth(bob.accessToken))
      .set(fwd())
      .send(msgBody());
    assert.equal(sent.status, 201);
    const messageId = sent.body.data.message.id;

    const listForAlice = await request(app)
      .get('/api/v1/conversations')
      .set(auth(alice.accessToken))
      .set(fwd());
    assert.equal(listForAlice.status, 200);
    const conv = listForAlice.body.data.conversations.find((c) => c.id === convId);
    assert.equal(conv.unreadCount, 1);
    assert.equal(conv.lastMessage.messageType, 'text');
    assert.equal(conv.lastMessage.senderUserId, bob.user.id);

    // Alice seen receipt bhejti hai — unread 0 ho jata hai.
    const receipt = await request(app)
      .post(`/api/v1/messages/${messageId}/receipt`)
      .set(auth(alice.accessToken))
      .set(fwd())
      .send({ status: 'seen' });
    assert.equal(receipt.status, 200);

    const afterReceipt = await request(app)
      .get('/api/v1/conversations')
      .set(auth(alice.accessToken))
      .set(fwd());
    const convAfter = afterReceipt.body.data.conversations.find((c) => c.id === convId);
    assert.equal(convAfter.unreadCount, 0);
  });
});

test('conversations: self, unknown user, blocked — 400/404/403', async (t) => {
  await withApp(t, async ({ app, mailer }) => {
    const alice = await register(app, mailer, { username: 'alice_c5', email: 'alice_c5@example.com' });
    const bob = await register(app, mailer, { username: 'bob_c5', email: 'bob_c5@example.com' });

    const self = await request(app)
      .post('/api/v1/conversations')
      .set(auth(alice.accessToken))
      .set(fwd())
      .send({ peerUserId: alice.user.id });
    assert.equal(self.status, 400);
    assert.equal(self.body.error.code, 'CANNOT_CONVERSE_WITH_SELF');

    const unknown = await request(app)
      .post('/api/v1/conversations')
      .set(auth(alice.accessToken))
      .set(fwd())
      .send({ peerUserId: '00000000-0000-4000-8000-000000000000' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'USER_NOT_FOUND');

    // Bob alice ko block karta hai — alice conversation nahi bana sakti.
    const block = await request(app)
      .post(`/api/v1/users/${alice.user.id}/block`)
      .set(auth(bob.accessToken))
      .set(fwd());
    assert.equal(block.status, 200);

    const blocked = await request(app)
      .post('/api/v1/conversations')
      .set(auth(alice.accessToken))
      .set(fwd())
      .send({ peerUserId: bob.user.id });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'CANNOT_MESSAGE_USER');
  });
});

test('conversations: list respects membership (stranger ki conversation nahi dikhti)', async (t) => {
  await withApp(t, async ({ app, mailer }) => {
    const alice = await register(app, mailer, { username: 'alice_c6', email: 'alice_c6@example.com' });
    const bob = await register(app, mailer, { username: 'bob_c6', email: 'bob_c6@example.com' });
    const carol = await register(app, mailer, { username: 'carol_c6', email: 'carol_c6@example.com' });

    await request(app)
      .post('/api/v1/conversations')
      .set(auth(alice.accessToken))
      .set(fwd())
      .send({ peerUserId: bob.user.id });

    const carolList = await request(app)
      .get('/api/v1/conversations')
      .set(auth(carol.accessToken))
      .set(fwd());
    assert.equal(carolList.status, 200);
    assert.deepEqual(carolList.body.data.conversations, []);
  });
});
