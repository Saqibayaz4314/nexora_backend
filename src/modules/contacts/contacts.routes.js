'use strict';

const express = require('express');

const { requireAuth } = require('../auth/authz');
const { makeContactsController } = require('./contacts.controller');
const { validate } = require('../../shared/validate');
const { asyncHandler } = require('../../shared/errors');
const { makeLimiter } = require('../../shared/rate-limit');
const schemas = require('./contacts.schemas');

const discoverLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyBy: (req) => `discover:${req.ip}`,
});

const contactsLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  keyBy: (req) => `contacts:${req.ip}`,
});

// /contacts routes
function makeContactsRouter() {
  const router = express.Router();
  const ctrl = makeContactsController();

  router.post('/discover', requireAuth, discoverLimiter, validate(schemas.discoverSchema), asyncHandler(ctrl.discover));
  router.get('/', requireAuth, contactsLimiter, asyncHandler(ctrl.listContacts));
  router.post('/:userId', requireAuth, contactsLimiter, validate(schemas.addContactSchema), asyncHandler(ctrl.addContact));
  router.delete('/:userId', requireAuth, contactsLimiter, validate(schemas.contactParamsSchema), asyncHandler(ctrl.removeContact));

  return router;
}

// /users/:userId/block + /reports routes
function makeSafetyRouter() {
  const router = express.Router();
  const ctrl = makeContactsController();

  router.post('/users/:userId/block', requireAuth, contactsLimiter, validate(schemas.contactParamsSchema), asyncHandler(ctrl.blockUser));
  router.delete('/users/:userId/block', requireAuth, contactsLimiter, validate(schemas.contactParamsSchema), asyncHandler(ctrl.unblockUser));
  router.post('/reports', requireAuth, contactsLimiter, validate(schemas.reportSchema), asyncHandler(ctrl.reportUser));

  return router;
}

module.exports = { makeContactsRouter, makeSafetyRouter };
