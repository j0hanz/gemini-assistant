import type { McpServer } from '@modelcontextprotocol/server';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getRootsEnv, getRootsFallbackCwd } from '../config.js';

// ── Sensitive Path Detection ──────────────────────────────────────────────

const SENSITIVE_UNTRACKED_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'credentials',
  'credentials.json',
  'id_ed25519',
  'id_rsa',
  'secrets.json',
]);
const SENSITIVE_UNTRACKED_EXTENSIONS = new Set(['.key', '.p12', '.pfx', '.pem']);
const SENSITIVE_UNTRACKED_SEGMENTS = new Set(['.aws', '.gnupg', '.ssh', 'credentials', 'secrets']);
const SENSITIVE_UNTRACKED_BASENAME_PARTS = ['credential', 'password', 'secret', 'token'];

function getPathExtension(basename: string): string {
  return basename.includes('.') ? `.${basename.split('.').pop() ?? ''}` : '';
}

export function isSensitiveUntrackedPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  const basename = segments.at(-1) ?? normalized;

  return (
    SENSITIVE_UNTRACKED_BASENAMES.has(basename) ||
    basename.startsWith('.env.') ||
    SENSITIVE_UNTRACKED_EXTENSIONS.has(getPathExtension(basename)) ||
    segments.some((segment) => SENSITIVE_UNTRACKED_SEGMENTS.has(segment)) ||
    SENSITIVE_UNTRACKED_BASENAME_PARTS.some((part) => basename.includes(part))
  );
}

// ── Workspace Path Resolution ─────────────────────────────────────────────

export type RootsFetcher = () => Promise<string[]>;

interface ResolvedWorkspacePath {
  resolvedPath: string;
  displayPath: string;
  workspaceRoot: string | undefined;
}

interface WorkspaceCandidate {
  candidate: string;
  root: string;
}

function getConfiguredRoots(): string[] | undefined {
  const allowedFileRootsEnv = getRootsEnv();
  if (!allowedFileRootsEnv) {
    return undefined;
  }

  const roots = allowedFileRootsEnv
    .split(',')
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => normalize(root))
    .filter(Boolean);

  return roots.length > 0 ? roots : undefined;
}

function parseRootUri(uri: string): string | undefined {
  try {
    return normalize(fileURLToPath(uri));
  } catch {
    return undefined;
  }
}

export function normalizePathForComparison(filePath: string): string {
  const resolved = resolve(normalize(filePath));
  const root = parse(resolved).root;
  const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/, '') : resolved;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

export function isPathWithinRoot(filePath: string, rootPath: string): boolean {
  const candidate = normalizePathForComparison(filePath);
  const root = normalizePathForComparison(rootPath);

  if (candidate === root) return true;

  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function dedupeRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const root of roots) {
    const key = normalizePathForComparison(root);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(root);
  }

  return deduped;
}

async function getClientRoots(rootsFetcher?: RootsFetcher): Promise<string[]> {
  if (!rootsFetcher) return [];

  try {
    return dedupeRoots((await rootsFetcher()).map((root) => normalize(root)).filter(Boolean));
  } catch {
    return [];
  }
}

function getDefaultWorkspaceRoot(): string {
  return normalize(process.cwd());
}

function getCwdFallbackRoots(): string[] {
  return getRootsFallbackCwd() ? [getDefaultWorkspaceRoot()] : [];
}

function getEffectiveWorkspaceRoots(clientRoots: string[]): string[] {
  if (clientRoots.length > 0) return clientRoots;
  return getCwdFallbackRoots();
}

function getEffectiveAllowedWorkspaceRoots(
  workspaceRoots: string[],
  allowedRoots: string[],
): string[] {
  const intersectedRoots = intersectRoots(workspaceRoots, allowedRoots);

  if (intersectedRoots.length > 0) {
    return intersectedRoots;
  }

  return workspaceRoots.length === 1 && workspaceRoots[0] === getDefaultWorkspaceRoot()
    ? allowedRoots
    : workspaceRoots;
}

function toPortablePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function toDisplayPath(filePath: string, rootPath: string | undefined): string {
  if (!rootPath || !isPathWithinRoot(filePath, rootPath)) {
    return toPortablePath(filePath);
  }

  return toPortablePath(relative(rootPath, filePath));
}

function chooseDisplayRoot(filePath: string, roots: string[]): string | undefined {
  return [...roots]
    .filter((root) => isPathWithinRoot(filePath, root))
    .sort((left, right) => right.length - left.length)[0];
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function canonicalizePath(filePath: string): Promise<string> {
  const normalized = normalize(filePath);

  try {
    return await realpath(normalized);
  } catch {
    let current = dirname(normalized);
    while (current !== dirname(current)) {
      try {
        const parentRealpath = await realpath(current);
        return resolve(parentRealpath, relative(current, normalized));
      } catch {
        current = dirname(current);
      }
    }

    return resolve(normalized);
  }
}

function buildAmbiguousWorkspacePathError(filePath: string, roots: string[]): Error {
  const listedRoots = roots.map((root) => `- ${toPortablePath(root)}`).join('\n');
  return new Error(
    `Relative path '${filePath}' is ambiguous across workspace roots:\n${listedRoots}`,
  );
}

function getRelativeWorkspaceCandidates(
  filePath: string,
  workspaceRoots: readonly string[],
): WorkspaceCandidate[] {
  const normalizedRelative = normalize(filePath);

  return workspaceRoots
    .map((root) => ({
      root,
      candidate: resolve(root, normalizedRelative),
    }))
    .filter(({ root, candidate }) => isPathWithinRoot(candidate, root));
}

async function getExistingWorkspaceCandidates(
  candidates: readonly WorkspaceCandidate[],
): Promise<WorkspaceCandidate[]> {
  const flags = await Promise.all(candidates.map((c) => pathExists(c.candidate)));
  return candidates.filter((_, i) => flags[i]);
}

async function resolveRelativeWorkspaceCandidate(
  filePath: string,
  workspaceRoots: readonly string[],
): Promise<WorkspaceCandidate> {
  const candidates = getRelativeWorkspaceCandidates(filePath, workspaceRoots);

  if (candidates.length === 0) {
    throw new Error(`Relative path '${filePath}' escapes the workspace root.`);
  }

  const existingCandidates = await getExistingWorkspaceCandidates(candidates);
  const matchedCandidates = existingCandidates.length > 0 ? existingCandidates : candidates;

  if (matchedCandidates.length > 1) {
    throw buildAmbiguousWorkspacePathError(
      filePath,
      matchedCandidates.map((candidate) => candidate.root),
    );
  }

  const selected = matchedCandidates[0];
  if (!selected) {
    throw new Error(`Unable to resolve path: ${filePath}`);
  }

  return selected;
}

function intersectRoots(serverRoots: string[], clientRoots: string[]): string[] {
  const intersections: string[] = [];

  for (const serverRoot of serverRoots) {
    for (const clientRoot of clientRoots) {
      if (isPathWithinRoot(serverRoot, clientRoot)) {
        intersections.push(serverRoot);
        continue;
      }

      if (isPathWithinRoot(clientRoot, serverRoot)) {
        intersections.push(clientRoot);
      }
    }
  }

  return dedupeRoots(intersections);
}

export async function getAllowedRoots(rootsFetcher?: RootsFetcher): Promise<string[]> {
  const configuredRoots = getConfiguredRoots();
  const fallbackRoots = configuredRoots ?? getCwdFallbackRoots();
  if (!rootsFetcher) return fallbackRoots;

  try {
    const clientRoots = await rootsFetcher();
    if (!configuredRoots) {
      return clientRoots.length > 0 ? clientRoots : fallbackRoots;
    }

    if (clientRoots.length === 0) {
      return fallbackRoots;
    }

    return intersectRoots(configuredRoots, clientRoots);
  } catch {
    return fallbackRoots;
  }
}

function buildRootsFetcher(
  getClientCapabilities: () =>
    | { roots?: { listChanged?: boolean | undefined } | undefined }
    | undefined,
  listRoots: () => Promise<{ roots: { uri: string; name?: string | undefined }[] }>,
): RootsFetcher {
  return async () => {
    if (!getClientCapabilities()?.roots) return [];
    const { roots } = await listRoots();
    return roots.map((r) => parseRootUri(r.uri)).filter((p): p is string => p !== undefined);
  };
}

export async function resolveWorkspacePath(
  filePath: string,
  rootsFetcher?: RootsFetcher,
): Promise<ResolvedWorkspacePath> {
  const clientRoots = await getClientRoots(rootsFetcher);
  const workspaceRoots = getEffectiveWorkspaceRoots(clientRoots);
  const allowedRoots = await getAllowedRoots(rootsFetcher);

  if (allowedRoots.length === 0) {
    const hasConfiguredIntent =
      getConfiguredRoots() !== undefined || getRootsFallbackCwd() || clientRoots.length > 0;

    if (!hasConfiguredIntent) {
      throw new Error(
        `Path '${filePath}' rejected: no workspace roots are configured. Set ROOTS to declare allowed directories or advertise client roots. (ROOTS_FALLBACK_CWD is disabled — set it to true to allow the server's working directory.)`,
      );
    }

    throw new Error(
      `Path '${filePath}' is outside allowed directories. Set ROOTS to expand access.`,
    );
  }

  const allowedWorkspaceRoots = getEffectiveAllowedWorkspaceRoots(workspaceRoots, allowedRoots);

  let resolvedPath: string;
  let workspaceRoot: string | undefined;

  if (isAbsolute(filePath)) {
    resolvedPath = await canonicalizePath(filePath);
    workspaceRoot = chooseDisplayRoot(resolvedPath, allowedWorkspaceRoots);
  } else {
    const selected = await resolveRelativeWorkspaceCandidate(filePath, allowedWorkspaceRoots);
    resolvedPath = await canonicalizePath(selected.candidate);
    workspaceRoot = selected.root;
  }

  const isUnderAllowedRoot = allowedRoots.some((root) => isPathWithinRoot(resolvedPath, root));

  if (!isUnderAllowedRoot) {
    throw new Error(
      `Path '${filePath}' is outside allowed directories. Set ROOTS to expand access.`,
    );
  }

  return {
    resolvedPath,
    displayPath: toDisplayPath(resolvedPath, workspaceRoot),
    workspaceRoot,
  };
}

export function buildServerRootsFetcher(server: McpServer): RootsFetcher {
  return buildRootsFetcher(
    () => server.server.getClientCapabilities(),
    () => server.server.listRoots(),
  );
}

// ── Workspace Path Validation ─────────────────────────────────────────────

/**
 * Validate a file path for security (prevent path traversal attacks).
 * Checks for:
 *  - Directory traversal sequences (e.g., ../)
 *  - Windows drive letter prefixes (e.g., C:\)
 *
 * Workspace-relative paths may include a leading slash.
 * Examples: 'src/foo.ts' → true, '/src/foo.ts' → true, '../etc/passwd' → error
 *
 * @param path - The file path to validate
 * @returns true if path is valid within workspace
 * @throws ProtocolError if path is invalid
 */
export function validateScanPath(path: string): boolean {
  if (!path || path.length === 0) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Path cannot be empty');
  }
  if (/^[A-Za-z]:/.test(path)) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Path must be workspace-relative');
  }
  const normalized = normalize(path);
  if (normalized.includes('..') || normalized.startsWith('..')) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      'Path traversal detected: cannot use .. sequences',
    );
  }
  return true;
}

/**
 * Normalize a file path to canonical form (forward slashes, leading slash).
 * Handles both Windows (C:\...) and Unix paths.
 * Adds leading slash if missing.
 * Converts backslashes to forward slashes.
 *
 * @param path - The file path to normalize
 * @returns Normalized path (e.g., '/src/foo.ts')
 */
export function normalizeWorkspacePath(path: string): string {
  let normalized = path.replace(/^[A-Za-z]:/, '');
  normalized = normalized.replace(/\\/g, '/');
  normalized = normalized.replace(/\/+$/, '');
  if (normalized.length > 0 && !normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }
  normalized = normalized.replace(/\/+/g, '/');
  if (normalized === '') {
    normalized = '/';
  }
  return normalized;
}
