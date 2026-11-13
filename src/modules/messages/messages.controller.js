'use strict';

const { ok } = require('../../shared/respond');

// Controller: req.user/req.session ko service ke expected `me` shape mein convert karta hai.
function makeMessagesController() {
  const service = (req) => req.app.locals.messagesService;

  function me(req) {
    return { id: req.user.id, sessionDeviceId: req.session.device_id || null };
  }

  return {
    async listConversations(req, res) {
      const { limit } = req.validated.query;
      const result = await service(req).listMyConversations(me(req), limit);
      ok(res, result, 200);
    },

    async createConversation(req, res) {
      const { peerUserId } = req.validated.body;
      const result = await service(req).createOneToOneConversation(me(req), peerUserId);
      ok(res, result, result.created ? 201 : 200);
    },

    async listMessages(req, res) {
      const { conversationId } = req.validated.params;
      const { cursor, limit } = req.validated.query;
      const result = await service(req).listMessages(me(req), conversationId, cursor, limit);
      ok(res, result, 200);
    },

    async sendMessage(req, res) {
      const { conversationId } = req.validated.params;
      const result = await service(req).sendMessage(me(req), conversationId, req.validated.body);
      ok(res, result, result.created ? 201 : 200);
    },

    async editMessage(req, res) {
      const { messageId } = req.validated.params;
      const result = await service(req).editMessage(me(req), messageId, req.validated.body);
      ok(res, result, 200);
    },

    async deleteMessage(req, res) {
      const { messageId } = req.validated.params;
      const result = await service(req).deleteMessage(me(req), messageId);
      ok(res, result, 200);
    },

    async setReaction(req, res) {
      const { messageId } = req.validated.params;
      const { reactionCiphertext } = req.validated.body;
      const result = await service(req).setReaction(me(req), messageId, reactionCiphertext);
      ok(res, result, 200);
    },

    async removeReaction(req, res) {
      const { messageId } = req.validated.params;
      const result = await service(req).removeReaction(me(req), messageId);
      ok(res, result, 200);
    },

    async updateReceipt(req, res) {
      const { messageId } = req.validated.params;
      const { status } = req.validated.body;
      const result = await service(req).updateReceipt(me(req), messageId, status);
      ok(res, result, 200);
    },
  };
}

module.exports = { makeMessagesController };
