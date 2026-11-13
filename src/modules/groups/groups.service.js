'use strict';

const crypto = require('crypto');
const { AppError } = require('../../shared/errors');

// Groups service — kind='group' conversations (Stage 7).
// - Roles: owner > admin > member. Owner banata hai group.
// - Permissions: update/invite/remove → owner ya admin (remove: admin sirf members);
//   role change/delete → sirf owner. Leave: owner nahi kar sakta (delete ya transfer).
// - Invites: pending → accept/decline; re-invite same row update hota hai.
// - getIo: invite/membership events socket rooms par emit hote hain.

function createGroupsService({ db, repo, contactsRepo, mediaRepo, getIo }) {
  if (!repo) {
    throw new Error('groups service ko repo chahiye');
  }
  if (!contactsRepo) {
    throw new Error('groups service ko contactsRepo chahiye (user lookup + block checks)');
  }

  function ensureDb() {
    if (!db) {
      throw new AppError(503, 'DB_NOT_CONFIGURED', 'Service temporarily unavailable');
    }
  }

  function emitToUser(userId, event, payload) {
    const io = getIo ? getIo() : null;
    if (io) {
      io.to(`user:${userId}`).emit(event, payload);
    }
  }

  function emitConversation(conversationId, event, payload) {
    const io = getIo ? getIo() : null;
    if (io) {
      io.to(`conversation:${conversationId}`).emit(event, payload);
    }
  }

  async function evictMember(conversationId, userId) {
    const io = getIo ? getIo() : null;
    if (!io || typeof io.in !== 'function') return;
    // Chained in() filters are a UNION in Socket.IO. Selecting the user room
    // and leaving only this conversation evicts the intended intersection.
    const userSockets = io.in(`user:${userId}`);
    if (typeof userSockets.socketsLeave === 'function') {
      await userSockets.socketsLeave(`conversation:${conversationId}`);
    }
  }

  async function requireMembership(conversationId, userId) {
    const membership = await repo.findMembership(conversationId, userId);
    if (!membership || membership.left_at) {
      throw new AppError(403, 'NOT_CONVERSATION_MEMBER', 'You are not a member of this conversation');
    }
    return membership;
  }

  function requireGroup(membership) {
    if (membership.kind !== 'group') {
      throw new AppError(400, 'NOT_GROUP_CONVERSATION', 'This conversation is not a group');
    }
  }

  function requireRole(membership, roles) {
    if (!roles.includes(membership.role)) {
      throw new AppError(403, 'INSUFFICIENT_ROLE', 'You do not have permission for this action');
    }
  }

  async function requireTargetUser(userId) {
    const user = await contactsRepo.findUserById(userId);
    if (!user) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }
    return user;
  }

  async function requireUsableIcon(iconMediaId, userId) {
    if (!mediaRepo) {
      throw new AppError(503, 'MEDIA_NOT_CONFIGURED', 'Media service unavailable');
    }
    const media = await mediaRepo.findMediaById(iconMediaId);
    if (!media || media.deleted_at) {
      throw new AppError(404, 'MEDIA_NOT_FOUND', 'Media not found');
    }
    if (media.owner_user_id !== userId) {
      throw new AppError(403, 'NOT_MEDIA_OWNER', 'You can only use your own media');
    }
    if (media.status !== 'ready') {
      throw new AppError(409, 'MEDIA_NOT_READY', 'Media upload not completed');
    }
  }

  function memberOut(row) {
    return {
      userId: row.user_id,
      role: row.role,
      joinedAt: row.joined_at,
      username: row.username,
      displayName: row.display_name,
      // Group fan-out E2EE ke liye — null ho sakta hai (device bina key ke).
      identityPublicKey: row.identity_public_key || null,
    };
  }

  return {
    // POST /conversations/groups — creator owner banta hai, members direct add.
    async createGroup(me, { name, description, memberUserIds }) {
      ensureDb();
      const trimmed = (name || '').trim();
      if (!trimmed) {
        throw new AppError(400, 'GROUP_NAME_REQUIRED', 'Group name is required');
      }

      const uniqueIds = [...new Set(memberUserIds || [])].filter((id) => id !== me.id);
      for (const uid of uniqueIds) {
        // eslint-disable-next-line no-await-in-loop
        await requireTargetUser(uid);
      }

      const id = crypto.randomUUID();
      const row = await repo.createGroup({
        id,
        name: trimmed,
        description: (description || '').trim(),
        createdBy: me.id,
      });
      await repo.insertMembers(id, [
        { userId: me.id, role: 'owner' },
        ...uniqueIds.map((uid) => ({ userId: uid, role: 'member' })),
      ]);

      const members = (await repo.listMembers(id)).map(memberOut);
      const conversation = { ...repo.toConversation(row), members };
      emitConversation(id, 'conversation:created', { conversation });
      return { conversation };
    },

    // GET /conversations/:id — member ko detail + members.
    async getConversation(me, conversationId) {
      ensureDb();
      const membership = await requireMembership(conversationId, me.id);
      const row = await repo.findConversationById(conversationId);
      if (!row) {
        throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
      }
      const members = (await repo.listMembers(conversationId)).map(memberOut);
      return {
        conversation: { ...repo.toConversation(row), myRole: membership.role, members },
      };
    },

    // PATCH /conversations/:id — name/description/icon; owner ya admin.
    async updateGroup(me, conversationId, { name, description, iconMediaId }) {
      ensureDb();
      const membership = await requireMembership(conversationId, me.id);
      requireGroup(membership);
      requireRole(membership, ['owner', 'admin']);

      const updates = {};
      if (name !== undefined) {
        const trimmed = name.trim();
        if (!trimmed) {
          throw new AppError(400, 'GROUP_NAME_REQUIRED', 'Group name cannot be empty');
        }
        updates.name = trimmed;
      }
      if (description !== undefined) {
        updates.description = description.trim();
      }
      if (iconMediaId !== undefined && iconMediaId !== null) {
        await requireUsableIcon(iconMediaId, me.id);
        updates.icon_media_id = iconMediaId;
      } else if (iconMediaId === null) {
        updates.icon_media_id = null; // icon remove
      }

      if (Object.keys(updates).length === 0) {
        throw new AppError(400, 'NOTHING_TO_UPDATE', 'No updatable fields provided');
      }

      const row = await repo.updateConversation(conversationId, updates);
      const conversation = repo.toConversation(row);
      emitConversation(conversationId, 'conversation:updated', { conversation });
      return { conversation };
    },

    // GET /conversations/:id/members
    async listMembers(me, conversationId) {
      ensureDb();
      await requireMembership(conversationId, me.id);
      const members = (await repo.listMembers(conversationId)).map(memberOut);
      return { members };
    },

    // POST /conversations/:id/invites — owner ya admin; dono directions block check.
    async invite(me, conversationId, userId) {
      ensureDb();
      const membership = await requireMembership(conversationId, me.id);
      requireGroup(membership);
      requireRole(membership, ['owner', 'admin']);

      if (userId === me.id) {
        throw new AppError(400, 'CANNOT_INVITE_SELF', 'You cannot invite yourself');
      }
      await requireTargetUser(userId);

      const targetMembership = await repo.findMembership(conversationId, userId);
      if (targetMembership && !targetMembership.left_at) {
        throw new AppError(409, 'ALREADY_MEMBER', 'User is already a member');
      }

      const [iBlockedThem, theyBlockedMe] = await Promise.all([
        contactsRepo.isBlocked(me.id, userId),
        contactsRepo.isBlocked(userId, me.id),
      ]);
      if (iBlockedThem || theyBlockedMe) {
        throw new AppError(403, 'CANNOT_INVITE_USER', 'You cannot invite this user');
      }

      const inviteRow = await repo.upsertInvite({
        id: crypto.randomUUID(),
        conversationId,
        inviterUserId: me.id,
        inviteeUserId: userId,
      });
      const row = await repo.findConversationById(conversationId);
      const invite = { ...repo.toInvite(inviteRow), conversationName: row ? row.name : '' };
      emitToUser(userId, 'group:invite', { invite });
      return { invite };
    },

    // GET /invites — meri pending invites.
    async listMyInvites(me, status, limit) {
      ensureDb();
      const rows = await repo.listInvitesForUser(me.id, status, limit);
      return {
        invites: rows.map((r) => ({
          ...repo.toInvite(r),
          conversationName: r.conversation_name,
          inviterUsername: r.inviter_username,
          inviterDisplayName: r.inviter_display_name,
        })),
      };
    },

    // POST /invites/:id/accept — pending invite ko accept; member add hota hai.
    async acceptInvite(me, inviteId) {
      ensureDb();
      const invite = await repo.findInviteById(inviteId);
      if (!invite) {
        throw new AppError(404, 'INVITE_NOT_FOUND', 'Invite not found');
      }
      if (invite.invitee_user_id !== me.id) {
        throw new AppError(403, 'NOT_INVITE_RECIPIENT', 'This invite is not for you');
      }
      if (invite.status !== 'pending') {
        throw new AppError(409, 'INVITE_ALREADY_HANDLED', 'Invite already handled');
      }
      // Group delete ho chuka ho to invite cascade se gayab hota — double-check.
      const conversation = await repo.findConversationById(invite.conversation_id);
      if (!conversation) {
        throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
      }

      await repo.insertMembers(invite.conversation_id, [{ userId: me.id, role: 'member' }]);
      const updated = await repo.updateInviteStatus(inviteId, me.id, 'pending', 'accepted');
      emitConversation(invite.conversation_id, 'conversation:member:joined', { userId: me.id });
      return { invite: repo.toInvite(updated), conversationId: invite.conversation_id };
    },

    // POST /invites/:id/decline
    async declineInvite(me, inviteId) {
      ensureDb();
      const invite = await repo.findInviteById(inviteId);
      if (!invite) {
        throw new AppError(404, 'INVITE_NOT_FOUND', 'Invite not found');
      }
      if (invite.invitee_user_id !== me.id) {
        throw new AppError(403, 'NOT_INVITE_RECIPIENT', 'This invite is not for you');
      }
      if (invite.status !== 'pending') {
        throw new AppError(409, 'INVITE_ALREADY_HANDLED', 'Invite already handled');
      }
      const updated = await repo.updateInviteStatus(inviteId, me.id, 'pending', 'declined');
      return { invite: repo.toInvite(updated) };
    },

    // POST /conversations/:id/leave — owner nahi; owner ko delete/transfer karna hota hai.
    async leaveGroup(me, conversationId) {
      ensureDb();
      const membership = await requireMembership(conversationId, me.id);
      requireGroup(membership);
      if (membership.role === 'owner') {
        throw new AppError(403, 'OWNER_CANNOT_LEAVE', 'Group owner cannot leave — delete the group or transfer ownership');
      }
      await repo.removeMember(conversationId, me.id);
      await evictMember(conversationId, me.id);
      emitConversation(conversationId, 'conversation:member:left', { userId: me.id });
      return { left: true, conversationId };
    },

    // DELETE /conversations/:id/self — WhatsApp-style "delete chat": sirf apni list
    // se hatao. DM ya group dono; group khud delete nahi hota, owner bhi kar sakta hai.
    async hideConversation(me, conversationId) {
      ensureDb();
      await requireMembership(conversationId, me.id);
      await repo.hideConversation(conversationId, me.id);
      emitToUser(me.id, 'conversation:hidden', { userId: me.id, conversationId });
      return { hidden: true, conversationId };
    },

    // DELETE /conversations/:id/members/:userId — owner kisi ko bhi (khud ko nahi);
    // admin sirf plain members ko remove kar sakta hai.
    async removeMember(me, conversationId, userId) {
      ensureDb();
      const actor = await requireMembership(conversationId, me.id);
      requireGroup(actor);
      if (userId === me.id) {
        throw new AppError(400, 'CANNOT_REMOVE_SELF', 'Use leave instead of removing yourself');
      }
      const target = await repo.findMembership(conversationId, userId);
      if (!target || target.left_at) {
        throw new AppError(404, 'MEMBER_NOT_FOUND', 'Member not found in this conversation');
      }
      if (actor.role === 'owner') {
        // Owner sab remove kar sakta hai (owner/admin/member), khud ko nahi.
      } else if (actor.role === 'admin') {
        if (target.role !== 'member') {
          throw new AppError(403, 'INSUFFICIENT_ROLE', 'Admins can only remove regular members');
        }
      } else {
        throw new AppError(403, 'INSUFFICIENT_ROLE', 'You do not have permission for this action');
      }
      await repo.removeMember(conversationId, userId);
      await evictMember(conversationId, userId);
      emitConversation(conversationId, 'conversation:member:removed', { userId });
      return { removed: true, conversationId, userId };
    },

    // POST /conversations/:id/members/:userId/role — sirf owner; role admin|member.
    async changeRole(me, conversationId, userId, role) {
      ensureDb();
      const actor = await requireMembership(conversationId, me.id);
      requireGroup(actor);
      requireRole(actor, ['owner']);
      if (userId === me.id) {
        throw new AppError(400, 'CANNOT_CHANGE_OWN_ROLE', 'You cannot change your own role');
      }
      const target = await repo.findMembership(conversationId, userId);
      if (!target || target.left_at) {
        throw new AppError(404, 'MEMBER_NOT_FOUND', 'Member not found in this conversation');
      }
      const updated = await repo.updateMemberRole(conversationId, userId, role);
      if (!updated) {
        // Race: target beech mein leave ho gaya ho.
        throw new AppError(404, 'MEMBER_NOT_FOUND', 'Member not found in this conversation');
      }
      emitConversation(conversationId, 'conversation:member:updated', { userId, role });
      return { updated: true, conversationId, userId, role: updated.role };
    },

    // DELETE /conversations/:id — sirf owner; cascade (members/invites/messages).
    async deleteGroup(me, conversationId) {
      ensureDb();
      const membership = await requireMembership(conversationId, me.id);
      requireGroup(membership);
      requireRole(membership, ['owner']);
      await repo.deleteGroupConversation(conversationId);
      emitConversation(conversationId, 'conversation:deleted', { conversationId });
      return { deleted: true, conversationId };
    },
  };
}

module.exports = { createGroupsService };
