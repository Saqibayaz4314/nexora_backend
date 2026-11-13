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

module.exports = { getRedis, pingRedis, closeRedis, redisConnectionOptions };
