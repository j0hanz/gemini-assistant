import { z } from 'zod/v4';

import { FileSearchStoreNameSchema, optionalField, textField } from './fields.js';

/**
 * Flat input schema for the `ingest` tool.
 *
 * MCP clients (including the MCP Inspector) introspect a tool's `inputSchema`
 * as a flat list of fields. A `z.discriminatedUnion` produces a JSON Schema
 * `anyOf` that most clients cannot render as a form, leaving the user with no
 * visible inputs. We therefore expose all fields on a single `z.strictObject`
 * and enforce per-operation requirements via `superRefine`.
 *
 * Path semantics for the `upload` operation:
 *   - a file path     → upload that single file
 *   - a directory     → walk that directory and upload all eligible files
 *
 * Workspace-wide uploads are intentionally unsupported: large workspaces
 * exceed MCP request timeouts. Always scope to a directory like `src`.
 */
const IngestOperationEnum = z.enum([
  'create-store',
  'upload',
  'delete-store',
  'delete-document',
] as const);

const RawIngestInputSchema = z.strictObject({
  operation: IngestOperationEnum.describe(
    "Operation to perform: 'create-store' | 'upload' | 'delete-store' | 'delete-document'.",
  ),
  storeName: FileSearchStoreNameSchema.describe(
    'File Search Store name. Required for all operations. Format: alphanumerics, _, -, /.',
  ),
  filePath: z
    .string()
    .trim()
    .max(4096)
    .optional()
    .describe(
      "Path to a file or directory (required for 'upload'). Absolute or workspace-relative (e.g. 'src').",
    ),
  documentName: optionalField(
    textField(
      'Document resource name from a previous upload (required when operation = delete-document).',
    ),
  ),
  displayName: optionalField(
    textField('Human-readable display name (optional, used by create-store and upload).', 256),
  ),
  mimeType: optionalField(
    textField('MIME type override for single-file upload (optional, ignored for batch).', 128),
  ),
});

export const IngestInputSchema = RawIngestInputSchema.superRefine((value, ctx) => {
  if (
    value.operation === 'upload' &&
    (value.filePath === undefined || value.filePath.length === 0)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['filePath'],
      message:
        "filePath is required when operation = 'upload' (e.g. 'src', 'docs', or an absolute path).",
    });
  }
  if (
    value.operation === 'delete-document' &&
    (value.documentName === undefined || value.documentName.length === 0)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['documentName'],
      message: "documentName is required when operation = 'delete-document'",
    });
  }
});

export type IngestInput = z.infer<typeof IngestInputSchema>;
