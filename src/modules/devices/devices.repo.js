'use strict';

// Devices repository — PostgreSQL queries (push tokens etc).

function createDevicesRepo({ db }) {
  const q = (text, params) => {
    if (!db) {
      const err = new Error('Database configured nahi hai');
      err.code = 'DB_NOT_CONFIGURED';
      throw err;
    }
    return db.query(text, params);
  };

  return {
    async findDeviceById(id) {
      const res = await q('SELECT * FROM devices WHERE id = $1 LIMIT 1', [id]);
      return res.rows[0] || null;
    },

    async upsertPushToken(deviceId, pushToken) {
      await q(
        `UPDATE devices SET push_token = $2, last_seen_at = now()
         WHERE id = $1 AND revoked_at IS NULL`,
        [deviceId, pushToken]
      );
    },

    // User ke saare active devices ke push tokens (offline push ke liye).
    async findPushTokensByUserId(userId) {
      const res = await q(
        `SELECT push_token FROM devices
         WHERE user_id = $1 AND revoked_at IS NULL AND push_token IS NOT NULL AND push_token <> ''`,
        [userId]
      );
      return res.rows.map((r) => r.push_token);
    },
  };
}

module.exports = { createDevicesRepo };
