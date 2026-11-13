'use strict';

const { z } = require('zod');

// Call payload validation. SDP max len generous hai (trickle-ICE bhi fit ho jaye).
const initiateCallSchema = z.object({
  params: z.object({
    conversationId: z.uuid(),
  }),
  body: z.object({
    callType: z.enum(['voice', 'video']),
    offerSdp: z.string().min(1).max(100000).optional(),
  }),
});

const listCallsSchema = z.object({
  params: z.object({
    conversationId: z.uuid(),
  }),
  query: z.object({
    cursor: z.string().max(256).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  }),
});

const callParamsSchema = z.object({
  params: z.object({
    callId: z.uuid(),
  }),
});

module.exports = {
  initiateCallSchema,
  listCallsSchema,
  callParamsSchema,
};
