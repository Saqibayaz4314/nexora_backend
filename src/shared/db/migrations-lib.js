'use strict';

const fs = require('fs');
const path = require('path');

// Plain-SQL migration runner. Production (Heroku release phase) mein transactional,
// tests (pg-mem) mein non-transactional chalta hai.
// Migration files: migrations/<name>.up.sql and migrations/<name>.down.sql
const DEFAULT_DIR = path.join(__dirname, '..', '..', '..', 'migrations');

function listMigrations(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.up.sql'))
    .sort();
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedMigrations(client) {
  const res = await client.query('SELECT name FROM schema_migrations');
  return new Set(res.rows.map((r) => r.name));
}

async function runSql(client, sql) {
  await client.query(sql);
}

async function migrateUp(client, options = {}) {
  const dir = options.dir || DEFAULT_DIR;
  const transactional = options.transactional !== false;
  await ensureMigrationsTable(client);
  const applied = await appliedMigrations(client);
  const files = listMigrations(dir);
  const appliedNow = [];

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const run = async () => {
      await runSql(client, sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    };
    if (transactional) {
      await client.query('BEGIN');
      try {
        await run();
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    } else {
      await run();
    }
    appliedNow.push(file);
  }
  return appliedNow;
}

async function migrateDown(client, options = {}) {
  const dir = options.dir || DEFAULT_DIR;
  const transactional = options.transactional !== false;
  await ensureMigrationsTable(client);
  const res = await client.query('SELECT name FROM schema_migrations ORDER BY applied_at DESC LIMIT 1');
  if (res.rows.length === 0) {
    return [];
  }
  const name = res.rows[0].name;
  const downFile = name.replace(/\.up\.sql$/, '.down.sql');
  const downPath = path.join(dir, downFile);
  if (!fs.existsSync(downPath)) {
    throw new Error(`Down migration nahi mili: ${downFile}`);
  }
  const sql = fs.readFileSync(downPath, 'utf8');
  const run = async () => {
    await runSql(client, sql);
    await client.query('DELETE FROM schema_migrations WHERE name = $1', [name]);
  };
  if (transactional) {
    await client.query('BEGIN');
    try {
      await run();
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } else {
    await run();
  }
  return [name];
}

module.exports = { migrateUp, migrateDown, DEFAULT_DIR };
