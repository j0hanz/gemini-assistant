import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { readdir, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

import { logger } from '../lib/logger.js';
import { sendProgress } from '../lib/progress.js';
import { DESTRUCTIVE_ANNOTATIONS, registerWorkTool } from '../lib/tasks.js';
import type { ToolRootsFetcher, ToolServices } from '../lib/tool-context.js';
import { createToolContext } from '../lib/tool-executor.js';
import { getAllowedRoots } from '../lib/validation.js';
import type { IngestInput } from '../schemas/ingest-input.js';
import { IngestInputSchema } from '../schemas/ingest-input.js';
import { type IngestOutput, IngestOutputSchema } from '../schemas/ingest-output.js';

import { getAI } from '../client.js';
import { appendResourceLinks } from '../resources/index.js';

const log = logger.child('ingest');

// ── Bulk upload limits ───────────────────────────────────────────────────────
const MAX_FILES_PER_UPLOAD = 200;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const UPLOAD_CONCURRENCY = 4;

// Directories that are never recursed into.
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  'coverage',
  '.cache',
  '.idea',
  '.vscode',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'bin',
  'obj',
]);

// Binary / non-text extensions skipped during workspace walks. Single-file uploads
// (where the user explicitly provided a path) bypass this filter.
const SKIPPED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.svg',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.webm',
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.class',
  '.jar',
  '.wasm',
  '.lock',
  '.map',
]);

// Explicit MIME types for non-obvious extensions. The Gemini File Search SDK
// rejects uploads when it cannot determine a MIME type from the path, so we
// fall back to `text/plain` for any source-like file we recognise.
// MIME types accepted by the Gemini File Search API. The API rejects
// non-IANA `x-*` subtypes (e.g. `text/x-typescript`), so source code uploads
// must use `text/plain`. We only use specific MIME types for formats the API
// is known to accept; everything else falls back to `text/plain`.
const MIME_BY_EXTENSION: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.jsonc': 'application/json',
  '.json5': 'application/json',
  '.ipynb': 'application/json',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.css': 'text/css',
  '.pdf': 'application/pdf',
};

function inferMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? 'text/plain';
}

/**
 * Ensure an absolute path lives inside one of the allowed workspace roots.
 * Prevents traversal outside the workspace without rejecting legitimate
 * absolute paths produced by `resolveUploadTarget`.
 */
function assertWithinRoots(target: string, roots: readonly string[]): void {
  if (roots.length === 0) return;
  const normalizedTarget = resolve(target);
  const inside = roots.some((root) => {
    const rel = relative(resolve(root), normalizedTarget);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
  if (!inside) {
    throw new Error('Path is outside the allowed workspace roots');
  }
}

/**
 * Resolve the upload target to an absolute path.
 *
 * - If `filePath` is absolute, returns it as-is.
 * - Otherwise searches across allowed workspace roots.
 * - If not found in any root, falls back to resolving relative to the first root.
 *
 * `filePath` is required by the schema for `upload`, so it is never empty here.
 */
async function resolveUploadTarget(
  filePath: string,
  rootsFetcher: ToolRootsFetcher,
): Promise<{ target: string; roots: string[] }> {
  const roots = await getAllowedRoots(rootsFetcher);
  const primaryRoot = roots[0] ?? process.cwd();

  const trimmed = filePath.trim();
  if (isAbsolute(trimmed)) {
    return { target: trimmed, roots };
  }

  for (const root of roots) {
    const candidate = resolve(root, trimmed);
    try {
      await stat(candidate);
      return { target: candidate, roots };
    } catch {
      // Ignore and try next root
    }
  }

  return { target: resolve(primaryRoot, trimmed), roots };
}

/**
 * Collect every eligible file under a directory tree.
 *
 * Skips: standard build/VCS directories, oversized files, and binary/lockfile extensions.
 * Caps the result at `MAX_FILES_PER_UPLOAD`; further matches contribute only to `skipped`.
 */
async function collectFiles(rootDir: string): Promise<{ files: string[]; skipped: number }> {
  const files: string[] = [];
  let skipped = 0;
  const queue: string[] = [rootDir];

  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) break;

    let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = extname(entry.name).toLowerCase();
      if (SKIPPED_EXTENSIONS.has(ext)) {
        skipped += 1;
        continue;
      }

      try {
        const info = await stat(full);
        if (info.size === 0 || info.size > MAX_FILE_SIZE_BYTES) {
          if (info.size > MAX_FILE_SIZE_BYTES) {
            log.warn(`Skipping file due to size limit (>10MB): ${full} (${info.size} bytes)`);
          }
          skipped += 1;
          continue;
        }
      } catch {
        skipped += 1;
        continue;
      }

      if (files.length >= MAX_FILES_PER_UPLOAD) {
        skipped += 1;
        continue;
      }
      files.push(full);
    }
  }

  return { files, skipped };
}

/**
 * Upload a single file. Returns the document name on success, or an error message on failure.
 */
export async function uploadOne(
  ai: ReturnType<typeof getAI>,
  fileSearchStoreName: string,
  filePath: string,
  rootDir: string,
  mimeType?: string,
  signal?: AbortSignal,
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const displayName = relative(rootDir, filePath) || filePath;
  try {
    const resolvedMime = mimeType ?? inferMimeType(filePath);
    const op = await ai.fileSearchStores.uploadToFileSearchStore({
      fileSearchStoreName,
      file: filePath,
      config: {
        displayName,
        mimeType: resolvedMime,
        ...(signal ? { abortSignal: signal } : {}),
      },
    });
    const documentName = op.response?.documentName ?? op.name;
    if (!documentName) {
      return { ok: false, error: 'SDK returned no documentName' };
    }
    return { ok: true, name: documentName };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`upload failed for ${filePath}`, { error: message });
    return { ok: false, error: message };
  }
}

/**
 * Upload an array of files with bounded concurrency. Sends progress
 * notifications after each batch so MCP clients (which apply a per-request
 * timeout that resets on progress) don't time out on large workspace uploads.
 */
export async function uploadAll(
  ai: ReturnType<typeof getAI>,
  fileSearchStoreName: string,
  files: string[],
  rootDir: string,
  ctx: ServerContext | undefined,
  signal?: AbortSignal,
): Promise<{ uploaded: string[]; failed: number; firstError: string | undefined }> {
  const uploaded: string[] = [];
  let failed = 0;
  let firstError: string | undefined;
  const total = files.length;

  for (let i = 0; i < files.length; i += UPLOAD_CONCURRENCY) {
    if (signal?.aborted) {
      throw new Error('Upload cancelled');
    }

    const batch = files.slice(i, i + UPLOAD_CONCURRENCY);
    const results = await Promise.all(
      batch.map((file) =>
        uploadOne(ai, fileSearchStoreName, file, rootDir, undefined, signal).then((r) => ({
          file,
          result: r,
        })),
      ),
    );

    for (const { file, result } of results) {
      if (result.ok) {
        uploaded.push(file);
      } else {
        failed += 1;
        firstError ??= result.error;
      }
    }

    if (ctx !== undefined) {
      const completed = Math.min(i + UPLOAD_CONCURRENCY, files.length);
      try {
        await sendProgress(
          ctx,
          completed,
          total,
          `ingest: uploaded ${String(completed)}/${String(total)} (failed: ${String(failed)})`,
        );
      } catch {
        // Progress is best-effort.
      }
    }
  }

  return { uploaded, failed, firstError };
}

/**
 * Handle create-store operation
 */
async function handleCreateStore(
  input: IngestInput,
  ai: ReturnType<typeof getAI>,
): Promise<IngestOutput> {
  const displayName = input.displayName ?? input.storeName;
  const created = await ai.fileSearchStores.create({
    config: { displayName },
  });
  const resourceName = created.name ?? `fileSearchStores/${input.storeName}`;

  return {
    operation: 'create-store',
    storeName: resourceName,
    message: `Store '${resourceName}' created successfully.`,
  };
}

const storeResolutionLocks = new Map<string, Promise<{ name: string; created: boolean }>>();

/**
 * Resolve a user-supplied store identifier to a real `fileSearchStores/<id>`
 * resource name.
 *
 * Rules:
 *  - If it already starts with `fileSearchStores/` it is returned as-is.
 *  - Otherwise it is treated as a display name: we list existing stores and
 *    return the first match.
 *  - If `createIfMissing` is set and no match is found, a new store is created
 *    with the supplied label as its `displayName`.
 */
async function resolveStore(
  ai: ReturnType<typeof getAI>,
  identifier: string,
  options: { createIfMissing: boolean },
): Promise<{ name: string; created: boolean }> {
  if (identifier.startsWith('fileSearchStores/')) {
    return { name: identifier, created: false };
  }

  const trimmed = identifier.trim();

  const lock = storeResolutionLocks.get(trimmed);
  if (lock) {
    return lock;
  }

  const promise = (async () => {
    for await (const store of await ai.fileSearchStores.list()) {
      if (store.displayName === trimmed && store.name !== undefined) {
        return { name: store.name, created: false };
      }
    }

    if (!options.createIfMissing) {
      throw new Error(
        `No file search store found with displayName '${trimmed}'. Use the 'create-store' operation first or pass an existing 'fileSearchStores/<id>' resource name.`,
      );
    }

    const created = await ai.fileSearchStores.create({ config: { displayName: trimmed } });
    if (created.name === undefined) {
      throw new Error(
        `Created store but server returned no resource name for displayName '${trimmed}'.`,
      );
    }
    log.info(`auto-created store '${created.name}' for displayName '${trimmed}'`);
    return { name: created.name, created: true };
  })();

  storeResolutionLocks.set(trimmed, promise);
  try {
    return await promise;
  } finally {
    storeResolutionLocks.delete(trimmed);
  }
}

/**
 * Handle upload operation.
 *
 * Path semantics:
 *  - empty filePath → walk all workspace roots
 *  - filePath points to a file → upload just that file
 *  - filePath points to a directory → walk and upload contents
 */
async function handleUpload(
  input: IngestInput,
  ai: ReturnType<typeof getAI>,
  rootsFetcher: ToolRootsFetcher,
  ctx: ServerContext,
): Promise<IngestOutput> {
  const { name: fileSearchStoreName, created: storeCreated } = await resolveStore(
    ai,
    input.storeName,
    { createIfMissing: true },
  );

  // Type guard: schema guarantees filePath for upload operation
  if (!input.filePath) {
    throw new Error(
      'Impossible: schema validation should prevent filePath being undefined for upload',
    );
  }

  const { target, roots } = await resolveUploadTarget(input.filePath, rootsFetcher);
  assertWithinRoots(target, roots);

  let info: { isFile: () => boolean; isDirectory: () => boolean };
  try {
    info = await stat(target);
  } catch (error) {
    throw new Error(
      error instanceof Error ? `Path not accessible: ${error.message}` : 'Path not accessible',
      { cause: error },
    );
  }

  // ── Single-file upload ────────────────────────────────────────────────────
  const createdSuffix = storeCreated ? ' (auto-created)' : '';
  const signal = (ctx.task as { cancellationSignal?: AbortSignal } | undefined)?.cancellationSignal;
  if (info.isFile()) {
    const result = await uploadOne(
      ai,
      fileSearchStoreName,
      target,
      dirname(target),
      input.mimeType,
      signal,
    );
    if (!result.ok) {
      throw new Error(`Upload failed for ${target}: ${result.error}`);
    }
    return {
      operation: 'upload',
      storeName: fileSearchStoreName,
      documentName: result.name,
      uploadedCount: 1,
      skippedCount: 0,
      message: `Uploaded 1 file to '${fileSearchStoreName}'${createdSuffix}.`,
    };
  }

  // ── Directory or workspace walk ───────────────────────────────────────────
  if (!info.isDirectory()) {
    throw new Error(`Path is neither a file nor a directory: ${target}`);
  }

  const { files, skipped } = await collectFiles(target);
  if (files.length === 0) {
    return {
      operation: 'upload',
      storeName: fileSearchStoreName,
      uploadedCount: 0,
      skippedCount: skipped,
      message: `No eligible files found under ${target} (skipped: ${skipped}).`,
    };
  }

  const { uploaded, failed, firstError } = await uploadAll(
    ai,
    fileSearchStoreName,
    files,
    target,
    ctx,
    signal,
  );
  const failureSuffix =
    failed > 0 && firstError !== undefined ? ` First failure: ${firstError}` : '';

  return {
    operation: 'upload',
    storeName: fileSearchStoreName,
    uploadedCount: uploaded.length,
    skippedCount: skipped + failed,
    uploadedFiles: uploaded.slice(0, 200).map((f) => relative(target, f) || f),
    message: `Uploaded ${String(uploaded.length)}/${String(files.length)} files from ${target} to '${fileSearchStoreName}'${createdSuffix} (skipped: ${String(skipped)}, failed: ${String(failed)}).${failureSuffix}`,
  };
}

/**
 * Handle delete-store operation
 */
async function handleDeleteStore(
  input: IngestInput,
  ai: ReturnType<typeof getAI>,
): Promise<IngestOutput> {
  const { name } = await resolveStore(ai, input.storeName, { createIfMissing: false });

  await ai.fileSearchStores.delete({ name, config: { force: true } });

  return {
    operation: 'delete-store',
    storeName: name,
    message: `Store '${name}' deleted successfully.`,
  };
}

/**
 * Handle delete-document operation
 */
async function handleDeleteDocument(
  input: IngestInput,
  ai: ReturnType<typeof getAI>,
): Promise<IngestOutput> {
  const documentName = input.documentName;

  // Type guard: schema guarantees documentName for delete-document operation
  if (!documentName) {
    throw new Error(
      'Impossible: schema validation should prevent documentName being undefined for delete-document',
    );
  }

  const { name: storeName } = await resolveStore(ai, input.storeName, { createIfMissing: false });
  const fullDocName = documentName.includes('/documents/')
    ? documentName
    : `${storeName}/documents/${documentName}`;

  await ai.fileSearchStores.documents.delete({ name: fullDocName });

  return {
    operation: 'delete-document',
    storeName,
    documentName: fullDocName,
    message: `Document '${fullDocName}' deleted successfully.`,
  };
}

/**
 * Main ingest tool handler
 */
async function ingestWork(
  input: IngestInput,
  ctx: ServerContext,
  rootsFetcher: ToolRootsFetcher,
): Promise<CallToolResult> {
  const toolContext = createToolContext('ingest', ctx);

  try {
    const ai = getAI();
    let output: IngestOutput;

    // Dispatch to operation handler
    switch (input.operation) {
      case 'create-store': {
        output = await handleCreateStore(input, ai);
        break;
      }

      case 'upload': {
        output = await handleUpload(input, ai, rootsFetcher, ctx);
        break;
      }

      case 'delete-store': {
        output = await handleDeleteStore(input, ai);
        break;
      }

      case 'delete-document': {
        output = await handleDeleteDocument(input, ai);
        break;
      }

      default: {
        const _exhaustive: never = input.operation;
        throw new Error(`Unknown operation: ${String(_exhaustive)}`);
      }
    }

    // Validate and return structured response
    const baseResult: CallToolResult = {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(output),
        },
      ],
      structuredContent: output,
    };
    const validated = toolContext.validateOutput(IngestOutputSchema, output, baseResult);

    // Append resource links as content items
    const resourceLinks = appendResourceLinks('ingest');
    const resourceLinkContent = resourceLinks.map((link) => ({
      type: 'resource_link' as const,
      uri: link.uri,
      name: link.name ?? link.uri,
      description: link.description,
      mimeType: link.mimeType,
    }));

    return {
      ...validated,
      content: [...validated.content, ...resourceLinkContent],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

    log.error('ingest tool error', { error: errorMessage });

    return {
      content: [
        {
          type: 'text' as const,
          text: errorMessage,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Register the ingest tool with the MCP server.
 *
 * **Why destructive annotations?**
 *
 * The ingest tool handles four operations:
 * - `create-store` — creates a new Gemini File Search Store (mutable, reversible)
 * - `upload` — uploads files to a store (mutable, reversible)
 * - `delete-store` — deletes a store with `force: true` (irreversible, destructive)
 * - `delete-document` — removes documents from a store (irreversible, destructive)
 *
 * In MCP, tool annotations are applied at the tool level, not per-operation.
 * Since the ingest tool contains irreversible destructive operations (delete-store and
 * delete-document), the entire tool must declare `destructiveHint: true` to signal to
 * MCP clients that some operations can permanently delete resources. This alerts them
 * that ingest operations should be gated behind user confirmation or careful authorization.
 */
export function registerIngestTool(server: McpServer, services?: ToolServices): void {
  const rootsFetcher: ToolRootsFetcher = services?.rootsFetcher ?? (() => Promise.resolve([]));
  registerWorkTool<IngestInput>({
    server,
    tool: {
      name: 'ingest',
      title: 'Ingest',
      description:
        "Manage Gemini File Search Stores. For 'upload', provide a filePath like 'src' to ingest a directory subtree, or a path to a single file.",
      inputSchema: IngestInputSchema,
      outputSchema: IngestOutputSchema,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    work: (args, ctx) => ingestWork(args, ctx, rootsFetcher),
  });
}
