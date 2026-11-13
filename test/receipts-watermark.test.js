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

async function fixture(t, { withRedis = true, getIo = null } = {}) {
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
    getIo,
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

test('receipts: seen flush par reader ko receipts:updated event milta hai (unread badge clear)', async (t) => {
  const emitted = [];
  const getIo = () => ({
    to(room) {
      return { emit(event, payload) { emitted.push({ room, event, payload }); } };
    },
  });
  const { service, recipient, conversationId, send } = await fixture(t, { getIo });
  const message = await send();

  await service.updateReceipt(recipient, message.id, 'seen');
  emitted.length = 0; // updateReceipt ke message:seen emit ko ignore karo
  await service.flushReceiptWatermarks();

  const events = emitted.filter((e) => e.event === 'receipts:updated');
  assert.equal(events.length, 1, 'seen flush ke baad receipts:updated emit hona chahiye');
  assert.equal(events[0].room, `user:${recipient.id}`, 'reader ke user room par emit ho');
  assert.deepEqual(events[0].payload.conversationIds, [conversationId]);
});

test('receipts: delivered flush receipts:updated emit nahi karta (badge unchanged)', async (t) => {
  const emitted = [];
  const getIo = () => ({
    to(room) {
      return { emit(event, payload) { emitted.push({ room, event, payload }); } };
    },
  });
  const { service, recipient, send } = await fixture(t, { getIo });
  const message = await send();

  await service.updateReceipt(recipient, message.id, 'delivered');
  await service.flushReceiptWatermarks();

  assert.equal(emitted.filter((e) => e.event === 'receipts:updated').length, 0,
    'delivered flush unread badge change nahi karta — event nahi hona chahiye');
});

test('listMessages: viewer ke apne messages ka status receipts se (sent/delivered/seen)', async (t) => {
  const { repo, service, sender, recipient, conversationId, send } = await fixture(t);
  const m1 = await send(); // sender ka — seen (watermark purane messages ko bhi cover karta hai)
  await new Promise((r) => setTimeout(r, 20));
  const m2 = await send(); // sender ka — delivered
  await new Promise((r) => setTimeout(r, 20));
  const m3 = await send(); // sender ka — koi receipt nahi
  const m4 = await send(recipient); // recipient ka — sender ne nahi dekha

  await service.updateReceipt(recipient, m1.id, 'seen');
  await service.updateReceipt(recipient, m2.id, 'delivered');
  await service.flushReceiptWatermarks();

  // Sender ka view: apne messages par status, doosron ke messages par nahi.
  const rows = await repo.listMessages(conversationId, null, 10, null, sender.id);
  const status = new Map(rows.map((r) => [r.id, r.status]));
  assert.equal(status.get(m1.id), 'seen');
  assert.equal(status.get(m2.id), 'delivered');
  assert.equal(status.get(m3.id), 'sent');
  assert.equal(status.get(m4.id), undefined, 'doosron ke messages par status nahi');

  // Recipient ka view: apna message status ke saath.
  const recipientRows = await repo.listMessages(conversationId, null, 10, null, recipient.id);
  const recipientStatus = new Map(recipientRows.map((r) => [r.id, r.status]));
  assert.equal(recipientStatus.get(m4.id), 'sent', 'recipient ka apna message sent (sender ne nahi dekha)');
  assert.equal(recipientStatus.get(m1.id), undefined, 'recipient ke liye sender ke messages par status nahi');
});

test('read paths pending watermarks pehle flush karte hain: listMessages status stale nahi (blue tick regression fix)', async (t) => {
  const { service, sender, recipient, conversationId, send } = await fixture(t);
  const m1 = await send();
  // Recipient ne seen kiya — watermark Redis mein pending (flusher abhi
  // nahi chala), DB mein receipt nahi. Bina pre-flush ke reload par status
  // 'sent' parh leta (blue tick wapas gray ho jata tha).
  await service.updateReceipt(recipient, m1.id, 'seen');

  // Sender ka reload — service path (pre-flush included).
  const data = await service.listMessages(sender, conversationId, null, 10);
  const mine = data.messages.find((m) => m.id === m1.id);
  assert.equal(mine.status, 'seen', 'pending flush ke bawajood status seen');
});

test('read paths pending watermarks pehle flush karte hain: listMyConversations unread stale nahi (badge regression fix)', async (t) => {
  const { service, sender, recipient, conversationId, send } = await fixture(t);
  await send();
  await send();
  // Recipient ne chat khol kar sab seen kiya — watermark pending, DB flush
  // abhi nahi hua. List reload par unread 0 hona chahiye (stale badge fix).
  const convs = await service.listMyConversations(recipient, 20);
  const before = convs.conversations.find((c) => c.id === conversationId);
  // Pehle receipts bhejo (watermark advance) — pre-flush hi DB likhega.
  const data = await service.listMessages(recipient, conversationId, null, 10);
  for (const m of data.messages) {
    if (m.senderUserId !== recipient.id) {
      // eslint-disable-next-line no-await-in-loop
      await service.updateReceipt(recipient, m.id, 'seen');
    }
  }
  const after = await service.listMyConversations(recipient, 20);
  const conv = after.conversations.find((c) => c.id === conversationId);
  assert.equal(conv.unreadCount, 0, 'seen ke baad badge wapas nahi aana chahiye');
  assert.ok(before, 'conversation list mein conversation maujood');
});

test("listMessages: peer chat delete kare to bhi ticks preserve (sent-regression fallback)", async (t) => {
  const { pool, repo, service, sender, recipient, conversationId, send } = await fixture(t);

  const m1 = await send(); // seen hoga
  const m2 = await send(); // sirf delivered hoga
  const m3 = await send(); // receipt hi nahi
  await service.updateReceipt(recipient, m1.id, 'seen');
  await service.updateReceipt(recipient, m2.id, 'delivered');
  await service.flushReceiptWatermarks();

  // Ab recipient chat delete karta hai (left_at set) — uske baad member-based
  // query se status nahi milta (koi active doosra member nahi). Fallback
  // receipts se compute hona chahiye, warna sab ticks 'sent' dikhte the.
  await pool.query(
    'UPDATE conversation_members SET left_at = now() WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, recipient.id]
  );
  const rows = await repo.listMessages(conversationId, null, 10, null, sender.id);
  const status = new Map(rows.map((r) => [r.id, r.status]));
  assert.equal(status.get(m1.id), 'seen', 'chat delete ke baad bhi seen tick');
  assert.equal(status.get(m2.id), 'delivered', 'chat delete ke baad delivered tick');
  assert.equal(status.get(m3.id), 'sent', 'receipt ke baghair sent hi');
});
