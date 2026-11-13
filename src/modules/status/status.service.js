'use strict';

const crypto = require('crypto');
const { AppError } = require('../../shared/errors');

// Status service — 24h posts (Stage 6).
// - Visibility: author khud + author ke contacts; blocked users kabhi nahi dekh sakte.
// - Media Stage 4 flow se aati hai (upload → complete → status banate waqt mediaId link).
// - Replies normal messages hote hain (messages module statusPostId set karta hai).

function createStatusService({ db, repo, mediaRepo, config }) {
  if (!repo) {
    throw new Error('status service ko repo chahiye');
  }

  const ttlSeconds = (config && config.statusTtlSeconds) || 24 * 60 * 60;

  function ensureDb() {
    if (!db) {
      throw new AppError(503, 'DB_NOT_CONFIGURED', 'Service temporarily unavailable');
    }
  }

  async function requireActiveStatus(postId) {
    const post = await repo.findStatusById(postId);
    // Expired post bhi "not found" jaisa hi treat hota hai — cleanup se pehle bhi
    // client ko kabhi expired content dikhana nahi chahiye.
    if (!post || post.deleted_at || new Date(post.expires_at).getTime() <= Date.now()) {
      throw new AppError(404, 'STATUS_NOT_FOUND', 'Status not found');
    }
    return post;
  }

  async function requireVisible(postId, userId) {
    await requireActiveStatus(postId);
    if (!(await repo.canViewStatus(postId, userId))) {
      throw new AppError(403, 'STATUS_NOT_VISIBLE', 'Status is not visible to you');
    }
  }

  async function validateMedia(mediaId, userId) {
    if (!mediaId) return null;
    if (!mediaRepo) {
      throw new AppError(503, 'MEDIA_NOT_CONFIGURED', 'Media service unavailable');
    }
    const media = await mediaRepo.findMediaById(mediaId);
    if (!media || media.deleted_at) {
      throw new AppError(404, 'MEDIA_NOT_FOUND', 'Media not found');
    }
    if (media.owner_user_id !== userId) {
      throw new AppError(403, 'NOT_MEDIA_OWNER', 'You can only use your own media');
    }
    if (media.status !== 'ready') {
      throw new AppError(409, 'MEDIA_NOT_READY', 'Media upload not completed');
    }
    return media;
  }

  // Status ko view counts + reactions ke saath decorate karta hai.
  async function decorate(postRow, { withViews = false, withReactions = true } = {}) {
    const status = repo.toStatus(postRow);
    const viewsCount = await repo.countViews(status.id);
    const reactions = withReactions ? await repo.listReactions(status.id) : [];
    const views = withViews ? await repo.listViews(status.id) : null;
    return {
      ...status,
      viewsCount,
      views: views
        ? views.map((v) => ({
            userId: v.viewer_user_id,
            name:
              (v.viewer_display_name && String(v.viewer_display_name).trim()) ||
              v.viewer_username ||
              v.viewer_user_id,
            viewedAt: v.viewed_at,
          }))
        : undefined,
      reactions: reactions.map((r) => ({
        userId: r.user_id,
        reactionCiphertext: r.reaction_ciphertext,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    };
  }

  return {
    // POST /status — mediaId optional (text-only status bhi chalega).
    async createStatus(me, { mediaId, captionCiphertext, captionNonce, captionAuthTag, ttlSeconds: customTtl }) {
      ensureDb();
      await validateMedia(mediaId, me.id);

      const ttl = customTtl && customTtl > 0 && customTtl <= ttlSeconds ? customTtl : ttlSeconds;
      const id = crypto.randomUUID();
      const row = await repo.insertStatus({
        id,
        authorUserId: me.id,
        mediaId: mediaId || null,
        captionCiphertext: captionCiphertext || '',
        captionNonce: captionNonce || '',
        captionAuthTag: captionAuthTag || '',
        expiresAt: new Date(Date.now() + ttl * 1000),
      });
      return { status: repo.toStatus(row) };
    },

    // GET /status — visible active posts (newest first).
    async listStatuses(me, cursor, limit) {
      ensureDb();
      let decodedCursor = null;
      if (cursor) {
        decodedCursor = repo.decodeCursor(cursor);
        if (!decodedCursor) {
          throw new AppError(400, 'INVALID_CURSOR', 'Invalid pagination cursor');
        }
      }
      const rows = await repo.listStatuses(me.id, decodedCursor, limit);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      const statuses = [];
      for (const row of page) {
        // eslint-disable-next-line no-await-in-loop
        statuses.push(await decorate(row, { withViews: false }));
      }

      let nextCursor = null;
      if (hasMore && page.length > 0) {
        const last = page[page.length - 1];
        nextCursor = repo.encodeCursor(last.created_at, last.id);
      }
      return { statuses, nextCursor };
    },

    // GET /status/:postId — author ko views bhi milte hain.
    async getStatus(me, postId) {
      ensureDb();
      const post = await requireActiveStatus(postId);
      if (!(await repo.canViewStatus(postId, me.id))) {
        throw new AppError(403, 'STATUS_NOT_VISIBLE', 'Status is not visible to you');
      }
      const isAuthor = post.author_user_id === me.id;
      return { status: await decorate(post, { withViews: isAuthor }) };
    },

    // POST /status/:postId/views — idempotent; author apna view mark nahi karta.
    async markViewed(me, postId) {
      ensureDb();
      const post = await requireActiveStatus(postId);
      if (post.author_user_id === me.id) {
        throw new AppError(400, 'CANNOT_VIEW_OWN_STATUS', 'You cannot view your own status');
      }
      await requireVisible(postId, me.id);
      await repo.upsertView(postId, me.id);
      return { viewed: true, postId };
    },

    // PUT /status/:postId/reaction
    async setReaction(me, postId, reactionCiphertext) {
      ensureDb();
      await requireVisible(postId, me.id);
      await repo.upsertReaction(postId, me.id, reactionCiphertext);
      return { reacted: true, postId };
    },

    // DELETE /status/:postId/reaction
    async removeReaction(me, postId) {
      ensureDb();
      await requireVisible(postId, me.id);
      await repo.deleteReaction(postId, me.id);
      return { removed: true, postId };
    },

    // DELETE /status/:postId — sirf author.
    async deleteStatus(me, postId) {
      ensureDb();
      const post = await requireActiveStatus(postId);
      if (post.author_user_id !== me.id) {
        throw new AppError(403, 'NOT_STATUS_AUTHOR', 'You can only delete your own status');
      }
      const row = await repo.softDeleteStatus(postId, me.id);
      if (!row) {
        throw new AppError(404, 'STATUS_NOT_FOUND', 'Status not found');
      }
      // Media soft-delete → existing media cleanup (7d) S3 object remove karega.
      if (row.media_id && mediaRepo) {
        await mediaRepo.softDeleteMedia(row.media_id).catch(() => {});
      }
      return { deleted: true, postId };
    },
  };
}

module.exports = { createStatusService };
