import { stat } from 'node:fs/promises';

import { ai } from '../client.js';
import { getMimeType, MAX_FILE_SIZE } from './file-utils.js';
import type { RootsFetcher } from './path-validation.js';
import { resolveAndValidatePath } from './path-validation.js';
import { withRetry } from './retry.js';

interface UploadedFile {
  name: string;
  uri: string;
  mimeType: string;
}

export async function uploadFile(
  filePath: string,
  signal: AbortSignal,
  rootsFetcher?: RootsFetcher,
): Promise<UploadedFile> {
  const validPath = await resolveAndValidatePath(filePath, rootsFetcher);

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

export async function deleteUploadedFiles(
  names: string[],
  onCleanupError?: (reason: unknown) => void,
): Promise<void> {
  if (names.length === 0) return;
  const results = await Promise.allSettled(names.map((n) => ai.files.delete({ name: n })));
  for (const r of results) {
    if (r.status === 'rejected') {
      onCleanupError?.(r.reason);
    }
  }
}
