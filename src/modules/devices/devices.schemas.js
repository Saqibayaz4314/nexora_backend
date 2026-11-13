'use strict';

const { z } = require('zod');

const pushTokenSchema = z.object({
  body: z.object({
    // Optional: explicitly target device. Agar nahi diya to session ka device use hota hai.
    deviceId: z.uuid().optional(),
    pushToken: z.string().trim().min(32).max(512),
  }),
});

module.exports = { pushTokenSchema };
