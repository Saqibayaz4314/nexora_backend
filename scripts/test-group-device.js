'use strict';
// Local emulator interoperability smoke test. All synthetic credentials and
// X25519 private keys are generated in memory, never printed or persisted.
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { io } = require('socket.io-client');
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env'), quiet: true });
const base = 'http://127.0.0.1:5000/api/v1';
let pool;
let socket;
let timer;

async function main() {
  const recipientUsername = process.argv[2] || 'fcmtestb';
  pool = new Pool({ connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false } });
  const recipient = (await pool.query('SELECT id FROM users WHERE username_norm = $1', [recipientUsername])).rows[0];
  if (!recipient) throw new Error('Test recipient not found');
  const userId = crypto.randomUUID();
  const username = `device_test_${crypto.randomBytes(5).toString('hex')}`;
  const password = crypto.randomBytes(24).toString('base64url');
  const keyPair = crypto.generateKeyPairSync('x25519');
  const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  const hash = await bcrypt.hash(password, 10);
  await pool.query(`INSERT INTO users (id, username, username_norm, email, email_norm, password_hash, display_name, email_verified_at)
    VALUES ($1,$2,$2,$3,$3,$4,'Device Test',now())`, [userId, username, `${username}@example.invalid`, hash]);
  const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: username, password, identityPublicKey: publicKey, platform: 'test', deviceName: 'ephemeral-device-test' }) });
  if (!login.ok) throw new Error(`Test login failed (${login.status})`);
  const loginBody = await login.json();
  const token = loginBody.data.accessToken;
  if (!token) throw new Error('Login response missing accessToken');
  async function api(path, method = 'GET', body) {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`API test failed (${response.status})`);
    return (await response.json()).data;
  }
  const group = await api('/conversations/groups', 'POST', { name: 'Device Smoke Group', memberUserIds: [recipient.id] });
  const conversationId = group.conversation.id;
  const members = (await api(`/conversations/${conversationId}/members`)).members;
  const memberKeys = Object.fromEntries(members.map(m => [m.userId, m.identityPublicKey]));
  function derivedKey(pub) {
    const raw = Buffer.from(pub, 'base64');
    assert.equal(raw.length, 32);
    const remote = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100','hex'), raw]), format: 'der', type: 'spki' });
    const shared = crypto.diffieHellman({ privateKey: keyPair.privateKey, publicKey: remote });
    return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from(`nexora-e2ee-conversation:${conversationId}`), 32));
  }
  function encrypt(text) {
    const recipients = {};
    for (const [id, pub] of Object.entries(memberKeys)) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey(pub), nonce);
      const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      recipients[id] = { c: bytes.toString('base64'), n: nonce.toString('base64'), t: cipher.getAuthTag().toString('base64') };
    }
    return { ciphertext: JSON.stringify({ v: 1, g: 1, r: recipients }), nonce: 'group', authTag: 'group' };
  }
  function decrypt(packed, senderId) {
    const mine = JSON.parse(packed).r[userId];
    if (!mine) throw new Error('Test recipient envelope missing');
    const cipher = crypto.createDecipheriv('aes-256-gcm', derivedKey(memberKeys[senderId]), Buffer.from(mine.n,'base64'));
    cipher.setAuthTag(Buffer.from(mine.t,'base64'));
    return Buffer.concat([cipher.update(Buffer.from(mine.c,'base64')), cipher.final()]).toString('utf8');
  }
  await new Promise((resolve, reject) => {
    socket = io('http://127.0.0.1:5000/v1', { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.once('connect', resolve);
    socket.once('connect_error', () => reject(new Error('Test socket connection failed')));
  });
  socket.on('message:received', async ({ message }) => {
    if (message.conversationId !== conversationId || message.senderUserId !== recipient.id) return;
    try {
      const plain = decrypt(message.ciphertext, message.senderUserId);
      if (message.messageType === 'text') {
        assert.ok(plain.length > 0);
        console.log('DEVICE_TO_NODE_GROUP_TEXT_OK');
      } else {
        const payload = JSON.parse(plain);
        const mediaKey = Buffer.from(payload.k, 'base64');
        assert.equal(mediaKey.length, 32);
        const info = await api(`/media/${message.mediaId}/download-url`);
        const download = await fetch(info.downloadUrl || `${base}/media/${message.mediaId}/raw`, {
          headers: info.downloadUrl ? {} : { Authorization: `Bearer ${token}` },
        });
        assert.ok(download.ok);
        const decipher = crypto.createDecipheriv('aes-256-gcm', mediaKey, Buffer.from(info.encryptionNonce, 'base64'));
        decipher.setAuthTag(Buffer.from(info.encryptionAuthTag, 'base64'));
        const bytes = Buffer.concat([decipher.update(Buffer.from(await download.arrayBuffer())), decipher.final()]);
        assert.ok(bytes.length > 0);
        console.log(`DEVICE_TO_NODE_GROUP_${message.messageType.toUpperCase()}_DECRYPT_OK`);
      }
    } catch (_) { console.log('DEVICE_TO_NODE_DECRYPT_FAILED'); }
  });
  socket.on('message:reacted', data => {
    if (data.conversationId !== conversationId || data.userId !== recipient.id) return;
    try { const packed = JSON.parse(data.reactionCiphertext); assert.ok(decrypt(packed.c, data.userId)); console.log('DEVICE_GROUP_REACTION_OK'); }
    catch (_) { console.log('DEVICE_GROUP_REACTION_FAILED'); }
  });
  socket.on('message:deleted', data => {
    if (data.conversationId === conversationId) console.log('DEVICE_GROUP_DELETE_EVENT_OK');
  });
  await api(`/conversations/${conversationId}/messages`, 'POST', { messageType: 'text', clientMessageId: crypto.randomUUID(), ...encrypt('Node se encrypted group test') });
  console.log(`LIVE_GROUP_CREATED ${conversationId}`);
  async function sendMedia(type, contentType, bytes, filename) {
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const tag = cipher.getAuthTag();
    const upload = await api('/media/upload-url', 'POST', { mediaType: type, byteSize: encrypted.length, contentType,
      encryptionNonce: nonce.toString('base64'), encryptionAuthTag: tag.toString('base64') });
    const uploadUrl = new URL(upload.uploadUrl, base).toString();
    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: encrypted });
    if (!put.ok) throw new Error(`API test upload failed (${put.status})`);
    await api(`/media/${upload.mediaId}/complete`, 'POST');
    await api(`/conversations/${conversationId}/messages`, 'POST', { messageType: type, mediaId: upload.mediaId,
      clientMessageId: crypto.randomUUID(), ...encrypt(JSON.stringify({ n: filename, k: key.toString('base64') })) });
    console.log(`NODE_TO_DEVICE_GROUP_${type.toUpperCase()}_SENT`);
  }
  // Synthetic 1-second WAV tone, not a microphone recording.
  const wav = Buffer.alloc(44 + 16000 * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
  for (let i = 0; i < 16000; i++) wav.writeInt16LE(Math.round(4000 * Math.sin(2 * Math.PI * 440 * i / 16000)), 44 + 2 * i);
  await sendMedia('audio', 'audio/wav', wav, 'Synthetic voice playback test.wav');
  await new Promise(resolve => { timer = setTimeout(resolve, 600000); });
  console.log('DEVICE_SMOKE_MONITOR_FINISHED');
}
main().catch(error => {
  const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : error.name;
  const safeMessage = /^(Test |Login response|API test|Test recipient)/.test(error.message) ? error.message : '';
  console.error('DEVICE_SMOKE_FAILED', code, safeMessage);
  if (error.name === 'TypeError') console.error(error.stack.split('\n').slice(1, 4).join('\n'));
  process.exitCode = 1;
}).finally(async () => {
  clearTimeout(timer);
  socket?.disconnect();
  await pool?.end();
});
