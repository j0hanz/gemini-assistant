import { z } from 'zod/v4';

import { FileSearchStoreNameSchema, optionalField, textField } from './fields.js';

const CreateStoreSchema = z.strictObject({
  operation: z.literal('create-store').describe('Literal: create-store'),
  storeName: FileSearchStoreNameSchema.describe('Store name. Format: alphanumerics, _, -, /.'),
  displayName: optionalField(textField('Human-readable store display name', 256)),
});

const UploadSchema = z.strictObject({
  operation: z.literal('upload').describe('Literal: upload'),
  storeName: FileSearchStoreNameSchema.describe('Store name. Format: alphanumerics, _, -, /.'),
  filePath: textField('Absolute or workspace-relative path to file').describe(
    'Absolute or workspace-relative path to file',
  ),
  displayName: optionalField(textField('Human-readable document display name', 256)),
  mimeType: optionalField(textField('MIME type (e.g. text/plain, application/json)', 128)),
});

const DeleteStoreSchema = z.strictObject({
  operation: z.literal('delete-store').describe('Literal: delete-store'),
  storeName: FileSearchStoreNameSchema.describe('Store name. Format: alphanumerics, _, -, /.'),
});

const DeleteDocumentSchema = z.strictObject({
  operation: z.literal('delete-document').describe('Literal: delete-document'),
  storeName: FileSearchStoreNameSchema.describe('Store name. Format: alphanumerics, _, -, /.'),
  documentName: textField('Document name from upload operation').describe(
    'Document name from upload operation',
  ),
});

export const IngestInputSchema = z.discriminatedUnion('operation', [
  CreateStoreSchema,
  UploadSchema,
  DeleteStoreSchema,
  DeleteDocumentSchema,
]);

export type IngestInput = z.infer<typeof IngestInputSchema>;
