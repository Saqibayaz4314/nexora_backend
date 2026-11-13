'use strict';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789-abcdefghijkl';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789-abcdefghijkl';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../src/app');
const { createTestPool } = require('./helpers/test-db');

test('health aur readiness endpoints', async (t) => {
  const pool = await createTestPool();
  const app = createApp({ pool });

  await t.test('GET /api/v1/health → 200 with requestId', async () => {
    const res = await request(app).get('/api/v1/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.error, null);
    assert.equal(res.body.data.status, 'ok');
    assert.ok(res.body.requestId);
  });

  await t.test('GET /api/v1/readiness → 200, postgres up, redis not_configured', async () => {
    const res = await request(app).get('/api/v1/readiness');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.dependencies.postgres, 'up');
    assert.equal(res.body.data.dependencies.redis, 'not_configured');
  });

  await t.test('X-Request-Id header echo hota hai', async () => {
    const res = await request(app).get('/api/v1/health').set('X-Request-Id', 'test-req-123');
    assert.equal(res.body.requestId, 'test-req-123');
  });

  await t.test('unknown route → 404 envelope', async () => {
    const res = await request(app).get('/api/v1/nonexistent');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'ROUTE_NOT_FOUND');
    assert.ok(res.body.requestId);
  });

  await pool.end();
});
