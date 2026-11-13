'use strict';

const crypto = require('crypto');
const { AppError } = require('../../shared/errors');

// Media service — business logic.
// - Object keys server-generated hain: media/<userId>/<mediaId>.
// - Initiate par type/size/MIME validation server-side hoti hai.
// - Complete par actual object verify hota hai (exists + size).
// - Download: sirf owner ya us message ke conversation member (jo media se linked hai).
// - Delete: sirf owner, soft delete + object best-effort remove.

function createMediaService({ db, repo, storage, limits, statusRepo }) {
  if (!repo) {
    throw new Error('media service ko repo chahiye');
  }
  if (!storage) {
    throw new Error('media service ko storage chahiye');
  }

  function ensureDb() {
    if (!db) {
      throw new AppError(503, 'DB_NOT_CONFIGURED', 'Service temporarily unavailable');
    }
  }

  function ensureStorage() {
    if (!storage.isAvailable()) {
      throw new AppError(503, 'MEDIA_NOT_CONFIGURED', 'Media storage is not configured');
    }
  }

  function validateLimits(mediaType, byteSize, contentType) {
    const limit = limits[mediaType];
    if (!limit) {
      throw new AppError(400, 'INVALID_MEDIA_TYPE', 'Unsupported media type');
    }
    if (byteSize > limit.maxBytes) {
      throw new AppError(
        400,
        'MEDIA_TOO_LARGE',
        `${mediaType} maximum size is ${Math.floor(limit.maxBytes / (1024 * 1024))} MB`
      );
    }
    const typeOk = limit.contentTypes.some(
      (prefix) => contentType === prefix || contentType.startsWith(prefix)
    );
    if (!typeOk) {
      throw new AppError(400, 'INVALID_CONTENT_TYPE', `Content type not allowed for ${mediaType}`);
    }
  }

  async function requireMedia(mediaId) {
    const media = await repo.findMediaById(mediaId);
    if (!media || media.deleted_at) {
      throw new AppError(404, 'MEDIA_NOT_FOUND', 'Media not found');
    }
    return media;
  }

  // Download authz: owner ya linked message ke conversation ka member,
  // ya kisi visible status post ki media (author ke contacts).
  async function canAccess(media, userId) {
    if (media.owner_user_id === userId) return true;
    const message = await repo.findMessageForMedia(media.id);
    if (message) {
      return repo.isConversationMember(message.conversation_id, userId);
    }
    if (statusRepo) {
      const post = await statusRepo.findStatusByMediaId(media.id);
      if (post) {
        return statusRepo.canViewStatus(post.id, userId);
      }
    }
    return false;
  }

  return {
    // POST /media/upload-url — initiate.
    async initiateUpload(me, { mediaType, byteSize, contentType, checksum, encryptionNonce, encryptionAuthTag }) {
      ensureDb();
      ensureStorage();
      validateLimits(mediaType, byteSize, contentType);

      const id = crypto.randomUUID();
      const s3Key = storage.newObjectKey(me.id, id);

      const row = await repo.insertMedia({
        id,
        ownerUserId: me.id,
        s3Key,
        mediaType,
        contentType,
        byteSize,
        checksum: checksum || '',
        encryptionNonce: encryptionNonce || '',
        encryptionAuthTag: encryptionAuthTag || '',
      });

      const { uploadUrl, provider, expiresIn } = await storage.initiateUpload({
        key: s3Key,
        contentType,
      });

      return {
        mediaId: id,
        uploadUrl,
        provider,
        expiresIn,
        status: row.status,
      };
    },

    // POST /media/:id/complete — upload ke baad finalize.
    async completeUpload(me, mediaId) {
      ensureDb();
      ensureStorage();
      const media = await requireMedia(mediaId);
      if (media.owner_user_id !== me.id) {
        throw new AppError(403, 'NOT_MEDIA_OWNER', 'This media does not belong to you');
      }
      if (media.status === 'ready') {
        return { mediaId, status: 'ready', byteSize: Number(media.byte_size), alreadyCompleted: true };
      }

      const head = await storage.headObject(media.s3_key);
      if (!head.exists) {
        throw new AppError(409, 'MEDIA_UPLOAD_MISSING', 'Uploaded object not found — upload first, then complete');
      }

      const actualSize = head.byteSize;
      if (media.byte_size > 0 && actualSize > 0 && actualSize !== Number(media.byte_size)) {
        throw new AppError(409, 'MEDIA_SIZE_MISMATCH', `Claimed ${media.byte_size} bytes but object is ${actualSize} bytes`);
      }

      const updated = await repo.markReady(mediaId, actualSize);
      if (!updated) {
        throw new AppError(409, 'MEDIA_NOT_PENDING', 'Media is not in pending state');
      }
      return { mediaId, status: 'ready', byteSize: Number(updated.byte_size) };
    },

    // GET /media/:id/download-url — private, authorized.
    async getDownloadUrl(me, mediaId) {
      ensureDb();
      ensureStorage();
      const media = await requireMedia(mediaId);
      if (media.status !== 'ready') {
        throw new AppError(403, 'MEDIA_NOT_READY', 'Media is not ready yet');
      }
      const allowed = await canAccess(media, me.id);
      if (!allowed) {
        throw new AppError(403, 'MEDIA_ACCESS_DENIED', 'You do not have access to this media');
      }

      const { downloadUrl, provider, expiresIn } = await storage.getDownloadUrl(media.s3_key);
      return {
        mediaId,
        downloadUrl, // local mode mein null — /raw route use karo
        provider,
        expiresIn,
        mediaType: media.media_type,
        contentType: media.content_type,
        byteSize: Number(media.byte_size),
        encryptionNonce: media.encryption_nonce || '',
        encryptionAuthTag: media.encryption_auth_tag || '',
      };
    },

    // Local mode authorized raw file path (controller serve karta hai).
    async getRawPath(me, mediaId) {
      ensureDb();
      const media = await requireMedia(mediaId);
      if (media.status !== 'ready') {
        throw new AppError(403, 'MEDIA_NOT_READY', 'Media is not ready yet');
      }
      const allowed = await canAccess(media, me.id);
      if (!allowed) {
        throw new AppError(403, 'MEDIA_ACCESS_DENIED', 'You do not have access to this media');
      }
      if (storage.mode !== 'local') {
        throw new AppError(404, 'RAW_DOWNLOAD_UNAVAILABLE', 'Use the presigned download URL instead');
      }
      return {
        path: storage.resolveLocalPath(media.s3_key),
        contentType: media.content_type,
      };
    },

    // DELETE /media/:id — owner only, soft delete + object remove.
    async deleteMedia(me, mediaId) {
      ensureDb();
      const media = await requireMedia(mediaId);
      if (media.owner_user_id !== me.id) {
        throw new AppError(403, 'NOT_MEDIA_OWNER', 'This media does not belong to you');
      }
      const deleted = await repo.softDeleteMedia(mediaId);
      if (!deleted) return { deleted: true, mediaId }; // already deleted

      // Object best-effort remove — DB soft delete already committed.
      await storage.deleteObject(deleted.s3_key).catch(() => false);
      return { deleted: true, mediaId };
    },
  };
}

module.exports = { createMediaService };
