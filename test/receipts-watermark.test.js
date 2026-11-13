'use strict';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789-abcdefghijkl';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789-abcdefghijkl';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { createTestPool } = require('./helpers/test-db');
const { createMessagesRepo } = require('../src/modules/messages/messages.repo');
const { createMessagesService } = require('../src/modules/messages/messages.service');

// Redis fake — receipts watermark path ke commands:
// eval (watermark Lua + rate-limit Lua), sadd/expire/smembers/get/srem.
function fakeReceiptRedis() {
  const strings = new Map(); // key -> { value, expiresAt }
  const sets = new Map();
  const counts = new Map();
  return {
    async eval(script, numKeys, key, arg1, arg2) {
      assert.equal(numKeys, 1);
      if (script.includes("redis.call('get', KEYS[1])")) {
        // Watermark advance (MAX) — sirf aage badhta hai.
        const cur = strings.get(key);
        const curVal = cur && cur.expiresAt > Date.now() ? Number(cur.value) : null;
        if (curVal === null || Number(arg1) > curVal) {
          strings.set(key, { value: String(arg1), expiresAt: Date.now() + Number(arg2) * 1000 });
          return 1;
        }
        return 0;
      }
      if (script.includes("redis.call('incr', KEYS[1])")) {
        // Rate limit INCR + first-time EXPIRE.
        const next = (counts.get(key) || 0) + 1;
        counts.set(key, next);
        return next;
      }
      throw new Error(`unexpected eval script: ${script}`);
    },
    async sadd(key, member) {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key).add(member);
      return 1;
    },
    async srem(key, ...members) {
      const s = sets.get(key);
      if (s) for (const m of members) s.delete(m);
      return 1;
    },
    async smembers(key) {
      const s = sets.get(key);
      return s ? [...s] : [];
    },
    async expire() { return 1; },
    async get(key) {
      const e = strings.get(key);
      if (!e) return null;
      if (e.expiresAt <= Date.now()) { strings.delete(key); return null; }
      return e.value;
    },
    async set(key, value, mode, seconds, nx) {
      assert.equal(mode, 'EX');
      if (nx === 'NX' && strings.has(key)) return null;
      strings.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
      return 'OK';
    },
    async del(key) {
      strings.delete(key);
      sets.delete(key);
      return 1;
    },
    async exists(key) { return (await this.get(key)) === null ? 0 : 1; },
  };
}

async function fixture(t, { withRedis = true } = {}) {
  const pool = await createTestPool();
  t.after(async () => { if (pool.end) await pool.end(); });
  const sender = { id: crypto.randomUUID(), sessionDeviceId: null, display_name: 'Sender', username: 'sender' };
  const recipient = { id: crypto.randomUUID(), sessionDeviceId: null, display_name: 'Recipient', username: 'recipient' };
  await pool.query(
    `INSERT INTO users (id, username, username_norm, email, email_norm, password_hash)
     VALUES ($1, 'sender', 'sender', 'sender@example.com', 'sender@example.com', 'x'),
            ($2, 'recipient', 'recipient', 'recipient@example.com', 'recipient@example.com', 'x')`,
    [sender.id, recipient.id]
  );
  const conversationId = crypto.randomUUID();
  await pool.query(`INSERT INTO conversations (id, kind) VALUES ($1, 'one_to_one')`, [conversationId]);
  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
    [conversationId, sender.id, recipient.id]
  );
  const repo = createMessagesRepo({ db: pool });
  const redis = withRedis ? fakeReceiptRedis() : null;
  const service = createMessagesService({
    db: pool,
    repo,
    contactsRepo: { async isBlocked() { return false; } },
    redis,
  });
  const send = async (user = sender) => {
    const { message } = await service.sendMessage(user, conversationId, {
      clientMessageId: crypto.randomUUID(),
      messageType: 'text',
      ciphertext: 'cipher',
      nonce: 'nonce',
      authTag: 'tag',
    });
    return message;
  };
  const receiptRow = async (messageId, userId) => {
    const res = await pool.query(
      'SELECT delivered_at, seen_at FROM message_receipts WHERE message_id = $1 AND user_id = $2',
      [messageId, userId]
    );
    return res.rows[0] || null;
  };
  return { pool, repo, redis, service, sender, recipient, conversationId, send, receiptRow };
}

test('receipts watermark: delivered DB turant nahi likhta, flush batch mein likhta hai', async (t) => {
  const { redis, service, recipient, conversationId, send, receiptRow } = await fixture(t);
  const message = await send();

  const res = await service.updateReceipt(recipient, message.id, 'delivered');
  assert.equal(res.receipt, 'delivered');

  // Redis watermark + dirty set hain, DB abhi nahi.
  assert.equal(await redis.get(`deliv:${conversationId}:${recipient.id}`), String(new Date(message.createdAt).getTime()));
  assert.deepEqual(await redis.smembers('dirty:receipts'), [`deliv:${conversationId}:${recipient.id}`]);
  assert.equal(await receiptRow(message.id, recipient.id), null, 'flush se pehle DB mein receipt nahi honi chahiye');

  const { flushed } = await service.flushReceiptWatermarks();
  assert.ok(flushed >= 1);
  const row = await receiptRow(message.id, recipient.id);
  assert.ok(row && row.delivered_at, 'flush ke baad delivered_at set hona chahiye');
  assert.equal(row.seen_at, null, 'delivered receipt seen_at set nahi karta');
  assert.deepEqual(await redis.smembers('dirty:receipts'), [], 'processed dirty entries clear honi chahiye');
});

test('receipts watermark: seen flush par delivered_at + seen_at dono set karta hai', async (t) => {
  const { service, recipient, send, receiptRow } = await fixture(t);
  const message = await send();

  await service.updateReceipt(recipient, message.id, 'seen');
  await service.flushReceiptWatermarks();

  const row = await receiptRow(message.id, recipient.id);
  assert.ok(row && row.delivered_at && row.seen_at, 'seen receipt dono timestamps set karta hai');
});

test('receipts watermark: watermark monotonic hai (purana receipt regress nahi karta)', async (t) => {
  const { redis, service, recipient, conversationId, send, receiptRow } = await fixture(t);
  const older = await send();
  await new Promise((r) => setTimeout(r, 20));
  const newer = await send();

  // Nayi message ka receipt pehle — watermark aage chala jata hai.
  await service.updateReceipt(recipient, newer.id, 'delivered');
  await service.flushReceiptWatermarks();
  const tsAfterFirst = await redis.get(`deliv:${conversationId}:${recipient.id}`);

  // Purani message ka receipt baad mein — watermark peeche nahi jaana chahiye.
  const res = await service.updateReceipt(recipient, older.id, 'delivered');
  assert.equal(res.receipt, 'delivered');
  assert.equal(await redis.get(`deliv:${conversationId}:${recipient.id}`), tsAfterFirst, 'watermark regress nahi hona chahiye');

  // Pehli flush ne purani message ko bhi cover kar liya tha (created_at <= ts).
  const row = await receiptRow(older.id, recipient.id);
  assert.ok(row && row.delivered_at, 'purana message watermark range mein covered hai');
});

test('receipts watermark: batch flush multiple conversations single pass mein', async (t) => {
  const { service, recipient, send, receiptRow } = await fixture(t);
  const m1 = await send();
  const m2 = await send();
  const m3 = await send();

  await service.updateReceipt(recipient, m1.id, 'delivered');
  await service.updateReceipt(recipient, m2.id, 'delivered');
  await service.updateReceipt(recipient, m3.id, 'seen');

  const { flushed } = await service.flushReceiptWatermarks();
  assert.ok(flushed >= 2, 'ek flush mein multiple receipts');

  const r1 = await receiptRow(m1.id, recipient.id);
  const r3 = await receiptRow(m3.id, recipient.id);
  assert.ok(r1 && r1.delivered_at);
  assert.ok(r3 && r3.seen_at);
});

test('receipts fail-open: Redis ke baghair direct DB write (ticks nahi rukte)', async (t) => {
  const { service, recipient, send, receiptRow } = await fixture(t, { withRedis: false });
  const message = await send();

  await service.updateReceipt(recipient, message.id, 'delivered');
  const row = await receiptRow(message.id, recipient.id);
  assert.ok(row && row.delivered_at, 'Redis na ho to receipt turant DB mein jana chahiye');
});
