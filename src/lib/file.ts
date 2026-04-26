import type { ServerContext } from '@modelcontextprotocol/server';

import { stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { createPartFromUri, type Part } from '@google/genai';

import { getAI } from '../client.js';
import { cleanupErrorLogger } from './errors.js';
import { withRetry } from './errors.js';
import { ProgressReporter } from './progress.js';
import type { RootsFetcher } from './validation.js';
import { resolveWorkspacePath } from './validation.js';

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
  path: string;
  displayPath: string;
}

type UploadedHandle = Awaited<ReturnType<ReturnType<typeof getAI>['files']['upload']>>;

function assertCompleteUploadedHandle(
  uploaded: UploadedHandle,
  displayPath: string,
): asserts uploaded is UploadedHandle & { uri: string; mimeType: string; name: string } {
  if (!uploaded.uri || !uploaded.mimeType || !uploaded.name) {
    throw new Error(`File upload returned an incomplete file handle: ${displayPath}`);
  }
}

export async function uploadFile(
  filePath: string,
  signal: AbortSignal,
  rootsFetcher?: RootsFetcher,
): Promise<UploadedFile> {
  const { resolvedPath, displayPath } = await resolveWorkspacePath(filePath, rootsFetcher);

  const fileStat = await stat(resolvedPath);
  if (fileStat.size > MAX_FILE_SIZE) {
    const limitMb = MAX_FILE_SIZE / 1024 / 1024;
    throw new Error(
      `File exceeds ${limitMb}MB limit: ${displayPath} (${(fileStat.size / 1024 / 1024).toFixed(1)}MB)`,
    );
  }

  const mimeType = getMimeType(resolvedPath);

  const uploaded = await withRetry(
    () => getAI().files.upload({ file: resolvedPath, config: { mimeType, abortSignal: signal } }),
    { signal },
  );

  assertCompleteUploadedHandle(uploaded, displayPath);

  return {
    name: uploaded.name,
    uri: uploaded.uri,
    mimeType: uploaded.mimeType,
    path: resolvedPath,
    displayPath,
  };
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

export interface UploadedFilesCleanupTracker {
  readonly names: readonly string[];
  addName(name: string): void;
  addUploadedFile(file: Pick<UploadedFile, 'name'>): void;
}

export async function withUploadedFilesCleanup<T>(
  ctx: ServerContext,
  operation: (tracker: UploadedFilesCleanupTracker) => Promise<T>,
): Promise<T> {
  const uploadedNames: string[] = [];
  const tracker: UploadedFilesCleanupTracker = {
    get names() {
      return uploadedNames;
    },
    addName(name: string) {
      uploadedNames.push(name);
    },
    addUploadedFile(file: Pick<UploadedFile, 'name'>) {
      uploadedNames.push(file.name);
    },
  };

  try {
    return await operation(tracker);
  } finally {
    await deleteUploadedFiles(uploadedNames, cleanupErrorLogger(ctx));
  }
}

export async function uploadFilesBatch(
  filePaths: string[],
  ctx: ServerContext,
  rootsFetcher: RootsFetcher,
  progress: ProgressReporter,
  labelTemplate: (filePath: string, index: number, total: number) => string,
  uploadedFiles: UploadedFilesCleanupTracker,
  indexOffset = 1,
): Promise<{ parts: Part[]; uploadedCount: number }> {
  const parts: Part[] = [];
  const totalSteps = filePaths.length + 1;
  let uploadedCount = 0;

  for (let index = 0; index < filePaths.length; index++) {
    if (ctx.mcpReq.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const filePath = filePaths[index];
    if (!filePath) continue;

    await progress.step(
      index + indexOffset,
      totalSteps,
      labelTemplate(filePath, index, filePaths.length),
    );

    const uploaded = await uploadFile(filePath, ctx.mcpReq.signal, rootsFetcher);
    uploadedCount += 1;
    uploadedFiles.addUploadedFile(uploaded);
    parts.push({ text: `File: ${uploaded.displayPath}` });
    parts.push(createPartFromUri(uploaded.uri, uploaded.mimeType));
  }

  return { parts, uploadedCount };
}

export async function withUploadsAndPipeline<T>(
  ctx: ServerContext,
  rootsFetcher: RootsFetcher,
  filePaths: string[],
  progress: ProgressReporter,
  labelTemplate: (filePath: string, index: number, total: number) => string,
  operation: (parts: Part[], uploadedCount: number) => Promise<T>,
  indexOffset = 1,
): Promise<T> {
  return await withUploadedFilesCleanup(ctx, async (uploadedFiles) => {
    const { parts, uploadedCount } = await uploadFilesBatch(
      filePaths,
      ctx,
      rootsFetcher,
      progress,
      labelTemplate,
      uploadedFiles,
      indexOffset,
    );
    return await operation(parts, uploadedCount);
  });
}
