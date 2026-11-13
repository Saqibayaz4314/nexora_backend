'use strict';

// Test helper: in-memory PostgreSQL (pg-mem) + migrations.
// Real Postgres ke sath same SQL chalega (scripts/migrate.js).

const { newDb } = require('pg-mem');
const { migrateUp } = require('../../src/shared/db/migrations-lib');

async function createTestPool() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const pgAdapter = db.adapters.createPg();
  const pool = new pgAdapter.Pool();
  await migrateUp(pool, { transactional: false });
  return pool;
}

function fakeMailer() {
  const sent = [];
  return {
    sent,
    async sendVerificationEmail(payload) {
      sent.push({ type: 'email_verify', ...payload });
    },
    async sendPasswordResetEmail(payload) {
      sent.push({ type: 'password_reset', ...payload });
    },
  };
}

// Rate limits ko bypass karne ke liye har request par unique IP.
let ipCounter = 0;
function uniqueIp() {
  ipCounter += 1;
  return `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

module.exports = { createTestPool, fakeMailer, uniqueIp };
