'use strict';

// Auth repository — PostgreSQL ke saare auth queries yahan hain.
// Never trust client-provided IDs; har query authenticated user ke context mein chalti hai.

function createAuthRepo({ db }) {
  const q = (text, params) => {
    if (!db) {
      const err = new Error('Database configured nahi hai');
      err.code = 'DB_NOT_CONFIGURED';
      throw err;
    }
    return db.query(text, params);
  };

  return {
    async findUserByIdentifier(identifier) {
      const norm = identifier.toLowerCase();
      const res = await q(
        `SELECT * FROM users
         WHERE (username_norm = $1 OR email_norm = $1) AND deleted_at IS NULL
         LIMIT 1`,
        [norm]
      );
      return res.rows[0] || null;
    },

    async findUserById(id) {
      const res = await q('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
      return res.rows[0] || null;
    },

    async findUserByEmailNorm(emailNorm) {
      const res = await q(
        'SELECT * FROM users WHERE email_norm = $1 AND deleted_at IS NULL LIMIT 1',
        [emailNorm]
      );
      return res.rows[0] || null;
    },

    async usernameTaken(usernameNorm) {
      const res = await q('SELECT 1 FROM users WHERE username_norm = $1 LIMIT 1', [usernameNorm]);
      return res.rows.length > 0;
    },

    async emailTaken(emailNorm) {
      const res = await q('SELECT 1 FROM users WHERE email_norm = $1 LIMIT 1', [emailNorm]);
      return res.rows.length > 0;
    },

    async createUser(user) {
      await q(
        `INSERT INTO users (id, username, username_norm, email, email_norm, password_hash, display_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          user.id,
          user.username,
          user.usernameNorm,
          user.email,
          user.emailNorm,
          user.passwordHash,
          user.displayName,
        ]
      );
    },

    async setEmailVerified(userId) {
      const res = await q(
        `UPDATE users
         SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING email_verified_at`,
        [userId]
      );
      return res.rows[0] || null;
    },

    async updatePassword(userId, passwordHash) {
      await q(
        'UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1',
        [userId, passwordHash]
      );
    },

    async softDeleteUser(userId) {
      const res = await q(
        `UPDATE users
         SET deleted_at = now(), updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id`,
        [userId]
      );
      return res.rows.length > 0;
    },

    async createDevice(device) {
      await q(
        `INSERT INTO devices (id, user_id, platform, device_name, identity_public_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [device.id, device.userId, device.platform || 'unknown', device.deviceName || '', device.identityPublicKey || null]
      );
    },

    async createSession(session) {
      await q(
        `INSERT INTO user_sessions (id, user_id, device_id, token_hash, family_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [session.id, session.userId, session.deviceId || null, session.tokenHash, session.familyId, session.expiresAt]
      );
    },

    async findSessionById(id) {
      const res = await q('SELECT * FROM user_sessions WHERE id = $1 LIMIT 1', [id]);
      return res.rows[0] || null;
    },

    async findSessionByTokenHash(tokenHash) {
      const res = await q('SELECT * FROM user_sessions WHERE token_hash = $1 LIMIT 1', [tokenHash]);
      return res.rows[0] || null;
    },

    async revokeSession(id) {
      await q(
        "UPDATE user_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
        [id]
      );
    },

    async revokeFamilySessions(familyId) {
      await q(
        "UPDATE user_sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL",
        [familyId]
      );
    },

    async revokeAllUserSessions(userId) {
      await q(
        "UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
        [userId]
      );
    },

    async touchSession(id) {
      await q('UPDATE user_sessions SET last_used_at = now() WHERE id = $1', [id]);
    },

    async createEmailToken(token) {
      await q(
        `INSERT INTO email_tokens (id, user_id, kind, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [token.id, token.userId, token.kind, token.tokenHash, token.expiresAt]
      );
    },

    async consumeEmailToken(tokenHash, kind) {
      const res = await q(
        `UPDATE email_tokens
         SET used_at = now()
         WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now()
         RETURNING *`,
        [tokenHash, kind]
      );
      return res.rows[0] || null;
    },

    async deleteEmailTokens(userId, kind) {
      await q('DELETE FROM email_tokens WHERE user_id = $1 AND kind = $2', [userId, kind]);
    },
  };
}

module.exports = { createAuthRepo };
