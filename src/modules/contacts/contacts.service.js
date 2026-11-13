'use strict';

const crypto = require('crypto');
const { AppError } = require('../../shared/errors');

function createContactsService({ db, repo }) {
  if (!repo) {
    throw new Error('contacts service ko repo chahiye');
  }

  function ensureDb() {
    if (!db) {
      throw new AppError(503, 'DB_NOT_CONFIGURED', 'Service temporarily unavailable');
    }
  }

  async function loadTargetUser(userId) {
    const row = await repo.findUserById(userId);
    if (!row || row.deleted_at) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }
    return row;
  }

  return {
    // Exact username ya verified email se discovery.
    // Hidden (discoverable=false), deleted, self aur blocked users kabhi return nahi hote.
    async discover(me, query) {
      ensureDb();
      const q = query.trim().toLowerCase();
      const isEmail = q.includes('@');
      const row = isEmail
        ? await repo.discoverByEmailNorm(q, me.id)
        : await repo.discoverByUsernameNorm(q, me.id);
      if (!row) {
        return { users: [] };
      }
      const [iBlockedThem, theyBlockedMe] = await Promise.all([
        repo.isBlocked(me.id, row.id),
        repo.isBlocked(row.id, me.id),
      ]);
      if (iBlockedThem || theyBlockedMe) {
        return { users: [] };
      }
      return { users: [repo.toPublicUser(row)] };
    },

    async listContacts(me) {
      ensureDb();
      const contacts = await repo.listContacts(me.id);
      return { contacts };
    },

    async addContact(me, targetUserId, nickname) {
      ensureDb();
      if (me.id === targetUserId) {
        throw new AppError(400, 'CANNOT_ADD_SELF', 'You cannot add yourself as a contact');
      }
      await loadTargetUser(targetUserId);

      const existing = await repo.findContact(me.id, targetUserId);
      if (existing) {
        if (nickname !== undefined && nickname !== existing.nickname) {
          await repo.updateContactNickname(me.id, targetUserId, nickname);
        }
        return {
          contact: {
            userId: targetUserId,
            nickname: nickname !== undefined ? nickname : existing.nickname,
            created: false,
          },
        };
      }

      await repo.insertContact(me.id, targetUserId, nickname);
      return {
        contact: {
          userId: targetUserId,
          nickname: nickname || '',
          created: true,
        },
      };
    },

    async removeContact(me, targetUserId) {
      ensureDb();
      // Idempotent: contact exist na kare tab bhi success.
      await repo.deleteContact(me.id, targetUserId);
      return { removed: true };
    },

    async blockUser(me, targetUserId) {
      ensureDb();
      if (me.id === targetUserId) {
        throw new AppError(400, 'CANNOT_BLOCK_SELF', 'You cannot block yourself');
      }
      await loadTargetUser(targetUserId);

      const alreadyBlocked = await repo.isBlocked(me.id, targetUserId);
      if (!alreadyBlocked) {
        await repo.insertBlock(me.id, targetUserId);
      }
      return { blocked: true };
    },

    async unblockUser(me, targetUserId) {
      ensureDb();
      // Idempotent: block exist na kare tab bhi success.
      await repo.deleteBlock(me.id, targetUserId);
      return { blocked: false };
    },

    async reportUser(me, targetUserId, reason, details) {
      ensureDb();
      if (me.id === targetUserId) {
        throw new AppError(400, 'CANNOT_REPORT_SELF', 'You cannot report yourself');
      }
      await loadTargetUser(targetUserId);

      const id = crypto.randomUUID();
      await repo.insertReport({
        id,
        reporterId: me.id,
        reportedId: targetUserId,
        reason,
        details,
      });
      return { reportId: id };
    },
  };
}

module.exports = { createContactsService };
