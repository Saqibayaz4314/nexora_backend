'use strict';

// Temporary FCM credential test — dry-run (validateOnly) se credentials verify
// hote hain bina kisi device ko real push bheje. Ye script sirf test ke liye hai;
// output mein kabhi key content nahi jata (sirf project_id + result).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const admin = require('firebase-admin');
const { getMessaging } = require('firebase-admin/messaging');
const { loadServiceAccount } = require('../src/shared/push/fcm');

(async () => {
  const sa = loadServiceAccount(process.env);
  if (!sa) {
    console.error('RESULT: NO_CREDENTIALS — FIREBASE_SERVICE_ACCOUNT env ya file nahi mili');
    process.exit(1);
  }

  console.log('project_id:', sa.project_id);

  if (admin.getApps().length === 0) {
    admin.initializeApp({ credential: admin.cert(sa) });
  }

  try {
    // dryRun=true — FCM sirf validate karta hai, kuch send nahi hota.
    await getMessaging().send(
      {
        token: 'fake-token-for-dry-run-test',
        notification: { title: 'Nexora test', body: 'dry-run' },
      },
      true
    );
    console.log('RESULT: SUCCESS — credentials valid hain, FCM API auth ho gaya');
  } catch (err) {
    console.error('RESULT: FAILED —', (err && err.code) || '', ((err && err.message) || '').split('\n')[0]);
    process.exit(1);
  }
})();
