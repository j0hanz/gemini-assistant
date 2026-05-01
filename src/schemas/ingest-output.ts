import { z } from 'zod/v4';

import { optionalField, textField, withFieldMetadata } from './fields.js';

export const IngestOutputSchema = z.strictObject({
  operation: withFieldMetadata(
    z.string(),
    'Which operation was performed (create-store, upload, delete-store, delete-document, etc.)',
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
  message: textField('Human-readable result message'),
  structuredContent: optionalField(
    z.strictObject({
      operation: withFieldMetadata(z.string(), 'Operation name'),
      storeName: optionalField(withFieldMetadata(z.string(), 'Store name')),
      documentName: optionalField(withFieldMetadata(z.string(), 'Document name')),
      uploadedCount: optionalField(withFieldMetadata(z.number(), 'Files uploaded')),
      skippedCount: optionalField(withFieldMetadata(z.number(), 'Files skipped')),
      message: textField('Result message'),
    }),
  ),
});

export type IngestOutput = z.infer<typeof IngestOutputSchema>;
