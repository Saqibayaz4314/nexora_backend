'use strict';

const { z } = require('zod');

// Username: 3-32 chars, letters/digits/underscore/dot, dot/underscore start-end par nahi.
const usernameRegex = /^[a-zA-Z0-9_][a-zA-Z0-9_.]{1,30}[a-zA-Z0-9_]$/;
const passwordMin = 8;
const passwordMax = 128;

const registerSchema = z.object({
  body: z.object({
    username: z.string().trim().min(3).max(32).regex(usernameRegex, 'Invalid username format'),
    email: z.email().max(255),
    password: z.string().min(passwordMin).max(passwordMax),
    displayName: z.string().trim().max(100).optional(),
    deviceName: z.string().trim().max(128).optional(),
    platform: z.string().trim().max(32).optional(),
    // Base64 X25519 identity key — device row par store hoti hai (E2EE ECDH ke liye).
    identityPublicKey: z.string().trim().min(20).max(200).optional(),
  }),
});

const loginSchema = z.object({
  body: z.object({
    identifier: z.string().trim().min(1).max(255),
    password: z.string().min(1).max(passwordMax),
    deviceName: z.string().trim().max(128).optional(),
    platform: z.string().trim().max(32).optional(),
    identityPublicKey: z.string().trim().min(20).max(200).optional(),
  }),
});

const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(10).max(512),
  }),
});

const logoutSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(10).max(512),
  }),
});

const verifyEmailSchema = z.object({
  body: z.object({
    token: z.string().min(6).max(512),
  }),
});

const resendVerificationSchema = z.object({
  body: z.object({
    email: z.email().max(255),
  }),
});

const forgotPasswordSchema = z.object({
  body: z.object({
    email: z.email().max(255),
  }),
});

const resetPasswordSchema = z.object({
  body: z.object({
    token: z.string().min(6).max(512),
    password: z.string().min(passwordMin).max(passwordMax),
  }),
});

module.exports = {
  usernameRegex,
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
};
