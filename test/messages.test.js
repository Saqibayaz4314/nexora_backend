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

async function attachDevice(pool, userId) {
  const deviceId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO devices (id, user_id, platform, device_name) VALUES ($1, $2, 'test', 'test-device')`,
    [deviceId, userId]
  );
  await pool.query(
    `UPDATE user_sessions SET device_id = $1 WHERE user_id = $2 AND revoked_at IS NULL`,
    [deviceId, userId]
  );
  return deviceId;
}

const msgBody = (overrides = {}) => ({
  messageType: 'text',
  ciphertext: 'ciphertext-placeholder',
  nonce: 'nonce-placeholder',
  authTag: 'authTag-placeholder',
  ...overrides,
});

test('messages: send + list', async (t) => {
  await t.test('send → 201, message fields; list shows it (newest first)', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const convId = await createConversation(pool, [alice.user.id, bob.user.id]);
      await attachDevice(pool, alice.user.id);

      const send = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(msgBody({ clientMessageId: 'msg-001' }));
      assert.equal(send.status, 201);
      assert.equal(send.body.data.created, true);
      const message = send.body.data.message;
      assert.ok(message.id);
      assert.equal(message.senderUserId, alice.user.id);
      assert.equal(message.messageType, 'text');
      assert.equal(message.clientMessageId, 'msg-001');

      const list = await request(app)
        .get(`/api/v1/conversations/${convId}/messages`)
        .set(auth(bob.accessToken));
      assert.equal(list.status, 200);
      assert.equal(list.body.data.messages.length, 1);
      assert.equal(list.body.data.messages[0].id, message.id);
      assert.equal(list.body.data.nextCursor, null);
    });
  });

  await t.test('idempotency: same clientMessageId → 200, same message, DB mein single row', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const convId = await createConversation(pool, [alice.user.id, bob.user.id]);
      await attachDevice(pool, alice.user.id);

      const first = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(msgBody({ clientMessageId: 'dup-001' }));
      assert.equal(first.status, 201);

      const second = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(msgBody({ clientMessageId: 'dup-001' }));
      assert.equal(second.status, 200);
      assert.equal(second.body.data.created, false);
      assert.equal(second.body.data.message.id, first.body.data.message.id);

      const rows = await pool.query('SELECT COUNT(*)::int AS n FROM messages');
      assert.equal(rows.rows[0].n, 1);
    });
  });

  await t.test('non-member: send → 403, list → 403', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const eve = await registerAndVerify(app, mailer, { username: 'eve_01', email: 'eve@example.com' });
      const convId = await createConversation(pool, [alice.user.id, bob.user.id]);

      const send = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(eve.accessToken))
        .set(fwd())
        .send(msgBody());
      assert.equal(send.status, 403);
      assert.equal(send.body.error.code, 'NOT_CONVERSATION_MEMBER');

      const list = await request(app)
        .get(`/api/v1/conversations/${convId}/messages`)
        .set(auth(eve.accessToken));
      assert.equal(list.status, 403);
      assert.equal(list.body.error.code, 'NOT_CONVERSATION_MEMBER');
    });
  });

  await t.test('blocked user ko message nahi bhej sakte (dono directions)', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const convId = await createConversation(pool, [alice.user.id, bob.user.id]);
      await attachDevice(pool, alice.user.id);
      await attachDevice(pool, bob.user.id);

      await request(app)
        .post(`/api/v1/users/${bob.user.id}/block`)
        .set(auth(alice.accessToken))
        .set(fwd());

      const fromAlice = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(msgBody());
      assert.equal(fromAlice.status, 403);
      assert.equal(fromAlice.body.error.code, 'CANNOT_MESSAGE_USER');

      const fromBob = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(bob.accessToken))
        .set(fwd())
        .send(msgBody());
      assert.equal(fromBob.status, 403);
      assert.equal(fromBob.body.error.code, 'CANNOT_MESSAGE_USER');
    });
  });

  await t.test('bina token send → 401', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const convId = await createConversation(pool, [alice.user.id, bob.user.id]);

      const res = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(fwd())
        .send(msgBody());
      assert.equal(res.status, 401);
    });
  });
});

test('messages: edit + delete', async (t) => {
  await t.test('edit own → 200 editedAt; edit other → 403; edit deleted → 404', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const convId = await createConversation(pool, [alice.user.id, bob.user.id]);
      await attachDevice(pool, alice.user.id);

      const sent = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(msgBody());
      const messageId = sent.body.data.message.id;

      const edit = await request(app)
        .patch(`/api/v1/messages/${messageId}`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ ciphertext: 'edited-cipher', nonce: 'n2', authTag: 't2' });
      assert.equal(edit.status, 200);
      assert.ok(edit.body.data.message.editedAt);
      assert.equal(edit.body.data.message.ciphertext, 'edited-cipher');

      const byBob = await request(app)
        .patch(`/api/v1/messages/${messageId}`)
        .set(auth(bob.accessToken))
        .set(fwd())
        .send({ ciphertext: 'hack', nonce: 'n3', authTag: 't3' });
      assert.equal(byBob.status, 403);
      assert.equal(byBob.body.error.code, 'NOT_MESSAGE_SENDER');
    });
  });

  await t.test('delete own → 200, list se gayab, ciphertext wiped; delete other → 403', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const convId = await createConversation(pool, [alice.user.id, bob.user.id]);
      await attachDevice(pool, alice.user.id);

      const sent = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(msgBody());
      const messageId = sent.body.data.message.id;

      const byBob = await request(app).delete(`/api/v1/messages/${messageId}`).set(auth(bob.accessToken));
      assert.equal(byBob.status, 403);
      assert.equal(byBob.body.error.code, 'NOT_MESSAGE_SENDER');

      const del = await request(app).delete(`/api/v1/messages/${messageId}`).set(auth(alice.accessToken));
      assert.equal(del.status, 200);
      assert.equal(del.body.data.deleted, true);

      const list = await request(app)
        .get(`/api/v1/conversations/${convId}/messages`)
        .set(auth(bob.accessToken));
      assert.equal(list.body.data.messages.length, 0);

      const row = await pool.query('SELECT ciphertext FROM messages WHERE id = $1', [messageId]);
      assert.equal(row.rows[0].ciphertext, '', 'deleted message ka ciphertext wipe hota hai');
    });
  });
});

test('messages: reactions + receipts', async (t) => {
  await t.test('reaction put/remove; list mein reactions aate hain', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const convId = await createConversation(pool, [alice.user.id, bob.user.id]);
      await attachDevice(pool, alice.user.id);

      const sent = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(msgBody());
      const messageId = sent.body.data.message.id;

      const react = await request(app)
        .put(`/api/v1/messages/${messageId}/reaction`)
        .set(auth(bob.accessToken))
        .set(fwd())
        .send({ reactionCiphertext: 'emoji-cipher' });
      assert.equal(react.status, 200);

      const list = await request(app)
        .get(`/api/v1/conversations/${convId}/messages`)
        .set(auth(alice.accessToken));
      assert.equal(list.body.data.messages[0].reactions.length, 1);
      assert.equal(list.body.data.messages[0].reactions[0].userId, bob.user.id);

      const remove = await request(app)
        .delete(`/api/v1/messages/${messageId}/reaction`)
        .set(auth(bob.accessToken));
      assert.equal(remove.status, 200);

      const after = await request(app)
        .get(`/api/v1/conversations/${convId}/messages`)
        .set(auth(alice.accessToken));
      assert.equal(after.body.data.messages[0].reactions.length, 0);
    });
  });

  await t.test('receipt seen → 200 DB update; own message receipt → 400', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const convId = await createConversation(pool, [alice.user.id, bob.user.id]);
      await attachDevice(pool, alice.user.id);

      const sent = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(msgBody());
      const messageId = sent.body.data.message.id;

      const own = await request(app)
        .post(`/api/v1/messages/${messageId}/receipt`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ status: 'seen' });
      assert.equal(own.status, 400);
      assert.equal(own.body.error.code, 'CANNOT_RECEIPT_OWN_MESSAGE');

      const seen = await request(app)
        .post(`/api/v1/messages/${messageId}/receipt`)
        .set(auth(bob.accessToken))
        .set(fwd())
        .send({ status: 'seen' });
      assert.equal(seen.status, 200);

      const row = await pool.query(
        'SELECT seen_at FROM message_receipts WHERE message_id = $1 AND user_id = $2',
        [messageId, bob.user.id]
      );
      assert.ok(row.rows[0].seen_at, 'seen_at set hota hai');
    });
  });
});

test('messages: cursor pagination', async (t) => {
  await t.test('limit=2 → pages walk; invalid cursor → 400', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const convId = await createConversation(pool, [alice.user.id, bob.user.id]);

      // 5 messages oldest → newest
      const ids = [];
      for (let i = 1; i <= 5; i += 1) {
        const id = crypto.randomUUID();
        ids.push(id);
        await pool.query(
          `INSERT INTO messages
             (id, conversation_id, sender_user_id, message_type, ciphertext, nonce, auth_tag, created_at)
           VALUES ($1, $2, $3, 'text', $4, 'nonce', 'tag', $5)`,
          [id, convId, alice.user.id, `cipher-${i}`, new Date(Date.now() - (6 - i) * 60000).toISOString()]
        );
      }

      const page1 = await request(app)
        .get(`/api/v1/conversations/${convId}/messages?limit=2`)
        .set(auth(alice.accessToken));
      assert.equal(page1.body.data.messages.length, 2);
      assert.equal(page1.body.data.messages[0].ciphertext, 'cipher-5');
      assert.equal(page1.body.data.messages[1].ciphertext, 'cipher-4');
      assert.ok(page1.body.data.nextCursor);

      const page2 = await request(app)
        .get(`/api/v1/conversations/${convId}/messages?limit=2&cursor=${page1.body.data.nextCursor}`)
        .set(auth(alice.accessToken));
      assert.equal(page2.body.data.messages[0].ciphertext, 'cipher-3');
      assert.equal(page2.body.data.messages[1].ciphertext, 'cipher-2');
      assert.ok(page2.body.data.nextCursor);

      const page3 = await request(app)
        .get(`/api/v1/conversations/${convId}/messages?limit=2&cursor=${page2.body.data.nextCursor}`)
        .set(auth(alice.accessToken));
      assert.equal(page3.body.data.messages.length, 1);
      assert.equal(page3.body.data.messages[0].ciphertext, 'cipher-1');
      assert.equal(page3.body.data.nextCursor, null, 'akhri page par nextCursor null');

      const bad = await request(app)
        .get(`/api/v1/conversations/${convId}/messages?cursor=not-a-real-cursor`)
        .set(auth(alice.accessToken));
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error.code, 'INVALID_CURSOR');
    });
  });
});

test('devices: push token registration', async (t) => {
  await t.test('session device ke saath → 200; device_id NULL session → 400; doosre ki device → 403; unknown → 404', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });

      // Normal flow: register/login ne device create kiya hota hai — 200.
      const okRes = await request(app)
        .put('/api/v1/devices/push-token')
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ pushToken: 'fcm-token-abcdefghijklmnopqrstuvwxyz123456' });
      assert.equal(okRes.status, 200);
      assert.equal(okRes.body.data.registered, true);

      const row = await pool.query('SELECT push_token FROM devices WHERE user_id = $1', [alice.user.id]);
      assert.equal(row.rows[0].push_token, 'fcm-token-abcdefghijklmnopqrstuvwxyz123456');

      // Session ka device_id NULL ho (purana session) → 400 DEVICE_NOT_REGISTERED.
      await pool.query(
        `UPDATE user_sessions SET device_id = NULL WHERE user_id = $1 AND revoked_at IS NULL`,
        [bob.user.id]
      );
      const noDevice = await request(app)
        .put('/api/v1/devices/push-token')
        .set(auth(bob.accessToken))
        .set(fwd())
        .send({ pushToken: 'fcm-token-abcdefghijklmnopqrstuvwxyz123456' });
      assert.equal(noDevice.status, 400);
      assert.equal(noDevice.body.error.code, 'DEVICE_NOT_REGISTERED');

      const bobDevice = await attachDevice(pool, bob.user.id);
      const foreign = await request(app)
        .put('/api/v1/devices/push-token')
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ deviceId: bobDevice, pushToken: 'fcm-token-abcdefghijklmnopqrstuvwxyz123456' });
      assert.equal(foreign.status, 403);
      assert.equal(foreign.body.error.code, 'NOT_YOUR_DEVICE');

      const ghost = await request(app)
        .put('/api/v1/devices/push-token')
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ deviceId: '00000000-0000-4000-8000-000000000000', pushToken: 'fcm-token-abcdefghijklmnopqrstuvwxyz123456' });
      assert.equal(ghost.status, 404);
      assert.equal(ghost.body.error.code, 'DEVICE_NOT_FOUND');
    });
  });
});

test('messages: reaction fanout bounds', async (t) => {
  await withApp(t, async ({ app, pool, mailer }) => {
    const alice = await registerAndVerify(app, mailer, { username: 'alice_bounds', email: 'alice_bounds@example.com' });
    const convId = await createConversation(pool, [alice.user.id]);
    const sent = await request(app).post(`/api/v1/conversations/${convId}/messages`)
      .set(auth(alice.accessToken)).set(fwd()).send(msgBody());
    assert.equal(sent.status, 201);
    const messageId = sent.body.data.message.id;
    for (const size of [1001, 100000]) {
      const reactionCiphertext = 'r'.repeat(size);
      const res = await request(app).put(`/api/v1/messages/${messageId}/reaction`)
        .set(auth(alice.accessToken)).set(fwd()).send({ reactionCiphertext });
      assert.equal(res.status, 200);
      const row = await pool.query('SELECT reaction_ciphertext FROM message_reactions WHERE message_id = $1', [messageId]);
      assert.equal(row.rows[0].reaction_ciphertext, reactionCiphertext);
    }
    for (const reactionCiphertext of ['', 'r'.repeat(100001)]) {
      const res = await request(app).put(`/api/v1/messages/${messageId}/reaction`)
        .set(auth(alice.accessToken)).set(fwd()).send({ reactionCiphertext });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    }
    const row = await pool.query('SELECT reaction_ciphertext FROM message_reactions WHERE message_id = $1', [messageId]);
    assert.equal(row.rows[0].reaction_ciphertext.length, 100000);
  });
});

test('messages: former sender membership required for edit/delete', async (t) => {
  await withApp(t, async ({ app, pool, mailer }) => {
    const alice = await registerAndVerify(app, mailer, { username: 'alice_former', email: 'alice_former@example.com' });
    const convId = await createConversation(pool, [alice.user.id]);
    const sent = await request(app).post(`/api/v1/conversations/${convId}/messages`)
      .set(auth(alice.accessToken)).set(fwd()).send(msgBody());
    assert.equal(sent.status, 201);
    const messageId = sent.body.data.message.id;
    for (const removeRow of [false, true]) {
      if (removeRow) {
        await pool.query('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, alice.user.id]);
      } else {
        await pool.query('UPDATE conversation_members SET left_at = now() WHERE conversation_id = $1 AND user_id = $2', [convId, alice.user.id]);
      }
      const edit = await request(app).patch(`/api/v1/messages/${messageId}`)
        .set(auth(alice.accessToken)).set(fwd()).send({ ciphertext: 'changed', nonce: 'n', authTag: 't' });
      const del = await request(app).delete(`/api/v1/messages/${messageId}`)
        .set(auth(alice.accessToken)).set(fwd());
      for (const res of [edit, del]) {
        assert.equal(res.status, 403);
        assert.equal(res.body.error.code, 'NOT_CONVERSATION_MEMBER');
      }
    }
    const row = await pool.query('SELECT ciphertext, edited_at, deleted_at FROM messages WHERE id = $1', [messageId]);
    assert.equal(row.rows[0].ciphertext, msgBody().ciphertext);
    assert.equal(row.rows[0].edited_at, null);
    assert.equal(row.rows[0].deleted_at, null);
  });
});

test('messages: validation', async (t) => {
  await t.test('invalid messageType → 400 VALIDATION_ERROR', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const convId = await createConversation(pool, [alice.user.id, bob.user.id]);

      const res = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(msgBody({ messageType: 'sticker' }));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });
  });
});
