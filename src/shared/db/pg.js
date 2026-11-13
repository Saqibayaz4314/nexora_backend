'use strict';

const { Pool } = require('pg');
const config = require('../../config');
const logger = require('../logger');

// PostgreSQL — primary source of truth. Pool lazily create hota hai.
let pool = null;

function getPool() {
  if (!config.databaseUrl) {
    return null;
  }
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      // Hosted Postgres (Heroku/Neon/Render style) SSL require karta hai —
      // bina SSL ke pg_hba reject (28000 "no encryption") deta hai.
      ssl: { rejectUnauthorized: false },
    });
    pool.on('error', (err) => {
      logger.error({ err: { message: err.message } }, 'pg pool idle client error');
    });
  }
  return pool;
}

async function pingPg() {
  if (!config.databaseUrl) {
    return { status: 'not_configured' };
  }
  const p = getPool();
  try {
    await p.query('SELECT 1');
    return { status: 'up' };
  } catch (err) {
    return { status: 'down', error: err.message };
  }
}

async function closePg() {
  if (pool) {
    try {
      await pool.end();
    } catch (err) {
      logger.warn({ err: { message: err.message } }, 'pg pool close error');
    }
    pool = null;
  }
}

module.exports = { getPool, pingPg, closePg };
