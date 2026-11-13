'use strict';

// Object storage abstraction (Stage 4 media).
//
// s3 mode: S3-compatible storage (DigitalOcean Spaces/AWS S3) —
//   server-generated keys, presigned PUT (upload) aur GET (download), HEAD, delete.
// local mode: dev fallback — files local disk par (media upload dir), upload URL
//   apna mock-upload endpoint hota hai, download authorized /raw route se.
//
// Client kabhi key choose nahi karta; keys hamesha `media/<userId>/<mediaId>` format mein
// server banata hai.

const fs = require('fs');
const path = require('path');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function safeKey(key) {
  // Path traversal protection — sirf safe segments allow hote hain.
  const clean = path.posix.normalize(key).replace(/^\/+/, '');
  if (clean.split('/').some((seg) => seg === '..' || seg === '')) {
    throw new Error('Invalid object key');
  }
  return clean;
}

function createObjectStorage({ config, logger }) {
  const log = logger || console;
  const hasS3 = config.mediaStorage === 's3' && config.spacesConfigured;
  if (config.isProd && !hasS3) {
    throw new Error('Production media requires MEDIA_STORAGE=s3 and all SPACES_* settings; local storage is disabled.');
  }
  const mode = hasS3 ? 's3' : 'local';

  let s3Client = null;
  if (mode === 's3') {
    s3Client = new S3Client({
      endpoint: config.spaces.endpoint,
      region: 'us-east-1', // S3 SDK requirement — Spaces isay ignore karta hai
      forcePathStyle: true, // Supabase S3 + DigitalOcean Spaces dono path-style support karte hain
      credentials: {
        accessKeyId: config.spaces.key,
        secretAccessKey: config.spaces.secret,
      },
    });
  }

  const uploadDir =
    (config.mediaUploadDir && path.resolve(config.mediaUploadDir)) ||
    path.join(__dirname, '..', '..', 'public', 'uploads');

  function localPath(key) {
    const safe = safeKey(key);
    const filePath = path.join(uploadDir, safe);
    // Double-check: resolve hoke uploadDir ke andar hi rahe.
    if (!filePath.startsWith(uploadDir + path.sep)) {
      throw new Error('Invalid object key path');
    }
    return filePath;
  }

  async function ensureLocalDir() {
    await fs.promises.mkdir(uploadDir, { recursive: true });
  }

  return {
    mode,
    uploadDir,

    isAvailable() {
      return mode === 's3' ? Boolean(s3Client) : true;
    },

    // Upload initiate — presigned PUT URL (s3) ya mock-upload endpoint (local).
    async initiateUpload({ key, contentType }) {
      if (mode === 's3') {
        const command = new PutObjectCommand({
          Bucket: config.spaces.bucket,
          Key: safeKey(key),
          ContentType: contentType || 'application/octet-stream',
        });
        const uploadUrl = await getSignedUrl(s3Client, command, {
          expiresIn: config.mediaPresignSeconds,
        });
        return { uploadUrl, provider: 's3', expiresIn: config.mediaPresignSeconds };
      }
      await ensureLocalDir();
      return {
        uploadUrl: `/api/v1/media/mock-upload/${encodeURIComponent(safeKey(key))}`,
        provider: 'local',
        expiresIn: config.mediaPresignSeconds,
      };
    },

    // Upload ke baad verify: object exist karta hai aur size kya hai.
    async headObject(key) {
      if (mode === 's3') {
        try {
          const command = new HeadObjectCommand({
            Bucket: config.spaces.bucket,
            Key: safeKey(key),
          });
          const res = await s3Client.send(command);
          return { exists: true, byteSize: res.ContentLength || 0 };
        } catch (err) {
          if (err && (err.$metadata?.httpStatusCode === 404 || err.name === 'NotFound' || err.name === 'NoSuchKey')) {
            return { exists: false };
          }
          log.warn({ err: { message: err.message } }, 'S3 headObject failed');
          return { exists: false, error: err.message };
        }
      }
      try {
        const stats = await fs.promises.stat(localPath(key));
        return { exists: true, byteSize: stats.size };
      } catch {
        return { exists: false };
      }
    },

    // Private download — presigned GET (s3); local mode raw route se serve hota hai.
    async getDownloadUrl(key, { expiresSeconds } = {}) {
      if (mode === 's3') {
        const command = new GetObjectCommand({
          Bucket: config.spaces.bucket,
          Key: safeKey(key),
        });
        const downloadUrl = await getSignedUrl(s3Client, command, {
          expiresIn: expiresSeconds || config.mediaPresignSeconds,
        });
        return { downloadUrl, provider: 's3', expiresIn: expiresSeconds || config.mediaPresignSeconds };
      }
      return { downloadUrl: null, provider: 'local', expiresIn: 0 };
    },

    // Local mode ke liye file path (authorized raw route serve karta hai).
    resolveLocalPath(key) {
      return localPath(key);
    },

    async deleteObject(key) {
      if (mode === 's3') {
        try {
          const command = new DeleteObjectCommand({
            Bucket: config.spaces.bucket,
            Key: safeKey(key),
          });
          await s3Client.send(command);
          return true;
        } catch (err) {
          log.warn({ err: { message: err.message } }, 'S3 deleteObject failed');
          return false;
        }
      }
      try {
        await fs.promises.unlink(localPath(key));
        return true;
      } catch {
        return false; // already gone
      }
    },

    // Cleanup mein file exist-check ke liye (tests use karte hain).
    async localExists(key) {
      try {
        await fs.promises.access(localPath(key));
        return true;
      } catch {
        return false;
      }
    },

    // Tests/init ke liye random key material.
    newObjectKey(userId, mediaId) {
      return `media/${userId}/${mediaId}`;
    },
  };
}

module.exports = { createObjectStorage, safeKey };
