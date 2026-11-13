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
const { createStatusRepo } = require('../src/modules/status/status.repo');
const { createMediaRepo } = require('../src/modules/media/media.repo');
const { runStatusCleanup } = require('../src/modules/status/status.cleanup');
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

async function registerAndVerify(app, mailer, { username, email, password = 'strongPassword123' }) {
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .set('X-Forwarded-For', uniqueIp())
    .send({ username, email, password, displayName: username });
  const data = reg.body.data;
  const mail = mailer.sent.find((m) => m.type === 'email_verify' && m.to === email);
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

async function addContact(app, token, userId) {
  return request(app).post(`/api/v1/contacts/${userId}`).set(auth(token)).set(fwd()).send({ nickname: '' });
}

const statusBody = (overrides = {}) => ({
  captionCiphertext: 'caption-enc',
  captionNonce: 'nonce',
  captionAuthTag: 'tag',
  ...overrides,
});

const msgBody = (overrides = {}) => ({
  messageType: 'text',
  ciphertext: 'enc',
  nonce: 'nonce',
  authTag: 'tag',
  ...overrides,
});

async function insertMedia(pool, { id, ownerId, status = 'ready' }) {
  await pool.query(
    `INSERT INTO media_objects (id, owner_user_id, s3_key, media_type, content_type, status)
     VALUES ($1, $2, $3, 'image', 'image/jpeg', $4)`,
    [id, ownerId, `test/${id}.jpg`, status]
  );
}

test('status: create + list visibility', async (t) => {
  await t.test('text-only create → 201; media-linked create → 201; author list newest-first', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });

      const created = await request(app)
        .post('/api/v1/status')
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(statusBody());
      assert.equal(created.status, 201);
      const textStatus = created.body.data.status;
      assert.ok(textStatus.id);
      assert.equal(textStatus.authorUserId, alice.user.id);
      assert.equal(textStatus.captionCiphertext, 'caption-enc');
      assert.ok(textStatus.expiresAt);

      const mediaId = crypto.randomUUID();
      await insertMedia(pool, { id: mediaId, ownerId: alice.user.id });
      const mediaCreated = await request(app)
        .post('/api/v1/status')
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(statusBody({ mediaId, captionCiphertext: '' }));
      assert.equal(mediaCreated.status, 201);
      assert.equal(mediaCreated.body.data.status.mediaId, mediaId);

      const list = await request(app).get('/api/v1/status').set(auth(alice.accessToken)).set(fwd());
      assert.equal(list.status, 200);
      assert.equal(list.body.data.statuses.length, 2);
      // Newest first.
      assert.equal(list.body.data.statuses[0].id, mediaCreated.body.data.status.id);
    });
  });

  await t.test('stranger list empty; contact sees; blocked sees nothing', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });

      await request(app).post('/api/v1/status').set(auth(alice.accessToken)).set(fwd()).send(statusBody());

      // Stranger (contact nahi) → kuch nahi dikhta.
      const strangerList = await request(app).get('/api/v1/status').set(auth(bob.accessToken)).set(fwd());
      assert.equal(strangerList.status, 200);
      assert.equal(strangerList.body.data.statuses.length, 0);

      // Contact banne ke baad visible.
      const add = await addContact(app, alice.accessToken, bob.user.id);
      assert.equal(add.status, 201);
      const contactList = await request(app).get('/api/v1/status').set(auth(bob.accessToken)).set(fwd());
      assert.equal(contactList.status, 200);
      assert.equal(contactList.body.data.statuses.length, 1);

      // Block ke baad dobara hidden.
      const block = await request(app)
        .post(`/api/v1/users/${bob.user.id}/block`)
        .set(auth(alice.accessToken))
        .set(fwd());
      assert.equal(block.status, 200);
      const blockedList = await request(app).get('/api/v1/status').set(auth(bob.accessToken)).set(fwd());
      assert.equal(blockedList.body.data.statuses.length, 0);
    });
  });
});

test('status: expired excluded from list and get', async (t) => {
  await withApp(t, async ({ app, pool, mailer }) => {
    const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
    const expiredId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO status_posts (id, author_user_id, expires_at) VALUES ($1, $2, $3)`,
      [expiredId, alice.user.id, new Date(Date.now() - 60 * 1000)]
    );

    const list = await request(app).get('/api/v1/status').set(auth(alice.accessToken)).set(fwd());
    assert.equal(list.status, 200);
    assert.ok(!list.body.data.statuses.some((s) => s.id === expiredId));

    const got = await request(app).get(`/api/v1/status/${expiredId}`).set(auth(alice.accessToken)).set(fwd());
    assert.equal(got.status, 404);
    assert.equal(got.body.error.code, 'STATUS_NOT_FOUND');
  });
});

test('status: views idempotent + author view count', async (t) => {
  await withApp(t, async ({ app, pool, mailer }) => {
    const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
    const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
    await addContact(app, alice.accessToken, bob.user.id);

    const created = await request(app).post('/api/v1/status').set(auth(alice.accessToken)).set(fwd()).send(statusBody());
    const postId = created.body.data.status.id;

    const viewed = await request(app).post(`/api/v1/status/${postId}/views`).set(auth(bob.accessToken)).set(fwd());
    assert.equal(viewed.status, 200);
    assert.equal(viewed.body.data.viewed, true);

    // Idempotent — dobara mark karna error nahi.
    const viewedAgain = await request(app).post(`/api/v1/status/${postId}/views`).set(auth(bob.accessToken)).set(fwd());
    assert.equal(viewedAgain.status, 200);

    const authorView = await request(app).get(`/api/v1/status/${postId}`).set(auth(alice.accessToken)).set(fwd());
    assert.equal(authorView.status, 200);
    assert.equal(authorView.body.data.status.viewsCount, 1);
    assert.equal(authorView.body.data.status.views.length, 1);
    assert.equal(authorView.body.data.status.views[0].userId, bob.user.id);

    // Author khud ka view mark nahi kar sakta.
    const ownView = await request(app).post(`/api/v1/status/${postId}/views`).set(auth(alice.accessToken)).set(fwd());
    assert.equal(ownView.status, 400);
    assert.equal(ownView.body.error.code, 'CANNOT_VIEW_OWN_STATUS');
  });
});

test('status: reactions set + remove', async (t) => {
  await withApp(t, async ({ app, pool, mailer }) => {
    const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
    const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
    await addContact(app, alice.accessToken, bob.user.id);

    const created = await request(app).post('/api/v1/status').set(auth(alice.accessToken)).set(fwd()).send(statusBody());
    const postId = created.body.data.status.id;

    const reacted = await request(app)
      .put(`/api/v1/status/${postId}/reaction`)
      .set(auth(bob.accessToken))
      .set(fwd())
      .send({ reactionCiphertext: 'react-enc' });
    assert.equal(reacted.status, 200);

    const authorView = await request(app).get(`/api/v1/status/${postId}`).set(auth(alice.accessToken)).set(fwd());
    assert.equal(authorView.body.data.status.reactions.length, 1);
    assert.equal(authorView.body.data.status.reactions[0].userId, bob.user.id);

    const removed = await request(app)
      .delete(`/api/v1/status/${postId}/reaction`)
      .set(auth(bob.accessToken))
      .set(fwd());
    assert.equal(removed.status, 200);

    const after = await request(app).get(`/api/v1/status/${postId}`).set(auth(alice.accessToken)).set(fwd());
    assert.equal(after.body.data.status.reactions.length, 0);
  });
});

test('status: reply via message statusPostId', async (t) => {
  await t.test('valid reply sets statusPostId on message', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      await addContact(app, alice.accessToken, bob.user.id);
      const convId = await createConversation(pool, [alice.user.id, bob.user.id]);

      const created = await request(app).post('/api/v1/status').set(auth(alice.accessToken)).set(fwd()).send(statusBody());
      const postId = created.body.data.status.id;

      const sent = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(bob.accessToken))
        .set(fwd())
        .send(msgBody({ statusPostId: postId }));
      assert.equal(sent.status, 201);
      assert.equal(sent.body.data.message.statusPostId, postId);

      const row = await pool.query('SELECT status_post_id FROM messages WHERE id = $1', [
        sent.body.data.message.id,
      ]);
      assert.equal(row.rows[0].status_post_id, postId);
    });
  });

  await t.test('author khud ka statusPostId use nahi kar sakta; random uuid → 400', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const convId = await createConversation(pool, [alice.user.id, bob.user.id]);

      const created = await request(app).post('/api/v1/status').set(auth(alice.accessToken)).set(fwd()).send(statusBody());
      const postId = created.body.data.status.id;

      // Alice (author) apne hi status par reply → doosra member author nahi.
      const ownReply = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(msgBody({ statusPostId: postId }));
      assert.equal(ownReply.status, 400);
      assert.equal(ownReply.body.error.code, 'INVALID_STATUS_REPLY');

      // Random uuid → 400, koi message insert nahi hota.
      const before = await pool.query('SELECT COUNT(*)::int AS n FROM messages');
      const badReply = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(bob.accessToken))
        .set(fwd())
        .send(msgBody({ statusPostId: crypto.randomUUID() }));
      assert.equal(badReply.status, 400);
      assert.equal(badReply.body.error.code, 'INVALID_STATUS_REPLY');
      const after = await pool.query('SELECT COUNT(*)::int AS n FROM messages');
      assert.equal(after.rows[0].n, before.rows[0].n);
    });
  });

  await t.test('expired status par reply → 400', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const convId = await createConversation(pool, [alice.user.id, bob.user.id]);

      const expiredId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO status_posts (id, author_user_id, expires_at) VALUES ($1, $2, $3)`,
        [expiredId, alice.user.id, new Date(Date.now() - 60 * 1000)]
      );

      const sent = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(bob.accessToken))
        .set(fwd())
        .send(msgBody({ statusPostId: expiredId }));
      assert.equal(sent.status, 400);
      assert.equal(sent.body.error.code, 'INVALID_STATUS_REPLY');
    });
  });
});

test('status: delete authz + media soft-delete', async (t) => {
  await withApp(t, async ({ app, pool, mailer }) => {
    const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
    const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });

    const mediaId = crypto.randomUUID();
    await insertMedia(pool, { id: mediaId, ownerId: alice.user.id });
    const created = await request(app)
      .post('/api/v1/status')
      .set(auth(alice.accessToken))
      .set(fwd())
      .send(statusBody({ mediaId }));
    const postId = created.body.data.status.id;

    // Non-author delete → 403.
    const forbidden = await request(app).delete(`/api/v1/status/${postId}`).set(auth(bob.accessToken)).set(fwd());
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'NOT_STATUS_AUTHOR');

    // Author delete → 200, dobara get → 404, media soft-deleted.
    const deleted = await request(app).delete(`/api/v1/status/${postId}`).set(auth(alice.accessToken)).set(fwd());
    assert.equal(deleted.status, 200);
    const got = await request(app).get(`/api/v1/status/${postId}`).set(auth(alice.accessToken)).set(fwd());
    assert.equal(got.status, 404);
    const mediaRow = await pool.query('SELECT deleted_at FROM media_objects WHERE id = $1', [mediaId]);
    assert.ok(mediaRow.rows[0].deleted_at);
  });
});

test('status: cleanup expired posts + linked media, active untouched', async (t) => {
  await withApp(t, async ({ app, pool, mailer }) => {
    const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });

    const expiredId = crypto.randomUUID();
    const expiredMediaId = crypto.randomUUID();
    const activeId = crypto.randomUUID();

    await insertMedia(pool, { id: expiredMediaId, ownerId: alice.user.id });
    await pool.query(
      `INSERT INTO status_posts (id, author_user_id, media_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [expiredId, alice.user.id, expiredMediaId, new Date(Date.now() - 60 * 1000)]
    );
    await pool.query(
      `INSERT INTO status_posts (id, author_user_id, expires_at) VALUES ($1, $2, $3)`,
      [activeId, alice.user.id, new Date(Date.now() + 60 * 60 * 1000)]
    );

    const repo = createStatusRepo({ db: pool });
    const mediaRepo = createMediaRepo({ db: pool });
    const result = await runStatusCleanup({ db: pool, repo, mediaRepo, now: new Date() });
    assert.equal(result.removedPosts, 1);
    assert.equal(result.removedMedia, 1);

    const expiredRow = await pool.query('SELECT deleted_at FROM status_posts WHERE id = $1', [expiredId]);
    assert.ok(expiredRow.rows[0].deleted_at);
    const mediaRow = await pool.query('SELECT deleted_at FROM media_objects WHERE id = $1', [expiredMediaId]);
    assert.ok(mediaRow.rows[0].deleted_at);
    const activeRow = await pool.query('SELECT deleted_at FROM status_posts WHERE id = $1', [activeId]);
    assert.equal(activeRow.rows[0].deleted_at, null);

    // Second run → idempotent, kuch nahi milta.
    const second = await runStatusCleanup({ db: pool, repo, mediaRepo, now: new Date() });
    assert.equal(second.removedPosts, 0);
    assert.equal(second.removedMedia, 0);
  });
});
