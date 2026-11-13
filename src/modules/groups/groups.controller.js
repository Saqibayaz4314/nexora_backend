'use strict';

const { ok } = require('../../shared/respond');

// Controller: req.user/req.session → service ke expected `me` shape.
function makeGroupsController() {
  const service = (req) => req.app.locals.groupsService;

  function me(req) {
    return { id: req.user.id, sessionDeviceId: req.session.device_id || null };
  }

  return {
    async createGroup(req, res) {
      const result = await service(req).createGroup(me(req), req.validated.body);
      ok(res, result, 201);
    },

    async getConversation(req, res) {
      const { conversationId } = req.validated.params;
      const result = await service(req).getConversation(me(req), conversationId);
      ok(res, result, 200);
    },

    async updateGroup(req, res) {
      const { conversationId } = req.validated.params;
      const result = await service(req).updateGroup(me(req), conversationId, req.validated.body);
      ok(res, result, 200);
    },

    async deleteGroup(req, res) {
      const { conversationId } = req.validated.params;
      const result = await service(req).deleteGroup(me(req), conversationId);
      ok(res, result, 200);
    },

    async listMembers(req, res) {
      const { conversationId } = req.validated.params;
      const result = await service(req).listMembers(me(req), conversationId);
      ok(res, result, 200);
    },

    async invite(req, res) {
      const { conversationId } = req.validated.params;
      const { userId } = req.validated.body;
      const result = await service(req).invite(me(req), conversationId, userId);
      ok(res, result, 201);
    },

    async listMyInvites(req, res) {
      const { status, limit } = req.validated.query;
      const result = await service(req).listMyInvites(me(req), status, limit);
      ok(res, result, 200);
    },

    async acceptInvite(req, res) {
      const { inviteId } = req.validated.params;
      const result = await service(req).acceptInvite(me(req), inviteId);
      ok(res, result, 200);
    },

    async declineInvite(req, res) {
      const { inviteId } = req.validated.params;
      const result = await service(req).declineInvite(me(req), inviteId);
      ok(res, result, 200);
    },

    async leaveGroup(req, res) {
      const { conversationId } = req.validated.params;
      const result = await service(req).leaveGroup(me(req), conversationId);
      ok(res, result, 200);
    },

    async hideConversation(req, res) {
      const { conversationId } = req.validated.params;
      const result = await service(req).hideConversation(me(req), conversationId);
      ok(res, result, 200);
    },

    async removeMember(req, res) {
      const { conversationId, userId } = req.validated.params;
      const result = await service(req).removeMember(me(req), conversationId, userId);
      ok(res, result, 200);
    },

    async changeRole(req, res) {
      const { conversationId, userId } = req.validated.params;
      const { role } = req.validated.body;
      const result = await service(req).changeRole(me(req), conversationId, userId, role);
      ok(res, result, 200);
    },
  };
}

module.exports = { makeGroupsController };
