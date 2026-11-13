'use strict';

// Status repository — status_posts/views/reactions queries (Stage 6).
// Visibility SQL yahan central hai: author khud + author ke contacts; blocked excluded.

const STATUS_COLUMNS = `
  sp.id, sp.author_user_id, sp.media_id, sp.caption_ciphertext, sp.caption_nonce,
  sp.caption_auth_tag, sp.expires_at, sp.created_at, sp.deleted_at`;

const STATUS_RETURN_COLUMNS = `
  id, author_user_id, media_id, caption_ciphertext, caption_nonce,
  caption_auth_tag, expires_at, created_at, deleted_at`;

function encodeCursor(createdAt, id) {
  const iso = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);
  return Buffer.from(`${iso}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.lastIndexOf('|');
    if (sep < 0) return null;
    const iso = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return { createdAt: date, id };
  } catch {
    return null;
  }
}

function toStatus(row) {
  if (!row) return null;
  return {
    id: row.id,
    authorUserId: row.author_user_id,
    mediaId: row.media_id,
    captionCiphertext: row.caption_ciphertext,
    captionNonce: row.caption_nonce,
    captionAuthTag: row.caption_auth_tag,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  };
}

function createStatusRepo({ db }) {
  const q = (text, params) => {
    if (!db) {
      const err = new Error('Database configured nahi hai');
      err.code = 'DB_NOT_CONFIGURED';
      throw err;
    }
    return db.query(text, params);
  };

  // Visibility predicate (author ya author ke contacts; blocked excluded).
  // NOTE: pg-mem correlated EXISTS subqueries support nahi karta, isliye IN-subquery
  // form — real PostgreSQL mein dono chalte hain. Columns NOT NULL hain, NOT IN safe hai.
  const visibleTo = `
    (sp.author_user_id = $1 OR sp.author_user_id IN (
      SELECT owner_user_id FROM contacts WHERE contact_user_id = $1
    ))
    AND sp.author_user_id NOT IN (
      SELECT blocked_user_id FROM blocked_users WHERE blocker_user_id = $1
    )
    AND sp.author_user_id NOT IN (
      SELECT blocker_user_id FROM blocked_users WHERE blocked_user_id = $1
    )`;

  return {
    encodeCursor,
    decodeCursor,
    toStatus,

    async insertStatus({ id, authorUserId, mediaId, captionCiphertext, captionNonce, captionAuthTag, expiresAt }) {
      const res = await q(
        `INSERT INTO status_posts
           (id, author_user_id, media_id, caption_ciphertext, caption_nonce, caption_auth_tag, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${STATUS_RETURN_COLUMNS}`,
        [id, authorUserId, mediaId || null, captionCiphertext || '', captionNonce || '', captionAuthTag || '', expiresAt]
      );
      return res.rows[0] || null;
    },

    async findStatusById(postId) {
      const res = await q(
        `SELECT ${STATUS_COLUMNS} FROM status_posts sp WHERE sp.id = $1 LIMIT 1`,
        [postId]
      );
      return res.rows[0] || null;
    },

    // Status media authz ke liye — media_id se post dhundo (deleted excluded).
    async findStatusByMediaId(mediaId) {
      const res = await q(
        `SELECT ${STATUS_COLUMNS} FROM status_posts sp WHERE sp.media_id = $1 AND sp.deleted_at IS NULL LIMIT 1`,
        [mediaId]
      );
      return res.rows[0] || null;
    },

    // Active = delete nahi hua, expire nahi hua.
    async isStatusActive(postId) {
      const res = await q(
        `SELECT 1 FROM status_posts sp
         WHERE sp.id = $1 AND sp.deleted_at IS NULL AND sp.expires_at > now()
         LIMIT 1`,
        [postId]
      );
      return res.rows.length > 0;
    },

    // Viewer yeh status dekh sakta hai (active + visible).
    async canViewStatus(postId, userId) {
      const res = await q(
        `SELECT 1 FROM status_posts sp
         WHERE sp.id = $2 AND sp.deleted_at IS NULL AND sp.expires_at > now()
           AND ${visibleTo}
         LIMIT 1`,
        [userId, postId]
      );
      return res.rows.length > 0;
    },

    async listStatuses(userId, cursor, limit) {
      let where = `WHERE sp.deleted_at IS NULL AND sp.expires_at > now() AND ${visibleTo}`;
      const params = [userId];
      if (cursor) {
        where += ' AND (sp.created_at < $2 OR (sp.created_at = $2 AND sp.id < $3))';
        params.push(cursor.createdAt, cursor.id);
      }
      params.push(limit + 1);
      const res = await q(
        `SELECT ${STATUS_COLUMNS} FROM status_posts sp
         ${where}
         ORDER BY sp.created_at DESC, sp.id DESC
         LIMIT $${params.length}`,
        params
      );
      return res.rows;
    },

    async upsertView(postId, userId) {
      await q(
        `INSERT INTO status_views (post_id, viewer_user_id)
         VALUES ($1, $2)
         ON CONFLICT (post_id, viewer_user_id) DO NOTHING`,
        [postId, userId]
      );
    },

    async listViews(postId) {
      const res = await q(
        `SELECT viewer_user_id, viewed_at FROM status_views
         WHERE post_id = $1
         ORDER BY viewed_at DESC`,
        [postId]
      );
      return res.rows;
    },

    async countViews(postId) {
      const res = await q(`SELECT COUNT(*)::int AS count FROM status_views WHERE post_id = $1`, [postId]);
      return res.rows[0].count;
    },

    async upsertReaction(postId, userId, reactionCiphertext) {
      await q(
        `INSERT INTO status_reactions (post_id, user_id, reaction_ciphertext)
         VALUES ($1, $2, $3)
         ON CONFLICT (post_id, user_id)
         DO UPDATE SET reaction_ciphertext = EXCLUDED.reaction_ciphertext, updated_at = now()`,
        [postId, userId, reactionCiphertext]
      );
    },

    async deleteReaction(postId, userId) {
      await q(`DELETE FROM status_reactions WHERE post_id = $1 AND user_id = $2`, [postId, userId]);
    },

    async listReactions(postId) {
      const res = await q(
        `SELECT user_id, reaction_ciphertext, created_at, updated_at FROM status_reactions
         WHERE post_id = $1
         ORDER BY created_at`,
        [postId]
      );
      return res.rows;
    },

    async softDeleteStatus(postId, authorUserId) {
      const res = await q(
        `UPDATE status_posts SET deleted_at = now()
         WHERE id = $1 AND author_user_id = $2 AND deleted_at IS NULL
         RETURNING ${STATUS_RETURN_COLUMNS}`,
        [postId, authorUserId]
      );
      return res.rows[0] || null;
    },

    // Cleanup: expired active posts batch mein.
    async listExpiredActive(cutoff, limit) {
      const res = await q(
        `SELECT id, media_id FROM status_posts
         WHERE deleted_at IS NULL AND expires_at < $1
         ORDER BY expires_at
         LIMIT $2`,
        [cutoff, limit]
      );
      return res.rows;
    },

    async markExpiredDeleted(ids) {
      if (ids.length === 0) return 0;
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
      const res = await q(
        `UPDATE status_posts SET deleted_at = now()
         WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
        ids
      );
      return res.rowCount;
    },
  };
}

module.exports = { createStatusRepo };
