'use strict';

const crypto = require('crypto');
const { AppError } = require('../../shared/errors');

// Messages service — business logic.
// - Sirf conversation members messages bhej/sakte/dekh sakte hain.
// - Blocked users ko message nahi bhej sakte (dono directions check).
// - Idempotency: (device, clientMessageId) duplicate par same message return.
// - getIo: socket fan-out ke liye lazy accessor (REST path bhi events emit kar sakta hai).

function createMessagesService({ db, repo, contactsRepo, getIo, devicesRepo, pushDispatcher, statusRepo, mediaRepo }) {
  if (!repo) {
    throw new Error('messages service ko repo chahiye');
  }
  if (!contactsRepo) {
    throw new Error('messages service ko contactsRepo chahiye (block checks)');
  }

  function ensureDb() {
    if (!db) {
      throw new AppError(503, 'DB_NOT_CONFIGURED', 'Service temporarily unavailable');
    }
  }

  async function requireMembership(conversationId, userId) {
    const membership = await repo.findMembership(conversationId, userId);
    if (!membership || membership.left_at) {
      throw new AppError(403, 'NOT_CONVERSATION_MEMBER', 'You are not a member of this conversation');
    }
    return membership;
  }

  async function requireMessage(messageId) {
    const message = await repo.findMessageById(messageId);
    if (!message) {
      throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Message not found');
    }
    return message;
  }

  // Media message attach ke liye: apni hi, ready, delete nahi hui media.
  async function requireUsableMedia(mediaId, userId) {
    if (!mediaRepo) {
      throw new AppError(503, 'MEDIA_NOT_CONFIGURED', 'Media service unavailable');
    }
    const media = await mediaRepo.findMediaById(mediaId);
    if (!media || media.deleted_at) {
      throw new AppError(404, 'MEDIA_NOT_FOUND', 'Media not found');
    }
    if (media.owner_user_id !== userId) {
      throw new AppError(403, 'NOT_MEDIA_OWNER', 'You can only attach your own media');
    }
    if (media.status !== 'ready') {
      throw new AppError(409, 'MEDIA_NOT_READY', 'Media upload not completed');
    }
    return media;
  }

  function emitConversation(conversationId, event, payload) {
    const io = getIo ? getIo() : null;
    if (io) {
      io.to(`conversation:${conversationId}`).emit(event, payload);
    }
  }

  function emitToUser(userId, event, payload) {
    const io = getIo ? getIo() : null;
    if (io) {
      io.to(`user:${userId}`).emit(event, payload);
    }
  }

  async function isUserOnline(userId) {
    const io = getIo ? getIo() : null;
    if (!io) return false;
    try {
      const sockets = await io.in(`user:${userId}`).fetchSockets();
      return sockets.length > 0;
    } catch {
      return false;
    }
  }

  // Offline members ko push — content encrypted hai isliye body generic rehti hai.
  async function pushToOfflineMembers(conversationId, senderUserId, messageId, statusPostId = null) {
    if (!pushDispatcher || !devicesRepo) return;
    const memberIds = await repo.listActiveMemberIds(conversationId);
    for (const memberId of memberIds) {
      if (memberId === senderUserId) continue;
      // eslint-disable-next-line no-await-in-loop
      if (await isUserOnline(memberId)) continue;
      // eslint-disable-next-line no-await-in-loop
      const tokens = await devicesRepo.findPushTokensByUserId(memberId);
      if (tokens.length > 0) {
        // eslint-disable-next-line no-await-in-loop
        await pushDispatcher.sendToUserDevices(tokens, {
          title: 'Nexora',
          body: 'New message',
          data: {
            type: 'message',
            conversationId,
            messageId,
            ...(statusPostId ? { statusPostId } : {}),
          },
        });
      }
    }
  }

  // GET /conversations — meri active conversations (preview + unread + peer).
  async function listMyConversations(me, limit) {
    ensureDb();
    const rows = await repo.listConversations(me.id, limit);
    if (rows.length === 0) return { conversations: [] };

    const ids = rows.map((r) => r.id);
    const peerRows = await repo.listConversationPeers(ids, me.id);
    const [lastMessages, unreadCounts, deviceKeys] = await Promise.all([
      repo.listLastMessages(ids, me.id),
      repo.listUnreadCounts(ids, me.id),
      repo.listLatestDeviceKeys(peerRows.map((p) => p.id)),
    ]);

    const lastByConv = new Map(lastMessages.map((m) => [m.conversation_id, m]));
    const unreadByConv = new Map(unreadCounts.map((u) => [u.conversation_id, u.unread_count]));
    const peerByConv = new Map();
    for (const p of peerRows) {
      if (!peerByConv.has(p.conversation_id)) peerByConv.set(p.conversation_id, []);
      peerByConv.get(p.conversation_id).push(p);
    }
    const keyByUser = new Map(deviceKeys.map((k) => [k.user_id, k.identity_public_key]));

    const conversations = rows.map((row) => {
      const conv = {
        id: row.id,
        kind: row.kind,
        name: row.name,
        description: row.description,
        iconMediaId: row.icon_media_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        myRole: row.role,
        unreadCount: unreadByConv.get(row.id) || 0,
        lastMessage: null,
        peer: null,
      };
      const last = lastByConv.get(row.id);
      if (last) {
        conv.lastMessage = {
          messageType: last.message_type,
          senderUserId: last.sender_user_id,
          createdAt: last.created_at,
        };
      }
      if (row.kind === 'one_to_one') {
        const peers = peerByConv.get(row.id) || [];
        if (peers.length > 0) {
          const p = peers[0];
          conv.peer = {
            id: p.id,
            username: p.username,
            displayName: p.display_name,
            identityPublicKey: keyByUser.get(p.id) || null,
          };
        }
      }
      return conv;
    });

    return { conversations };
  }

  return {
    listMyConversations,

    // POST /conversations — contact ke saath one_to_one get-or-create.
    async createOneToOneConversation(me, peerUserId) {
      ensureDb();
      if (peerUserId === me.id) {
        throw new AppError(400, 'CANNOT_CONVERSE_WITH_SELF', 'You cannot create a conversation with yourself');
      }
      const peer = await repo.findUserById(peerUserId);
      if (!peer) {
        throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
      }
      const [iBlockedThem, theyBlockedMe] = await Promise.all([
        contactsRepo.isBlocked(me.id, peerUserId),
        contactsRepo.isBlocked(peerUserId, me.id),
      ]);
      if (iBlockedThem || theyBlockedMe) {
        throw new AppError(403, 'CANNOT_MESSAGE_USER', 'You cannot message this user');
      }

      const existing = await repo.findOneToOne(me.id, peerUserId);
      if (existing) {
        const { conversations } = await listMyConversations(me, 100);
        const found = conversations.find((c) => c.id === existing.id) || null;
        if (found) {
          emitToUser(peerUserId, 'conversation:created', { conversation: found });
        }
        return { conversation: found || { id: existing.id }, created: false };
      }

      const row = await repo.createOneToOne(me.id, peerUserId, crypto.randomUUID());
      const { conversations } = await listMyConversations(me, 100);
      const created = conversations.find((c) => c.id === row.id) || null;
      if (created) {
        emitToUser(peerUserId, 'conversation:created', { conversation: created });
      }
      return { conversation: created || { id: row.id, kind: row.kind }, created: true };
    },

    // GET /conversations/:id/messages — cursor pagination, newest first.
    async listMessages(me, conversationId, cursor, limit) {
      ensureDb();
      const membership = await requireMembership(conversationId, me.id);

      let decodedCursor = null;
      if (cursor) {
        decodedCursor = repo.decodeCursor(cursor);
        if (!decodedCursor) {
          throw new AppError(400, 'INVALID_CURSOR', 'Invalid pagination cursor');
        }
      }

      const rows = await repo.listMessages(conversationId, decodedCursor, limit, membership.history_cleared_at);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      const reactions = await repo.listReactionsForMessages(page.map((r) => r.id));
      const reactionsByMessage = new Map();
      for (const r of reactions) {
        if (!reactionsByMessage.has(r.message_id)) reactionsByMessage.set(r.message_id, []);
        reactionsByMessage.get(r.message_id).push({
          userId: r.user_id,
          reactionCiphertext: r.reaction_ciphertext,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        });
      }

      const messages = page.map((row) => ({
        ...repo.toMessage(row),
        reactions: reactionsByMessage.get(row.id) || [],
      }));

      let nextCursor = null;
      if (hasMore && page.length > 0) {
        const last = page[page.length - 1];
        nextCursor = repo.encodeCursor(last.created_at, last.id);
      }

      return { messages, nextCursor };
    },

    // POST /conversations/:id/messages — idempotent send.
    async sendMessage(me, conversationId, payload) {
      ensureDb();
      const { clientMessageId, messageType, ciphertext, nonce, authTag, replyToId, statusPostId, mediaId } = payload;
      const membership = await requireMembership(conversationId, me.id);

      // Block check: one_to_one conversation ke doosre member ke saath dono directions.
      let otherId = null;
      if (membership.kind === 'one_to_one') {
        otherId = await repo.getOtherMemberId(conversationId, me.id);
        if (otherId) {
          const [iBlockedThem, theyBlockedMe] = await Promise.all([
            contactsRepo.isBlocked(me.id, otherId),
            contactsRepo.isBlocked(otherId, me.id),
          ]);
          if (iBlockedThem || theyBlockedMe) {
            throw new AppError(403, 'CANNOT_MESSAGE_USER', 'You cannot message this user');
          }
        }
      }

      const senderDeviceId = me.sessionDeviceId || null;

      // Idempotency: same device + same clientMessageId → same message.
      if (clientMessageId && senderDeviceId) {
        const existing = await repo.findMessageByClientId(senderDeviceId, clientMessageId, conversationId);
        if (existing) {
          return { message: repo.toMessage(existing), created: false };
        }
      }

      // reply_to_id validate: same conversation ka message hona chahiye.
      if (replyToId) {
        const replied = await repo.findMessageById(replyToId);
        if (!replied || replied.conversation_id !== conversationId) {
          throw new AppError(400, 'INVALID_REPLY_TARGET', 'Reply target must be a message in the same conversation');
        }
      }

      // Status reply validate: sirf one_to_one, status active ho, author doosra member ho.
      if (statusPostId) {
        if (!statusRepo) {
          throw new AppError(503, 'STATUS_UNAVAILABLE', 'Status service unavailable');
        }
        if (membership.kind !== 'one_to_one' || !otherId) {
          throw new AppError(400, 'INVALID_STATUS_REPLY', 'Status replies are only allowed in one-to-one conversations');
        }
        const post = await statusRepo.findStatusById(statusPostId);
        if (!post || post.deleted_at) {
          throw new AppError(400, 'INVALID_STATUS_REPLY', 'Status not found');
        }
        if (post.author_user_id !== otherId) {
          throw new AppError(400, 'INVALID_STATUS_REPLY', 'Status reply target must belong to the other member');
        }
        // DB ke now() se compare — client clock trust nahi karte.
        const active = await statusRepo.isStatusActive(statusPostId);
        if (!active) {
          throw new AppError(400, 'INVALID_STATUS_REPLY', 'Status has expired');
        }
      }

      // Media attach rules: media type → mediaId required; mediaId → media type non-text.
      // Text-only messages ko mediaId nahi chahiye (caption media ke saath ciphertext mein jata hai).
      if (mediaId) {
        if (messageType === 'text') {
          throw new AppError(400, 'MEDIA_MESSAGE_TYPE_MISMATCH', 'Media attachments require a media message type');
        }
        await requireUsableMedia(mediaId, me.id);
      } else if (messageType !== 'text') {
        throw new AppError(400, 'MEDIA_ID_REQUIRED', 'Media messages require mediaId');
      }

      const id = crypto.randomUUID();
      const row = await repo.insertMessage({
        id,
        clientMessageId: clientMessageId || null,
        conversationId,
        senderUserId: me.id,
        senderDeviceId,
        messageType,
        ciphertext,
        nonce,
        authTag,
        replyToId: replyToId || null,
        statusPostId: statusPostId || null,
        mediaId: mediaId || null,
      });
      await repo.insertOwnReceipt(id, me.id);
      await repo.touchConversation(conversationId);

      const message = repo.toMessage(row);
      emitConversation(conversationId, 'message:received', { message });
      // Offline members ko FCM push (best-effort — errors send ko fail nahi karte).
      pushToOfflineMembers(conversationId, me.id, id, statusPostId || null).catch(() => {});

      return { message, created: true };
    },

    async editMessage(me, messageId, { ciphertext, nonce, authTag }) {
      ensureDb();
      const message = await requireMessage(messageId);
      await requireMembership(message.conversation_id, me.id);
      if (message.sender_user_id !== me.id) {
        throw new AppError(403, 'NOT_MESSAGE_SENDER', 'You can only edit your own messages');
      }
      const updated = await repo.updateMessageEdit(messageId, me.id, ciphertext, nonce, authTag);
      if (!updated) {
        throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Message not found or already deleted');
      }
      const messageOut = repo.toMessage(updated);
      emitConversation(message.conversation_id, 'message:edited', { message: messageOut });
      return { message: messageOut };
    },

    async deleteMessage(me, messageId) {
      ensureDb();
      const message = await requireMessage(messageId);
      await requireMembership(message.conversation_id, me.id);
      if (message.sender_user_id !== me.id) {
        throw new AppError(403, 'NOT_MESSAGE_SENDER', 'You can only delete your own messages');
      }
      const deleted = await repo.softDeleteMessage(messageId, me.id);
      if (!deleted) {
        throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Message not found or already deleted');
      }
      emitConversation(message.conversation_id, 'message:deleted', {
        messageId,
        conversationId: message.conversation_id,
      });
      return { deleted: true, messageId };
    },

    async setReaction(me, messageId, reactionCiphertext) {
      ensureDb();
      const message = await requireMessage(messageId);
      await requireMembership(message.conversation_id, me.id);
      await repo.upsertReaction(messageId, me.id, reactionCiphertext);
      emitConversation(message.conversation_id, 'message:reacted', {
        messageId,
        conversationId: message.conversation_id,
        userId: me.id,
        reactionCiphertext,
      });
      return { reacted: true, messageId };
    },

    async removeReaction(me, messageId) {
      ensureDb();
      const message = await requireMessage(messageId);
      await requireMembership(message.conversation_id, me.id);
      await repo.deleteReaction(messageId, me.id);
      emitConversation(message.conversation_id, 'message:reaction:removed', {
        messageId,
        conversationId: message.conversation_id,
        userId: me.id,
      });
      return { removed: true, messageId };
    },

    async updateReceipt(me, messageId, status) {
      ensureDb();
      const message = await requireMessage(messageId);
      if (message.sender_user_id === me.id) {
        throw new AppError(400, 'CANNOT_RECEIPT_OWN_MESSAGE', 'You cannot send receipts for your own message');
      }
      await requireMembership(message.conversation_id, me.id);
      await repo.upsertReceipt(messageId, me.id, status);
      emitConversation(message.conversation_id, status === 'seen' ? 'message:seen' : 'message:delivered', {
        messageId,
        conversationId: message.conversation_id,
        userId: me.id,
      });
      return { receipt: status, messageId };
    },
  };
}

module.exports = { createMessagesService };
