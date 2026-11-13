'use strict';

const { z } = require('zod');

const MEDIA_TYPES = ['image', 'video', 'audio', 'document'];

const initiateUploadSchema = z.object({
  body: z.object({
    mediaType: z.enum(MEDIA_TYPES),
    byteSize: z.number().int().min(1).max(500 * 1024 * 1024), // claimed size (sanity cap)
    contentType: z.string().trim().min(1).max(255),
    checksum: z.string().trim().max(128).optional(),
    encryptionNonce: z.string().trim().max(64).optional(),
    encryptionAuthTag: z.string().trim().max(64).optional(),
  }),
});

const mediaParamsSchema = z.object({
  params: z.object({
    mediaId: z.uuid(),
  }),
});

module.exports = { MEDIA_TYPES, initiateUploadSchema, mediaParamsSchema };
