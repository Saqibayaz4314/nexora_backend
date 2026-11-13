// Supabase storage E2E test — presigned PUT + HEAD + presigned GET + delete.
require('dotenv').config();
const config = require('../src/config');
const { createObjectStorage } = require('../src/shared/storage/object-storage');

(async () => {
  const storage = createObjectStorage({ config, logger: console });
  console.log('mode:', storage.mode);
  if (storage.mode !== 's3') { console.log('FAIL: not s3 mode'); process.exit(1); }

  const key = 'media/test/supabase-check.txt';
  const content = 'nexora supabase storage test ' + Date.now();

  const { uploadUrl } = await storage.initiateUpload({ key, contentType: 'text/plain' });
  console.log('presigned PUT url host:', new URL(uploadUrl).host);

  const putRes = await fetch(uploadUrl, { method: 'PUT', body: content, headers: { 'Content-Type': 'text/plain' } });
  console.log('PUT status:', putRes.status);
  if (putRes.status >= 300) { console.log('PUT body:', await putRes.text()); process.exit(1); }

  const head = await storage.headObject(key);
  console.log('HEAD:', JSON.stringify(head));
  if (!head.exists) { console.log('FAIL: object not found after upload'); process.exit(1); }

  const { downloadUrl } = await storage.getDownloadUrl(key, { expiresSeconds: 60 });
  const getRes = await fetch(downloadUrl);
  const got = await getRes.text();
  console.log('GET status:', getRes.status, '| match:', got === content);

  const del = await storage.deleteObject(key);
  console.log('deleted:', del);
  const headAfter = await storage.headObject(key);
  console.log('HEAD after delete:', JSON.stringify(headAfter));

  const ok = putRes.status < 300 && head.exists && got === content && del && !headAfter.exists;
  console.log(ok ? 'SUPABASE_STORAGE_OK' : 'SUPABASE_STORAGE_FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
