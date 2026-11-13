'use strict';

const { z } = require('zod');

const discoverSchema = z.object({
  body: z.object({
    query: z.string().trim().min(3).max(255),
  }),
});

const contactParamsSchema = z.object({
  params: z.object({
    userId: z.uuid(),
  }),
});

const addContactSchema = z.object({
  params: z.object({
    userId: z.uuid(),
  }),
  body: z.object({
    nickname: z.string().trim().max(100).optional(),
  }),
});

const reportSchema = z.object({
  body: z.object({
    userId: z.uuid(),
    reason: z.string().trim().min(2).max(32),
    details: z.string().trim().max(500).optional(),
  }),
});

module.exports = { discoverSchema, contactParamsSchema, addContactSchema, reportSchema };
