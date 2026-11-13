'use strict';

const Redis = require('ioredis');
const config = require('../config');
const logger = require('./logger');

// Redis abstraction — ephemeral state, rate limits, queues, Socket.IO scaling ke liye.
// Abhi sirf connection + health check; presence/caching later stages mein use hoga.
let client = null;

function redisConnectionOptions(settings) {
  const options = {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 200, 3000),
  };
  if (settings.redisUrl.startsWith('rediss://')) {
    options.tls = { rejectUnauthorized: settings.redisTlsRejectUnauthorized !== false };
  }
  return options;
}

function getRedis() {
  if (!config.redisUrl) {
    return null;
  }
  if (!client) {
    client = new Redis(config.redisUrl, redisConnectionOptions(config));
    client.on('error', (err) => {
      logger.warn({ err: { message: err.message } }, 'redis connection error');
    });
  }
  return client;
}

async function pingRedis() {
  if (!config.redisUrl) {
    return { status: 'not_configured' };
  }
  const c = getRedis();
  if (!c) {
    return { status: 'down', error: 'client not initialized' };
  }
  try {
    await c.ping();
    return { status: 'up' };
  } catch (err) {
    return { status: 'down', error: err.message };
  }
}

async function closeRedis() {
  if (client) {
    try {
      await client.quit();
    } catch (err) {
      logger.warn({ err: { message: err.message } }, 'redis close error');
    }
    client = null;
  }
}

// Best-effort wrapper — Redis configured na ho ya error aaye to null (fail-open).
// withClient: injected/test client ke saath; withRedis: global singleton ke saath.
async function withClient(c, fn) {
  if (!c) return null;
  try {
    return await fn(c);
  } catch (err) {
    logger.warn({ err: { message: err.message } }, 'redis call failed (fail-open)');
    return null;
  }
}

async function withRedis(fn) {
  return withClient(getRedis(), fn);
}

// Atomic NX claim with TTL — push dedup ke liye.
//   true  → key abhi nayi set hui (first claimer — action karo)
//   false → key pehle se thi (duplicate — skip karo)
// Redis error par bhi true (fail-open: dedup se zyada important hai push na rukna).
async function claimOnce(c, key, ttlSeconds) {
  if (!c) return true;
  try {
    const res = await c.set(key, '1', 'EX', ttlSeconds, 'NX');
    return res === 'OK';
  } catch (err) {
    logger.warn({ err: { message: err.message }, key }, 'redis claim failed (fail-open)');
    return true;
  }
}

// Atomic INCR + first-time EXPIRE — rate limiting ke liye.
// Lua script isliye: INCR aur EXPIRE ke beech crash par bina-TTL key nahi banti.
// Return: count (number) ya null (Redis na ho / error → fail-open, allow).
async function incrWithExpiry(c, key, ttlSeconds) {
  if (!c) return null;
  try {
    return await c.eval(
      "local c = redis.call('incr', KEYS[1]); if c == 1 then redis.call('expire', KEYS[1], ARGV[1]) end return c",
      1,
      key,
      String(ttlSeconds)
    );
  } catch (err) {
    logger.warn({ err: { message: err.message }, key }, 'redis rate limit failed (fail-open)');
    return null;
  }
}

// Receipts watermark advance (Lua MAX) — sirf aage badhta hai, peeche nahi.
// Return: 1 = advanced (SET hua), 0 = pehle se aage tha (no write), null = fail-open.
async function advanceWatermark(c, key, epochMs, ttlSeconds) {
  if (!c) return null;
  try {
    return await c.eval(
      "local cur = redis.call('get', KEYS[1]); if not cur or tonumber(ARGV[1]) > tonumber(cur) then redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2]); return 1 end return 0",
      1,
      key,
      String(epochMs),
      String(ttlSeconds)
    );
  } catch (err) {
    logger.warn({ err: { message: err.message }, key }, 'redis watermark advance failed (fail-open)');
    return null;
  }
}

module.exports = { getRedis, pingRedis, closeRedis, redisConnectionOptions, withRedis, withClient, claimOnce, incrWithExpiry, advanceWatermark };
