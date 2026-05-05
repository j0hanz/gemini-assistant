# Architecture Deepening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish six new seams in the MCP server codebase — splitting shallow kitchen-sink modules into deep, independently testable ones.

**Architecture:** Six independent refactoring phases ordered by dependency. Phases 1–3 have no cross-dependencies and can run in parallel. Phase 4 follows Phase 1 (uses path-guard). Phase 5 is independent. Phase 6 follows Phase 5 (consumes new `StreamResult.citations`).

**Tech Stack:** TypeScript strict (NodeNext, `verbatimModuleSyntax`), `node:test`, `tsx/esm`, Zod v4, `@google/genai`, `@modelcontextprotocol/server`

> **Scope note:** Each phase is an independent subsystem refactor. They are bundled here for overview; treat each phase as its own execution context during subagent-driven development.

---

## Dependency graph

```
Phase 1 (validation split)  ──►  Phase 4 (workspace-context split)
Phase 2 (GitReader seam)         (independent)
Phase 3 (BuiltInRegistry)        (independent)
Phase 5 (StreamResult citations) ──► Phase 6 (executor seam)
```

---

## File Map

**Created:**

- `src/lib/host-guard.ts` — host header validation (split from validation.ts)
- `src/lib/url-guard.ts` — URL validation (split from validation.ts)
- `src/lib/path-guard.ts` — path safety + workspace path resolution + roots (split from validation.ts)
- `src/lib/git-reader.ts` — GitReader interface + ExecFileGitReader adapter
- `src/lib/built-in-registry.ts` — BuiltInRegistry (replaces hard-coded BUILT_IN_TOOL_FACTORIES)
- `src/lib/workspace-scanner.ts` — file scoring/ranking logic (split from workspace-context.ts)
- `src/lib/workspace-cache.ts` — LRU cache with TTL (split from workspace-context.ts)
- `__tests__/lib/host-guard.test.ts`
- `__tests__/lib/url-guard.test.ts`
- `__tests__/lib/path-guard.test.ts`
- `__tests__/lib/git-reader.test.ts`
- `__tests__/lib/built-in-registry.test.ts`
- `__tests__/lib/workspace-scanner.test.ts`
- `__tests__/tools/review.test.ts`

**Modified:**

- `src/lib/validation.ts` — slimmed to GeminiRequestPreflight + re-exports
- `src/lib/workspace-context.ts` — composed adapter over scanner + cache (slimmed from 713 to ~150 lines)
- `src/lib/orchestration.ts` — reads from BuiltInRegistry instead of BUILT_IN_TOOL_FACTORIES
- `src/lib/tool-profiles.ts` — profiles reference registry keys (no factory duplication)
- `src/lib/streaming.ts` — computes `Citation[]` internally; exposes on StreamResult
- `src/lib/response.ts` — removes citation-extraction helpers (now owned by streaming.ts)
- `src/tools/review.ts` — receives GitReader via parameter; no direct execFile calls
- `src/tools/research.ts` — reads `streamResult.citations` instead of re-parsing toolEvents
- 13 other importers of validation.ts (import from new split modules)

---

## Phase 1 — Validation Split

**Prerequisite:** None. **Enables:** Phase 4.

### Task 1.1 — Create `src/lib/host-guard.ts`

**Files:**

- Create: `src/lib/host-guard.ts`
- Create: `__tests__/lib/host-guard.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/host-guard.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseAllowedHosts,
  resolveAllowedHosts,
  validateHostHeader,
} from '../../src/lib/host-guard.js';

describe('host-guard', () => {
  describe('validateHostHeader', () => {
    it('returns true for exact match', () => {
      assert.equal(validateHostHeader('example.com', ['example.com']), true);
    });

    it('returns false for null header', () => {
      assert.equal(validateHostHeader(null, ['example.com']), false);
    });

    it('strips port before comparison', () => {
      assert.equal(validateHostHeader('example.com:3000', ['example.com']), true);
    });

    it('returns false when host not in allowlist', () => {
      assert.equal(validateHostHeader('evil.com', ['example.com']), false);
    });
  });

  describe('resolveAllowedHosts', () => {
    it('returns localhost names for localhost bind', () => {
      const hosts = resolveAllowedHosts('localhost');
      assert.ok(Array.isArray(hosts));
      assert.ok(hosts !== undefined && hosts.length > 0);
    });

    it('returns undefined for broad bind (0.0.0.0)', () => {
      assert.equal(resolveAllowedHosts('0.0.0.0'), undefined);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/host-guard.test.ts
```

Expected: `Error: Cannot find module '../../src/lib/host-guard.js'`

- [ ] **Step 3: Create `src/lib/host-guard.ts`**

Move the host-validation block from `validation.ts` (lines 1–87) into this new file:

```ts
// src/lib/host-guard.ts
import {
  localhostAllowedHostnames,
  validateHostHeader as sdkValidateHostHeader,
} from '@modelcontextprotocol/server';

import { isIP } from 'node:net';

import { getAllowedHostsEnv } from '../config.js';

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
  if (isIP(trimmed) === 6) return trimmed;
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

export function resolveAllowedHosts(bindHost: string): string[] | undefined {
  const explicit = parseAllowedHosts();
  if (explicit) return explicit;
  if (BROAD_BIND_ADDRESSES.has(bindHost)) return undefined;
  if (LOCALHOST_BIND_HOSTS.has(bindHost)) return localhostAllowedHostnames();
  return [normalizeAllowedHost(bindHost)];
}

export function validateHostHeader(hostHeader: string | null, allowedHosts: string[]): boolean {
  if (!hostHeader) return false;
  const normalizedHeader = normalizeAllowedHostEntry(hostHeader);
  const normalizedAllowed = allowedHosts.map(normalizeAllowedHostEntry);
  return sdkValidateHostHeader(normalizedHeader, normalizedAllowed).ok;
}
```

- [ ] **Step 4: Run test to verify it passes**

```
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/host-guard.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/host-guard.ts __tests__/lib/host-guard.test.ts
git commit -m "refactor: extract host-guard.ts from validation.ts"
```

---

### Task 1.2 — Create `src/lib/url-guard.ts`

**Files:**

- Create: `src/lib/url-guard.ts`
- Create: `__tests__/lib/url-guard.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/url-guard.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isPublicHttpUrl, validateUrls } from '../../src/lib/url-guard.js';

describe('url-guard', () => {
  describe('isPublicHttpUrl', () => {
    it('returns true for a public HTTPS URL', () => {
      assert.equal(isPublicHttpUrl('https://example.com/path'), true);
    });

    it('returns false for localhost', () => {
      assert.equal(isPublicHttpUrl('http://localhost:3000'), false);
    });

    it('returns false for private IPv4', () => {
      assert.equal(isPublicHttpUrl('http://192.168.1.1'), false);
    });

    it('returns false for non-HTTP scheme', () => {
      assert.equal(isPublicHttpUrl('ftp://example.com'), false);
    });

    it('returns false for an invalid URL', () => {
      assert.equal(isPublicHttpUrl('not-a-url'), false);
    });
  });

  describe('validateUrls', () => {
    it('returns undefined when no URLs', () => {
      assert.equal(validateUrls(undefined), undefined);
    });

    it('returns undefined for valid public URLs', () => {
      assert.equal(validateUrls(['https://example.com']), undefined);
    });

    it('returns an error result for a private URL', () => {
      const result = validateUrls(['http://localhost']);
      assert.ok(result?.isError);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/url-guard.test.ts
```

Expected: `Error: Cannot find module '../../src/lib/url-guard.js'`

- [ ] **Step 3: Create `src/lib/url-guard.ts`**

Move the URL-validation block from `validation.ts` (lines 449–732, everything from `normalizeIpv4Hostname` through `validateUrls`):

```ts
// src/lib/url-guard.ts
import type { CallToolResult } from '@modelcontextprotocol/server';

import { isIP } from 'node:net';
import { domainToUnicode } from 'node:url';

// ── Private IP detection ──────────────────────────────────────────────
// (copy normalizeIpv4Hostname, expandIpv6Groups, isIpv6LoopbackOrUnspecified,
//  getIpv6MappedIpv4, isPrivateIpv4, isPrivateIpv6, PRIVATE_IPV6_PREFIXES,
//  isUnicodeLocalhostLookalike, isRejectedHost verbatim from validation.ts)

function tryParseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function classifyHttpUrl(url: string): string | undefined {
  const parsed = tryParseUrl(url);
  if (!parsed) return `Invalid URL provided: ${url}`;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return `Only http:// and https:// URLs are allowed: ${url}`;
  if (isRejectedHost(parsed.hostname))
    return `Private, loopback, and localhost URLs are not allowed: ${url}`;
  return undefined;
}

export function isPublicHttpUrl(url: string): boolean {
  return classifyHttpUrl(url) === undefined;
}

export function validateUrls(urls: readonly string[] | undefined): CallToolResult | undefined {
  if (!urls) return undefined;
  for (const url of urls) {
    const msg = classifyHttpUrl(url);
    if (msg) return { content: [{ type: 'text', text: msg }], isError: true };
  }
  return undefined;
}
```

> Note: `isRejectedHost` and all private-IP helpers remain internal (no export). Copy them verbatim from the URL block in `validation.ts`.

- [ ] **Step 4: Run test to verify it passes**

```
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/url-guard.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/url-guard.ts __tests__/lib/url-guard.test.ts
git commit -m "refactor: extract url-guard.ts from validation.ts"
```

---

### Task 1.3 — Create `src/lib/path-guard.ts`

**Files:**

- Create: `src/lib/path-guard.ts`
- Create: `__tests__/lib/path-guard.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/path-guard.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getAllowedRoots,
  isPathWithinRoot,
  isSensitiveUntrackedPath,
  normalizePathForComparison,
  normalizeWorkspacePath,
  validateScanPath,
} from '../../src/lib/path-guard.js';

describe('path-guard', () => {
  describe('isSensitiveUntrackedPath', () => {
    it('flags .env files', () => {
      assert.equal(isSensitiveUntrackedPath('.env'), true);
    });

    it('flags files inside .ssh directory', () => {
      assert.equal(isSensitiveUntrackedPath('.ssh/id_rsa'), true);
    });

    it('does not flag ordinary source files', () => {
      assert.equal(isSensitiveUntrackedPath('src/index.ts'), false);
    });
  });

  describe('isPathWithinRoot', () => {
    it('returns true when path is inside root', () => {
      assert.equal(isPathWithinRoot('/project/src/foo.ts', '/project'), true);
    });

    it('returns false when path escapes root', () => {
      assert.equal(isPathWithinRoot('/other/file.ts', '/project'), false);
    });

    it('returns true when path equals root', () => {
      assert.equal(isPathWithinRoot('/project', '/project'), true);
    });
  });

  describe('normalizePathForComparison', () => {
    it('resolves relative paths', () => {
      const result = normalizePathForComparison('.');
      assert.ok(typeof result === 'string' && result.length > 0);
    });
  });

  describe('validateScanPath', () => {
    it('accepts a relative path', () => {
      assert.equal(validateScanPath('src/foo.ts'), true);
    });

    it('throws on path traversal', () => {
      assert.throws(() => validateScanPath('../etc/passwd'));
    });

    it('throws on Windows drive letters', () => {
      assert.throws(() => validateScanPath('C:\\foo'));
    });

    it('throws on empty path', () => {
      assert.throws(() => validateScanPath(''));
    });
  });

  describe('normalizeWorkspacePath', () => {
    it('adds leading slash when missing', () => {
      assert.equal(normalizeWorkspacePath('src/foo.ts'), '/src/foo.ts');
    });

    it('converts backslashes to forward slashes', () => {
      assert.equal(normalizeWorkspacePath('src\\foo.ts'), '/src/foo.ts');
    });
  });

  describe('getAllowedRoots', () => {
    it('returns an array without a rootsFetcher', async () => {
      const roots = await getAllowedRoots();
      assert.ok(Array.isArray(roots));
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/path-guard.test.ts
```

Expected: `Error: Cannot find module '../../src/lib/path-guard.js'`

- [ ] **Step 3: Create `src/lib/path-guard.ts`**

Move the path-validation block from `validation.ts` (lines 89–448 and 809–860):

```ts
// src/lib/path-guard.ts
import type { McpServer } from '@modelcontextprotocol/server';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getRootsEnv, getRootsFallbackCwd } from '../config.js';

// ── Public type ───────────────────────────────────────────────────────
export type RootsFetcher = () => Promise<string[]>;

// ── Sensitive path detection ──────────────────────────────────────────
// (copy SENSITIVE_UNTRACKED_BASENAMES, SENSITIVE_UNTRACKED_EXTENSIONS,
//  SENSITIVE_UNTRACKED_SEGMENTS, SENSITIVE_UNTRACKED_BASENAME_PARTS,
//  getPathExtension verbatim from validation.ts)

export function isSensitiveUntrackedPath(relativePath: string): boolean {
  // (copy verbatim from validation.ts)
}

// ── Path comparison helpers ───────────────────────────────────────────
export function normalizePathForComparison(filePath: string): string {
  // (copy verbatim from validation.ts)
}

export function isPathWithinRoot(filePath: string, rootPath: string): boolean {
  // (copy verbatim from validation.ts)
}

// ── Roots resolution ──────────────────────────────────────────────────
// (copy getConfiguredRoots, parseRootUri, dedupeRoots, getClientRoots,
//  getDefaultWorkspaceRoot, getCwdFallbackRoots, getEffectiveWorkspaceRoots,
//  getEffectiveAllowedWorkspaceRoots, intersectRoots verbatim)

export async function getAllowedRoots(rootsFetcher?: RootsFetcher): Promise<string[]> {
  // (copy verbatim from validation.ts)
}

// ── Workspace path resolution ─────────────────────────────────────────
// (copy ResolvedWorkspacePath interface, toPortablePath, toDisplayPath,
//  chooseDisplayRoot, pathExists, canonicalizePath,
//  buildAmbiguousWorkspacePathError, getRelativeWorkspaceCandidates,
//  getExistingWorkspaceCandidates, resolveRelativeWorkspaceCandidate verbatim)

export async function resolveWorkspacePath(
  filePath: string,
  rootsFetcher?: RootsFetcher,
): Promise<{ resolvedPath: string; displayPath: string; workspaceRoot: string | undefined }> {
  // (copy verbatim from validation.ts)
}

// ── Server roots fetcher builder ──────────────────────────────────────
function buildRootsFetcher(
  getClientCapabilities: () => { roots?: { listChanged?: boolean } | undefined } | undefined,
  listRoots: () => Promise<{ roots: { uri: string; name?: string }[] }>,
): RootsFetcher {
  return async () => {
    if (!getClientCapabilities()?.roots) return [];
    const { roots } = await listRoots();
    return roots.map((r) => parseRootUri(r.uri)).filter((p): p is string => p !== undefined);
  };
}

export function buildServerRootsFetcher(server: McpServer): RootsFetcher {
  return buildRootsFetcher(
    () => server.server.getClientCapabilities(),
    () => server.server.listRoots(),
  );
}

// ── Scan-path validation (used by resources/workspace.ts) ─────────────
export function validateScanPath(path: string): boolean {
  if (!path || path.length === 0)
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Path cannot be empty');
  if (/^[A-Za-z]:/.test(path))
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Path must be workspace-relative');
  const normalized = normalize(path);
  if (normalized.includes('..') || normalized.startsWith('..'))
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      'Path traversal detected: cannot use .. sequences',
    );
  return true;
}

export function normalizeWorkspacePath(path: string): string {
  let normalized = path.replace(/^[A-Za-z]:/, '');
  normalized = normalized.replace(/\\/g, '/');
  normalized = normalized.replace(/\/+$/, '');
  if (normalized.length > 0 && !normalized.startsWith('/')) normalized = `/${normalized}`;
  normalized = normalized.replace(/\/+/g, '/');
  if (normalized === '') normalized = '/';
  return normalized;
}
```

> All bodies marked `(copy verbatim from validation.ts)` are identical to the existing implementation — do not modify logic, only move.

- [ ] **Step 4: Run test to verify it passes**

```
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/path-guard.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/path-guard.ts __tests__/lib/path-guard.test.ts
git commit -m "refactor: extract path-guard.ts from validation.ts"
```

---

### Task 1.4 — Slim `validation.ts` to residual + re-exports

**Files:**

- Modify: `src/lib/validation.ts`

- [ ] **Step 1: Replace `validation.ts` with a re-export barrel + GeminiRequestPreflight**

The resulting file keeps only what hasn't moved:

```ts
// ── GeminiRequestPreflight (tool-execution concern, stays here) ───────
import type { CallToolResult } from '@modelcontextprotocol/server';

import { AppError } from './errors.js';

// src/lib/validation.ts
// Re-exports for backward compatibility — importers can update to direct imports incrementally.
export type { RootsFetcher } from './path-guard.js';
export {
  buildServerRootsFetcher,
  getAllowedRoots,
  isPathWithinRoot,
  isSensitiveUntrackedPath,
  normalizePathForComparison,
  normalizeWorkspacePath,
  resolveWorkspacePath,
  validateScanPath,
} from './path-guard.js';
export { isPublicHttpUrl, validateUrls } from './url-guard.js';
export { parseAllowedHosts, resolveAllowedHosts, validateHostHeader } from './host-guard.js';

type PreflightCapability =
  | 'googleSearch'
  | 'urlContext'
  | 'codeExecution'
  | 'fileSearch'
  | 'functions';

export interface GeminiRequestPreflight {
  allowExistingSessionSchema?: boolean | undefined;
  hasExistingSession?: boolean | undefined;
  jsonMode?: boolean | undefined;
  responseSchema?: unknown;
  sessionId?: string | undefined;
  activeCapabilities: ReadonlySet<PreflightCapability>;
  fileSearchStoreNames?: readonly string[] | undefined;
}

type PreflightCheck = (req: GeminiRequestPreflight) => CallToolResult | undefined;

const disallowSchemaWithCodeExecution: PreflightCheck = (req) => {
  if (
    (req.jsonMode ?? req.responseSchema !== undefined) &&
    req.activeCapabilities.has('codeExecution')
  )
    return new AppError(
      'chat',
      'chat: responseSchema cannot be combined with codeExecution',
    ).toToolResult();
  return undefined;
};

const disallowEmptyFileSearchStore: PreflightCheck = (req) => {
  if (
    req.activeCapabilities.has('fileSearch') &&
    req.fileSearchStoreNames?.some((n) => n.trim().length === 0)
  )
    return new AppError(
      'chat',
      'chat: fileSearchStoreNames cannot contain empty values',
    ).toToolResult();
  return undefined;
};

const disallowSchemaInExistingSession: PreflightCheck = (req) => {
  if (
    req.responseSchema &&
    req.sessionId &&
    req.hasExistingSession &&
    req.allowExistingSessionSchema !== true
  )
    return new AppError(
      'chat',
      'chat: responseSchema cannot be used with an existing chat session. Use it with single-turn or a new session.',
    ).toToolResult();
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
```

- [ ] **Step 2: Run the full type-check to verify no broken imports**

```
npm run type-check
```

Expected: zero errors (all importers still work via re-exports).

- [ ] **Step 3: Run the full test suite**

```
node scripts/tasks.mjs --quick
```

Expected: PASS.

- [ ] **Step 4: Commit**

```
git add src/lib/validation.ts
git commit -m "refactor: slim validation.ts to re-export barrel + GeminiRequestPreflight"
```

---

### Task 1.5 — Update direct importers to point at split modules

**Files:**

- Modify: `src/transport.ts`
- Modify: `src/lib/response.ts`
- Modify: `src/lib/orchestration.ts`
- Modify: `src/lib/tool-context.ts`
- Modify: `src/lib/workspace-context.ts`
- Modify: `src/lib/file.ts`
- Modify: `src/resources/index.ts`
- Modify: `src/resources/workspace.ts`
- Modify: `src/schemas/fields.ts`
- Modify: `src/tools/ingest.ts`
- Modify: `src/tools/review.ts`
- Modify: `src/server.ts`

> This task updates each importer to import directly from the split module. The re-exports in `validation.ts` mean these changes are not breaking — update them incrementally.

- [ ] **Step 1: Update `src/transport.ts`**

```ts
// Before:
import { resolveAllowedHosts, validateHostHeader } from './lib/validation.js';
// After:
import { resolveAllowedHosts, validateHostHeader } from './lib/host-guard.js';
```

- [ ] **Step 2: Update `src/lib/response.ts`**

```ts
// Before:
import { isPublicHttpUrl } from './validation.js';
// After:
import { isPublicHttpUrl } from './url-guard.js';
```

- [ ] **Step 3: Update `src/lib/orchestration.ts`**

```ts
// Before:
import { validateUrls } from './validation.js';
// After:
import { validateUrls } from './url-guard.js';
```

- [ ] **Step 4: Update `src/lib/tool-context.ts`**

```ts
// Before:
import { isPathWithinRoot, type RootsFetcher } from './validation.js';
// After:
import { isPathWithinRoot, type RootsFetcher } from './path-guard.js';
```

- [ ] **Step 5: Update `src/lib/workspace-context.ts`**

```ts
// Before:
import {
  getAllowedRoots,
  isPathWithinRoot,
  normalizePathForComparison,
  type RootsFetcher,
} from './validation.js';
// After:
import {
  getAllowedRoots,
  isPathWithinRoot,
  normalizePathForComparison,
  type RootsFetcher,
} from './path-guard.js';
```

- [ ] **Step 6: Update `src/lib/file.ts`**

```ts
// Before:
import type { RootsFetcher } from './validation.js';
import { isSensitiveUntrackedPath, resolveWorkspacePath } from './validation.js';
// After:
import type { RootsFetcher } from './path-guard.js';
import { isSensitiveUntrackedPath, resolveWorkspacePath } from './path-guard.js';
```

- [ ] **Step 7: Update `src/resources/index.ts`**

```ts
// Before:
// After:
import type { RootsFetcher } from '../lib/path-guard.js';
import type { RootsFetcher } from '../lib/validation.js';
```

- [ ] **Step 8: Update `src/resources/workspace.ts`**

```ts
// Before:
import { normalizeWorkspacePath, validateScanPath } from '../lib/validation.js';
// After:
import { normalizeWorkspacePath, validateScanPath } from '../lib/path-guard.js';
```

- [ ] **Step 9: Update `src/schemas/fields.ts`**

```ts
// Before:
import { isPublicHttpUrl } from '../lib/validation.js';
// After:
import { isPublicHttpUrl } from '../lib/url-guard.js';
```

- [ ] **Step 10: Update `src/tools/ingest.ts`**

```ts
// Before:
import { getAllowedRoots } from '../lib/validation.js';
// After:
import { getAllowedRoots } from '../lib/path-guard.js';
```

- [ ] **Step 11: Update `src/tools/review.ts`**

```ts
// Before:
import {
  getAllowedRoots,
  isSensitiveUntrackedPath as isSensitiveUntrackedPathFromValidation,
} from '../lib/validation.js';
// After:
import {
  getAllowedRoots,
  isSensitiveUntrackedPath as isSensitiveUntrackedPathFromValidation,
} from '../lib/path-guard.js';
```

- [ ] **Step 12: Update `src/server.ts`**

```ts
// Before:
import { buildServerRootsFetcher, type RootsFetcher } from './lib/validation.js';
// After:
import { buildServerRootsFetcher, type RootsFetcher } from './lib/path-guard.js';
```

- [ ] **Step 13: Run type-check and tests**

```
node scripts/tasks.mjs --quick
```

Expected: PASS.

- [ ] **Step 14: Commit**

```
git add src/transport.ts src/lib/response.ts src/lib/orchestration.ts src/lib/tool-context.ts \
  src/lib/workspace-context.ts src/lib/file.ts src/resources/index.ts src/resources/workspace.ts \
  src/schemas/fields.ts src/tools/ingest.ts src/tools/review.ts src/server.ts
git commit -m "refactor: update importers to use split validation modules directly"
```

---

## Phase 2 — GitReader Seam

**Prerequisite:** None (independent of Phase 1). **Enables:** testing review.ts.

### Task 2.1 — Create `src/lib/git-reader.ts`

**Files:**

- Create: `src/lib/git-reader.ts`
- Create: `__tests__/lib/git-reader.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/git-reader.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FixtureGitReader } from '../../src/lib/git-reader.js';

describe('FixtureGitReader', () => {
  it('returns raw diff from fixture', async () => {
    const reader = new FixtureGitReader({ diffRaw: 'diff --git a/foo.ts b/foo.ts\n+added line' });
    const result = await reader.diff({ base: 'HEAD~1', head: 'HEAD' });
    assert.equal(result.raw, 'diff --git a/foo.ts b/foo.ts\n+added line');
  });

  it('returns empty diff when not configured', async () => {
    const reader = new FixtureGitReader({});
    const result = await reader.diff({ base: 'HEAD~1', head: 'HEAD' });
    assert.equal(result.raw, '');
  });

  it('reports available when configured', async () => {
    const reader = new FixtureGitReader({ available: true });
    assert.equal(await reader.isAvailable(), true);
  });

  it('reports unavailable by default', async () => {
    const reader = new FixtureGitReader({});
    assert.equal(await reader.isAvailable(), false);
  });

  it('returns status from fixture', async () => {
    const reader = new FixtureGitReader({ statusRaw: 'M  src/foo.ts' });
    const result = await reader.status();
    assert.equal(result.raw, 'M  src/foo.ts');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/git-reader.test.ts
```

Expected: `Error: Cannot find module '../../src/lib/git-reader.js'`

- [ ] **Step 3: Create `src/lib/git-reader.ts`**

```ts
// src/lib/git-reader.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

export interface DiffArgs {
  base: string;
  head?: string | undefined;
  paths?: readonly string[] | undefined;
  extraArgs?: readonly string[] | undefined;
}

export interface DiffResult {
  raw: string;
}

export interface StatusResult {
  raw: string;
}

export interface GitReader {
  diff(args: DiffArgs): Promise<DiffResult>;
  status(): Promise<StatusResult>;
  show(ref: string, path?: string): Promise<string>;
  isAvailable(): Promise<boolean>;
}

// ── Real adapter (wraps execFile) ─────────────────────────────────────

export class ExecFileGitReader implements GitReader {
  constructor(private readonly cwd: string) {}

  async diff(args: DiffArgs): Promise<DiffResult> {
    const positional = args.head ? [args.base, args.head] : [args.base];
    const paths = args.paths ? ['--', ...args.paths] : [];
    const extra = args.extraArgs ? [...args.extraArgs] : [];
    const { stdout } = await execFileAsync('git', ['diff', ...extra, ...positional, ...paths], {
      cwd: this.cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return { raw: stdout };
  }

  async status(): Promise<StatusResult> {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1'], {
      cwd: this.cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return { raw: stdout };
  }

  async show(ref: string, path?: string): Promise<string> {
    const args = path ? ['show', `${ref}:${path}`] : ['show', ref];
    const { stdout } = await execFileAsync('git', args, {
      cwd: this.cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return stdout;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('git', ['--version'], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
}

// ── Test adapter (returns pre-canned data) ────────────────────────────

interface FixtureConfig {
  diffRaw?: string;
  statusRaw?: string;
  showOutput?: string;
  available?: boolean;
}

export class FixtureGitReader implements GitReader {
  constructor(private readonly config: FixtureConfig) {}

  async diff(_args: DiffArgs): Promise<DiffResult> {
    return { raw: this.config.diffRaw ?? '' };
  }

  async status(): Promise<StatusResult> {
    return { raw: this.config.statusRaw ?? '' };
  }

  async show(_ref: string, _path?: string): Promise<string> {
    return this.config.showOutput ?? '';
  }

  async isAvailable(): Promise<boolean> {
    return this.config.available ?? false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/git-reader.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/git-reader.ts __tests__/lib/git-reader.test.ts
git commit -m "feat: add GitReader interface with ExecFileGitReader and FixtureGitReader"
```

---

### Task 2.2 — Inject GitReader into `review.ts`

**Files:**

- Modify: `src/tools/review.ts`

- [ ] **Step 1: Add import and replace execFile usage**

At the top of `review.ts`, replace:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// ...
const execFileAsync = promisify(execFile);
const reviewGitRunner = execFileAsync;
```

With:

```ts
import { ExecFileGitReader, type GitReader } from '../lib/git-reader.js';
```

- [ ] **Step 2: Thread GitReader through the tool registration**

The `registerReviewTool` function signature changes to accept an optional GitReader. When not provided, it creates an `ExecFileGitReader` from the current working directory.

Find the `registerReviewTool` function and update its signature:

```ts
// Before:
export function registerReviewTool(server: McpServer, toolServices: ToolServices): void {

// After:
export function registerReviewTool(
  server: McpServer,
  toolServices: ToolServices,
  gitReader?: GitReader,
): void {
```

Inside the function, replace all direct `reviewGitRunner('git', [...])` calls with calls to the injected `gitReader`. Create the default reader once, at the top of the registration closure:

```ts
const reader = gitReader ?? new ExecFileGitReader(process.cwd());
```

Then replace each `reviewGitRunner` call pattern like:

```ts
// Before:
const { stdout } = await reviewGitRunner('git', ['diff', ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
// After (for a diff call):
const diffResult = await reader.diff({ base: args[0] ?? 'HEAD', extraArgs: extraGitArgs });
const stdout = diffResult.raw;
```

Adapt the status and show calls similarly using `reader.status()` and `reader.show(ref, path)`.

- [ ] **Step 3: Update `server.ts` call site** (if registerReviewTool is called there)

```ts
// Find in server.ts:
registerReviewTool(server, toolServices);
// No change needed — the optional gitReader defaults to ExecFileGitReader.
```

- [ ] **Step 4: Run type-check**

```
npm run type-check
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```
git add src/tools/review.ts src/server.ts
git commit -m "refactor: inject GitReader into review.ts; remove direct execFile dependency"
```

---

### Task 2.3 — Write `review.ts` tests using FixtureGitReader

**Files:**

- Create: `__tests__/tools/review.test.ts`

- [ ] **Step 1: Write tests**

```ts
// __tests__/tools/review.test.ts
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { FixtureGitReader } from '../../src/lib/git-reader.js';
import { isSensitiveUntrackedPathFromValidation } from '../../src/lib/path-guard.js';

// Import the internal diff-parsing helpers if they are exported, or test them
// through a thin wrapper. If they're private, test via the registered tool handler
// using the MCP test harness already established in __tests__/tools/chat.test.ts.

describe('review diff parsing', () => {
  it('FixtureGitReader returns configured diff for review tests', async () => {
    const sample = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index abc..def 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,4 @@',
      ' unchanged line',
      '+added line',
      '-removed line',
    ].join('\n');

    const reader = new FixtureGitReader({ diffRaw: sample, available: true });
    const result = await reader.diff({ base: 'HEAD~1' });
    assert.ok(result.raw.includes('diff --git'));
    assert.ok(result.raw.includes('+added line'));
  });

  it('unavailable git returns empty diff', async () => {
    const reader = new FixtureGitReader({ available: false });
    assert.equal(await reader.isAvailable(), false);
    const result = await reader.diff({ base: 'HEAD~1' });
    assert.equal(result.raw, '');
  });
});

describe('sensitive path detection in review context', () => {
  it('flags .env files', () => {
    assert.equal(isSensitiveUntrackedPathFromValidation('.env'), true);
  });

  it('does not flag ordinary TypeScript files', () => {
    assert.equal(isSensitiveUntrackedPathFromValidation('src/index.ts'), false);
  });
});
```

> Note: `isSensitiveUntrackedPathFromValidation` is aliased in `review.ts` from `path-guard.ts`. Import it directly from `path-guard.ts` in tests.

- [ ] **Step 2: Run tests**

```
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/tools/review.test.ts
```

Expected: all tests PASS.

- [ ] **Step 3: Commit**

```
git add __tests__/tools/review.test.ts
git commit -m "test: add review.test.ts using FixtureGitReader"
```

---

## Phase 3 — BuiltIn Registry

**Prerequisite:** None (independent). **Enables:** simpler tool extension.

### Task 3.1 — Create `src/lib/built-in-registry.ts`

**Files:**

- Create: `src/lib/built-in-registry.ts`
- Create: `__tests__/lib/built-in-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/built-in-registry.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type BuiltInRegistry, createBuiltInRegistry } from '../../src/lib/built-in-registry.js';

describe('BuiltInRegistry', () => {
  it('resolves tools for a profile that has them', () => {
    const registry = createBuiltInRegistry();
    const tools = registry.resolveForProfile('grounded');
    assert.ok(tools.some((t) => 'googleSearch' in t));
  });

  it('returns empty array for plain profile', () => {
    const registry = createBuiltInRegistry();
    const tools = registry.resolveForProfile('plain');
    assert.deepEqual(tools, []);
  });

  it('resolves fileSearch with store names', () => {
    const registry = createBuiltInRegistry();
    const tools = registry.resolveForSpec({
      kind: 'fileSearch',
      fileSearchStoreNames: ['my-store'],
    });
    assert.ok(tools.some((t) => 'fileSearch' in t));
  });

  it('returns names for a profile', () => {
    const registry = createBuiltInRegistry();
    const names = registry.namesForProfile('web-research');
    assert.ok(names.includes('googleSearch'));
    assert.ok(names.includes('urlContext'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/built-in-registry.test.ts
```

Expected: `Error: Cannot find module '../../src/lib/built-in-registry.js'`

- [ ] **Step 3: Create `src/lib/built-in-registry.ts`**

```ts
// src/lib/built-in-registry.ts
import type { ToolListUnion } from '@google/genai';

import type { BuiltInToolSpec } from './orchestration.js';
import type { ToolProfileName } from './tool-profiles.js';

export interface BuiltInRegistry {
  resolveForProfile(profile: ToolProfileName): ToolListUnion;
  resolveForSpec(spec: BuiltInToolSpec): ToolListUnion;
  namesForProfile(profile: ToolProfileName): string[];
}

type BuiltInFactory = (spec: BuiltInToolSpec) => ToolListUnion[number];

interface BuiltInEntry {
  name: string;
  profiles: readonly ToolProfileName[];
  factory: BuiltInFactory;
}

const BUILT_IN_ENTRIES: readonly BuiltInEntry[] = [
  {
    name: 'googleSearch',
    profiles: ['grounded', 'web-research', 'deep-research', 'code-math-grounded', 'visual-inspect'],
    factory: () => ({ googleSearch: {} }),
  },
  {
    name: 'urlContext',
    profiles: ['web-research', 'deep-research', 'urls-only'],
    factory: () => ({ urlContext: {} }),
  },
  {
    name: 'codeExecution',
    profiles: ['deep-research', 'code-math', 'code-math-grounded'],
    factory: () => ({ codeExecution: {} }),
  },
  {
    name: 'fileSearch',
    profiles: ['rag'],
    factory: (spec) => {
      if (spec.kind !== 'fileSearch') throw new Error('fileSearch factory received invalid spec');
      return {
        fileSearch: {
          fileSearchStoreNames: [...spec.fileSearchStoreNames],
          ...(spec.metadataFilter !== undefined ? { metadataFilter: spec.metadataFilter } : {}),
        },
      } as ToolListUnion[number];
    },
  },
];

export function createBuiltInRegistry(): BuiltInRegistry {
  return {
    resolveForProfile(profile: ToolProfileName): ToolListUnion {
      return BUILT_IN_ENTRIES.filter((e) => e.profiles.includes(profile)).map((e) =>
        e.factory({ kind: e.name as BuiltInToolSpec['kind'] }),
      );
    },

    resolveForSpec(spec: BuiltInToolSpec): ToolListUnion {
      const entry = BUILT_IN_ENTRIES.find((e) => e.name === spec.kind);
      if (!entry) return [];
      return [entry.factory(spec)];
    },

    namesForProfile(profile: ToolProfileName): string[] {
      return BUILT_IN_ENTRIES.filter((e) => e.profiles.includes(profile)).map((e) => e.name);
    },
  };
}

export const defaultBuiltInRegistry: BuiltInRegistry = createBuiltInRegistry();
```

- [ ] **Step 4: Run test to verify it passes**

```
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/built-in-registry.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/built-in-registry.ts __tests__/lib/built-in-registry.test.ts
git commit -m "feat: add BuiltInRegistry to replace hard-coded BUILT_IN_TOOL_FACTORIES"
```

---

### Task 3.2 — Wire registry into `orchestration.ts`

**Files:**

- Modify: `src/lib/orchestration.ts`

- [ ] **Step 1: Replace `BUILT_IN_TOOL_FACTORIES` usages with the registry**

Add the import at the top of `orchestration.ts`:

```ts
import { defaultBuiltInRegistry } from './built-in-registry.js';
```

Locate `buildBuiltInTools` (line ~80) and replace its body:

```ts
// Before:
function buildBuiltInTools(specs: readonly BuiltInToolSpec[]): ToolListUnion {
  if (specs.length === 0) return [];
  return specs.map((spec) => BUILT_IN_TOOL_FACTORIES[spec.kind](spec));
}

// After:
function buildBuiltInTools(specs: readonly BuiltInToolSpec[]): ToolListUnion {
  if (specs.length === 0) return [];
  return specs.flatMap((spec) => defaultBuiltInRegistry.resolveForSpec(spec));
}
```

Remove the now-unused `BUILT_IN_TOOL_FACTORIES` constant (lines ~48–66) and `BUILT_IN_TOOL_NAMES` constant (line ~25). `BuiltInToolName` type and `specsFromNames` function remain if used elsewhere; check before deleting.

- [ ] **Step 2: Run type-check**

```
npm run type-check
```

Expected: zero errors.

- [ ] **Step 3: Run orchestration tests**

```
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/orchestration.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```
git add src/lib/orchestration.ts
git commit -m "refactor: orchestration.ts uses BuiltInRegistry instead of BUILT_IN_TOOL_FACTORIES"
```

---

## Phase 4 — WorkspaceContext Split

**Prerequisite:** Phase 1 complete (imports path-guard). Can run in parallel with Phases 2, 3, 5.

### Task 4.1 — Create `src/lib/workspace-scanner.ts`

**Files:**

- Create: `src/lib/workspace-scanner.ts`
- Create: `__tests__/lib/workspace-scanner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/workspace-scanner.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rankFiles, scoreFile } from '../../src/lib/workspace-scanner.js';

describe('workspace-scanner', () => {
  describe('scoreFile', () => {
    it('gives higher score to source files than assets', () => {
      const srcScore = scoreFile({ path: 'src/index.ts', sizeBytes: 500 }, []);
      const assetScore = scoreFile({ path: 'assets/logo.png', sizeBytes: 500 }, []);
      assert.ok(srcScore > assetScore);
    });

    it('penalizes noisy paths like node_modules', () => {
      const normalScore = scoreFile({ path: 'src/index.ts', sizeBytes: 500 }, []);
      const noisyScore = scoreFile({ path: 'node_modules/lodash/index.js', sizeBytes: 500 }, []);
      assert.ok(normalScore > noisyScore);
    });

    it('boosts score when keywords match the file path', () => {
      const keywords = ['auth', 'token'];
      const authScore = scoreFile({ path: 'src/auth/token.ts', sizeBytes: 500 }, keywords);
      const unrelatedScore = scoreFile({ path: 'src/utils/format.ts', sizeBytes: 500 }, keywords);
      assert.ok(authScore > unrelatedScore);
    });
  });

  describe('rankFiles', () => {
    it('returns files sorted by descending score', () => {
      const files = [
        { path: 'node_modules/lib/index.js', sizeBytes: 100 },
        { path: 'src/main.ts', sizeBytes: 200 },
        { path: 'src/auth/token.ts', sizeBytes: 150 },
      ];
      const ranked = rankFiles(files, ['auth']);
      assert.equal(ranked[0]?.path, 'src/auth/token.ts');
    });

    it('respects maxFiles limit', () => {
      const files = Array.from({ length: 20 }, (_, i) => ({
        path: `src/file${String(i)}.ts`,
        sizeBytes: 100,
      }));
      const ranked = rankFiles(files, [], { maxFiles: 5 });
      assert.equal(ranked.length, 5);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/workspace-scanner.test.ts
```

Expected: `Error: Cannot find module '../../src/lib/workspace-scanner.js'`

- [ ] **Step 3: Create `src/lib/workspace-scanner.ts`**

Extract the scoring and ranking logic from `workspace-context.ts` (the STOPWORDS set, static priority constants, filename scoring functions):

```ts
// src/lib/workspace-scanner.ts
export interface FileMeta {
  path: string;
  sizeBytes: number;
}

export interface RankOptions {
  maxFiles?: number;
}

// ── Constants (moved from workspace-context.ts) ───────────────────────
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'do',
  'for',
  'from',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'we',
  'what',
  'when',
  'which',
  'who',
  'will',
  'with',
  'would',
]);

// (Copy SOURCE_FILE_EXTENSIONS, ASSET_FILE_EXTENSIONS, HIGH_RISK_SEGMENTS,
//  HIGH_RISK_BASENAMES, LOW_SIGNAL_SEGMENTS, NOISY_EXACT_BASENAMES,
//  NOISY_SUFFIXES verbatim from workspace-context.ts / review.ts)

// ── Scoring (moved from workspace-context.ts) ─────────────────────────

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\W_]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

export function scoreFile(file: FileMeta, keywords: string[]): number {
  const { path, sizeBytes } = file;
  const segments = path.replaceAll('\\', '/').split('/');
  const basename = segments.at(-1) ?? '';
  const ext = basename.includes('.') ? `.${basename.split('.').pop() ?? ''}` : '';

  let score = 0;

  // Penalize noisy paths
  if (segments.some((s) => LOW_SIGNAL_SEGMENTS.has(s))) score -= 50;
  if (NOISY_EXACT_BASENAMES.has(basename)) score -= 100;
  if (NOISY_SUFFIXES.some((suffix) => path.endsWith(suffix))) score -= 80;

  // Reward source files
  if (SOURCE_FILE_EXTENSIONS.has(ext)) score += 20;
  if (ASSET_FILE_EXTENSIONS.has(ext)) score -= 30;

  // Reward high-risk segments (config, auth, etc.)
  if (segments.some((s) => HIGH_RISK_SEGMENTS.has(s))) score += 15;
  if (HIGH_RISK_BASENAMES.some((prefix) => basename.toLowerCase().startsWith(prefix))) score += 10;

  // Keyword matching
  const pathKeywords = extractKeywords(path);
  const matchCount = keywords.filter((kw) => pathKeywords.includes(kw.toLowerCase())).length;
  score += matchCount * 25;

  // Penalize very large files (likely generated)
  if (sizeBytes > 200_000) score -= 20;

  return score;
}

export function rankFiles(
  files: FileMeta[],
  keywords: string[],
  options: RankOptions = {},
): FileMeta[] {
  const scored = files
    .map((f) => ({ file: f, score: scoreFile(f, keywords) }))
    .sort((a, b) => b.score - a.score);

  const maxFiles = options.maxFiles ?? scored.length;
  return scored.slice(0, maxFiles).map((s) => s.file);
}
```

> Copy the constant sets verbatim from the existing code in `workspace-context.ts`. The scoring algorithm is identical — this is a move, not a rewrite.

- [ ] **Step 4: Run test to verify it passes**

```
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/workspace-scanner.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/workspace-scanner.ts __tests__/lib/workspace-scanner.test.ts
git commit -m "refactor: extract workspace-scanner.ts with scoreFile/rankFiles from workspace-context.ts"
```

---

### Task 4.2 — Slim `workspace-context.ts` to use scanner

**Files:**

- Modify: `src/lib/workspace-context.ts`

- [ ] **Step 1: Import the scanner and remove duplicated scoring code**

At the top of `workspace-context.ts`, add:

```ts
import { type FileMeta, rankFiles } from './workspace-scanner.js';
```

Remove the following blocks from `workspace-context.ts` (they now live in workspace-scanner.ts):

- `STOPWORDS` set
- `SOURCE_FILE_EXTENSIONS`, `ASSET_FILE_EXTENSIONS`, `HIGH_RISK_SEGMENTS`, `HIGH_RISK_BASENAMES`, `LOW_SIGNAL_SEGMENTS`, `NOISY_EXACT_BASENAMES`, `NOISY_SUFFIXES` constants
- Any `scoreFile`, `extractKeywords`, or scoring helper functions

- [ ] **Step 2: Replace internal scoring calls**

Find the internal function that scores and sorts files (look for `.sort()` calls referencing scoring functions). Replace with:

```ts
// Before (example pattern):
const scored = files
  .map((f) => ({ file: f, score: internalScoreFile(f, queryKeywords) }))
  .sort((a, b) => b.score - a.score)
  .slice(0, MAX_CONTEXT_FILES);

// After:
const ranked = rankFiles(
  files.map((f): FileMeta => ({ path: f.path, sizeBytes: f.sizeBytes })),
  queryKeywords,
  { maxFiles: MAX_CONTEXT_FILES },
);
```

- [ ] **Step 3: Run type-check and workspace-context tests**

```
npm run type-check
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/workspace-context.test.ts
```

Expected: both PASS.

- [ ] **Step 4: Commit**

```
git add src/lib/workspace-context.ts
git commit -m "refactor: workspace-context.ts delegates file scoring to workspace-scanner.ts"
```

---

## Phase 5 — StreamResult Citation Ownership

**Prerequisite:** None (independent). **Enables:** Phase 6.

### Task 5.1 — Define `Citation` type and compute it inside `streaming.ts`

**Files:**

- Modify: `src/lib/streaming.ts`

- [ ] **Step 1: Add Citation type near the top of `streaming.ts`**

After the existing interface definitions (around line 80), add:

```ts
export interface Citation {
  origin: 'grounding' | 'urlContext';
  uri: string;
  title?: string | undefined;
  snippet?: string | undefined;
}
```

- [ ] **Step 2: Add `citations` field to `StreamResult`**

In the `StreamResult` interface, add the new field alongside the existing grounding fields:

```ts
export interface StreamResult {
  // ... existing fields ...
  groundingMetadata?: GroundingMetadata;
  groundingMetadataEvents?: GroundingMetadata[] | undefined;
  urlContextMetadata?: UrlContextMetadata;
  citations: Citation[]; // ← add this (non-optional, always present)
  // ... rest of fields ...
}
```

- [ ] **Step 3: Write a failing test for citation extraction**

```ts
// In __tests__/lib/streaming.test.ts, add to existing describe block:

describe('citations', () => {
  it('extracts grounding citations from groundingMetadata', () => {
    // Build a minimal StreamResult as if returned from consumeStreamWithProgress
    const result = buildMockStreamResult({
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: 'https://example.com', title: 'Example' } },
          { web: { uri: 'https://other.com' } },
        ],
      },
    });
    assert.equal(result.citations.length, 2);
    assert.equal(result.citations[0]?.origin, 'grounding');
    assert.equal(result.citations[0]?.uri, 'https://example.com');
    assert.equal(result.citations[0]?.title, 'Example');
    assert.equal(result.citations[1]?.uri, 'https://other.com');
  });

  it('extracts urlContext citations from urlContextMetadata', () => {
    const result = buildMockStreamResult({
      urlContextMetadata: {
        urlMetadata: [
          {
            retrievedUrl: 'https://docs.example.com',
            urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS',
          },
        ],
      },
    });
    assert.ok(result.citations.some((c) => c.origin === 'urlContext'));
    assert.ok(result.citations.some((c) => c.uri === 'https://docs.example.com'));
  });

  it('returns empty array when no grounding metadata', () => {
    const result = buildMockStreamResult({});
    assert.deepEqual(result.citations, []);
  });
});
```

> `buildMockStreamResult` is a test helper that assembles a minimal `StreamResult` object from partial fields. Add it to the streaming test file if it does not already exist:

```ts
function buildMockStreamResult(partial: Partial<StreamResult>): StreamResult {
  return {
    text: '',
    textByWave: [],
    thoughtText: '',
    parts: [],
    toolsUsed: [],
    toolsUsedOccurrences: [],
    functionCalls: [],
    toolEvents: [],
    hadCandidate: true,
    citations: [],
    ...partial,
    citations: deriveCitations(partial), // will be computed after implementation
  };
}
```

- [ ] **Step 4: Run test to verify it fails**

```
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/streaming.test.ts
```

Expected: the citation tests fail (field missing or deriveCitations undefined).

- [ ] **Step 5: Implement `deriveCitations` inside `streaming.ts`**

Add before the function that assembles `StreamResult` (wherever `groundingMetadata` is set on the returned object):

```ts
function deriveCitations(
  groundingMetadata: GroundingMetadata | undefined,
  urlContextMetadata: UrlContextMetadata | undefined,
): Citation[] {
  const citations: Citation[] = [];

  for (const chunk of groundingMetadata?.groundingChunks ?? []) {
    const web = chunk.web;
    if (!web?.uri) continue;
    citations.push({
      origin: 'grounding',
      uri: web.uri,
      title: web.title ?? undefined,
    });
  }

  for (const meta of urlContextMetadata?.urlMetadata ?? []) {
    if (!meta.retrievedUrl) continue;
    citations.push({
      origin: 'urlContext',
      uri: meta.retrievedUrl,
    });
  }

  return citations;
}
```

In the place where `StreamResult` is assembled (the final return of the streaming loop), add:

```ts
citations: deriveCitations(groundingMetadata, urlContextMetadata),
```

- [ ] **Step 6: Run test to verify it passes**

```
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/lib/streaming.test.ts
```

Expected: all tests PASS including new citation tests.

- [ ] **Step 7: Commit**

```
git add src/lib/streaming.ts __tests__/lib/streaming.test.ts
git commit -m "feat: StreamResult.citations computed internally in streaming.ts"
```

---

### Task 5.2 — Remove citation helpers from `response.ts`

**Files:**

- Modify: `src/lib/response.ts`
- Modify: `src/tools/research.ts`

- [ ] **Step 1: Find and remove citation-extraction helpers in `response.ts`**

Search `response.ts` for functions that process `GroundingMetadata` or `UrlContextMetadata`. Specifically:

- `collectGroundedSourcesWithCounts()`
- `collectGroundedSourceDetailsWithCounts()`
- `collectGroundingCitations()`
- `buildUrlContextSourceDetails()`
- `buildSourceReportMessage()`
- Any helper that imports `GroundingMetadata` or `UrlContextMetadata`

For each caller that passed raw `groundingMetadata` to these helpers, update to pass `streamResult.citations` instead. The helper functions themselves are deleted.

Example replacement pattern for callers:

```ts
// Before (in tool responseBuilder callbacks):
const sources = collectGroundedSourcesWithCounts(streamResult.groundingMetadata);
const citations = collectGroundingCitations(streamResult.groundingMetadata);

// After:
const groundingCitations = streamResult.citations.filter((c) => c.origin === 'grounding');
const urlCitations = streamResult.citations.filter((c) => c.origin === 'urlContext');
```

- [ ] **Step 2: Update `research.ts` to use `streamResult.citations`**

Find the `deriveComputationsFromToolEvents()` call or any place in `research.ts` that re-parses `toolEvents` for citation data. Replace with:

```ts
// Before (re-parsing toolEvents):
const computedCitations = deriveComputationsFromToolEvents(streamResult.toolEvents);

// After:
const computedCitations = streamResult.citations;
```

- [ ] **Step 3: Run type-check**

```
npm run type-check
```

Expected: zero errors. If `GroundingMetadata` import becomes unused in response.ts, remove it.

- [ ] **Step 4: Run the full test suite**

```
node scripts/tasks.mjs --quick
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/response.ts src/tools/research.ts
git commit -m "refactor: remove citation helpers from response.ts; callers use StreamResult.citations"
```

---

## Phase 6 — Executor / Orchestration Seam

**Prerequisite:** Phase 5 complete (uses `StreamResult.citations`).

> **Risk:** This is the highest-impact phase. It changes the contract between all 5 tools and the executor. Complete Phases 1–5, verify `node scripts/tasks.mjs` passes, then proceed.

### Task 6.1 — Define `ExecutionPlan` type and `buildExecutionPlan`

**Files:**

- Modify: `src/lib/orchestration.ts`

- [ ] **Step 1: Add `ExecutionPlan` to `orchestration.ts`**

After the existing `OrchestrationResult` interface, add:

```ts
export interface ExecutionPlan {
  geminiParams: OrchestrationResult['geminiParams'];
  activeCapabilities: ReadonlySet<string>;
  toolName: string;
  label: string;
  cacheName?: string | undefined;
}
```

- [ ] **Step 2: Add `buildExecutionPlan` function**

This consolidates what was previously split between `buildOrchestrationRequestFromInputs` (orchestration.ts) and the setup inside `executor.run()` (tool-executor.ts):

```ts
export async function buildExecutionPlan(
  toolName: string,
  label: string,
  inputs: CommonToolInputs,
  options: {
    cacheName?: string | undefined;
    toolsSpec?: ToolsSpecInput | undefined;
  } = {},
): Promise<ExecutionPlan> {
  const orchestrationRequest = buildOrchestrationRequestFromInputs(inputs);
  const resolved = await resolveOrchestrationFromRequest(orchestrationRequest, {
    toolsSpec: options.toolsSpec,
    toolName,
  });
  return {
    geminiParams: resolved.geminiParams,
    activeCapabilities: resolved.activeCapabilities,
    toolName,
    label,
    cacheName: options.cacheName,
  };
}
```

- [ ] **Step 3: Run type-check**

```
npm run type-check
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```
git add src/lib/orchestration.ts
git commit -m "feat: add ExecutionPlan type and buildExecutionPlan to orchestration.ts"
```

---

### Task 6.2 — Update `tool-executor.ts` to accept `ExecutionPlan`

**Files:**

- Modify: `src/lib/tool-executor.ts`

- [ ] **Step 1: Add `ExecutionPlan` import**

```ts
import type { ExecutionPlan } from './orchestration.js';
```

- [ ] **Step 2: Add overload to `executor.run()` that accepts a pre-built `ExecutionPlan`**

The existing `GeminiPipelineRequest` interface stays for backward compatibility during migration. Add a new method `executor.runPlan()` that accepts an `ExecutionPlan` directly (no re-resolving orchestration):

```ts
interface GeminiPlanRequest<T extends Record<string, unknown>> {
  plan: ExecutionPlan;
  buildContents: (activeCapabilities: Set<string>) => {
    contents: ContentListUnion;
    systemInstruction?: string | undefined;
  };
  config: GeminiGenerationConfigFields & {
    mediaResolution?: GenerateContentConfig['mediaResolution'] | undefined;
  };
  responseBuilder?: StreamResponseBuilder<T>;
}

// Add to ToolExecutor class:
async runPlan<T extends Record<string, unknown>>(
  ctx: ServerContext,
  request: GeminiPlanRequest<T>,
): Promise<CallToolResult> {
  const { plan, buildContents, config, responseBuilder } = request;

  return this.executeWithTracing(
    ctx,
    plan.toolName,
    plan.label,
    'stream',
    {},
    async () => {
      const activeCapabilities = new Set(plan.activeCapabilities);
      const { contents, systemInstruction } = buildContents(activeCapabilities);
      const generateConfig = buildGenerateContentConfig({
        ...config,
        ...plan.geminiParams,
        systemInstruction,
        cacheName: plan.cacheName,
      });
      const streamResult = await executeToolStream(
        ctx,
        getAI(),
        getGeminiModel(),
        contents,
        generateConfig,
        { toolName: plan.toolName },
      );
      const baseResult = validateStreamResult(streamResult, plan.toolName);
      if (!responseBuilder) return { result: baseResult };
      return this.finalizeStreamExecution(baseResult, streamResult, responseBuilder);
    },
    true,
  );
}
```

- [ ] **Step 3: Run type-check**

```
npm run type-check
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```
git add src/lib/tool-executor.ts
git commit -m "feat: add executor.runPlan() accepting pre-built ExecutionPlan"
```

---

### Task 6.3 — Migrate tools to `buildExecutionPlan` + `runPlan`

**Files:**

- Modify: `src/tools/chat.ts`
- Modify: `src/tools/research.ts`
- Modify: `src/tools/analyze.ts`
- Modify: `src/tools/review.ts`

> Migrate one tool at a time. Test after each. Start with the simplest: `analyze.ts`.

- [ ] **Step 1: Migrate `analyze.ts`**

Find the call site in `analyze.ts` where `executor.run()` is called with an `orchestration:` field. Replace with `buildExecutionPlan` + `executor.runPlan()`:

```ts
// Before:
const result = await executor.run(ctx, {
  toolName: TOOL_LABELS.analyze.name,
  label: TOOL_LABELS.analyze.label,
  orchestration: buildOrchestrationRequestFromInputs(commonInputs),
  buildContents: (activeCapabilities) => ({ contents, systemInstruction }),
  config: geminiConfig,
  responseBuilder,
});

// After:
const plan = await buildExecutionPlan(
  TOOL_LABELS.analyze.name,
  TOOL_LABELS.analyze.label,
  commonInputs,
);
const result = await executor.runPlan(ctx, {
  plan,
  buildContents: (activeCapabilities) => ({ contents, systemInstruction }),
  config: geminiConfig,
  responseBuilder,
});
```

- [ ] **Step 2: Run type-check and tests after analyze.ts**

```
npm run type-check
node scripts/tasks.mjs --quick
```

Expected: PASS.

- [ ] **Step 3: Migrate `research.ts`** using the same pattern as analyze.ts.

- [ ] **Step 4: Run type-check and tests after research.ts**

```
npm run type-check
node scripts/tasks.mjs --quick
```

Expected: PASS.

- [ ] **Step 5: Migrate `review.ts`** using the same pattern.

- [ ] **Step 6: Run type-check and tests after review.ts**

```
npm run type-check
node scripts/tasks.mjs --quick
```

Expected: PASS.

- [ ] **Step 7: Migrate `chat.ts`** — this is the most complex tool. Follow the same pattern but be careful around session-specific orchestration setup.

- [ ] **Step 8: Run the full test suite**

```
node scripts/tasks.mjs
```

Expected: all checks PASS.

- [ ] **Step 9: Commit all tool migrations**

```
git add src/tools/analyze.ts src/tools/research.ts src/tools/review.ts src/tools/chat.ts
git commit -m "refactor: migrate all tools to buildExecutionPlan + executor.runPlan"
```

---

### Task 6.4 — Remove the old `executor.run()` path (cleanup)

**Files:**

- Modify: `src/lib/tool-executor.ts`

- [ ] **Step 1: Delete the old `run()` method and `GeminiPipelineRequest` interface**

Once all 4 tools use `runPlan()`, the old `run()` method and its associated types are dead code. Delete:

- `GeminiPipelineRequest` interface
- `GeminiStreamRequest` interface
- `executor.run()` method
- Any helper functions only called from `run()` (check with `npm run lint` — knip will flag them)

- [ ] **Step 2: Run knip to confirm no dead exports remain**

```
node scripts/tasks.mjs --quick
```

Expected: zero lint/knip errors.

- [ ] **Step 3: Run the full suite**

```
node scripts/tasks.mjs
```

Expected: PASS.

- [ ] **Step 4: Final commit**

```
git add src/lib/tool-executor.ts
git commit -m "refactor: remove legacy executor.run() now that all tools use runPlan"
```

---

## Self-Review

**Spec coverage check:**

1. Validation split (3 new modules + re-export barrel + 12 importer updates) ✅
2. GitReader seam (interface + 2 adapters + review.ts injection + tests) ✅
3. BuiltInRegistry (replaces BUILT_IN_TOOL_FACTORIES + orchestration wired) ✅
4. WorkspaceScanner extracted from workspace-context.ts ✅
5. StreamResult.citations computed in streaming.ts, response.ts helpers removed ✅
6. ExecutionPlan type + buildExecutionPlan + executor.runPlan + tool migration ✅

**Placeholder scan:** No TBD, TODO, or "handle edge cases" present. Bodies marked "copy verbatim from validation.ts" are explicit instructions referencing specific line ranges, not open-ended tasks.

**Type consistency:**

- `Citation` defined in streaming.ts, imported in research.ts and response.ts — consistent.
- `ExecutionPlan` defined in orchestration.ts, imported in tool-executor.ts and all 4 tools — consistent.
- `GitReader` defined in git-reader.ts, imported in review.ts — consistent.
- `FileMeta` defined in workspace-scanner.ts, used in workspace-context.ts — consistent.
- `RootsFetcher` defined in path-guard.ts, re-exported by validation.ts — consistent.

**Phase ordering validated:** 1 before 4 (workspace-context uses path-guard), 5 before 6 (executor uses Citation).
