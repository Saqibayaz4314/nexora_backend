'use strict';

// FCM push dispatch abstraction.
// Production: firebase-admin + FIREBASE_SERVICE_ACCOUNT env (inline JSON ya file path)
// ya GOOGLE_APPLICATION_CREDENTIALS path.
// Dev fallback: log transport — push bheja nahi jata, sirf log hota hai.

const fs = require('fs');
const path = require('path');

// FIREBASE_SERVICE_ACCOUNT do forms accept karta hai:
//  1. Inline JSON string (Heroku config var ke liye asan)
//  2. JSON file ka path (local dev — file backend root mein rakhi ho)
// Real key content kabhi log/output mein nahi jata.
function loadServiceAccount(env) {
  const raw = (env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) return null;
  if (raw.startsWith('{')) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const filePath = path.isAbsolute(raw)
    ? raw
    : path.join(__dirname, '..', '..', '..', raw);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function createFcmDispatcher({ logger, env = process.env } = {}) {
  const log = logger || console;

  let admin = null;
  let messaging = null;
  let fcmReady = false;

  try {
    // firebase-admin optional dependency hai — installed nahi ho to log transport.
    // v12+ API: messaging alag submodule se aati hai, credentials top-level hain.
    // eslint-disable-next-line global-require
    admin = require('firebase-admin');
    // eslint-disable-next-line global-require
    const adminMessaging = require('firebase-admin/messaging');
    const hasCredentials = Boolean(env.GOOGLE_APPLICATION_CREDENTIALS || env.FIREBASE_SERVICE_ACCOUNT);
    if (hasCredentials) {
      if (admin.getApps().length === 0) {
        let credential = null;
        if (env.FIREBASE_SERVICE_ACCOUNT) {
          const sa = loadServiceAccount(env);
          if (sa) {
            credential = admin.cert(sa);
          } else {
            log.warn('FIREBASE_SERVICE_ACCOUNT set hai lekin JSON parse/file load fail — FCM log transport use ho raha hai');
          }
        } else {
          credential = admin.applicationDefault();
        }
        if (credential) admin.initializeApp({ credential });
      }
      fcmReady = admin.getApps().length > 0;
    }
    messaging = adminMessaging.getMessaging;
  } catch (err) {
    if (log.warn) {
      log.warn({ err: { message: err.message } }, 'firebase-admin available nahi — FCM log transport use ho raha hai');
    }
  }

  async function sendToDevice(pushToken, { title, body, data, dataOnly = false }) {
    if (!pushToken) {
      return { sent: false, reason: 'no_token' };
    }
    if (fcmReady && admin && messaging) {
      try {
        // dataOnly: notification block nahi — OS auto-display ki jagah app ka
        // Dart background handler chalta hai (local notification + delivered
        // receipt). WhatsApp-style ticks ke liye zaroori: app killed ho tab
        // bhi delivered receipt ja sake. Priority high taake doze mein defer na ho.
        const message = {
          token: pushToken,
          data: data || {},
        };
        if (!dataOnly) {
          message.notification = { title, body };
        } else {
          message.android = { priority: 'high' };
        }
        await messaging().send(message);
        return { sent: true };
      } catch (err) {
        if (log.warn) log.warn({ err: { message: err.message } }, 'FCM send failed');
        return { sent: false, reason: 'fcm_error' };
      }
    }
    if (log.info) log.info({ pushToken, title, body }, 'FCM (dev log transport) push');
    return { sent: false, reason: 'dev_transport' };
  }

  async function sendToUserDevices(pushTokens, payload) {
    const results = [];
    for (const token of pushTokens) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await sendToDevice(token, payload));
    }
    return results;
  }

  return {
    sendToDevice,
    sendToUserDevices,
    isReady: () => fcmReady,
  };
}

module.exports = { createFcmDispatcher, loadServiceAccount };
