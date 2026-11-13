'use strict';

const express = require('express');

const { requireAuth } = require('../auth/authz');
const { makeCallsController } = require('./calls.controller');
const { validate } = require('../../shared/validate');
const { asyncHandler } = require('../../shared/errors');
const { makeLimiter } = require('../../shared/rate-limit');
const schemas = require('./calls.schemas');

// Calls: initiate/end — normal limiter.
const callsLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyBy: (req) => `calls:${req.ip}`,
});

function makeCallsRouter() {
  const router = express.Router();
  const ctrl = makeCallsController();

  router.get(
    '/calls/turn',
    requireAuth,
    asyncHandler(ctrl.getTurnConfig)
  );

  router.get(
    '/calls/:callId',
    requireAuth,
    callsLimiter,
    validate(schemas.callParamsSchema),
    asyncHandler(ctrl.getCall)
  );
  router.post(
    '/calls/:callId/end',
    requireAuth,
    callsLimiter,
    validate(schemas.callParamsSchema),
    asyncHandler(ctrl.endCall)
  );

  router.post(
    '/conversations/:conversationId/calls',
    requireAuth,
    callsLimiter,
    validate(schemas.initiateCallSchema),
    asyncHandler(ctrl.initiateCall)
  );
  router.get(
    '/conversations/:conversationId/calls',
    requireAuth,
    callsLimiter,
    validate(schemas.listCallsSchema),
    asyncHandler(ctrl.listCalls)
  );

  return router;
}

module.exports = { makeCallsRouter };
