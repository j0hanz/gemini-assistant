import { stat } from 'node:fs/promises';

import { ai } from '../client.js';
import { getMimeType, MAX_FILE_SIZE } from './file-utils.js';
import { resolveAndValidatePath } from './path-validation.js';
import { withRetry } from './retry.js';

interface UploadedFile {
  name: string;
  uri: string;
  mimeType: string;
}

export async function uploadFile(filePath: string, signal: AbortSignal): Promise<UploadedFile> {
  const validPath = await resolveAndValidatePath(filePath);

  const fileStat = await stat(validPath);
  if (fileStat.size > MAX_FILE_SIZE) {
    throw new Error(
      `File exceeds 20MB limit: ${validPath} (${(fileStat.size / 1024 / 1024).toFixed(1)}MB)`,
    );
  }

  const mimeType = getMimeType(validPath);

  const uploaded = await withRetry(
    () => ai.files.upload({ file: validPath, config: { mimeType, abortSignal: signal } }),
    { signal },
  );

  if (!uploaded.uri || !uploaded.mimeType) {
    throw new Error(`File upload succeeded but returned no URI: ${validPath}`);
  }

  return { name: uploaded.name ?? '', uri: uploaded.uri, mimeType: uploaded.mimeType };
}
