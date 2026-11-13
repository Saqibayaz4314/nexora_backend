'use strict';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789-abcdefghijkl';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789-abcdefghijkl';

const test = require('node:test');
const assert = require('node:assert/strict');
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

test('contact discovery', async (t) => {
  await t.test('exact username se discover (case-insensitive), email leak nahi hota', async () => {
    await withApp(t, async ({ app, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });

      const byUsername = await request(app)
        .post('/api/v1/contacts/discover')
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ query: 'BOB_01' });
      assert.equal(byUsername.status, 200);
      assert.equal(byUsername.body.data.users.length, 1);
      const found = byUsername.body.data.users[0];
      assert.equal(found.username, 'bob_01');
      assert.equal(found.email, undefined, 'email kabhi leak nahi hota');
      assert.equal(found.displayName, 'bob_01');
    });
  });

  await t.test('exact email se discover', async () => {
    await withApp(t, async ({ app, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });

      const byEmail = await request(app)
        .post('/api/v1/contacts/discover')
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ query: 'bob@example.com' });
      assert.equal(byEmail.status, 200);
      assert.equal(byEmail.body.data.users[0].username, 'bob_01');
    });
  });

  await t.test('self discover mein nahi aata', async () => {
    await withApp(t, async ({ app, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const res = await request(app)
        .post('/api/v1/contacts/discover')
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ query: 'alice_01' });
      assert.equal(res.body.data.users.length, 0);
    });
  });

  await t.test('hidden (discoverable=false) user discover nahi hota', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      await registerAndVerify(app, mailer, { username: 'hidden_01', email: 'hidden@example.com' });
      await pool.query("UPDATE users SET discoverable = false WHERE username_norm = 'hidden_01'");

      const res = await request(app)
        .post('/api/v1/contacts/discover')
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ query: 'hidden_01' });
      assert.equal(res.body.data.users.length, 0);
    });
  });

  await t.test('blocked user discover nahi hota (dono directions)', async () => {
    await withApp(t, async ({ app, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });

      await request(app)
        .post(`/api/v1/users/${bob.user.id}/block`)
        .set(auth(alice.accessToken))
        .set(fwd());

      const aliceSees = await request(app)
        .post('/api/v1/contacts/discover')
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ query: 'bob_01' });
      assert.equal(aliceSees.body.data.users.length, 0, 'blocker ko blocked user nahi dikhta');

      const bobSees = await request(app)
        .post('/api/v1/contacts/discover')
        .set(auth(bob.accessToken))
        .set(fwd())
        .send({ query: 'alice_01' });
      assert.equal(bobSees.body.data.users.length, 0, 'blocked user ko blocker nahi dikhta');
    });
  });

  await t.test('bina token discover → 401', async () => {
    await withApp(t, async ({ app }) => {
      const res = await request(app)
        .post('/api/v1/contacts/discover')
        .set(fwd())
        .send({ query: 'someone' });
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'UNAUTHORIZED');
    });
  });
});

test('contacts add/list/remove', async (t) => {
  await t.test('add → 201 created; duplicate add → 200 idempotent; nickname update', async () => {
    await withApp(t, async ({ app, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });

      const add = await request(app)
        .post(`/api/v1/contacts/${bob.user.id}`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ nickname: 'Bobby' });
      assert.equal(add.status, 201);
      assert.equal(add.body.data.contact.created, true);
      assert.equal(add.body.data.contact.nickname, 'Bobby');

      const dup = await request(app)
        .post(`/api/v1/contacts/${bob.user.id}`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ nickname: 'Bob2' });
      assert.equal(dup.status, 200);
      assert.equal(dup.body.data.contact.created, false);
      assert.equal(dup.body.data.contact.nickname, 'Bob2');

      const list = await request(app).get('/api/v1/contacts').set(auth(alice.accessToken));
      assert.equal(list.status, 200);
      assert.equal(list.body.data.contacts.length, 1);
      assert.equal(list.body.data.contacts[0].user.username, 'bob_01');
      assert.equal(list.body.data.contacts[0].nickname, 'Bob2');
    });
  });

  await t.test('remove → list khali; remove again idempotent', async () => {
    await withApp(t, async ({ app, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      await request(app).post(`/api/v1/contacts/${bob.user.id}`).set(auth(alice.accessToken)).set(fwd());

      const del = await request(app).delete(`/api/v1/contacts/${bob.user.id}`).set(auth(alice.accessToken));
      assert.equal(del.status, 200);
      assert.equal(del.body.data.removed, true);

      const again = await request(app).delete(`/api/v1/contacts/${bob.user.id}`).set(auth(alice.accessToken));
      assert.equal(again.status, 200);

      const list = await request(app).get('/api/v1/contacts').set(auth(alice.accessToken));
      assert.equal(list.body.data.contacts.length, 0);
    });
  });

  await t.test('self add → 400; nonexistent user → 404', async () => {
    await withApp(t, async ({ app, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });

      const self = await request(app)
        .post(`/api/v1/contacts/${alice.user.id}`)
        .set(auth(alice.accessToken))
        .set(fwd());
      assert.equal(self.status, 400);
      assert.equal(self.body.error.code, 'CANNOT_ADD_SELF');

      const ghost = await request(app)
        .post('/api/v1/contacts/00000000-0000-4000-8000-000000000000')
        .set(auth(alice.accessToken))
        .set(fwd());
      assert.equal(ghost.status, 404);
      assert.equal(ghost.body.error.code, 'USER_NOT_FOUND');
    });
  });

  await t.test('unverified account contacts use kar sakta hai (spec: sirf chat/call/status/group blocked)', async () => {
    await withApp(t, async ({ app, mailer }) => {
      const alice = await register(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const res = await request(app).get('/api/v1/contacts').set(auth(alice.accessToken));
      assert.equal(res.status, 200);
    });
  });
});

test('block/unblock', async (t) => {
  await t.test('block → 200; idempotent; unblock → 200; discover wapas dikhta hai', async () => {
    await withApp(t, async ({ app, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });

      const block = await request(app)
        .post(`/api/v1/users/${bob.user.id}/block`)
        .set(auth(alice.accessToken))
        .set(fwd());
      assert.equal(block.status, 200);
      assert.equal(block.body.data.blocked, true);

      const again = await request(app)
        .post(`/api/v1/users/${bob.user.id}/block`)
        .set(auth(alice.accessToken))
        .set(fwd());
      assert.equal(again.status, 200);

      const unblock = await request(app)
        .delete(`/api/v1/users/${bob.user.id}/block`)
        .set(auth(alice.accessToken));
      assert.equal(unblock.status, 200);
      assert.equal(unblock.body.data.blocked, false);

      const sees = await request(app)
        .post('/api/v1/contacts/discover')
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ query: 'bob_01' });
      assert.equal(sees.body.data.users.length, 1);
    });
  });

  await t.test('block self → 400; nonexistent → 404', async () => {
    await withApp(t, async ({ app, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });

      const self = await request(app)
        .post(`/api/v1/users/${alice.user.id}/block`)
        .set(auth(alice.accessToken))
        .set(fwd());
      assert.equal(self.status, 400);
      assert.equal(self.body.error.code, 'CANNOT_BLOCK_SELF');

      const ghost = await request(app)
        .post('/api/v1/users/00000000-0000-4000-8000-000000000000/block')
        .set(auth(alice.accessToken))
        .set(fwd());
      assert.equal(ghost.status, 404);
    });
  });
});

test('reports', async (t) => {
  await t.test('report → 201 reportId; self report → 400; nonexistent → 404', async () => {
    await withApp(t, async ({ app, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });

      const report = await request(app)
        .post('/api/v1/reports')
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ userId: bob.user.id, reason: 'spam', details: 'Repeated unwanted messages' });
      assert.equal(report.status, 201);
      assert.ok(report.body.data.reportId);

      const self = await request(app)
        .post('/api/v1/reports')
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ userId: alice.user.id, reason: 'spam' });
      assert.equal(self.status, 400);
      assert.equal(self.body.error.code, 'CANNOT_REPORT_SELF');

      const ghost = await request(app)
        .post('/api/v1/reports')
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ userId: '00000000-0000-4000-8000-000000000000', reason: 'spam' });
      assert.equal(ghost.status, 404);
    });
  });

  await t.test('bina token report → 401', async () => {
    await withApp(t, async ({ app }) => {
      const res = await request(app)
        .post('/api/v1/reports')
        .set(fwd())
        .send({ userId: '00000000-0000-4000-8000-000000000000', reason: 'spam' });
      assert.equal(res.status, 401);
    });
  });
});
