'use strict';

const express = require('express');

const { requireAuth } = require('../auth/authz');
const { makeStatusController } = require('./status.controller');
const { validate } = require('../../shared/validate');
const { asyncHandler } = require('../../shared/errors');
const { makeLimiter } = require('../../shared/rate-limit');
const schemas = require('./status.schemas');

const statusLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyBy: (req) => `status:${req.ip}`,
});

function makeStatusRouter() {
  const router = express.Router();
  const ctrl = makeStatusController();

  router.get(
    '/status',
    requireAuth,
    statusLimiter,
    validate(schemas.listStatusesSchema),
    asyncHandler(ctrl.listStatuses)
  );
  router.post(
    '/status',
    requireAuth,
    statusLimiter,
    validate(schemas.createStatusSchema),
    asyncHandler(ctrl.createStatus)
  );

  router.get(
    '/status/:postId',
    requireAuth,
    statusLimiter,
    validate(schemas.statusParamsSchema),
    asyncHandler(ctrl.getStatus)
  );
  router.delete(
    '/status/:postId',
    requireAuth,
    statusLimiter,
    validate(schemas.statusParamsSchema),
    asyncHandler(ctrl.deleteStatus)
  );

  router.post(
    '/status/:postId/views',
    requireAuth,
    statusLimiter,
    validate(schemas.statusParamsSchema),
    asyncHandler(ctrl.markViewed)
  );

  router.put(
    '/status/:postId/reaction',
    requireAuth,
    statusLimiter,
    validate(schemas.statusReactionSchema),
    asyncHandler(ctrl.setReaction)
  );
  router.delete(
    '/status/:postId/reaction',
    requireAuth,
    statusLimiter,
    validate(schemas.statusParamsSchema),
    asyncHandler(ctrl.removeReaction)
  );

  return router;
}

module.exports = { makeStatusRouter };
