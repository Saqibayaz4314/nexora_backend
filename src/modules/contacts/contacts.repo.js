'use strict';

// Contacts/safety repository — PostgreSQL queries.
// Block checks hamesha dono directions mein hote hain.

function createContactsRepo({ db }) {
  const q = (text, params) => {
    if (!db) {
      const err = new Error('Database configured nahi hai');
      err.code = 'DB_NOT_CONFIGURED';
      throw err;
    }
    return db.query(text, params);
  };

  const PUBLIC_USER_COLUMNS = `
    id, username, display_name, avatar_key, about, discoverable, deleted_at
  `;

  function toPublicUser(row) {
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarKey: row.avatar_key,
      about: row.about,
    };
  }

  return {
    toPublicUser,

    async findUserById(id) {
      const res = await q(
        `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1 LIMIT 1`,
        [id]
      );
      return res.rows[0] || null;
    },

    async discoverByUsernameNorm(usernameNorm, excludeId) {
      const res = await q(
        `SELECT ${PUBLIC_USER_COLUMNS} FROM users
         WHERE username_norm = $1 AND discoverable = true AND deleted_at IS NULL AND id <> $2
         LIMIT 1`,
        [usernameNorm, excludeId]
      );
      return res.rows[0] || null;
    },

    async discoverByEmailNorm(emailNorm, excludeId) {
      const res = await q(
        `SELECT ${PUBLIC_USER_COLUMNS} FROM users
         WHERE email_norm = $1 AND discoverable = true AND deleted_at IS NULL AND id <> $2
         LIMIT 1`,
        [emailNorm, excludeId]
      );
      return res.rows[0] || null;
    },

    async isBlocked(blockerId, blockedId) {
      const res = await q(
        'SELECT 1 FROM blocked_users WHERE blocker_user_id = $1 AND blocked_user_id = $2 LIMIT 1',
        [blockerId, blockedId]
      );
      return res.rows.length > 0;
    },

    async listContacts(ownerId) {
      const res = await q(
        `SELECT c.contact_user_id, c.nickname, c.created_at,
                u.username, u.display_name, u.avatar_key, u.about, u.last_seen_at
         FROM contacts c
         JOIN users u ON u.id = c.contact_user_id
         WHERE c.owner_user_id = $1 AND u.deleted_at IS NULL
         ORDER BY c.created_at DESC`,
        [ownerId]
      );
      return res.rows.map((row) => ({
        user: {
          id: row.contact_user_id,
          username: row.username,
          displayName: row.display_name,
          avatarKey: row.avatar_key,
          about: row.about,
          lastSeenAt: row.last_seen_at,
        },
        nickname: row.nickname,
        createdAt: row.created_at,
      }));
    },

    async findContact(ownerId, contactId) {
      const res = await q(
        'SELECT * FROM contacts WHERE owner_user_id = $1 AND contact_user_id = $2 LIMIT 1',
        [ownerId, contactId]
      );
      return res.rows[0] || null;
    },

    async insertContact(ownerId, contactId, nickname) {
      await q(
        'INSERT INTO contacts (owner_user_id, contact_user_id, nickname) VALUES ($1, $2, $3)',
        [ownerId, contactId, nickname || '']
      );
    },

    async updateContactNickname(ownerId, contactId, nickname) {
      await q(
        'UPDATE contacts SET nickname = $3 WHERE owner_user_id = $1 AND contact_user_id = $2',
        [ownerId, contactId, nickname || '']
      );
    },

    async deleteContact(ownerId, contactId) {
      await q(
        'DELETE FROM contacts WHERE owner_user_id = $1 AND contact_user_id = $2',
        [ownerId, contactId]
      );
    },

    async insertBlock(blockerId, blockedId) {
      await q(
        'INSERT INTO blocked_users (blocker_user_id, blocked_user_id) VALUES ($1, $2)',
        [blockerId, blockedId]
      );
    },

    async deleteBlock(blockerId, blockedId) {
      await q(
        'DELETE FROM blocked_users WHERE blocker_user_id = $1 AND blocked_user_id = $2',
        [blockerId, blockedId]
      );
    },

    async insertReport({ id, reporterId, reportedId, reason, details }) {
      await q(
        `INSERT INTO reports (id, reporter_user_id, reported_user_id, reason, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, reporterId, reportedId, reason, details || '']
      );
    },
  };
}

module.exports = { createContactsRepo };
