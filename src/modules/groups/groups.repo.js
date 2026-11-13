'use strict';

// Groups repository — conversations (kind='group') metadata, members, invites.
// Notes: INSERT/UPDATE RETURNING unaliased (pg-mem), UPDATE target unaliased.

const CONVERSATION_COLUMNS = `
  c.id, c.kind, c.name, c.description, c.icon_media_id,
  c.created_by, c.created_at, c.updated_at`;

const CONVERSATION_RETURN_COLUMNS = `
  id, kind, name, description, icon_media_id,
  created_by, created_at, updated_at`;

const INVITE_COLUMNS = `
  i.id, i.conversation_id, i.inviter_user_id, i.invitee_user_id,
  i.status, i.created_at, i.updated_at`;

const INVITE_RETURN_COLUMNS = `
  id, conversation_id, inviter_user_id, invitee_user_id,
  status, created_at, updated_at`;

function toConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    iconMediaId: row.icon_media_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toInvite(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    inviterUserId: row.inviter_user_id,
    inviteeUserId: row.invitee_user_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createGroupsRepo({ db }) {
  const q = (text, params) => {
    if (!db) {
      const err = new Error('Database configured nahi hai');
      err.code = 'DB_NOT_CONFIGURED';
      throw err;
    }
    return db.query(text, params);
  };

  return {
    toConversation,
    toInvite,

    async findConversationById(conversationId) {
      const res = await q(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations c WHERE c.id = $1 LIMIT 1`,
        [conversationId]
      );
      return res.rows[0] || null;
    },

    // Membership row: user_id, role, left_at + conversation kind/created_by.
    async findMembership(conversationId, userId) {
      const res = await q(
        `SELECT cm.user_id, cm.role, cm.left_at, cm.joined_at, c.kind, c.created_by
         FROM conversation_members cm
         JOIN conversations c ON c.id = cm.conversation_id
         WHERE cm.conversation_id = $1 AND cm.user_id = $2
         LIMIT 1`,
        [conversationId, userId]
      );
      return res.rows[0] || null;
    },

    async createGroup({ id, name, description, createdBy }) {
      const res = await q(
        `INSERT INTO conversations (id, kind, name, description, created_by)
         VALUES ($1, 'group', $2, $3, $4)
         RETURNING ${CONVERSATION_RETURN_COLUMNS}`,
        [id, name, description || '', createdBy]
      );
      return res.rows[0];
    },

    // Dynamic SET — sirf provided keys update hote hain (COALESCE-free).
    async updateConversation(conversationId, updates) {
      const keys = Object.keys(updates);
      if (keys.length === 0) return null;
      const sets = [];
      const params = [conversationId];
      for (const key of keys) {
        params.push(updates[key]);
        sets.push(`${key} = $${params.length}`);
      }
      const res = await q(
        `UPDATE conversations SET ${sets.join(', ')}, updated_at = now()
         WHERE id = $1
         RETURNING ${CONVERSATION_RETURN_COLUMNS}`,
        params
      );
      return res.rows[0] || null;
    },

    async insertMembers(conversationId, members) {
      if (members.length === 0) return;
      const values = [];
      const params = [conversationId];
      let i = 1;
      for (const m of members) {
        params.push(m.userId, m.role);
        values.push(`($1, $${i + 1}, $${i + 2})`);
        i += 2;
      }
      await q(
        `INSERT INTO conversation_members (conversation_id, user_id, role)
         VALUES ${values.join(', ')}
         ON CONFLICT (conversation_id, user_id) DO UPDATE SET
           left_at = NULL, joined_at = now(), role = 'member', hidden_at = NULL,
           history_cleared_at = CASE
             WHEN conversation_members.history_cleared_at > now()
               THEN conversation_members.history_cleared_at
             ELSE now()
           END
         WHERE conversation_members.left_at IS NOT NULL`,
        params
      );
    },

    async listMembers(conversationId) {
      // identity_public_key: member ke latest non-revoked device se — group
      // fan-out E2EE ke liye client ko har member ki ECDH public key chahiye.
      const res = await q(
        `SELECT cm.user_id, cm.role, cm.joined_at, u.username, u.display_name
         FROM conversation_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.conversation_id = $1 AND cm.left_at IS NULL
         ORDER BY cm.joined_at ASC, cm.user_id ASC`,
        [conversationId]
      );
      if (res.rows.length === 0) return res.rows;

      const memberIds = res.rows.map((row) => row.user_id);
      const devices = await q(
        `SELECT user_id, identity_public_key FROM devices
         WHERE user_id IN (${memberIds.map((_, i) => `$${i + 1}`).join(', ')})
           AND identity_public_key IS NOT NULL AND revoked_at IS NULL
         ORDER BY created_at DESC, id DESC`,
        memberIds
      );
      const keys = new Map();
      for (const device of devices.rows) {
        if (!keys.has(device.user_id)) keys.set(device.user_id, device.identity_public_key);
      }
      return res.rows.map((row) => ({
        ...row,
        identity_public_key: keys.get(row.user_id) ?? null,
      }));
    },

    async countActiveMembers(conversationId) {
      const res = await q(
        `SELECT COUNT(*)::int AS n FROM conversation_members
         WHERE conversation_id = $1 AND left_at IS NULL`,
        [conversationId]
      );
      return res.rows[0].n;
    },

    async updateMemberRole(conversationId, userId, role) {
      const res = await q(
        `UPDATE conversation_members SET role = $3
         WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL
         RETURNING user_id, role`,
        [conversationId, userId, role]
      );
      return res.rows[0] || null;
    },

    // Delete chat is per-user visibility/history state, never a membership removal.
    async hideConversation(conversationId, userId) {
      const res = await q(
        `UPDATE conversation_members SET hidden_at = now(), history_cleared_at = now()
         WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL
         RETURNING user_id`,
        [conversationId, userId]
      );
      return res.rows[0] || null;
    },

    // Soft remove: left_at set (history/receipts preserve ho jate hain).
    async removeMember(conversationId, userId) {
      const res = await q(
        `UPDATE conversation_members SET left_at = now()
         WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL
         RETURNING user_id`,
        [conversationId, userId]
      );
      return res.rows[0] || null;
    },

    // Re-invite: existing pair row hi pending ho jati hai (ek row per pair).
    async upsertInvite({ id, conversationId, inviterUserId, inviteeUserId }) {
      const res = await q(
        `INSERT INTO conversation_invites (id, conversation_id, inviter_user_id, invitee_user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (conversation_id, invitee_user_id)
         DO UPDATE SET
           status = 'pending',
           inviter_user_id = EXCLUDED.inviter_user_id,
           updated_at = now()
         RETURNING ${INVITE_RETURN_COLUMNS}`,
        [id, conversationId, inviterUserId, inviteeUserId]
      );
      return res.rows[0];
    },

    async findInviteById(inviteId) {
      const res = await q(
        `SELECT ${INVITE_COLUMNS} FROM conversation_invites i WHERE i.id = $1 LIMIT 1`,
        [inviteId]
      );
      return res.rows[0] || null;
    },

    // Status transition atomic: sirf pending invite accept/decline hota hai.
    async updateInviteStatus(inviteId, inviteeUserId, fromStatus, toStatus) {
      const res = await q(
        `UPDATE conversation_invites SET status = $4, updated_at = now()
         WHERE id = $1 AND invitee_user_id = $2 AND status = $3
         RETURNING ${INVITE_RETURN_COLUMNS}`,
        [inviteId, inviteeUserId, fromStatus, toStatus]
      );
      return res.rows[0] || null;
    },

    async listInvitesForUser(userId, status, limit) {
      const res = await q(
        `SELECT ${INVITE_COLUMNS},
                c.name AS conversation_name,
                u.username AS inviter_username, u.display_name AS inviter_display_name
         FROM conversation_invites i
         JOIN conversations c ON c.id = i.conversation_id
         JOIN users u ON u.id = i.inviter_user_id
         WHERE i.invitee_user_id = $1 AND i.status = $2
         ORDER BY i.created_at DESC
         LIMIT $3`,
        [userId, status, limit]
      );
      return res.rows;
    },

    // Owner transfer candidate: sabse purana active member.
    async findOldestActiveMemberExcept(conversationId, excludeUserId) {
      const res = await q(
        `SELECT user_id, role FROM conversation_members
         WHERE conversation_id = $1 AND user_id <> $2 AND left_at IS NULL
         ORDER BY joined_at ASC, user_id ASC
         LIMIT 1`,
        [conversationId, excludeUserId]
      );
      return res.rows[0] || null;
    },

    // Hard delete — members/invites/messages FK cascade hote hain.
    async deleteGroupConversation(conversationId) {
      const res = await q(
        `DELETE FROM conversations WHERE id = $1 AND kind = 'group' RETURNING id`,
        [conversationId]
      );
      return res.rows[0] || null;
    },
  };
}

module.exports = { createGroupsRepo };
