import { z } from 'zod';

export const memoryTypeSchema = z.enum(['fact', 'preference', 'episode', 'summary']);
export const namespaceSchema = z.string().trim().min(1).max(128);
export const userIdSchema = z.string().trim().min(1).max(256);
export const objectIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/);
export const rememberSchema = z.strictObject({
  namespace: namespaceSchema,
  userId: userIdSchema,
  content: z.string().trim().min(1).max(16000),
  type: memoryTypeSchema.default('fact'),
  tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  importance: z.number().min(0).max(1).optional(),
  ttlDays: z.number().positive().max(36500).optional(),
  source: z
    .strictObject({
      sessionId: z.string().max(256).nullable(),
      messageId: z.string().max(256).nullable(),
    })
    .optional(),
});
export const forgetSchema = z.union([
  z.strictObject({ id: objectIdSchema }),
  z.strictObject({ namespace: namespaceSchema, userId: userIdSchema }),
]);
export const recallSchema = z.strictObject({
  namespace: namespaceSchema,
  userId: userIdSchema,
  query: z.string().trim().min(1).max(16000),
  k: z.number().int().min(1).max(100).optional(),
  types: z.array(memoryTypeSchema).min(1).max(4).optional(),
  since: z.iso.datetime().optional(),
});
export const listMemoriesSchema = z.strictObject({
  namespace: namespaceSchema,
  userId: userIdSchema,
  type: memoryTypeSchema.optional(),
  status: z.enum(['active', 'archived']).default('active'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(512).optional(),
});
