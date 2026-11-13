'use strict';

const express = require('express');

const { requireAuth } = require('../auth/authz');
const { makeMessagesController } = require('./messages.controller');
const { validate } = require('../../shared/validate');
const { asyncHandler } = require('../../shared/errors');
const { makeLimiter } = require('../../shared/rate-limit');
const schemas = require('./messages.schemas');

// Messages: send/edit/delete/receipts thoda zyada sensitive hain — tighter limiter.
const messagesLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  keyBy: (req) => `messages:${req.ip}`,
});

function makeMessagesRouter() {
  const router = express.Router();
  const ctrl = makeMessagesController();

  router.get(
    '/conversations',
    requireAuth,
    messagesLimiter,
    validate(schemas.listConversationsSchema),
    asyncHandler(ctrl.listConversations)
  );
  router.post(
    '/conversations',
    requireAuth,
    messagesLimiter,
    validate(schemas.createConversationSchema),
    asyncHandler(ctrl.createConversation)
  );

  router.get(
    '/conversations/:conversationId/messages',
    requireAuth,
    messagesLimiter,
    validate(schemas.listMessagesSchema),
    asyncHandler(ctrl.listMessages)
  );
  router.post(
    '/conversations/:conversationId/messages',
    requireAuth,
    messagesLimiter,
    validate(schemas.sendMessageSchema),
    asyncHandler(ctrl.sendMessage)
  );

  router.patch(
    '/messages/:messageId',
    requireAuth,
    messagesLimiter,
    validate(schemas.editMessageSchema),
    asyncHandler(ctrl.editMessage)
  );
  router.delete(
    '/messages/:messageId',
    requireAuth,
    messagesLimiter,
    validate(schemas.messageParamsSchema),
    asyncHandler(ctrl.deleteMessage)
  );

  router.put(
    '/messages/:messageId/reaction',
    requireAuth,
    messagesLimiter,
    validate(schemas.reactionSchema),
    asyncHandler(ctrl.setReaction)
  );
  router.delete(
    '/messages/:messageId/reaction',
    requireAuth,
    messagesLimiter,
    validate(schemas.messageParamsSchema),
    asyncHandler(ctrl.removeReaction)
  );

  router.post(
    '/messages/:messageId/receipt',
    requireAuth,
    messagesLimiter,
    validate(schemas.receiptSchema),
    asyncHandler(ctrl.updateReceipt)
  );

  return router;
}

module.exports = { makeMessagesRouter };
