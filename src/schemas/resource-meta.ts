import { z } from 'zod/v4';

export const ResourceLinkRefSchema = z.strictObject({
  uri: z.string(),
  name: z.string(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});
export type ResourceLinkRef = z.infer<typeof ResourceLinkRefSchema>;

export const ResourceMetaSchema = z.strictObject({
  generatedAt: z.string(),
  source: z.enum(['static', 'session', 'workspace', 'gemini-api']),
  cached: z.boolean(),
  ttlMs: z.number().int().nonnegative().optional(),
  size: z.number().int().nonnegative(),
  links: z.array(ResourceLinkRefSchema).optional(),
});
export type ResourceMeta = z.infer<typeof ResourceMetaSchema>;
