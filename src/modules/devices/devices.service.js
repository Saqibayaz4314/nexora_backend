'use strict';

const { AppError } = require('../../shared/errors');

function createDevicesService({ db, repo }) {
  if (!repo) {
    throw new Error('devices service ko repo chahiye');
  }

  function ensureDb() {
    if (!db) {
      throw new AppError(503, 'DB_NOT_CONFIGURED', 'Service temporarily unavailable');
    }
  }

  return {
    // Push token register — session ke device ya explicit deviceId par.
    async registerPushToken(me, { deviceId, pushToken }) {
      ensureDb();

      const targetDeviceId = deviceId || me.sessionDeviceId;
      if (!targetDeviceId) {
        throw new AppError(400, 'DEVICE_NOT_REGISTERED', 'No device associated with this session — provide deviceId');
      }

      const device = await repo.findDeviceById(targetDeviceId);
      if (!device || device.revoked_at) {
        throw new AppError(404, 'DEVICE_NOT_FOUND', 'Device not found');
      }
      if (device.user_id !== me.id) {
        throw new AppError(403, 'NOT_YOUR_DEVICE', 'This device does not belong to you');
      }

      await repo.upsertPushToken(targetDeviceId, pushToken);
      return { registered: true, deviceId: targetDeviceId };
    },
  };
}

module.exports = { createDevicesService };
