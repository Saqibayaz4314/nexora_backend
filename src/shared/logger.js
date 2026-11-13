'use strict';

const pino = require('pino');
const config = require('../config');

// Structured, safe logging: sensitive fields hamesha redact hote hain.
module.exports = pino({
  level: config.logLevel,
  redact: {
    paths: [
      'password',
      'pass',
      '*.password',
      '*.pass',
      'body.password',
      'body.token',
      'body.refreshToken',
      'body.accessToken',
      'body.ciphertext',
      'body.nonce',
      'body.authTag',
      'token',
      'accessToken',
      'refreshToken',
      'ciphertext',
      'authTag',
      'req.headers.authorization',
      'authorization',
      'smtpPass',
      'SMTP_PASS',
      'jwtAccessSecret',
      'jwtRefreshSecret',
    ],
    censor: '[REDACTED]',
  },
});
