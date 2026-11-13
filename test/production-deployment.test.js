'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createObjectStorage } = require('../src/shared/storage/object-storage');

const ROOT = path.resolve(__dirname, '..');

function storageConfig(overrides = {}) {
  return {
    isProd: false,
    mediaStorage: 'local',
    spacesConfigured: false,
    spaces: {
      endpoint: 'https://storage.example.invalid',
      key: 'synthetic-access-key',
      secret: 'synthetic-secret-key',
      bucket: 'synthetic-bucket',
    },
    mediaPresignSeconds: 300,
    ...overrides,
  };
}

function syntheticEnv(nodeEnv) {
  // Deliberately do not inherit process.env, credentials, or NODE_OPTIONS.
  return {
    NODE_ENV: nodeEnv,
    LOG_LEVEL: 'silent',
    JWT_ACCESS_SECRET: 'synthetic-access-secret-0123456789-abcdef',
    JWT_REFRESH_SECRET: 'synthetic-refresh-secret-0123456789-abcdef',
    DATABASE_URL: 'postgres://fixture:fixture@db.example.invalid/fixture',
    SMTP_HOST: 'smtp.example.invalid',
    SMTP_USER: 'synthetic-user',
    SMTP_PASS: 'synthetic-password',
    CORS_ORIGINS: 'https://app.example.invalid',
    MEDIA_STORAGE: 's3',
    SPACES_ENDPOINT: 'https://storage.example.invalid',
    SPACES_KEY: 'synthetic-access-key',
    SPACES_SECRET: 'synthetic-secret-key',
    SPACES_BUCKET: 'synthetic-bucket',
  };
}

function runIsolated(source, env) {
  const script = `
    'use strict';
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const originalLoad = Module._load;
    // Production config calls dotenv; intercept it before loading any application
    // module so the real dotenv module and local .env are never read.
    Module._load = function (id, ...args) {
      if (id === 'dotenv') return { config: () => ({ parsed: {} }) };
      return originalLoad.call(this, id, ...args);
    };
    (async () => {
      ${source}
      process.stdout.write('regression-ok\\n');
    })().catch(() => {
      process.stderr.write('Isolated regression assertion failed\\n');
      process.exitCode = 1;
    });
  `;
  const result = spawnSync(process.execPath, ['--max-old-space-size=256', '-e', script], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 64 * 1024,
  });
  // Keep spawn arguments (including synthetic credential fixtures) out of diagnostics.
  assert.equal(Boolean(result.error), false, 'isolated subprocess must start and finish');
  assert.equal(result.signal, null, 'isolated subprocess must not be terminated');
  assert.equal(result.status, 0, 'isolated regression assertions must pass');
  assert.equal(result.stdout, 'regression-ok\n');
}

test('production storage rejects explicitly local mode even with Spaces configured', () => {
  assert.throws(
    () => createObjectStorage({ config: storageConfig({ isProd: true, spacesConfigured: true }) }),
    /Production media requires MEDIA_STORAGE=s3 and all SPACES_\* settings; local storage is disabled\./
  );
});

test('production storage rejects S3 with missing Spaces settings', () => {
  assert.throws(
    () => createObjectStorage({
      config: storageConfig({ isProd: true, mediaStorage: 's3', spaces: {}, spacesConfigured: false }),
    }),
    /Production media requires MEDIA_STORAGE=s3 and all SPACES_\* settings; local storage is disabled\./
  );
});

test('production storage accepts fully synthetic configured S3 without making requests', () => {
  const storage = createObjectStorage({
    config: storageConfig({ isProd: true, mediaStorage: 's3', spacesConfigured: true }),
  });
  // Only inspect synchronous metadata: never presign, upload, HEAD, GET, or delete.
  assert.equal(storage.mode, 's3');
  assert.equal(storage.isAvailable(), true);
});

test('development storage still permits local mode', () => {
  const storage = createObjectStorage({ config: storageConfig() });
  assert.equal(storage.mode, 'local');
  assert.equal(storage.isAvailable(), true);
});

function assertMockUploadBlocked(nodeEnv, mode) {
  runIsolated(`
    const express = require('express');
    const request = require('supertest');
    const config = require('./src/config');
    assert.equal(config.isProd, ${nodeEnv === 'production'});
    let rawParserCalls = 0;
    let resolverCalls = 0;
    const originalRaw = express.raw;
    express.raw = (...options) => {
      const parser = originalRaw(...options);
      return (req, res, next) => {
        rawParserCalls += 1;
        return parser(req, res, next);
      };
    };
    const { makeMediaRouter } = require('./src/modules/media/media.routes');
    const app = express();
    app.locals.objectStorage = {
      mode: ${JSON.stringify(mode)},
      resolveLocalPath() {
        resolverCalls += 1;
        throw new Error('Path resolver must not be reached');
      },
    };
    app.use('/api/v1/media', makeMediaRouter());
    const response = await request(app)
      .put('/api/v1/media/mock-upload/media/fixture-user/fixture-media')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('synthetic-upload-body'));
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    assert.equal(rawParserCalls, 0);
    assert.equal(resolverCalls, 0);
  `, { ...syntheticEnv(nodeEnv), REDIS_URL: 'redis://redis.example.invalid:6379' });
}

test('S3 mock-upload returns 404 before raw parsing or resolving a local path', () => {
  assertMockUploadBlocked('test', 's3');
});

test('production mock-upload rejects even injected local storage before raw parsing', () => {
  assertMockUploadBlocked('production', 'local');
});

test('production config startup rejects missing REDIS_URL without reading dotenv', () => {
  runIsolated(`
    assert.equal(Object.hasOwn(process.env, 'REDIS_URL'), false);
    assert.throws(
      () => require('./src/config'),
      { message: '[config] REDIS_URL production mein required hai.' }
    );
  `, syntheticEnv('production'));
});

test('Redis TLS options verify certificates by default and allow only explicit Redis opt-out', () => {
  runIsolated(`
    const { redisConnectionOptions } = require('./src/shared/redis');
    const secure = redisConnectionOptions({ redisUrl: 'rediss://redis.example.invalid:6379' });
    assert.equal(secure.tls.rejectUnauthorized, true);
    const heroku = redisConnectionOptions({
      redisUrl: 'rediss://redis.example.invalid:6379', redisTlsRejectUnauthorized: false,
    });
    assert.equal(heroku.tls.rejectUnauthorized, false);
    const local = redisConnectionOptions({ redisUrl: 'redis://localhost:6379' });
    assert.equal(Object.hasOwn(local, 'tls'), false);
    assert.equal(secure.enableOfflineQueue, false);
    assert.equal(secure.retryStrategy(100), 3000);
    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  `, syntheticEnv('test'));
});

test('production app does not expose legacy public media or disk uploads', () => {
  runIsolated(`
    const express = require('express');
    const request = require('supertest');
    let staticCalls = 0;
    express.static = () => {
      staticCalls += 1;
      return (_req, res) => res.status(200).send('unexpected-public-file');
    };
    const savedLoad = Module._load;
    Module._load = function (id, ...args) {
      if (id === 'ioredis') return class { on() { return this; } };
      return savedLoad.call(this, id, ...args);
    };
    const { createApp } = require('./src/app');
    const app = createApp({ pool: null, mailer: {} });
    assert.equal(staticCalls, 0);
    for (const route of ['/uploads/synthetic-file', '/api/media/upload-url']) {
      const response = route.includes('upload-url')
        ? await request(app).post(route).send({})
        : await request(app).get(route);
      assert.equal(response.status, 404);
    }
    const put = await request(app).put('/api/media/mock-upload/synthetic-file')
      .set('Content-Type', 'application/octet-stream').send(Buffer.from('synthetic-body'));
    assert.equal(put.status, 404);
  `, { ...syntheticEnv('production'), REDIS_URL: 'rediss://redis.example.invalid:6379' });
});

test('package-lock root Node engine matches the package Node 22 engine', () => {
  const pkg = require('../package.json');
  const lock = require('../package-lock.json');
  assert.equal(pkg.engines.node, '22.x');
  assert.equal(lock.packages[''].engines.node, pkg.engines.node);
});
