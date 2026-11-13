'use strict';

const fs = require('fs');
const { ok } = require('../../shared/respond');

function makeMediaController() {
  const service = (req) => req.app.locals.mediaService;

  function me(req) {
    return { id: req.user.id, sessionDeviceId: req.session.device_id || null };
  }

  return {
    async initiateUpload(req, res) {
      const result = await service(req).initiateUpload(me(req), req.validated.body);
      ok(res, result, 201);
    },

    async completeUpload(req, res) {
      const { mediaId } = req.validated.params;
      const result = await service(req).completeUpload(me(req), mediaId);
      ok(res, result, 200);
    },

    async getDownloadUrl(req, res) {
      const { mediaId } = req.validated.params;
      const result = await service(req).getDownloadUrl(me(req), mediaId);
      ok(res, result, 200);
    },

    // Local mode authorized raw serve (s3 mode mein 404 — presigned URL use hota hai).
    async getRaw(req, res) {
      const { mediaId } = req.validated.params;
      const result = await service(req).getRawPath(me(req), mediaId);
      res.setHeader('Content-Type', result.contentType || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      fs.createReadStream(result.path).pipe(res);
    },

    async deleteMedia(req, res) {
      const { mediaId } = req.validated.params;
      const result = await service(req).deleteMedia(me(req), mediaId);
      ok(res, result, 200);
    },

    // Mock upload (local mode): PUT body → file. Key path validate hota hai.
    // Public behaviour S3 presigned PUT ke jaisa hai (bina auth, signed URL ke barabar).
    // express.raw body stream pehle hi consume kar chuka hota hai — req.body Buffer use karo.
    mockUpload(req, res) {
      const key = decodeURIComponent(req.params[0] || '');
      const storage = req.app.locals.objectStorage;
      let filePath;
      try {
        filePath = storage.resolveLocalPath(key);
      } catch (err) {
        res.status(400).json({ error: { code: 'INVALID_KEY', message: 'Invalid object key' } });
        return;
      }
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      fs.promises
        .mkdir(require('path').dirname(filePath), { recursive: true })
        .then(() => fs.promises.writeFile(filePath, body))
        .then(() => {
          res.status(200).json({ uploaded: true, byteSize: body.length });
        })
        .catch(() => {
          res.status(500).json({ error: { code: 'UPLOAD_FAILED', message: 'Upload failed' } });
        });
    },
  };
}

module.exports = { makeMediaController };
