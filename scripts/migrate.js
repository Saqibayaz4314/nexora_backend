'use strict';

// Migration runner: node scripts/migrate.js [up|down]
// Heroku release phase mein `npm run migrate:up` chalega.
require('dotenv').config();
const { Pool } = require('pg');
const { migrateUp, migrateDown } = require('../src/shared/db/migrations-lib');

const direction = process.argv[2] || 'up';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[migrate] DATABASE_URL set nahi hai.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1, ssl: { rejectUnauthorized: false } });
  try {
    if (direction === 'up') {
      const applied = await migrateUp(pool, { transactional: true });
      console.log(applied.length ? `[migrate] Applied: ${applied.join(', ')}` : '[migrate] Koi nayi migration nahi thi.');
    } else if (direction === 'down') {
      const reverted = await migrateDown(pool, { transactional: true });
      console.log(reverted.length ? `[migrate] Reverted: ${reverted.join(', ')}` : '[migrate] Koi migration applied nahi thi.');
    } else {
      console.error(`[migrate] Unknown direction: ${direction} (up|down)`);
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`[migrate] Failed: ${err.message}`);
  process.exit(1);
});
