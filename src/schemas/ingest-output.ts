import { z } from 'zod/v4';
import { withFieldMetadata, textField, optionalField } from './fields.js';

export const IngestOutputSchema = z.strictObject({
  operation: withFieldMetadata(
    z.string(),
    'Which operation was performed (create-store, upload, delete-store, delete-document, etc.)',
  ),
  storeName: optionalField(
    withFieldMetadata(z.string(), 'The store name involved in the operation'),
  ),
  documentName: optionalField(
    withFieldMetadata(z.string(), 'Document name (populated for upload operation)'),
  ),
  message: textField('Human-readable result message'),
  structuredContent: optionalField(
    z.strictObject({
      operation: withFieldMetadata(z.string(), 'Operation name'),
      storeName: optionalField(
        withFieldMetadata(z.string(), 'Store name'),
      ),
      documentName: optionalField(
        withFieldMetadata(z.string(), 'Document name'),
      ),
      message: textField('Result message'),
    }),
  ),
});

export type IngestOutput = z.infer<typeof IngestOutputSchema>;
