'use strict';

const { ok } = require('../../shared/respond');

// Controller: req.user/req.session → service ke expected `me` shape.
function makeStatusController() {
  const service = (req) => req.app.locals.statusService;

  function me(req) {
    return { id: req.user.id, sessionDeviceId: req.session.device_id || null };
  }

  return {
    async createStatus(req, res) {
      const result = await service(req).createStatus(me(req), req.validated.body);
      ok(res, result, 201);
    },

    async listStatuses(req, res) {
      const { cursor, limit } = req.validated.query;
      const result = await service(req).listStatuses(me(req), cursor, limit);
      ok(res, result, 200);
    },

    async getStatus(req, res) {
      const { postId } = req.validated.params;
      const result = await service(req).getStatus(me(req), postId);
      ok(res, result, 200);
    },

    async markViewed(req, res) {
      const { postId } = req.validated.params;
      const result = await service(req).markViewed(me(req), postId);
      ok(res, result, 200);
    },

    async setReaction(req, res) {
      const { postId } = req.validated.params;
      const { reactionCiphertext } = req.validated.body;
      const result = await service(req).setReaction(me(req), postId, reactionCiphertext);
      ok(res, result, 200);
    },

    async removeReaction(req, res) {
      const { postId } = req.validated.params;
      const result = await service(req).removeReaction(me(req), postId);
      ok(res, result, 200);
    },

    async deleteStatus(req, res) {
      const { postId } = req.validated.params;
      const result = await service(req).deleteStatus(me(req), postId);
      ok(res, result, 200);
    },
  };
}

module.exports = { makeStatusController };
