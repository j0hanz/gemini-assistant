import { z } from 'zod/v4';

import { optionalField, textField, withFieldMetadata } from './fields.js';
import { IngestOperationEnum } from './ingest-input.js';

export const IngestOutputSchema = z.strictObject({
  operation: withFieldMetadata(
    IngestOperationEnum,
    'Which operation was performed (create-store, upload, delete-store, delete-document)',
  ),
  storeName: optionalField(
    withFieldMetadata(z.string(), 'The store name involved in the operation'),
  ),
  documentName: optionalField(
    withFieldMetadata(z.string(), 'Document name (populated for single-file upload)'),
  ),
  uploadedCount: optionalField(
    withFieldMetadata(z.number().int().nonnegative(), 'Number of files uploaded (batch upload)'),
  ),
  skippedCount: optionalField(
    withFieldMetadata(
      z.number().int().nonnegative(),
      'Number of files skipped (binary, oversized, ignored directory, or cap reached)',
    ),
  ),
  uploadedFiles: optionalField(
    withFieldMetadata(
      z.array(z.string()).max(200),
      'Sample of uploaded file paths (truncated to first 200)',
    ),
  ),
  created: optionalField(
    withFieldMetadata(z.boolean(), 'True if the store was auto-created during this upload'),
  ),
  message: textField('Human-readable result message'),
});

export type IngestOutput = z.infer<typeof IngestOutputSchema>;
