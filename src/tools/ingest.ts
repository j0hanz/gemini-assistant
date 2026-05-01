import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { readdir, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

import { logger } from '../lib/logger.js';
import { sendProgress } from '../lib/progress.js';
import { MUTABLE_ANNOTATIONS, registerWorkTool } from '../lib/tasks.js';
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
  '.pdf',
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

// Filenames without an extension that are still worth ingesting as plain text.
const TEXT_BASENAMES = new Set([
  'dockerfile',
  'makefile',
  'rakefile',
  'gemfile',
  'procfile',
  'jenkinsfile',
  'license',
  'readme',
  'changelog',
  'authors',
  'contributors',
  'notice',
]);

function inferMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext.length > 0) {
    return MIME_BY_EXTENSION[ext] ?? 'text/plain';
  }
  const base = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (TEXT_BASENAMES.has(base)) return 'text/plain';
  return 'text/plain';
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
 * - If `filePath` is empty, returns the first workspace root.
 * - If `filePath` is absolute, returns it as-is.
 * - Otherwise resolves relative to the first workspace root.
 */
async function resolveUploadTarget(
  filePath: string | undefined,
  rootsFetcher: ToolRootsFetcher,
): Promise<{ target: string; isWorkspaceRoot: boolean; roots: string[] }> {
  const roots = await getAllowedRoots(rootsFetcher);
  const primaryRoot = roots[0] ?? process.cwd();

  const trimmed = filePath?.trim() ?? '';
  if (trimmed.length === 0) {
    return { target: primaryRoot, isWorkspaceRoot: true, roots };
  }

  const absolute = isAbsolute(trimmed) ? trimmed : resolve(primaryRoot, trimmed);
  return { target: absolute, isWorkspaceRoot: false, roots };
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
async function uploadOne(
  ai: ReturnType<typeof getAI>,
  fileSearchStoreName: string,
  filePath: string,
  rootDir: string,
  mimeType?: string,
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
      },
    });
    return { ok: true, name: op.response?.documentName ?? op.name ?? displayName };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`upload failed for ${filePath}`, { error: message });
    return { ok: false, error: message };
  }
}

/**
 * Upload an array of files with bounded concurrency. Sends progress
 * notifications after each file so MCP clients (which apply a per-request
 * timeout that resets on progress) don't time out on large workspace uploads.
 */
async function uploadAll(
  ai: ReturnType<typeof getAI>,
  fileSearchStoreName: string,
  files: string[],
  rootDir: string,
  ctx: ServerContext | undefined,
): Promise<{ uploaded: string[]; failed: number; firstError: string | undefined }> {
  const uploaded: string[] = [];
  let failed = 0;
  let firstError: string | undefined;
  let cursor = 0;
  let completed = 0;
  const total = files.length;

  async function worker(): Promise<void> {
    while (cursor < files.length) {
      const index = cursor++;
      const file = files[index];
      if (file === undefined) break;
      const result = await uploadOne(ai, fileSearchStoreName, file, rootDir);
      if (result.ok) {
        uploaded.push(file);
      } else {
        failed += 1;
        firstError ??= result.error;
      }
      completed += 1;
      if (ctx !== undefined) {
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
  }

  const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
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

  const { target, isWorkspaceRoot, roots } = await resolveUploadTarget(
    input.filePath,
    rootsFetcher,
  );
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
  if (info.isFile()) {
    const result = await uploadOne(ai, fileSearchStoreName, target, target, input.mimeType);
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
  );
  const scope = isWorkspaceRoot ? 'workspace' : target;
  const failureSuffix =
    failed > 0 && firstError !== undefined ? ` First failure: ${firstError}` : '';

  return {
    operation: 'upload',
    storeName: fileSearchStoreName,
    uploadedCount: uploaded.length,
    skippedCount: skipped + failed,
    uploadedFiles: uploaded.slice(0, 200).map((f) => relative(target, f) || f),
    message: `Uploaded ${String(uploaded.length)}/${String(files.length)} files from ${scope} to '${fileSearchStoreName}'${createdSuffix} (skipped: ${String(skipped)}, failed: ${String(failed)}).${failureSuffix}`,
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
  // Schema's superRefine guarantees documentName is present for delete-document.
  const documentName = input.documentName;
  if (documentName === undefined) {
    throw new Error("documentName is required when operation = 'delete-document'");
  }

  const storeName = input.storeName.startsWith('fileSearchStores/')
    ? input.storeName
    : `fileSearchStores/${input.storeName}`;
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
    const validated = toolContext.validateOutput(IngestOutputSchema, output, {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(output),
        },
      ],
    });

    const resourceLinks = appendResourceLinks('ingest');
    return {
      ...validated,
      resourceLink: resourceLinks,
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
 * Register the ingest tool with the MCP server
 */
export function registerIngestTool(server: McpServer, services?: ToolServices): void {
  const rootsFetcher: ToolRootsFetcher = services?.rootsFetcher ?? (() => Promise.resolve([]));
  registerWorkTool<IngestInput>({
    server,
    tool: {
      name: 'ingest',
      title: 'Ingest',
      description:
        "Manage Gemini File Search Stores. 'upload' with empty filePath ingests the entire workspace; with a directory path ingests that subtree; with a file path uploads one file.",
      inputSchema: IngestInputSchema,
      outputSchema: IngestOutputSchema,
      annotations: MUTABLE_ANNOTATIONS,
    },
    work: (args, ctx) => ingestWork(args, ctx, rootsFetcher),
  });
}
