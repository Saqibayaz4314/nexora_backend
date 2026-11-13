'use strict';

const { ok } = require('../../shared/respond');

// Thin controllers: validation aur service calls ke beech sirf mapping.

function makeAuthController() {
  const service = (req) => req.app.locals.authService;

  return {
    async register(req, res) {
      const { username, email, password, displayName, deviceName, platform, identityPublicKey } = req.validated.body;
      const result = await service(req).register({ username, email, password, displayName, deviceName, platform, identityPublicKey });
      ok(res, result, 201);
    },

    async login(req, res) {
      const { identifier, password, deviceName, platform, identityPublicKey } = req.validated.body;
      const result = await service(req).login({ identifier, password, deviceName, platform, identityPublicKey });
      ok(res, result, 200);
    },

    async refresh(req, res) {
      const { refreshToken } = req.validated.body;
      const result = await service(req).refresh(refreshToken);
      ok(res, result, 200);
    },

    async logout(req, res) {
      const { refreshToken } = req.validated.body;
      const result = await service(req).logout(refreshToken);
      ok(res, result, 200);
    },

    async verifyEmail(req, res) {
      const { token } = req.validated.body;
      const result = await service(req).verifyEmail(token);
      ok(res, result, 200);
    },

    async resendVerification(req, res) {
      const { email } = req.validated.body;
      const result = await service(req).resendVerification(email);
      ok(res, result, 200);
    },

    async forgotPassword(req, res) {
      const { email } = req.validated.body;
      const result = await service(req).forgotPassword(email);
      ok(res, result, 200);
    },

    async resetPassword(req, res) {
      const { token, password } = req.validated.body;
      const result = await service(req).resetPassword(token, password);
      ok(res, result, 200);
    },

    async getMe(req, res) {
      const result = await service(req).getMe(req.user.id);
      ok(res, result, 200);
    },

    async deleteAccount(req, res) {
      const result = await service(req).deleteAccount(req.user.id);
      ok(res, result, 200);
    },
  };
}

module.exports = { makeAuthController };
