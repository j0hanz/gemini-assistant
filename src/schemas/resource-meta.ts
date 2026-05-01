import { z } from 'zod/v4';

/**
 * Resource link structure for _meta.links
 * Describes a related resource URI with optional metadata
 */
const ResourceLinkSchema = z.strictObject({
  uri: z.url().describe('Absolute resource URI (e.g., gemini://sessions)'),
  name: z.string().optional().describe('Human-readable name'),
  description: z.string().optional().describe('Brief description of the resource'),
  mimeType: z.string().optional().describe('MIME type of the resource content'),
});

export type ResourceLink = z.infer<typeof ResourceLinkSchema>;

/**
 * Resource metadata block appended to resource content
 * Contains generation info, caching metadata, and resource links
 */
const ResourceMetadataSchema = z.strictObject({
  generatedAt: z.string().describe('ISO 8601 timestamp of generation'),
  source: z.enum(['gemini-assistant']).describe('Source system'),
  cached: z.boolean().describe('Whether response came from cache'),
  ttlMs: z.number().int().nonnegative().optional().describe('Time-to-live in milliseconds'),
  size: z.number().int().nonnegative().optional().describe('Content size in bytes'),
  links: z
    .strictObject({
      self: ResourceLinkSchema.optional().describe('Link to this resource'),
    })
    .optional()
    .describe('Resource links block'),
});

export type ResourceMetadata = z.infer<typeof ResourceMetadataSchema>;
