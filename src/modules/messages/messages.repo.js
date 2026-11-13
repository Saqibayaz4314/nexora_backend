'use strict';

// Messages repository — PostgreSQL queries.
// Idempotency: (sender_device_id, client_message_id) unique per device.
// Cursor pagination: keyset (created_at, id) DESC.

const MESSAGE_COLUMNS = `
  m.id, m.client_message_id, m.conversation_id, m.sender_user_id,
  m.message_type, m.ciphertext, m.nonce, m.auth_tag,
  m.media_id, m.reply_to_id, m.status_post_id, m.edited_at, m.deleted_at, m.created_at
`;

// INSERT ... RETURNING mein alias nahi chalta — unaliased columns list.
const MESSAGE_RETURN_COLUMNS = `
  id, client_message_id, conversation_id, sender_user_id,
  message_type, ciphertext, nonce, auth_tag,
  media_id, reply_to_id, status_post_id, edited_at, deleted_at, created_at
`;

function encodeCursor(createdAt, id) {
  return Buffer.from(`${new Date(createdAt).toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const idx = raw.indexOf('|');
    if (idx === -1) return null;
    const createdAt = new Date(raw.slice(0, idx));
    const id = raw.slice(idx + 1);
    if (Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function toMessage(row) {
  return {
    id: row.id,
    clientMessageId: row.client_message_id,
    conversationId: row.conversation_id,
    senderUserId: row.sender_user_id,
    messageType: row.message_type,
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    authTag: row.auth_tag,
    replyToId: row.reply_to_id,
    statusPostId: row.status_post_id,
    mediaId: row.media_id,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
  };
}

function createMessagesRepo({ db }) {
  const q = (text, params) => {
    if (!db) {
      const err = new Error('Database configured nahi hai');
      err.code = 'DB_NOT_CONFIGURED';
      throw err;
    }
    return db.query(text, params);
  };

  return {
    encodeCursor,
    decodeCursor,
    toMessage,

    // Membership: user active member hai ya nahi (left_at NULL).
    async findMembership(conversationId, userId) {
      const res = await q(
        `SELECT cm.user_id, cm.role, cm.left_at, cm.history_cleared_at, c.kind
         FROM conversation_members cm
         JOIN conversations c ON c.id = cm.conversation_id
         WHERE cm.conversation_id = $1 AND cm.user_id = $2
         LIMIT 1`,
        [conversationId, userId]
      );
      return res.rows[0] || null;
    },

    // one_to_one conversation ke doosre member ki id (block check ke liye).
    async getOtherMemberId(conversationId, excludeUserId) {
      const res = await q(
        `SELECT user_id FROM conversation_members
         WHERE conversation_id = $1 AND user_id <> $2 AND left_at IS NULL
         LIMIT 1`,
        [conversationId, excludeUserId]
      );
      return res.rows[0] ? res.rows[0].user_id : null;
    },

    async findMessageById(messageId) {
      const res = await q(`SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE m.id = $1 LIMIT 1`, [messageId]);
      return res.rows[0] || null;
    },

    // Idempotent send: same device + same clientMessageId → same message.
    async findMessageByClientId(senderDeviceId, clientMessageId, conversationId) {
      const res = await q(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m
         WHERE m.sender_device_id = $1 AND m.client_message_id = $2 AND m.conversation_id = $3
         LIMIT 1`,
        [senderDeviceId, clientMessageId, conversationId]
      );
      return res.rows[0] || null;
    },

    async insertMessage({
      id,
      clientMessageId,
      conversationId,
      senderUserId,
      senderDeviceId,
      messageType,
      ciphertext,
      nonce,
      authTag,
      replyToId,
      statusPostId,
      mediaId,
    }) {
      const res = await q(
        `INSERT INTO messages
           (id, client_message_id, conversation_id, sender_user_id, sender_device_id,
            message_type, ciphertext, nonce, auth_tag, reply_to_id, status_post_id, media_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING ${MESSAGE_RETURN_COLUMNS}`,
        [id, clientMessageId, conversationId, senderUserId, senderDeviceId, messageType, ciphertext, nonce, authTag, replyToId, statusPostId || null, mediaId || null]
      );
      return res.rows[0];
    },

    // Sender ka khud ka receipt send ke waqt hi seen hota hai.
    async insertOwnReceipt(messageId, senderUserId) {
      await q(
        `INSERT INTO message_receipts (message_id, user_id, delivered_at, seen_at)
         VALUES ($1, $2, now(), now())
         ON CONFLICT (message_id, user_id) DO NOTHING`,
        [messageId, senderUserId]
      );
    },

    async updateMessageEdit(messageId, userId, ciphertext, nonce, authTag) {
      const res = await q(
        `UPDATE messages
         SET ciphertext = $3, nonce = $4, auth_tag = $5, edited_at = now()
         WHERE id = $1 AND sender_user_id = $2 AND deleted_at IS NULL
         RETURNING ${MESSAGE_RETURN_COLUMNS}`,
        [messageId, userId, ciphertext, nonce, authTag]
      );
      return res.rows[0] || null;
    },

    // Soft delete + ciphertext wipe (privacy).
    async softDeleteMessage(messageId, userId) {
      const res = await q(
        `UPDATE messages
         SET deleted_at = now(), ciphertext = '', nonce = '', auth_tag = ''
         WHERE id = $1 AND sender_user_id = $2 AND deleted_at IS NULL
         RETURNING ${MESSAGE_RETURN_COLUMNS}`,
        [messageId, userId]
      );
      return res.rows[0] || null;
    },

    async upsertReaction(messageId, userId, reactionCiphertext) {
      await q(
        `INSERT INTO message_reactions (message_id, user_id, reaction_ciphertext)
         VALUES ($1, $2, $3)
         ON CONFLICT (message_id, user_id)
         DO UPDATE SET reaction_ciphertext = EXCLUDED.reaction_ciphertext, updated_at = now()`,
        [messageId, userId, reactionCiphertext]
      );
    },

    async deleteReaction(messageId, userId) {
      await q(
        'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2',
        [messageId, userId]
      );
    },

    async upsertReceipt(messageId, userId, status) {
      // delivered: sirf pehli baar. seen: delivered bhi mark hota hai, seen sirf pehli baar.
      if (status === 'seen') {
        await q(
          `INSERT INTO message_receipts (message_id, user_id, delivered_at, seen_at)
           VALUES ($1, $2, now(), now())
           ON CONFLICT (message_id, user_id)
           DO UPDATE SET
             delivered_at = COALESCE(message_receipts.delivered_at, now()),
             seen_at = COALESCE(message_receipts.seen_at, now())`,
          [messageId, userId]
        );
      } else {
        await q(
          `INSERT INTO message_receipts (message_id, user_id, delivered_at)
           VALUES ($1, $2, now())
           ON CONFLICT (message_id, user_id)
           DO UPDATE SET delivered_at = COALESCE(message_receipts.delivered_at, now())`,
          [messageId, userId]
        );
      }
    },

    // Cursor pagination: newest-first keyset. limit+1 fetch karte hain taake nextCursor pata chale.
    async listMessages(conversationId, cursor, limit, historyClearedAt = null) {
      const params = [conversationId, limit + 1];
      let where = 'm.conversation_id = $1 AND m.deleted_at IS NULL';
      if (historyClearedAt) {
        params.push(historyClearedAt);
        where += ` AND m.created_at > $${params.length}`;
      }
      if (cursor) {
        params.push(cursor.createdAt, cursor.id);
        where += ` AND (m.created_at < $${params.length - 1} OR (m.created_at = $${params.length - 1} AND m.id < $${params.length}))`;
      }
      const res = await q(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m
         WHERE ${where}
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT $2`,
        params
      );
      return res.rows;
    },

    async listReactionsForMessages(messageIds) {
      if (messageIds.length === 0) return [];
      // IN + placeholders — ANY($1::uuid[]) pg-mem mein problematic tha, real PG mein dono chalte hain.
      const placeholders = messageIds.map((_, i) => `$${i + 1}`).join(', ');
      const res = await q(
        `SELECT message_id, user_id, reaction_ciphertext, created_at, updated_at
         FROM message_reactions
         WHERE message_id IN (${placeholders})
         ORDER BY created_at ASC`,
        messageIds
      );
      return res.rows;
    },

    async touchConversation(conversationId) {
      await q('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);
      // A new message restores hidden chats, but never restores cleared history.
      await q(
        `UPDATE conversation_members SET hidden_at = NULL
         WHERE conversation_id = $1 AND left_at IS NULL AND hidden_at IS NOT NULL`,
        [conversationId]
      );
    },

    // For socket fan-out: conversation ke saare active member ids.
    async listActiveMemberIds(conversationId) {
      const res = await q(
        `SELECT user_id FROM conversation_members
         WHERE conversation_id = $1 AND left_at IS NULL`,
        [conversationId]
      );
      return res.rows.map((r) => r.user_id);
    },

    // Socket reconnect par room restore: user ki saari active conversations.
    async listUserConversations(userId) {
      const res = await q(
        `SELECT conversation_id FROM conversation_members
         WHERE user_id = $1 AND left_at IS NULL`,
        [userId]
      );
      return res.rows;
    },

    // ===== Conversations list/create (Stage 8) =====

    // User ke active memberships — newest activity pehle.
    async listConversations(userId, limit) {
      const res = await q(
        `SELECT c.id, c.kind, c.name, c.description, c.icon_media_id, c.created_by,
                c.created_at, c.updated_at, cm.role
         FROM conversation_members cm
         JOIN conversations c ON c.id = cm.conversation_id
         WHERE cm.user_id = $1 AND cm.left_at IS NULL AND cm.hidden_at IS NULL
         ORDER BY c.updated_at DESC, c.id DESC
         LIMIT $2`,
        [userId, limit]
      );
      return res.rows;
    },

    // Har conversation ka sabse naya non-deleted message (preview ke liye).
    async listLastMessages(conversationIds, userId) {
      if (conversationIds.length === 0) return [];
      const placeholders = conversationIds.map((_, i) => `$${i + 1}`).join(', ');
      const res = await q(
        `SELECT DISTINCT ON (m.conversation_id) m.conversation_id, m.message_type, m.sender_user_id, m.created_at
         FROM messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
           AND cm.user_id = $${conversationIds.length + 1}
         WHERE m.conversation_id IN (${placeholders}) AND m.deleted_at IS NULL
           AND (cm.history_cleared_at IS NULL OR m.created_at > cm.history_cleared_at)
         ORDER BY m.conversation_id, m.created_at DESC, m.id DESC`,
        [...conversationIds, userId]
      );
      return res.rows;
    },

    // Unread count: mere seen receipt ke baghair, doosron ke non-deleted messages.
    async listUnreadCounts(conversationIds, userId) {
      if (conversationIds.length === 0) return [];
      const placeholders = conversationIds.map((_, i) => `$${i + 1}`).join(', ');
      const res = await q(
        `SELECT m.conversation_id, COUNT(*)::int AS unread_count
         FROM messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
           AND cm.user_id = $${conversationIds.length + 1}
         LEFT JOIN message_receipts r
           ON r.message_id = m.id AND r.user_id = $${conversationIds.length + 1} AND r.seen_at IS NOT NULL
         WHERE m.conversation_id IN (${placeholders})
           AND m.deleted_at IS NULL
           AND m.sender_user_id <> $${conversationIds.length + 2}
           AND (cm.history_cleared_at IS NULL OR m.created_at > cm.history_cleared_at)
           AND r.message_id IS NULL
         GROUP BY m.conversation_id`,
        [...conversationIds, userId, userId]
      );
      return res.rows;
    },

    // one_to_one conversations ke doosre members (peer info ke liye).
    async listConversationPeers(conversationIds, userId) {
      if (conversationIds.length === 0) return [];
      const placeholders = conversationIds.map((_, i) => `$${i + 1}`).join(', ');
      const res = await q(
        `SELECT cm.conversation_id, u.id, u.username, u.display_name
         FROM conversation_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.conversation_id IN (${placeholders})
           AND cm.user_id <> $${conversationIds.length + 1}
           AND cm.left_at IS NULL`,
        [...conversationIds, userId]
      );
      return res.rows;
    },

    // Peers ke latest non-revoked device identity keys (E2EE ECDH ke liye).
    async listLatestDeviceKeys(userIds) {
      if (userIds.length === 0) return [];
      const placeholders = userIds.map((_, i) => `$${i + 1}`).join(', ');
      const res = await q(
        `SELECT DISTINCT ON (d.user_id) d.user_id, d.identity_public_key
         FROM devices d
         WHERE d.user_id IN (${placeholders})
           AND d.identity_public_key IS NOT NULL
           AND d.revoked_at IS NULL
         ORDER BY d.user_id, d.created_at DESC, d.id DESC`,
        userIds
      );
      return res.rows;
    },

    // Users lookup (deleted accounts excluded) — create 1:1 validation ke liye.
    async findUserById(userId) {
      const res = await q(
        `SELECT id, username, display_name FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [userId]
      );
      return res.rows[0] || null;
    },

    // Existing active one_to_one between do users (get-or-create ke liye).
    async findOneToOne(userA, userB) {
      const res = await q(
        `SELECT c.id
         FROM conversation_members a
         JOIN conversation_members b ON b.conversation_id = a.conversation_id
         JOIN conversations c ON c.id = a.conversation_id
         WHERE a.user_id = $1 AND b.user_id = $2
           AND a.left_at IS NULL AND b.left_at IS NULL
           AND c.kind = 'one_to_one'
         LIMIT 1`,
        [userA, userB]
      );
      return res.rows[0] || null;
    },

    // Naya one_to_one conversation + dono members (race par duplicate possible —
    // get-or-create flow ke liye acceptable; unique index schema mein nahi hai).
    async createOneToOne(userA, userB, conversationId) {
      const inserted = await q(
        `INSERT INTO conversations (id, kind, created_by)
         VALUES ($1, 'one_to_one', $2)
         RETURNING id, kind, name, description, icon_media_id, created_by, created_at, updated_at`,
        [conversationId, userA]
      );
      await q(
        `INSERT INTO conversation_members (conversation_id, user_id, role)
         VALUES ($1, $2, 'member'), ($1, $3, 'member')
         ON CONFLICT DO NOTHING`,
        [conversationId, userA, userB]
      );
      return inserted.rows[0];
    },
  };
}

module.exports = { createMessagesRepo };
