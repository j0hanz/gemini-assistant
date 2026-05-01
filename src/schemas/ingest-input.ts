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
  filePath: optionalField(
    textField(
      'Absolute or workspace-relative path to the file to upload (required when operation = upload).',
    ),
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
    textField('MIME type of the uploaded file, e.g. text/plain (optional, upload only).', 128),
  ),
});

export const IngestInputSchema = RawIngestInputSchema.superRefine((value, ctx) => {
  switch (value.operation) {
    case 'upload': {
      if (value.filePath === undefined || value.filePath.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['filePath'],
          message: "filePath is required when operation = 'upload'",
        });
      }
      break;
    }
    case 'delete-document': {
      if (value.documentName === undefined || value.documentName.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['documentName'],
          message: "documentName is required when operation = 'delete-document'",
        });
      }
      break;
    }
    case 'create-store':
    case 'delete-store':
      // No additional fields required beyond storeName.
      break;
  }
});

export type IngestInput = z.infer<typeof IngestInputSchema>;
