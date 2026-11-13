'use strict';

const { ok } = require('../../shared/respond');

// Controller: req.user/req.session → service ke expected `me` shape.
function makeCallsController() {
  const service = (req) => req.app.locals.callsService;

  function me(req) {
    return { id: req.user.id, sessionDeviceId: req.session.device_id || null };
  }

  return {
    async initiateCall(req, res) {
      const { conversationId } = req.validated.params;
      const result = await service(req).initiateCall(me(req), conversationId, req.validated.body);
      ok(res, result, 201);
    },

    async getCall(req, res) {
      const { callId } = req.validated.params;
      const result = await service(req).getCall(me(req), callId);
      ok(res, result, 200);
    },

    async endCall(req, res) {
      const { callId } = req.validated.params;
      const result = await service(req).endCall(me(req), callId);
      ok(res, result, 200);
    },

    async listCalls(req, res) {
      const { conversationId } = req.validated.params;
      const { cursor, limit } = req.validated.query;
      const result = await service(req).listCalls(me(req), conversationId, cursor, limit);
      ok(res, result, 200);
    },

    async getTurnConfig(req, res) {
      const result = service(req).getTurnConfig();
      ok(res, result, 200);
    },
  };
}

module.exports = { makeCallsController };
