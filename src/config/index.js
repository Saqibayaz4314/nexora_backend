'use strict';

// Config module: environment loading + validation.
// Real secret values sirf env vars se aate hain — kabhi bhi code mein nahi likhe jaate.
// Isolated tests must not read local credentials or production service settings.
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config();
}

const env = process.env;

function fail(message) {
  throw new Error(`[config] ${message}`);
}

const nodeEnv = env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';
const isTest = nodeEnv === 'test';

// JWT secrets: new canonical name (JWT_ACCESS_SECRET) with legacy fallback env (JWT_SECRET).
const jwtAccessSecret = env.JWT_ACCESS_SECRET || env.JWT_SECRET || '';
if (jwtAccessSecret.length < 32) {
  fail('JWT_ACCESS_SECRET required hai (kam az kam 32 characters). Legacy JWT_SECRET bhi acceptable hai.');
}
const jwtRefreshSecret = env.JWT_REFRESH_SECRET || '';
if (jwtRefreshSecret.length < 32) {
  fail('JWT_REFRESH_SECRET required hai (kam az kam 32 characters) — legacy refresh endpoint isay use karta hai.');
}

const databaseUrl = env.DATABASE_URL || '';
if (isProd && !databaseUrl) {
  fail('DATABASE_URL production mein required hai.');
}

const redisUrl = env.REDIS_URL || '';
if (isProd && !redisUrl) {
  fail('REDIS_URL production mein required hai.');
}

// SMTP (Gmail initial provider). Values sirf env se.
const smtp = {
  host: env.SMTP_HOST || '',
  port: parseInt(env.SMTP_PORT || '587', 10),
  secure: env.SMTP_SECURE === 'true',
  user: env.SMTP_USER || '',
  pass: env.SMTP_PASS || '',
  from: env.SMTP_FROM || '',
};
const smtpConfigured = Boolean(smtp.host && smtp.user && smtp.pass);
if (isProd && !smtpConfigured) {
  fail('SMTP_HOST, SMTP_USER aur SMTP_PASS production mein required hain.');
}

const corsOrigins = (env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (isProd && corsOrigins.length === 0) {
  fail('CORS_ORIGINS production mein required hai (comma-separated allowed origins).');
}

// TURN (WebRTC relay) — sirf env se; client ke paas runtime mein
// GET /api/v1/calls/turn se aati hai, koi hardcoded credential nahi.
const turnUrls = (env.TURN_URLS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const turn = {
  urls: turnUrls,
  username: env.TURN_USERNAME || '',
  credential: env.TURN_CREDENTIAL || '',
};
const turnConfigured = Boolean(turnUrls.length > 0 && turn.username && turn.credential);

// Media storage: private S3 (DigitalOcean Spaces / S3-compatible) ya local fallback.
// Production mein complete private S3 configuration required hai; object-storage
// initialization missing settings par fail hoti hai, local disk par fallback nahi hota.
const mediaStorage = env.MEDIA_STORAGE || (isProd ? 's3' : 'local');
const spaces = {
  endpoint: env.SPACES_ENDPOINT || '',
  key: env.SPACES_KEY || '',
  secret: env.SPACES_SECRET || '',
  bucket: env.SPACES_BUCKET || '',
};
const spacesConfigured = Boolean(spaces.endpoint && spaces.key && spaces.secret && spaces.bucket);

// Per-type limits — server hi enforce karta hai (client values trust nahi hote).
const mediaLimits = {
  image: { maxBytes: 10 * 1024 * 1024, contentTypes: ['image/'] }, // 10 MB
  video: { maxBytes: 100 * 1024 * 1024, contentTypes: ['video/'] }, // 100 MB
  audio: { maxBytes: 20 * 1024 * 1024, contentTypes: ['audio/'] }, // 20 MB
  document: {
    maxBytes: 50 * 1024 * 1024, // 50 MB
    contentTypes: [
      'application/pdf', 'text/plain', 'text/csv',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/zip', 'application/x-zip-compressed',
    ],
  },
};

const config = {
  nodeEnv,
  isProd,
  isTest,
  port: parseInt(env.PORT || '5000', 10),
  databaseUrl,
  redisUrl,
  // Secure default; Heroku self-signed Redis needs an explicit, Redis-only opt-in.
  redisTlsRejectUnauthorized: env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false',
  jwtAccessSecret,
  jwtRefreshSecret,
  accessTokenTtlSeconds: parseInt(env.ACCESS_TOKEN_TTL_SECONDS || '900', 10), // 15 min
  refreshTokenTtlSeconds: parseInt(env.REFRESH_TOKEN_TTL_SECONDS || String(30 * 24 * 60 * 60), 10), // 30 days
  emailVerifyTokenTtlSeconds: parseInt(env.EMAIL_VERIFY_TOKEN_TTL_SECONDS || String(24 * 60 * 60), 10), // 24h
  passwordResetTokenTtlSeconds: parseInt(env.PASSWORD_RESET_TOKEN_TTL_SECONDS || String(30 * 60), 10), // 30 min
  bcryptRounds: parseInt(env.BCRYPT_ROUNDS || '12', 10),
  smtp,
  smtpConfigured,
  emailLinkBaseUrl: env.EMAIL_LINK_BASE_URL || '',
  corsOrigins,
  mediaStorage,
  spaces,
  spacesConfigured,
  mediaLimits,
  mediaPresignSeconds: parseInt(env.MEDIA_PRESIGN_SECONDS || '300', 10), // 5 min
  mediaUploadDir: env.MEDIA_UPLOAD_DIR || '',
  turn,
  turnConfigured,
  callRingTimeoutSeconds: parseInt(env.CALL_RING_TIMEOUT_SECONDS || '60', 10), // ringing kitni der tak
  callActiveTtlSeconds: parseInt(env.CALL_ACTIVE_TTL_SECONDS || String(2 * 60 * 60), 10), // active call max (busy detection)
  callMaxDurationSeconds: parseInt(env.CALL_MAX_DURATION_SECONDS || String(24 * 60 * 60), 10), // ongoing cleanup threshold
  statusTtlSeconds: parseInt(env.STATUS_TTL_SECONDS || String(24 * 60 * 60), 10), // status 24h expiry
  logLevel: env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  appName: env.APP_NAME || 'Nexora',
};

Object.freeze(config);
Object.freeze(config.smtp);

module.exports = config;
