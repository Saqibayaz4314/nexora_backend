'use strict';

const { z } = require('zod');

// Client ke liye allowed message types — 'system' sirf server generate karta hai.
const MESSAGE_TYPES = ['text', 'image', 'video', 'audio', 'document'];

const sendMessageSchema = z.object({
  params: z.object({
    conversationId: z.uuid(),
  }),
  body: z.object({
    clientMessageId: z.string().trim().min(1).max(64).optional(),
    messageType: z.enum(MESSAGE_TYPES),
    ciphertext: z.string().min(1).max(100000),
    nonce: z.string().min(1).max(64),
    authTag: z.string().min(1).max(64),
    replyToId: z.uuid().optional(),
    statusPostId: z.uuid().optional(),
    mediaId: z.uuid().optional(),
  }),
});

const listMessagesSchema = z.object({
  params: z.object({
    conversationId: z.uuid(),
  }),
  query: z.object({
    cursor: z.string().max(256).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  }),
});

const editMessageSchema = z.object({
  params: z.object({
    messageId: z.uuid(),
  }),
  body: z.object({
    ciphertext: z.string().min(1).max(100000),
    nonce: z.string().min(1).max(64),
    authTag: z.string().min(1).max(64),
  }),
});

const messageParamsSchema = z.object({
  params: z.object({
    messageId: z.uuid(),
  }),
});

const reactionSchema = z.object({
  params: z.object({
    messageId: z.uuid(),
  }),
  body: z.object({
    reactionCiphertext: z.string().min(1).max(100000),
  }),
});

const receiptSchema = z.object({
  params: z.object({
    messageId: z.uuid(),
  }),
  body: z.object({
    status: z.enum(['delivered', 'seen']),
  }),
});

const listConversationsSchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(100),
  }),
});

const createConversationSchema = z.object({
  body: z.object({
    peerUserId: z.uuid(),
  }),
});

module.exports = {
  MESSAGE_TYPES,
  sendMessageSchema,
  listMessagesSchema,
  editMessageSchema,
  messageParamsSchema,
  reactionSchema,
  receiptSchema,
  listConversationsSchema,
  createConversationSchema,
};
