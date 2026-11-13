'use strict';

const { z } = require('zod');

const createGroupSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    memberUserIds: z.array(z.uuid()).max(100).optional(),
  }),
});

const conversationParamsSchema = z.object({
  params: z.object({
    conversationId: z.uuid(),
  }),
});

const updateGroupSchema = z.object({
  params: z.object({
    conversationId: z.uuid(),
  }),
  body: z.object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    iconMediaId: z.uuid().nullable().optional(), // null = icon remove
  }),
});

const inviteSchema = z.object({
  params: z.object({
    conversationId: z.uuid(),
  }),
  body: z.object({
    userId: z.uuid(),
  }),
});

const inviteParamsSchema = z.object({
  params: z.object({
    inviteId: z.uuid(),
  }),
});

const listInvitesSchema = z.object({
  query: z.object({
    status: z.enum(['pending', 'accepted', 'declined']).default('pending'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
});

const memberActionSchema = z.object({
  params: z.object({
    conversationId: z.uuid(),
    userId: z.uuid(),
  }),
});

const changeRoleSchema = z.object({
  params: z.object({
    conversationId: z.uuid(),
    userId: z.uuid(),
  }),
  body: z.object({
    role: z.enum(['admin', 'member']), // owner sirf group create par set hota hai
  }),
});

module.exports = {
  createGroupSchema,
  conversationParamsSchema,
  updateGroupSchema,
  inviteSchema,
  inviteParamsSchema,
  listInvitesSchema,
  memberActionSchema,
  changeRoleSchema,
};
