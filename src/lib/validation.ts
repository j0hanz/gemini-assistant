import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';

import { realpath } from 'node:fs/promises';
import { isAbsolute, normalize, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Host Validation ───────────────────────────────────────────────────

const LOCALHOST_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const BROAD_BIND_ADDRESSES = new Set(['0.0.0.0', '::', '']);

function isBroadBind(host: string): boolean {
  return BROAD_BIND_ADDRESSES.has(host);
}

export function parseAllowedHosts(): string[] | undefined {
  const raw = process.env.MCP_ALLOWED_HOSTS;
  if (!raw) return undefined;
  const hosts = raw
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return hosts.length > 0 ? hosts : undefined;
}

/**
 * Returns the allowed-host list for a given bind address.
 *
 * - Explicit `MCP_ALLOWED_HOSTS` always wins.
 * - Localhost binds auto-resolve to `['localhost','127.0.0.1','[::1]']`.
 * - Broad binds (`0.0.0.0`, `::`) without an explicit list return `undefined`
 *   (caller should log a warning but must not block for backward compat).
 */
export function resolveAllowedHosts(bindHost: string): string[] | undefined {
  const explicit = parseAllowedHosts();
  if (explicit) return explicit;
  if (!isBroadBind(bindHost)) return LOCALHOST_HOSTS;
  return undefined;
}

/**
 * Validates a request `Host` header against an allow-list.
 * Strips the port before comparing (case-insensitive).
 */
export function validateHostHeader(hostHeader: string | null, allowedHosts: string[]): boolean {
  if (!hostHeader) return false;

  let hostname: string;

  if (hostHeader.startsWith('[')) {
    // IPv6 with brackets — e.g. [::1]:3000 or [::1]
    const bracketEnd = hostHeader.indexOf(']');
    hostname = bracketEnd === -1 ? hostHeader : hostHeader.slice(0, bracketEnd + 1);
  } else {
    // IPv4 / hostname — strip port after last colon
    const colonIdx = hostHeader.lastIndexOf(':');
    hostname = colonIdx === -1 ? hostHeader : hostHeader.slice(0, colonIdx);
  }

  const lower = hostname.toLowerCase();
  return allowedHosts.some((h) => h.toLowerCase() === lower);
}

// ── Path Validation ───────────────────────────────────────────────────

export type RootsFetcher = () => Promise<string[]>;

const ENV_ROOTS: string[] = process.env.ALLOWED_FILE_ROOTS
  ? process.env.ALLOWED_FILE_ROOTS.split(',').map((r) => normalize(r.trim()))
  : [normalize(process.cwd())];

function parseRootUri(uri: string): string | undefined {
  try {
    return normalize(fileURLToPath(uri));
  } catch {
    return undefined;
  }
}

function normalizePathForComparison(filePath: string): string {
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

export async function getAllowedRoots(rootsFetcher?: RootsFetcher): Promise<string[]> {
  if (!rootsFetcher) return ENV_ROOTS;
  try {
    const clientRoots = await rootsFetcher();
    return clientRoots.length > 0 ? clientRoots : ENV_ROOTS;
  } catch {
    return ENV_ROOTS;
  }
}

export function buildRootsFetcher(
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
  if (!isAbsolute(filePath)) {
    throw new Error(`Path must be absolute: ${filePath}`);
  }

  const normalized = normalize(filePath);

  // Resolve symlinks to get the real path
  let resolved: string;
  try {
    resolved = await realpath(normalized);
  } catch {
    // File may not exist yet — use normalized path for the check
    resolved = resolve(normalized);
  }

  const allowedRoots = await getAllowedRoots(rootsFetcher);

  const isUnderAllowedRoot = allowedRoots.some((root) => isPathWithinRoot(resolved, root));

  if (!isUnderAllowedRoot) {
    throw new Error(
      `Path '${filePath}' is outside allowed directories. Set ALLOWED_FILE_ROOTS to expand access.`,
    );
  }

  return resolved;
}

export function buildServerRootsFetcher(server: McpServer): RootsFetcher {
  return buildRootsFetcher(
    () => server.server.getClientCapabilities(),
    () => server.server.listRoots(),
  );
}

// ── URL Validation ────────────────────────────────────────────────────

export function validateUrls(urls: readonly string[] | undefined): CallToolResult | undefined {
  if (!urls) return undefined;

  for (const url of urls) {
    try {
      new URL(url);
    } catch {
      return {
        content: [{ type: 'text', text: `Invalid URL provided: ${url}` }],
        isError: true,
      };
    }
  }

  return undefined;
}
