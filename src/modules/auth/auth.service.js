'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('../../config');
const logger = require('../../shared/logger');
const { AppError } = require('../../shared/errors');

const uuid = () => crypto.randomUUID();
const generateOpaqueToken = () => crypto.randomBytes(48).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function createAuthService({ db, repo, mailer }) {
  if (!repo) {
    throw new Error('auth service ko repo chahiye');
  }

  function ensureDb() {
    if (!db) {
      throw new AppError(503, 'DB_NOT_CONFIGURED', 'Service temporarily unavailable');
    }
  }

  function signAccessToken(userId, sessionId) {
    return jwt.sign(
      {
        sub: userId,
        sid: sessionId,
        jti: uuid(),
        typ: 'access',
      },
      config.jwtAccessSecret,
      { expiresIn: config.accessTokenTtlSeconds, algorithm: 'HS256' }
    );
  }

  function publicUser(user) {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.display_name,
      avatarKey: user.avatar_key,
      about: user.about,
      emailVerifiedAt: user.email_verified_at,
      discoverable: user.discoverable,
      createdAt: user.created_at,
    };
  }

  async function createSessionForUser({ userId, deviceName, platform, identityPublicKey }) {
    ensureDb();
    const deviceId = uuid();
    await repo.createDevice({ id: deviceId, userId, platform, deviceName, identityPublicKey });

    const familyId = uuid();
    const sessionId = uuid();
    const refreshToken = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + config.refreshTokenTtlSeconds * 1000);
    await repo.createSession({
      id: sessionId,
      userId,
      deviceId,
      tokenHash: hashToken(refreshToken),
      familyId,
      expiresAt,
    });
    return {
      sessionId,
      refreshToken,
      accessToken: signAccessToken(userId, sessionId),
      expiresIn: config.accessTokenTtlSeconds,
    };
  }

  async function issueEmailToken(userId, kind, ttlSeconds) {
    const token = generateOpaqueToken();
    await repo.createEmailToken({
      id: uuid(),
      userId,
      kind,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    });
    return token;
  }

  function ttlText(seconds) {
    const hours = Math.round(seconds / 3600);
    if (seconds < 3600) {
      const mins = Math.round(seconds / 60);
      return `${mins} minutes`;
    }
    return `${hours} hours`;
  }

  return {
    async register({ username, email, password, displayName, deviceName, platform, identityPublicKey }) {
      ensureDb();
      const usernameNorm = username.toLowerCase();
      const emailNorm = email.toLowerCase();

      if (await repo.usernameTaken(usernameNorm)) {
        throw new AppError(409, 'USERNAME_TAKEN', 'This username is already taken');
      }
      if (await repo.emailTaken(emailNorm)) {
        throw new AppError(409, 'EMAIL_TAKEN', 'This email is already registered');
      }

      const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
      const userId = uuid();
      await repo.createUser({
        id: userId,
        username,
        usernameNorm,
        email,
        emailNorm,
        passwordHash,
        displayName: displayName || username,
      });

      const session = await createSessionForUser({ userId, deviceName, platform, identityPublicKey });

      // Verification email best-effort: fail hone par registration fail nahi hoti,
      // user /auth/email/resend se dobara mangwa sakta hai.
      try {
        const token = await issueEmailToken(userId, 'email_verify', config.emailVerifyTokenTtlSeconds);
        await mailer.sendVerificationEmail({
          to: emailNorm,
          token,
          expiresInText: ttlText(config.emailVerifyTokenTtlSeconds),
        });
      } catch (err) {
        logger.error({ err: { message: err.message }, userId }, 'Verification email bhejne mein error');
      }

      const user = await repo.findUserById(userId);
      return {
        user: publicUser(user),
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresIn: session.expiresIn,
        sessionId: session.sessionId,
      };
    },

    async login({ identifier, password, deviceName, platform, identityPublicKey }) {
      ensureDb();
      const user = await repo.findUserByIdentifier(identifier);
      // Same generic error dono cases mein — email/user exist nahi karta yeh reveal nahi hota.
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
      }

      const session = await createSessionForUser({ userId: user.id, deviceName, platform, identityPublicKey });
      return {
        user: publicUser(user),
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresIn: session.expiresIn,
        sessionId: session.sessionId,
      };
    },

    async refresh(refreshToken) {
      ensureDb();
      const tokenHash = hashToken(refreshToken);
      const session = await repo.findSessionByTokenHash(tokenHash);

      if (!session) {
        throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Invalid refresh token');
      }
      if (session.revoked_at) {
        // Reuse detection: revoked token dobara use hua — poora family revoke.
        await repo.revokeFamilySessions(session.family_id);
        logger.warn({ userId: session.user_id, familyId: session.family_id }, 'Refresh token reuse detected — session family revoked');
        throw new AppError(401, 'REFRESH_TOKEN_REUSED', 'Refresh token reuse detected. Please log in again.');
      }
      if (new Date(session.expires_at) < new Date()) {
        throw new AppError(401, 'REFRESH_TOKEN_EXPIRED', 'Refresh token expired');
      }

      const user = await repo.findUserById(session.user_id);
      if (!user || user.deleted_at) {
        throw new AppError(401, 'ACCOUNT_UNAVAILABLE', 'Account unavailable');
      }

      // Rotation: purana token revoke, naya token same family mein.
      await repo.revokeSession(session.id);
      const newSessionId = uuid();
      const newRefreshToken = generateOpaqueToken();
      await repo.createSession({
        id: newSessionId,
        userId: session.user_id,
        deviceId: session.device_id,
        tokenHash: hashToken(newRefreshToken),
        familyId: session.family_id,
        expiresAt: new Date(Date.now() + config.refreshTokenTtlSeconds * 1000),
      });

      return {
        accessToken: signAccessToken(session.user_id, newSessionId),
        refreshToken: newRefreshToken,
        expiresIn: config.accessTokenTtlSeconds,
        sessionId: newSessionId,
      };
    },

    async logout(refreshToken) {
      ensureDb();
      const session = await repo.findSessionByTokenHash(hashToken(refreshToken));
      if (session && !session.revoked_at) {
        await repo.revokeSession(session.id);
      }
      // Idempotent: unknown/expired token par bhi success.
      return { success: true };
    },

    async verifyEmail(token) {
      ensureDb();
      const consumed = await repo.consumeEmailToken(hashToken(token), 'email_verify');
      if (!consumed) {
        throw new AppError(400, 'EMAIL_VERIFY_INVALID_OR_EXPIRED', 'Invalid, expired or already used verification code');
      }
      await repo.setEmailVerified(consumed.user_id);
      // Baaki pending verification tokens single-use flow ke liye hata do.
      await repo.deleteEmailTokens(consumed.user_id, 'email_verify');
      return { emailVerified: true };
    },

    async resendVerification(email) {
      ensureDb();
      const emailNorm = email.toLowerCase();
      const user = await repo.findUserByEmailNorm(emailNorm);
      // Account exist nahi karta ya already verified — same generic response (no reveal).
      if (user && !user.email_verified_at) {
        try {
          await repo.deleteEmailTokens(user.id, 'email_verify');
          const token = await issueEmailToken(user.id, 'email_verify', config.emailVerifyTokenTtlSeconds);
          await mailer.sendVerificationEmail({
            to: emailNorm,
            token,
            expiresInText: ttlText(config.emailVerifyTokenTtlSeconds),
          });
        } catch (err) {
          logger.error({ err: { message: err.message }, userId: user.id }, 'Resend verification email error');
        }
      }
      return { message: 'If the account exists and is not verified yet, a new verification email has been sent.' };
    },

    async forgotPassword(email) {
      ensureDb();
      const emailNorm = email.toLowerCase();
      const user = await repo.findUserByEmailNorm(emailNorm);
      // Account exist na kare tab bhi same response — email enumeration nahi.
      if (user) {
        try {
          await repo.deleteEmailTokens(user.id, 'password_reset');
          const token = await issueEmailToken(user.id, 'password_reset', config.passwordResetTokenTtlSeconds);
          await mailer.sendPasswordResetEmail({
            to: emailNorm,
            token,
            expiresInText: ttlText(config.passwordResetTokenTtlSeconds),
          });
        } catch (err) {
          logger.error({ err: { message: err.message }, userId: user.id }, 'Password reset email error');
        }
      }
      return { message: 'If an account with that email exists, a password reset email has been sent.' };
    },

    async resetPassword(token, password) {
      ensureDb();
      const consumed = await repo.consumeEmailToken(hashToken(token), 'password_reset');
      if (!consumed) {
        throw new AppError(400, 'RESET_TOKEN_INVALID_OR_EXPIRED', 'Invalid, expired or already used reset code');
      }
      const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
      await repo.updatePassword(consumed.user_id, passwordHash);
      // Password change ke baad saare sessions revoke — har device dobara login kare.
      await repo.revokeAllUserSessions(consumed.user_id);
      await repo.deleteEmailTokens(consumed.user_id, 'password_reset');
      return { success: true };
    },

    async getMe(userId) {
      ensureDb();
      const user = await repo.findUserById(userId);
      if (!user || user.deleted_at) {
        throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
      }
      return { user: publicUser(user) };
    },

    async deleteAccount(userId) {
      ensureDb();
      await repo.softDeleteUser(userId);
      await repo.revokeAllUserSessions(userId);
      // Username/email reserved rehte hain (soft-delete + unique constraints).
      return { success: true };
    },
  };
}

module.exports = { createAuthService, hashToken, generateOpaqueToken };
