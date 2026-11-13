'use strict';

const express = require('express');

const { requireAuth } = require('../auth/authz');
const { makeGroupsController } = require('./groups.controller');
const { validate } = require('../../shared/validate');
const { asyncHandler } = require('../../shared/errors');
const { makeLimiter } = require('../../shared/rate-limit');
const schemas = require('./groups.schemas');

const groupsLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  keyBy: (req) => `groups:${req.ip}`,
});

function makeGroupsRouter() {
  const router = express.Router();
  const ctrl = makeGroupsController();

  // NOTE: /conversations/groups fixed path pehle register hota hai,
  // taake /conversations/:conversationId se clash na ho.
  router.post(
    '/conversations/groups',
    requireAuth,
    groupsLimiter,
    validate(schemas.createGroupSchema),
    asyncHandler(ctrl.createGroup)
  );

  router.get(
    '/conversations/:conversationId',
    requireAuth,
    groupsLimiter,
    validate(schemas.conversationParamsSchema),
    asyncHandler(ctrl.getConversation)
  );
  router.patch(
    '/conversations/:conversationId',
    requireAuth,
    groupsLimiter,
    validate(schemas.updateGroupSchema),
    asyncHandler(ctrl.updateGroup)
  );
  router.delete(
    '/conversations/:conversationId',
    requireAuth,
    groupsLimiter,
    validate(schemas.conversationParamsSchema),
    asyncHandler(ctrl.deleteGroup)
  );

  router.delete(
    '/conversations/:conversationId/self',
    requireAuth,
    groupsLimiter,
    validate(schemas.conversationParamsSchema),
    asyncHandler(ctrl.hideConversation)
  );

  router.get(
    '/conversations/:conversationId/members',
    requireAuth,
    groupsLimiter,
    validate(schemas.conversationParamsSchema),
    asyncHandler(ctrl.listMembers)
  );
  router.post(
    '/conversations/:conversationId/invites',
    requireAuth,
    groupsLimiter,
    validate(schemas.inviteSchema),
    asyncHandler(ctrl.invite)
  );
  router.post(
    '/conversations/:conversationId/leave',
    requireAuth,
    groupsLimiter,
    validate(schemas.conversationParamsSchema),
    asyncHandler(ctrl.leaveGroup)
  );
  router.delete(
    '/conversations/:conversationId/members/:userId',
    requireAuth,
    groupsLimiter,
    validate(schemas.memberActionSchema),
    asyncHandler(ctrl.removeMember)
  );
  router.post(
    '/conversations/:conversationId/members/:userId/role',
    requireAuth,
    groupsLimiter,
    validate(schemas.changeRoleSchema),
    asyncHandler(ctrl.changeRole)
  );

  router.get(
    '/invites',
    requireAuth,
    groupsLimiter,
    validate(schemas.listInvitesSchema),
    asyncHandler(ctrl.listMyInvites)
  );
  router.post(
    '/invites/:inviteId/accept',
    requireAuth,
    groupsLimiter,
    validate(schemas.inviteParamsSchema),
    asyncHandler(ctrl.acceptInvite)
  );
  router.post(
    '/invites/:inviteId/decline',
    requireAuth,
    groupsLimiter,
    validate(schemas.inviteParamsSchema),
    asyncHandler(ctrl.declineInvite)
  );

  return router;
}

module.exports = { makeGroupsRouter };
