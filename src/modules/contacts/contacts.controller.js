'use strict';

const { ok } = require('../../shared/respond');

function makeContactsController() {
  const service = (req) => req.app.locals.contactsService;

  return {
    async discover(req, res) {
      const { query } = req.validated.body;
      const result = await service(req).discover(req.user, query);
      ok(res, result, 200);
    },

    async listContacts(req, res) {
      const result = await service(req).listContacts(req.user);
      ok(res, result, 200);
    },

    async addContact(req, res) {
      const { userId } = req.validated.params;
      const { nickname } = req.validated.body;
      const result = await service(req).addContact(req.user, userId, nickname);
      ok(res, result, result.contact.created ? 201 : 200);
    },

    async removeContact(req, res) {
      const { userId } = req.validated.params;
      const result = await service(req).removeContact(req.user, userId);
      ok(res, result, 200);
    },

    async blockUser(req, res) {
      const { userId } = req.validated.params;
      const result = await service(req).blockUser(req.user, userId);
      ok(res, result, 200);
    },

    async unblockUser(req, res) {
      const { userId } = req.validated.params;
      const result = await service(req).unblockUser(req.user, userId);
      ok(res, result, 200);
    },

    async reportUser(req, res) {
      const { userId, reason, details } = req.validated.body;
      const result = await service(req).reportUser(req.user, userId, reason, details);
      ok(res, result, 201);
    },
  };
}

module.exports = { makeContactsController };
