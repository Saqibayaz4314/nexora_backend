'use strict';

const { z } = require('zod');

// Status payload validation — caption encrypted hoga (khali allowed: media-only status).
const createStatusSchema = z.object({
  body: z.object({
    mediaId: z.uuid().optional(),
    captionCiphertext: z.string().max(100000).optional(),
    captionNonce: z.string().max(64).optional(),
    captionAuthTag: z.string().max(64).optional(),
    ttlSeconds: z.coerce.number().int().min(1).max(24 * 60 * 60).optional(),
  }),
});

const listStatusesSchema = z.object({
  query: z.object({
    cursor: z.string().max(256).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  }),
});

const statusParamsSchema = z.object({
  params: z.object({
    postId: z.uuid(),
  }),
});

const statusReactionSchema = z.object({
  params: z.object({
    postId: z.uuid(),
  }),
  body: z.object({
    reactionCiphertext: z.string().min(1).max(1000),
  }),
});

module.exports = {
  createStatusSchema,
  listStatusesSchema,
  statusParamsSchema,
  statusReactionSchema,
};
