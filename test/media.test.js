'use strict';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789-abcdefghijkl';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789-abcdefghijkl';
process.env.MEDIA_UPLOAD_DIR = require('path').join(__dirname, '..', '.tmp-test-uploads');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');

const { createApp } = require('../src/app');
const { createTestPool, fakeMailer, uniqueIp } = require('./helpers/test-db');
const { runMediaCleanup } = require('../src/modules/media/media.cleanup');

const TMP_DIR = process.env.MEDIA_UPLOAD_DIR;

async function withApp(t, fn) {
  const pool = await createTestPool();
  const mailer = fakeMailer();
  const app = createApp({ pool, mailer });
  const objectStorage = app.locals.objectStorage;
  try {
    await fn({ app, pool, mailer, objectStorage });
  } finally {
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
const fwd = () => ({ 'X-Forwarded-For': uniqueIp() });

function cleanTmp() {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// Initiate + mock PUT + complete ka full happy path.
async function uploadMedia(app, pool, token, { mediaType = 'image', contentType = 'image/jpeg', bytes = Buffer.from('fake-jpeg-bytes') } = {}) {
  const initiated = await request(app)
    .post('/api/v1/media/upload-url')
    .set(auth(token))
    .set(fwd())
    .send({ mediaType, byteSize: bytes.length, contentType });
  assert.equal(initiated.status, 201, JSON.stringify(initiated.body));
  const { mediaId, uploadUrl } = initiated.body.data;

  const put = await request(app)
    .put(uploadUrl)
    .set('Content-Type', contentType)
    .send(bytes);
  assert.equal(put.status, 200, JSON.stringify(put.body));

  const complete = await request(app)
    .post(`/api/v1/media/${mediaId}/complete`)
    .set(auth(token))
    .set(fwd());
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  return { mediaId, initiated, complete };
}

test('media: initiate upload', async (t) => {
  await t.test('initiate → 201, server-generated key, local upload URL, pending row', async () => {
    cleanTmp();
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });

      const res = await request(app)
        .post('/api/v1/media/upload-url')
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ mediaType: 'image', byteSize: 1234, contentType: 'image/jpeg' });
      assert.equal(res.status, 201);
      assert.ok(res.body.data.mediaId);
      assert.ok(res.body.data.uploadUrl.includes('/api/v1/media/mock-upload/'));
      assert.equal(res.body.data.provider, 'local');
      assert.equal(res.body.data.status, 'pending');

      const row = await pool.query('SELECT s3_key, owner_user_id, status FROM media_objects WHERE id = $1', [
        res.body.data.mediaId,
      ]);
      assert.equal(row.rows[0].s3_key, `media/${alice.user.id}/${res.body.data.mediaId}`);
      assert.equal(row.rows[0].owner_user_id, alice.user.id);
      assert.equal(row.rows[0].status, 'pending');
    });
  });

  await t.test('size limit: image > 10MB → 400 MEDIA_TOO_LARGE', async () => {
    await withApp(t, async ({ app, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const res = await request(app)
        .post('/api/v1/media/upload-url')
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ mediaType: 'image', byteSize: 11 * 1024 * 1024, contentType: 'image/jpeg' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'MEDIA_TOO_LARGE');
    });
  });

  await t.test('content type mismatch → 400 INVALID_CONTENT_TYPE', async () => {
    await withApp(t, async ({ app, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const res = await request(app)
        .post('/api/v1/media/upload-url')
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ mediaType: 'image', byteSize: 100, contentType: 'application/pdf' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_CONTENT_TYPE');
    });
  });

  await t.test('bina token → 401', async () => {
    await withApp(t, async ({ app }) => {
      const res = await request(app)
        .post('/api/v1/media/upload-url')
        .set(fwd())
        .send({ mediaType: 'image', byteSize: 100, contentType: 'image/jpeg' });
      assert.equal(res.status, 401);
    });
  });
});

test('media: complete + download authz', async (t) => {
  await t.test('complete bina upload → 409; upload ke baad complete → ready with byteSize', async () => {
    cleanTmp();
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bytes = Buffer.from('hello-media-bytes');

      const initiated = await request(app)
        .post('/api/v1/media/upload-url')
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ mediaType: 'image', byteSize: bytes.length, contentType: 'image/jpeg' });
      const mediaId = initiated.body.data.mediaId;

      const beforeUpload = await request(app)
        .post(`/api/v1/media/${mediaId}/complete`)
        .set(auth(alice.accessToken))
        .set(fwd());
      assert.equal(beforeUpload.status, 409);
      assert.equal(beforeUpload.body.error.code, 'MEDIA_UPLOAD_MISSING');

      const put = await request(app)
        .put(initiated.body.data.uploadUrl)
        .set('Content-Type', 'image/jpeg')
        .send(bytes);
      assert.equal(put.status, 200);

      const complete = await request(app)
        .post(`/api/v1/media/${mediaId}/complete`)
        .set(auth(alice.accessToken))
        .set(fwd());
      assert.equal(complete.status, 200);
      assert.equal(complete.body.data.status, 'ready');
      assert.equal(complete.body.data.byteSize, bytes.length);

      // Idempotent complete.
      const again = await request(app)
        .post(`/api/v1/media/${mediaId}/complete`)
        .set(auth(alice.accessToken))
        .set(fwd());
      assert.equal(again.status, 200);
      assert.equal(again.body.data.alreadyCompleted, true);
    });
  });

  await t.test('size mismatch → 409 MEDIA_SIZE_MISMATCH', async () => {
    cleanTmp();
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const initiated = await request(app)
        .post('/api/v1/media/upload-url')
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ mediaType: 'image', byteSize: 1000, contentType: 'image/jpeg' });

      await request(app)
        .put(initiated.body.data.uploadUrl)
        .set('Content-Type', 'image/jpeg')
        .send(Buffer.from('only-17-bytes-here'));

      const complete = await request(app)
        .post(`/api/v1/media/${initiated.body.data.mediaId}/complete`)
        .set(auth(alice.accessToken))
        .set(fwd());
      assert.equal(complete.status, 409);
      assert.equal(complete.body.error.code, 'MEDIA_SIZE_MISMATCH');
    });
  });

  await t.test('download: owner ok, stranger 403, message-member ok, pending 403, delete ke baad 404', async () => {
    cleanTmp();
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const eve = await registerAndVerify(app, mailer, { username: 'eve_01', email: 'eve@example.com' });

      const { mediaId } = await uploadMedia(app, pool, alice.accessToken, {
        bytes: Buffer.from('secret-image-bytes'),
      });

      // Owner download-url (local provider).
      const ownerDl = await request(app)
        .get(`/api/v1/media/${mediaId}/download-url`)
        .set(auth(alice.accessToken));
      assert.equal(ownerDl.status, 200);
      assert.equal(ownerDl.body.data.provider, 'local');

      // Owner raw bytes.
      const ownerRaw = await request(app).get(`/api/v1/media/${mediaId}/raw`).set(auth(alice.accessToken));
      assert.equal(ownerRaw.status, 200);
      assert.equal(ownerRaw.headers['content-type'], 'image/jpeg');

      // Stranger (no message link) → 403.
      const stranger = await request(app)
        .get(`/api/v1/media/${mediaId}/download-url`)
        .set(auth(eve.accessToken));
      assert.equal(stranger.status, 403);
      assert.equal(stranger.body.error.code, 'MEDIA_ACCESS_DENIED');

      // Message-link: media alice→bob conversation ke message se linked → bob access kar sakta hai.
      const convId = crypto.randomUUID();
      await pool.query(`INSERT INTO conversations (id, kind) VALUES ($1, 'one_to_one')`, [convId]);
      await pool.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
        [convId, alice.user.id, bob.user.id]
      );
      const msgId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO messages (id, conversation_id, sender_user_id, message_type, ciphertext, nonce, auth_tag, media_id)
         VALUES ($1, $2, $3, 'image', 'cipher', 'nonce', 'tag', $4)`,
        [msgId, convId, alice.user.id, mediaId]
      );

      const bobDl = await request(app)
        .get(`/api/v1/media/${mediaId}/download-url`)
        .set(auth(bob.accessToken));
      assert.equal(bobDl.status, 200, JSON.stringify(bobDl.body));

      // Eve ab bhi deny (message member nahi).
      const eveAgain = await request(app)
        .get(`/api/v1/media/${mediaId}/download-url`)
        .set(auth(eve.accessToken));
      assert.equal(eveAgain.status, 403);

      // Delete: stranger 403, owner 200, phir download 404.
      const delByEve = await request(app).delete(`/api/v1/media/${mediaId}`).set(auth(eve.accessToken));
      assert.equal(delByEve.status, 403);
      assert.equal(delByEve.body.error.code, 'NOT_MEDIA_OWNER');

      const delByOwner = await request(app).delete(`/api/v1/media/${mediaId}`).set(auth(alice.accessToken));
      assert.equal(delByOwner.status, 200);
      assert.equal(delByOwner.body.data.deleted, true);

      const afterDelete = await request(app)
        .get(`/api/v1/media/${mediaId}/download-url`)
        .set(auth(alice.accessToken));
      assert.equal(afterDelete.status, 404);
      assert.equal(afterDelete.body.error.code, 'MEDIA_NOT_FOUND');
    });
  });

  await t.test('pending media ka download → 403 MEDIA_NOT_READY', async () => {
    cleanTmp();
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const initiated = await request(app)
        .post('/api/v1/media/upload-url')
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ mediaType: 'image', byteSize: 10, contentType: 'image/jpeg' });

      const dl = await request(app)
        .get(`/api/v1/media/${initiated.body.data.mediaId}/download-url`)
        .set(auth(alice.accessToken));
      assert.equal(dl.status, 403);
      assert.equal(dl.body.error.code, 'MEDIA_NOT_READY');
    });
  });
});

test('media: cleanup retention', async (t) => {
  await t.test('24h purana pending + 7 din purana deleted remove hote hain; fresh rows rehte hain', async () => {
    cleanTmp();
    await withApp(t, async ({ app, pool, mailer, objectStorage }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const userId = alice.user.id;

      async function insertMedia(overrides) {
        const id = crypto.randomUUID();
        const key = `media/${userId}/${id}`;
        await pool.query(
          `INSERT INTO media_objects (id, owner_user_id, s3_key, media_type, status, created_at, deleted_at)
           VALUES ($1, $2, $3, 'image', $4, $5, $6)`,
          [id, userId, key, overrides.status, overrides.createdAt, overrides.deletedAt || null]
        );
        return { id, key };
      }

      // Local files banate hain (cleanup unhe remove kare).
      const mkFile = async (key) => {
        const p = objectStorage.resolveLocalPath(key);
        await fs.promises.mkdir(path.dirname(p), { recursive: true });
        await fs.promises.writeFile(p, 'x');
      };

      const stalePending = await insertMedia({
        status: 'pending',
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      });
      await mkFile(stalePending.key);

      const staleDeleted = await insertMedia({
        status: 'ready',
        createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        deletedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      });
      await mkFile(staleDeleted.key);

      const freshPending = await insertMedia({
        status: 'pending',
        createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      });
      await mkFile(freshPending.key);

      const result = await runMediaCleanup({
        db: pool,
        repo: app.locals.mediaRepo,
        storage: objectStorage,
        logger: null,
      });
      assert.equal(result.removedPending, 1);
      assert.equal(result.removedDeleted, 1);

      const remaining = await pool.query('SELECT id FROM media_objects');
      assert.equal(remaining.rows.length, 1, 'sirf fresh row bachti hai');
      assert.equal(remaining.rows[0].id, freshPending.id);

      assert.equal(await objectStorage.localExists(stalePending.key), false);
      assert.equal(await objectStorage.localExists(staleDeleted.key), false);
      assert.equal(await objectStorage.localExists(freshPending.key), true);
    });
  });
});
