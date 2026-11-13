'use strict';
// Optional local-device interoperability check. Credentials and raw test key
// must be injected into the process environment; nothing sensitive is logged.
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

async function main() {
  const required = ['GROUP_TEST_TOKEN', 'GROUP_TEST_PRIVATE_KEY', 'GROUP_TEST_USER_ID', 'GROUP_TEST_SENDER_PUBLIC_KEY'];
  for (const name of required) {
    if (!process.env[name]) throw new Error(`Missing environment variable: ${name}`);
  }
  const conversationId = process.argv[2];
  if (!conversationId) throw new Error('Provide a conversation id');
  const base = process.env.GROUP_TEST_BASE_URL || 'http://127.0.0.1:5000/api/v1';
  const response = await fetch(`${base}/conversations/${encodeURIComponent(conversationId)}/messages`, {
    headers: { Authorization: `Bearer ${process.env.GROUP_TEST_TOKEN}` },
  });
  if (!response.ok) throw new Error(`History request failed (${response.status})`);
  const body = await response.json();
  const message = body.data.messages.find(m => m.nonce === 'group' &&
    (!process.env.GROUP_TEST_SENDER_ID || m.senderUserId === process.env.GROUP_TEST_SENDER_ID));
  if (!message) throw new Error('No group message found');
  const privateBytes = Buffer.from(process.env.GROUP_TEST_PRIVATE_KEY, 'base64');
  const publicBytes = Buffer.from(process.env.GROUP_TEST_SENDER_PUBLIC_KEY, 'base64');
  assert.equal(privateBytes.length, 32);
  assert.equal(publicBytes.length, 32);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), privateBytes]),
    format: 'der', type: 'pkcs8',
  });
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), publicBytes]),
    format: 'der', type: 'spki',
  });
  const shared = crypto.diffieHellman({ privateKey, publicKey });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0),
    Buffer.from(`nexora-e2ee-conversation:${conversationId}`), 32));
  const packed = JSON.parse(message.ciphertext);
  assert.equal(packed.v, 1);
  assert.equal(packed.g, 1);
  const mine = packed.r[process.env.GROUP_TEST_USER_ID];
  if (!mine) throw new Error('Recipient entry missing');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(mine.n, 'base64'));
  decipher.setAuthTag(Buffer.from(mine.t, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(mine.c, 'base64')), decipher.final()]).toString('utf8');
  if (process.argv[3]) assert.ok(plaintext.includes(process.argv[3]));
  console.log('GROUP_FANOUT_OK');
}
main().catch(error => {
  // Never dump HTTP bodies, tokens, key material or decrypted messages.
  console.error(error instanceof assert.AssertionError ? 'GROUP_FANOUT_ASSERTION_FAILED' : error.message);
  process.exitCode = 1;
});
