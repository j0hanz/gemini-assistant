import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';

import { realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, isAbsolute, normalize, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAllowedHostsEnv, getRootsEnv } from '../config.js';
import { AppError } from './errors.js';

// ── Host Validation ───────────────────────────────────────────────────

const LOCALHOST_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const LOCALHOST_BIND_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const BROAD_BIND_ADDRESSES = new Set(['0.0.0.0', '::', '']);

function normalizeAllowedHost(host: string): string {
  const cleanHost = host.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return isIP(cleanHost) === 6 ? `[${cleanHost}]` : cleanHost;
}

function stripHostPort(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const bracketEnd = trimmed.indexOf(']');
    return bracketEnd === -1 ? trimmed : trimmed.slice(0, bracketEnd + 1);
  }

  if (isIP(trimmed) === 6) {
    return trimmed;
  }

  const colonIdx = trimmed.lastIndexOf(':');
  return colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx);
}

function normalizeAllowedHostEntry(host: string): string {
  return normalizeAllowedHost(stripHostPort(host));
}

function dedupeAllowedHosts(hosts: string[]): string[] {
  return [...new Set(hosts)];
}

export function parseAllowedHosts(): string[] | undefined {
  const raw = getAllowedHostsEnv();
  if (!raw) return undefined;
  const hosts = raw.split(',').map(normalizeAllowedHostEntry).filter(Boolean);
  const deduped = dedupeAllowedHosts(hosts);
  return deduped.length > 0 ? deduped : undefined;
}

/**
 * Returns the allowed-host list for a given bind address.
 *
 * - Localhost binds auto-resolve to `['localhost','127.0.0.1','[::1]']`.
 * - Broad binds (`0.0.0.0`, `::`) return `undefined`
 *   (caller should log a warning but must not block for backward compat).
 */
export function resolveAllowedHosts(bindHost: string): string[] | undefined {
  const explicit = parseAllowedHosts();
  if (explicit) return explicit;
  if (BROAD_BIND_ADDRESSES.has(bindHost)) return undefined;
  if (LOCALHOST_BIND_HOSTS.has(bindHost)) return LOCALHOST_HOSTS;
  return [normalizeAllowedHost(bindHost)];
}

export function isAutoDerivedAllowedHosts(bindHost: string): boolean {
  return (
    parseAllowedHosts() === undefined &&
    !BROAD_BIND_ADDRESSES.has(bindHost) &&
    !LOCALHOST_BIND_HOSTS.has(bindHost)
  );
}

/**
 * Validates a request `Host` header against an allow-list.
 * Strips the port before comparing (case-insensitive).
 */
export function validateHostHeader(hostHeader: string | null, allowedHosts: string[]): boolean {
  if (!hostHeader) return false;

  const normalizedHost = normalizeAllowedHostEntry(hostHeader);
  return allowedHosts.some((host) => normalizeAllowedHostEntry(host) === normalizedHost);
}

// ── Path Validation ───────────────────────────────────────────────────

export type RootsFetcher = () => Promise<string[]>;

interface ResolvedWorkspacePath {
  resolvedPath: string;
  displayPath: string;
  workspaceRoot: string | undefined;
}

function getEnvRoots(): string[] {
  const allowedFileRootsEnv = getRootsEnv();
  if (!allowedFileRootsEnv) {
    return [normalize(process.cwd())];
  }

  const roots = allowedFileRootsEnv
    .split(',')
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => normalize(root))
    .filter(Boolean);

  return roots.length > 0 ? roots : [normalize(process.cwd())];
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

function getEffectiveWorkspaceRoots(clientRoots: string[]): string[] {
  return clientRoots.length > 0 ? clientRoots : [getDefaultWorkspaceRoot()];
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

interface WorkspaceCandidate {
  candidate: string;
  root: string;
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
  const serverRoots = getEnvRoots();
  if (!rootsFetcher) return serverRoots;

  try {
    const clientRoots = await rootsFetcher();
    if (clientRoots.length === 0) {
      return serverRoots;
    }

    return intersectRoots(serverRoots, clientRoots);
  } catch {
    return serverRoots;
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

export async function resolveAndValidatePath(
  filePath: string,
  rootsFetcher?: RootsFetcher,
): Promise<string> {
  return (await resolveWorkspacePath(filePath, rootsFetcher)).resolvedPath;
}

export async function resolveWorkspacePath(
  filePath: string,
  rootsFetcher?: RootsFetcher,
): Promise<ResolvedWorkspacePath> {
  const clientRoots = await getClientRoots(rootsFetcher);
  const workspaceRoots = getEffectiveWorkspaceRoots(clientRoots);
  const allowedRoots = await getAllowedRoots(rootsFetcher);
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

  const isUnderAllowedRoot =
    allowedRoots.length > 0 && allowedRoots.some((root) => isPathWithinRoot(resolvedPath, root));

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

// ── URL Validation ────────────────────────────────────────────────────

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }

  const [a, b] = parts;

  if (a === 10 || a === 127) {
    return true;
  }

  if (a === 172) {
    return b !== undefined && b >= 16 && b <= 31;
  }

  if (a === 192) {
    return b === 168;
  }

  return a === 169 && b === 254;
}

const PRIVATE_IPV6_PREFIXES = ['fc', 'fd', 'fe8', 'fe9', 'fea', 'feb', '::ffff:'];

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === '::1') return true;
  return PRIVATE_IPV6_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isRejectedHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '[::1]' ||
    normalized === '0.0.0.0'
  ) {
    return true;
  }

  const cleanHost = normalized.replace(/^\[(.*)\]$/, '$1');
  const ipVersion = isIP(cleanHost);
  if (ipVersion === 4) return isPrivateIpv4(cleanHost);
  if (ipVersion === 6) return isPrivateIpv6(cleanHost);

  return false;
}

export function isPublicHttpUrl(url: string): boolean {
  return classifyHttpUrl(url) === undefined;
}

function tryParseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function classifyHttpUrl(url: string): string | undefined {
  const parsed = tryParseUrl(url);
  if (!parsed) {
    return `Invalid URL provided: ${url}`;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Only http:// and https:// URLs are allowed: ${url}`;
  }

  if (isRejectedHost(parsed.hostname)) {
    return `Private, loopback, and localhost URLs are not allowed: ${url}`;
  }

  return undefined;
}

export function validateUrls(urls: readonly string[] | undefined): CallToolResult | undefined {
  if (!urls) return undefined;

  for (const url of urls) {
    const validationMessage = classifyHttpUrl(url);
    if (validationMessage) {
      return {
        content: [{ type: 'text', text: validationMessage }],
        isError: true,
      };
    }
  }

  return undefined;
}

// -- Gemini Request Preflight ------------------------------------------

// Local mirror of orchestration.ActiveCapability to avoid type-import cycle with orchestration.ts.
type PreflightCapability =
  | 'googleSearch'
  | 'urlContext'
  | 'codeExecution'
  | 'fileSearch'
  | 'functions';

export interface GeminiRequestPreflight {
  hasExistingSession?: boolean | undefined;
  jsonMode?: boolean | undefined;
  responseSchema?: unknown;
  sessionId?: string | undefined;
  activeCapabilities: ReadonlySet<PreflightCapability>;
  fileSearchStoreNames?: readonly string[] | undefined;
}

type PreflightCheck = (req: GeminiRequestPreflight) => CallToolResult | undefined;

const disallowSchemaWithCodeExecution: PreflightCheck = (req) => {
  const schemaRequested = req.jsonMode ?? req.responseSchema !== undefined;
  if (schemaRequested && req.activeCapabilities.has('codeExecution')) {
    return new AppError(
      'chat',
      'chat: responseSchema cannot be combined with codeExecution',
    ).toToolResult();
  }
  return undefined;
};

const disallowEmptyFileSearchStore: PreflightCheck = (req) => {
  if (
    req.activeCapabilities.has('fileSearch') &&
    req.fileSearchStoreNames?.some((name) => name.trim().length === 0)
  ) {
    return new AppError(
      'chat',
      'chat: fileSearchStoreNames cannot contain empty values',
    ).toToolResult();
  }
  return undefined;
};

const disallowSchemaInExistingSession: PreflightCheck = (req) => {
  if (req.responseSchema && req.sessionId && req.hasExistingSession) {
    return new AppError(
      'chat',
      'chat: responseSchema cannot be used with an existing chat session. Use it with single-turn or a new session.',
    ).toToolResult();
  }
  return undefined;
};

const PREFLIGHT_CHECKS: readonly PreflightCheck[] = [
  disallowSchemaWithCodeExecution,
  disallowEmptyFileSearchStore,
  disallowSchemaInExistingSession,
];

export function validateGeminiRequest(req: GeminiRequestPreflight): CallToolResult | undefined {
  for (const check of PREFLIGHT_CHECKS) {
    const result = check(req);
    if (result) return result;
  }
  return undefined;
}
