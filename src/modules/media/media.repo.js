'use strict';

// Media repository — PostgreSQL queries.

function createMediaRepo({ db }) {
  const q = (text, params) => {
    if (!db) {
      const err = new Error('Database configured nahi hai');
      err.code = 'DB_NOT_CONFIGURED';
      throw err;
    }
    return db.query(text, params);
  };

  return {
    async insertMedia({
      id,
      ownerUserId,
      s3Key,
      mediaType,
      contentType,
      byteSize,
      checksum,
      encryptionNonce,
      encryptionAuthTag,
    }) {
      const res = await q(
        `INSERT INTO media_objects
           (id, owner_user_id, s3_key, media_type, content_type, byte_size, checksum,
            encryption_nonce, encryption_auth_tag, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
         RETURNING id, status, created_at`,
        [id, ownerUserId, s3Key, mediaType, contentType, byteSize, checksum, encryptionNonce, encryptionAuthTag]
      );
      return res.rows[0];
    },

    async findMediaById(id) {
      const res = await q('SELECT * FROM media_objects WHERE id = $1 LIMIT 1', [id]);
      return res.rows[0] || null;
    },

    async markReady(id, actualByteSize) {
      const res = await q(
        `UPDATE media_objects
         SET status = 'ready', byte_size = $2, completed_at = now()
         WHERE id = $1 AND status = 'pending' AND deleted_at IS NULL
         RETURNING id, status, byte_size, completed_at`,
        [id, actualByteSize]
      );
      return res.rows[0] || null;
    },

    async softDeleteMedia(id) {
      const res = await q(
        `UPDATE media_objects SET deleted_at = now()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, s3_key, deleted_at`,
        [id]
      );
      return res.rows[0] || null;
    },

    // Authz: media kisi message se linked hai to us message ki conversation.
    async findMessageForMedia(mediaId) {
      const res = await q(
        'SELECT id, conversation_id FROM messages WHERE media_id = $1 AND deleted_at IS NULL LIMIT 1',
        [mediaId]
      );
      return res.rows[0] || null;
    },

    async isConversationMember(conversationId, userId) {
      const res = await q(
        `SELECT 1 FROM conversation_members
         WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL LIMIT 1`,
        [conversationId, userId]
      );
      return res.rows.length > 0;
    },

    // Cleanup queries
    async listPendingOlderThan(date) {
      const res = await q(
        `SELECT id, s3_key FROM media_objects
         WHERE status = 'pending' AND created_at < $1
         ORDER BY created_at ASC
         LIMIT 500`,
        [date]
      );
      return res.rows;
    },

    async listDeletedOlderThan(date) {
      const res = await q(
        `SELECT id, s3_key FROM media_objects
         WHERE deleted_at IS NOT NULL AND deleted_at < $1
         ORDER BY deleted_at ASC
         LIMIT 500`,
        [date]
      );
      return res.rows;
    },

    async deleteRow(id) {
      await q('DELETE FROM media_objects WHERE id = $1', [id]);
    },
  };
}

module.exports = { createMediaRepo };
