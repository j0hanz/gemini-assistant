import { stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { getAI } from '../client.js';
import { withRetry } from './errors.js';
import type { RootsFetcher } from './validation.js';
import { resolveAndValidatePath } from './validation.js';

// ── MIME / Size ───────────────────────────────────────────────────────

export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

const MIME_MAP: Record<string, string> = {
  // Documents
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.txt': 'text/plain',
  '.md': 'text/plain',
  '.rtf': 'application/rtf',
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  // Video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  // Archives
  '.zip': 'application/zip',
  // Office
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Code
  '.js': 'text/javascript',
  '.ts': 'text/plain',
  '.py': 'text/plain',
  '.java': 'text/plain',
  '.c': 'text/plain',
  '.cpp': 'text/plain',
  '.go': 'text/plain',
  '.rs': 'text/plain',
  '.rb': 'text/plain',
  '.sh': 'text/plain',
  // Config
  '.yaml': 'text/plain',
  '.yml': 'text/plain',
  '.toml': 'text/plain',
};

export function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

// ── File Upload ───────────────────────────────────────────────────────

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
    () => getAI().files.upload({ file: validPath, config: { mimeType, abortSignal: signal } }),
    { signal },
  );

  if (!uploaded.uri || !uploaded.mimeType || !uploaded.name) {
    throw new Error(`File upload returned an incomplete file handle: ${validPath}`);
  }

  return { name: uploaded.name, uri: uploaded.uri, mimeType: uploaded.mimeType };
}

export async function deleteUploadedFiles(
  names: string[],
  onCleanupError?: (reason: unknown) => void,
): Promise<void> {
  if (names.length === 0) return;
  const results = await Promise.allSettled(names.map((n) => getAI().files.delete({ name: n })));
  for (const r of results) {
    if (r.status === 'rejected') {
      onCleanupError?.(r.reason);
    }
  }
}
