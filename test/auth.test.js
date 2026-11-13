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

function setup() {
  const pool = createTestPool();
  const mailer = fakeMailer();
  const app = createApp({ pool, mailer });
  return { app, pool, mailer };
}

// Har test case ko apna app + in-memory DB milta hai.
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

const registerBody = {
  username: 'sara_01',
  email: 'sara@example.com',
  password: 'strongPassword123',
  displayName: 'Sara',
  deviceName: 'Test Phone',
  platform: 'android',
};

async function registerUser(app, overrides = {}, ip) {
  return request(app)
    .post('/api/v1/auth/register')
    .set('X-Forwarded-For', ip || uniqueIp())
    .send({ ...registerBody, ...overrides });
}

test('registration flow', async (t) => {
  await t.test('successful register → 201, tokens, verification email', async () => {
    await withApp(t, async ({ app, mailer }) => {
      const res = await registerUser(app);
      assert.equal(res.status, 201);
      assert.equal(res.body.error, null);
      assert.equal(res.body.data.user.username, 'sara_01');
      assert.equal(res.body.data.user.email, 'sara@example.com');
      assert.equal(res.body.data.user.emailVerifiedAt, null);
      assert.ok(res.body.data.accessToken);
      assert.ok(res.body.data.refreshToken);
      assert.ok(res.body.data.sessionId);
      assert.ok(res.body.requestId);

      assert.equal(mailer.sent.length, 1);
      assert.equal(mailer.sent[0].type, 'email_verify');
      assert.equal(mailer.sent[0].to, 'sara@example.com');
      // 6-digit code (OTP) — user app mein enter karta hai.
      assert.match(mailer.sent[0].token, /^\d{6}$/);
    });
  });

  await t.test('duplicate username → 409 USERNAME_TAKEN', async () => {
    await withApp(t, async ({ app }) => {
      await registerUser(app);
      const res = await registerUser(app, { email: 'other@example.com' });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'USERNAME_TAKEN');
    });
  });

  await t.test('duplicate email → 409 EMAIL_TAKEN', async () => {
    await withApp(t, async ({ app }) => {
      await registerUser(app);
      const res = await registerUser(app, { username: 'different_user' });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'EMAIL_TAKEN');
    });
  });

  await t.test('invalid payload → 400 VALIDATION_ERROR', async () => {
    await withApp(t, async ({ app }) => {
      const res = await registerUser(app, { username: 'x', email: 'not-an-email', password: 'short' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
      assert.ok(Array.isArray(res.body.error.details));
    });
  });

  await t.test('username case-insensitive duplicate → 409', async () => {
    await withApp(t, async ({ app }) => {
      await registerUser(app);
      const res = await registerUser(app, { username: 'SARA_01', email: 'another@example.com' });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'USERNAME_TAKEN');
    });
  });
});

test('login flow', async (t) => {
  await t.test('login email se + login username se', async () => {
    await withApp(t, async ({ app }) => {
      await registerUser(app);

      const byEmail = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', uniqueIp())
        .send({ identifier: 'sara@example.com', password: 'strongPassword123' });
      assert.equal(byEmail.status, 200);
      assert.equal(byEmail.body.data.user.username, 'sara_01');
      assert.ok(byEmail.body.data.accessToken);
      assert.ok(byEmail.body.data.refreshToken);

      const byUsername = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', uniqueIp())
        .send({ identifier: 'SARA_01', password: 'strongPassword123' });
      assert.equal(byUsername.status, 200);
    });
  });

  await t.test('wrong password → 401 INVALID_CREDENTIALS', async () => {
    await withApp(t, async ({ app }) => {
      await registerUser(app);
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', uniqueIp())
        .send({ identifier: 'sara_01', password: 'wrongPassword123' });
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
    });
  });

  await t.test('unknown identifier → 401 same generic error', async () => {
    await withApp(t, async ({ app }) => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', uniqueIp())
        .send({ identifier: 'ghost_user', password: 'whatever123' });
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
    });
  });
});

test('email verification flow', async (t) => {
  await t.test('verify token → emailVerifiedAt set, token single-use', async () => {
    await withApp(t, async ({ app, mailer }) => {
      const reg = await registerUser(app);
      const token = mailer.sent[0].token;

      const verify = await request(app)
        .post('/api/v1/auth/email/verify')
        .set('X-Forwarded-For', uniqueIp())
        .send({ token });
      assert.equal(verify.status, 200);
      assert.equal(verify.body.data.emailVerified, true);

      const me = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${reg.body.data.accessToken}`);
      assert.equal(me.status, 200);
      assert.ok(me.body.data.user.emailVerifiedAt);

      // Same token dobara → 400
      const reuse = await request(app)
        .post('/api/v1/auth/email/verify')
        .set('X-Forwarded-For', uniqueIp())
        .send({ token });
      assert.equal(reuse.status, 400);
      assert.equal(reuse.body.error.code, 'EMAIL_VERIFY_INVALID_OR_EXPIRED');
    });
  });

  await t.test('invalid token → 400', async () => {
    await withApp(t, async ({ app }) => {
      const res = await request(app)
        .post('/api/v1/auth/email/verify')
        .set('X-Forwarded-For', uniqueIp())
        .send({ token: 'made-up-token-123' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'EMAIL_VERIFY_INVALID_OR_EXPIRED');
    });
  });

  await t.test('resend → naya email; verified user par koi email nahi', async () => {
    await withApp(t, async ({ app, mailer }) => {
      await registerUser(app);
      assert.equal(mailer.sent.length, 1);

      const resend = await request(app)
        .post('/api/v1/auth/email/resend')
        .set('X-Forwarded-For', uniqueIp())
        .send({ email: 'sara@example.com' });
      assert.equal(resend.status, 200);
      assert.equal(mailer.sent.length, 2);

      // Verify kar do, phir resend → no new email
      const token = mailer.sent[1].token;
      await request(app).post('/api/v1/auth/email/verify').set('X-Forwarded-For', uniqueIp()).send({ token });
      const afterVerify = await request(app)
        .post('/api/v1/auth/email/resend')
        .set('X-Forwarded-For', uniqueIp())
        .send({ email: 'sara@example.com' });
      assert.equal(afterVerify.status, 200);
      assert.equal(mailer.sent.length, 2);
    });
  });
});

test('refresh session rotation', async (t) => {
  await t.test('refresh → naya pair; purana token reuse → 401 + family revoked', async () => {
    await withApp(t, async ({ app }) => {
      const reg = await registerUser(app);
      const oldRefresh = reg.body.data.refreshToken;

      const refreshed = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: oldRefresh });
      assert.equal(refreshed.status, 200);
      assert.ok(refreshed.body.data.accessToken);
      const newRefresh = refreshed.body.data.refreshToken;
      assert.notEqual(newRefresh, oldRefresh);

      // Purana (revoked) token dobara use → reuse detection
      const reuse = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: oldRefresh });
      assert.equal(reuse.status, 401);
      assert.equal(reuse.body.error.code, 'REFRESH_TOKEN_REUSED');

      // Family revoke ho chuki — naya token bhi ab invalid
      const newTokenUse = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: newRefresh });
      assert.equal(newTokenUse.status, 401);
    });
  });

  await t.test('garbage refresh token → 401', async () => {
    await withApp(t, async ({ app }) => {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'garbage-token-value-1234567890' });
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_REFRESH_TOKEN');
    });
  });
});

test('logout flow', async (t) => {
  await t.test('logout → session revoked; refresh ab fail', async () => {
    await withApp(t, async ({ app }) => {
      const reg = await registerUser(app);
      const logout = await request(app)
        .post('/api/v1/auth/logout')
        .send({ refreshToken: reg.body.data.refreshToken });
      assert.equal(logout.status, 200);
      assert.equal(logout.body.data.success, true);

      const refresh = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: reg.body.data.refreshToken });
      assert.equal(refresh.status, 401);
    });
  });

  await t.test('logout unknown token par bhi idempotent 200', async () => {
    await withApp(t, async ({ app }) => {
      const res = await request(app)
        .post('/api/v1/auth/logout')
        .send({ refreshToken: 'unknown-token-value-1234567890' });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.success, true);
    });
  });
});

test('forgot/reset password flow', async (t) => {
  await t.test('reset → naya password login hota hai, purana nahi; token single-use', async () => {
    await withApp(t, async ({ app, mailer }) => {
      await registerUser(app);

      const forgot = await request(app)
        .post('/api/v1/auth/password/forgot')
        .set('X-Forwarded-For', uniqueIp())
        .send({ email: 'sara@example.com' });
      assert.equal(forgot.status, 200);
      assert.equal(mailer.sent.filter((m) => m.type === 'password_reset').length, 1);

      const token = mailer.sent.find((m) => m.type === 'password_reset').token;
      const reset = await request(app)
        .post('/api/v1/auth/password/reset')
        .send({ token, password: 'newStrongPassword456' });
      assert.equal(reset.status, 200);
      assert.equal(reset.body.data.success, true);

      const loginNew = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', uniqueIp())
        .send({ identifier: 'sara_01', password: 'newStrongPassword456' });
      assert.equal(loginNew.status, 200);

      const loginOld = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', uniqueIp())
        .send({ identifier: 'sara_01', password: 'strongPassword123' });
      assert.equal(loginOld.status, 401);

      // Token dobara → 400
      const reuse = await request(app)
        .post('/api/v1/auth/password/reset')
        .send({ token, password: 'anotherPassword789' });
      assert.equal(reuse.status, 400);
      assert.equal(reuse.body.error.code, 'RESET_TOKEN_INVALID_OR_EXPIRED');
    });
  });

  await t.test('forgot unknown email → 200 generic, koi email nahi (no enumeration)', async () => {
    await withApp(t, async ({ app, mailer }) => {
      const res = await request(app)
        .post('/api/v1/auth/password/forgot')
        .set('X-Forwarded-For', uniqueIp())
        .send({ email: 'nobody@example.com' });
      assert.equal(res.status, 200);
      assert.equal(mailer.sent.length, 0);
    });
  });
});

test('authz aur account deletion', async (t) => {
  await t.test('/auth/me bina token → 401; garbage token → 401', async () => {
    await withApp(t, async ({ app }) => {
      const noToken = await request(app).get('/api/v1/auth/me');
      assert.equal(noToken.status, 401);
      assert.equal(noToken.body.error.code, 'UNAUTHORIZED');

      const badToken = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer not-a-real-jwt');
      assert.equal(badToken.status, 401);
      assert.equal(badToken.body.error.code, 'TOKEN_INVALID_OR_EXPIRED');
    });
  });

  await t.test('account delete → me 401, login 401', async () => {
    await withApp(t, async ({ app }) => {
      const reg = await registerUser(app);
      const del = await request(app)
        .delete('/api/v1/auth/account')
        .set('Authorization', `Bearer ${reg.body.data.accessToken}`);
      assert.equal(del.status, 200);
      assert.equal(del.body.data.success, true);

      const me = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${reg.body.data.accessToken}`);
      assert.equal(me.status, 401);

      const login = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', uniqueIp())
        .send({ identifier: 'sara_01', password: 'strongPassword123' });
      assert.equal(login.status, 401);
      assert.equal(login.body.error.code, 'INVALID_CREDENTIALS');
    });
  });

  await t.test('unverified account login kar sakta hai (restrictions later stages mein)', async () => {
    await withApp(t, async ({ app }) => {
      await registerUser(app);
      const login = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', uniqueIp())
        .send({ identifier: 'sara@example.com', password: 'strongPassword123' });
      assert.equal(login.status, 200);
      assert.equal(login.body.data.user.emailVerifiedAt, null);
    });
  });
});
