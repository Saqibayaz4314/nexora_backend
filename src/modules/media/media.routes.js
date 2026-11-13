'use strict';

const express = require('express');
const config = require('../../config');

const { requireAuth } = require('../auth/authz');
const { makeMediaController } = require('./media.controller');
const { validate } = require('../../shared/validate');
const { asyncHandler } = require('../../shared/errors');
const { makeLimiter } = require('../../shared/rate-limit');
const schemas = require('./media.schemas');

const mediaLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyBy: (req) => `media:${req.ip}`,
});

function makeMediaRouter() {
  const router = express.Router();
  const ctrl = makeMediaController();

  router.post('/upload-url', requireAuth, mediaLimiter, validate(schemas.initiateUploadSchema), asyncHandler(ctrl.initiateUpload));
  router.post('/:mediaId/complete', requireAuth, mediaLimiter, validate(schemas.mediaParamsSchema), asyncHandler(ctrl.completeUpload));
  router.get('/:mediaId/download-url', requireAuth, mediaLimiter, validate(schemas.mediaParamsSchema), asyncHandler(ctrl.getDownloadUrl));
  router.get('/:mediaId/raw', requireAuth, mediaLimiter, validate(schemas.mediaParamsSchema), asyncHandler(ctrl.getRaw));
  router.delete('/:mediaId', requireAuth, mediaLimiter, validate(schemas.mediaParamsSchema), asyncHandler(ctrl.deleteMedia));

  // Dev local uploads only; reject before parsing large bodies in production/S3.
  router.put('/mock-upload/*', (req, res, next) => {
    if (config.isProd || req.app.locals.objectStorage?.mode !== 'local') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
    return next();
  }, express.raw({ type: '*/*', limit: '120mb' }), (req, res) => ctrl.mockUpload(req, res));

  return router;
}

module.exports = { makeMediaRouter };
