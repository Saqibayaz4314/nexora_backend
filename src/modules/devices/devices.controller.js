'use strict';

const { ok } = require('../../shared/respond');

function makeDevicesController() {
  const service = (req) => req.app.locals.devicesService;

  function me(req) {
    return { id: req.user.id, sessionDeviceId: req.session.device_id || null };
  }

  return {
    async registerPushToken(req, res) {
      const result = await service(req).registerPushToken(me(req), req.validated.body);
      ok(res, result, 200);
    },
  };
}

module.exports = { makeDevicesController };
