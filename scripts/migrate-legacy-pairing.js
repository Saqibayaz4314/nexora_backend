'use strict';

// Legacy pairing → accounts/contacts migration.
// Usage: node scripts/migrate-legacy-pairing.js
// Requires: MONGO_URI (legacy data) + DATABASE_URL (Postgres target).
//
// Ye script REAL data par abhi test NAHI hua hai — local machine se Atlas Mongo
// unreachable hai. Production run se pehle staging par dry-run style verify karo.
// Idempotent-ish design: email_norm se skip check hota hai, conversations dedupe hote hain.

require('dotenv').config();
const crypto = require('crypto');
const { Pool } = require('pg');
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

if (!MONGO_URI) {
  console.error('[legacy-migrate] MONGO_URI set nahi hai.');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('[legacy-migrate] DATABASE_URL set nahi hai.');
  process.exit(1);
}

// Legacy Mongo models (schema same repo se)
const User = require('../src/models/User');
const Chat = require('../src/models/Chat');

const uuid = () => crypto.randomUUID();

function usernameFromEmail(email) {
  const prefix = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30);
  return prefix || 'user';
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('[legacy-migrate] Legacy MongoDB connected.');

  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });

  const stats = { users: 0, skippedUsers: 0, devices: 0, conversations: 0, members: 0 };

  const legacyUsers = await User.find({}).lean();
  console.log(`[legacy-migrate] Legacy users: ${legacyUsers.length}`);

  const emailToPgId = new Map();

  for (const u of legacyUsers) {
    const emailNorm = String(u.email || '').toLowerCase();
    if (!emailNorm) {
      stats.skippedUsers += 1;
      continue;
    }
    const exists = await pool.query('SELECT 1 FROM users WHERE email_norm = $1 LIMIT 1', [emailNorm]);
    if (exists.rows.length > 0) {
      stats.skippedUsers += 1;
      continue;
    }

    // Username: email prefix + dedupe suffix
    const base = usernameFromEmail(emailNorm);
    let username = base;
    let n = 1;
    while ((await pool.query('SELECT 1 FROM users WHERE username_norm = $1 LIMIT 1', [username])).rows.length > 0) {
      n += 1;
      username = `${base}_${n}`;
    }

    const userId = uuid();
    // Legacy passwords bcryptjs se hashed hain — direct compatible.
    const passwordHash = u.password || '';
    if (!passwordHash) {
      stats.skippedUsers += 1;
      console.warn(`[legacy-migrate] Skip (no password hash): ${emailNorm}`);
      continue;
    }

    await pool.query(
      `INSERT INTO users (id, username, username_norm, email, email_norm, password_hash, display_name, email_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [userId, username, username, u.email, emailNorm, passwordHash, String(u.name || username)]
    );
    // Legacy user-level X25519 public key device identity key ke taur par store hota hai.
    if (u.publicKey) {
      await pool.query(
        `INSERT INTO devices (id, user_id, platform, device_name, identity_public_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuid(), userId, 'legacy', 'Legacy device', u.publicKey]
      );
      stats.devices += 1;
    }
    emailToPgId.set(emailNorm, userId);
    stats.users += 1;
  }

  // Legacy chats → one-to-one conversations
  const legacyChats = await Chat.find({}).lean();
  console.log(`[legacy-migrate] Legacy chats: ${legacyChats.length}`);

  for (const chat of legacyChats) {
    const participants = (chat.participants || []).map((p) => String(p));
    const legacyById = new Map();
    for (const u of legacyUsers) {
      legacyById.set(String(u._id), u);
    }
    const pgIds = [];
    for (const pid of participants) {
      const lu = legacyById.get(pid);
      if (lu && emailToPgId.has(String(lu.email).toLowerCase())) {
        pgIds.push(emailToPgId.get(String(lu.email).toLowerCase()));
      }
    }
    if (pgIds.length < 2) {
      continue;
    }
    const [a, b] = pgIds.sort();

    // Dedupe: dono users ki existing one_to_one conversation hai to skip
    const existing = await pool.query(
      `SELECT cm.conversation_id
       FROM conversation_members cm
       WHERE cm.user_id = ANY($1::uuid[])
       GROUP BY cm.conversation_id
       HAVING count(*) = 2`,
      [[a, b]]
    );
    if (existing.rows.length > 0) {
      continue;
    }

    const conversationId = uuid();
    await pool.query(
      `INSERT INTO conversations (id, kind, created_by, created_at)
       VALUES ($1, 'one_to_one', $2, $3)`,
      [conversationId, a, chat.pairedAt || new Date()]
    );
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member')`,
      [conversationId, a]
    );
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member')`,
      [conversationId, b]
    );
    stats.conversations += 1;
    stats.members += 2;
  }

  await mongoose.disconnect();
  await pool.end();

  console.log('[legacy-migrate] Done:', JSON.stringify(stats));
}

main().catch((err) => {
  console.error(`[legacy-migrate] Failed: ${err.message}`);
  process.exit(1);
});
