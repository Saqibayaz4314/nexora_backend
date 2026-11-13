'use strict';

const express = require('express');

const { requireAuth } = require('../auth/authz');
const { makeDevicesController } = require('./devices.controller');
const { validate } = require('../../shared/validate');
const { asyncHandler } = require('../../shared/errors');
const { makeLimiter } = require('../../shared/rate-limit');
const schemas = require('./devices.schemas');

const devicesLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyBy: (req) => `devices:${req.ip}`,
});

function makeDevicesRouter() {
  const router = express.Router();
  const ctrl = makeDevicesController();

  router.put('/push-token', requireAuth, devicesLimiter, validate(schemas.pushTokenSchema), asyncHandler(ctrl.registerPushToken));

  return router;
}

module.exports = { makeDevicesRouter };
