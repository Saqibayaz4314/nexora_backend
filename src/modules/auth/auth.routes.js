'use strict';

const express = require('express');

const { requireAuth } = require('./authz');
const { makeAuthController } = require('./auth.controller');
const { validate } = require('../../shared/validate');
const { asyncHandler } = require('../../shared/errors');
const { makeLimiter } = require('../../shared/rate-limit');
const schemas = require('./auth.schemas');

const loginLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyBy: (req) => `login:${req.ip}`,
});

const registerLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyBy: (req) => `register:${req.ip}`,
});

// Per-email + per-IP limits email endpoints par.
const emailLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyBy: (req) => {
    const email = req.body && typeof req.body.email === 'string' ? req.body.email.toLowerCase() : '';
    return `email:${email || 'none'}:${req.ip}`;
  },
});

// 6-digit code endpoints (verify/reset) — per-IP limit brute force rokta hai.
const codeLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyBy: (req) => `code:${req.ip}`,
});

function makeAuthRoutes() {
  const router = express.Router();
  const ctrl = makeAuthController();

  router.post('/register', registerLimiter, validate(schemas.registerSchema), asyncHandler(ctrl.register));
  router.post('/login', loginLimiter, validate(schemas.loginSchema), asyncHandler(ctrl.login));
  router.post('/refresh', validate(schemas.refreshSchema), asyncHandler(ctrl.refresh));
  router.post('/logout', validate(schemas.logoutSchema), asyncHandler(ctrl.logout));
  router.post('/email/verify', emailLimiter, codeLimiter, validate(schemas.verifyEmailSchema), asyncHandler(ctrl.verifyEmail));
  router.post('/email/resend', emailLimiter, validate(schemas.resendVerificationSchema), asyncHandler(ctrl.resendVerification));
  router.post('/password/forgot', emailLimiter, validate(schemas.forgotPasswordSchema), asyncHandler(ctrl.forgotPassword));
  router.post('/password/reset', codeLimiter, validate(schemas.resetPasswordSchema), asyncHandler(ctrl.resetPassword));
  router.get('/me', requireAuth, asyncHandler(ctrl.getMe));
  router.delete('/account', requireAuth, asyncHandler(ctrl.deleteAccount));

  return router;
}

module.exports = { makeAuthRoutes };
