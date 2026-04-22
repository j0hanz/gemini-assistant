import { ProtocolError } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { listDiscoveryEntries, listWorkflowEntries } from '../src/catalog.js';
import {
  cacheDetailUri,
  DISCOVER_CATALOG_URI,
  DISCOVER_CONTEXT_URI,
  DISCOVER_WORKFLOWS_URI,
  MEMORY_CACHES_URI,
  MEMORY_WORKSPACE_CACHE_URI,
  MEMORY_WORKSPACE_CONTEXT_URI,
} from '../src/lib/resource-uris.js';
import { workspaceCacheManager } from '../src/lib/workspace-context.js';
import { PUBLIC_RESOURCE_URIS, PUBLIC_WORKFLOW_NAMES } from '../src/public-contract.js';
import {
  buildServerContextSnapshot,
  getSessionEventsResourceData,
  getSessionTranscriptResourceData,
  readCacheDetailResource,
  readDiscoverCatalogResource,
  readDiscoverContextResource,
  readDiscoverWorkflowsResource,
  readSessionEventsResource,
  readSessionTranscriptResource,
  readWorkspaceContextResource,
  renderServerContextMarkdown,
  renderWorkspaceContextMarkdown,
} from '../src/resources.js';
import { createSessionStore, type SessionStore } from '../src/sessions.js';

function parseResourceText(result: { contents: { text: string }[] }) {
  return JSON.parse(result.contents[0]?.text ?? 'null') as unknown;
}

function mockChat(label = 'chat') {
  return { _label: label } as unknown as never;
}

function createStore(): SessionStore {
  return createSessionStore();
}

describe('discovery resources', () => {
  it('reads discover://catalog with deterministic catalog contents and markdown rendering', () => {
    const result = readDiscoverCatalogResource('discover://catalog');
    const data = parseResourceText(result) as ReturnType<typeof listDiscoveryEntries>;

    assert.strictEqual(result.contents.length, 2);
    assert.strictEqual(result.contents[0]?.mimeType, 'application/json');
    assert.deepStrictEqual(data, listDiscoveryEntries());
    assert.deepStrictEqual(
      data.map((entry) => `${entry.kind}:${entry.name}`),
      [
        'tool:analyze',
        'tool:chat',
        'tool:memory',
        'tool:research',
        'tool:review',
        'prompt:discover',
        'prompt:memory',
        'prompt:research',
        'prompt:review',
        'resource:discover://catalog',
        'resource:discover://context',
        'resource:discover://workflows',
        'resource:memory://caches',
        'resource:memory://caches/{cacheName}',
        'resource:memory://sessions',
        'resource:memory://sessions/{sessionId}',
        'resource:memory://sessions/{sessionId}/events',
        'resource:memory://sessions/{sessionId}/transcript',
        'resource:memory://workspace/cache',
        'resource:memory://workspace/context',
      ],
    );
    assert.strictEqual(result.contents[1]?.mimeType, 'text/markdown');
    assert.match(result.contents[1]?.text ?? '', /^# Discovery Catalog/m);
    assert.match(result.contents[1]?.text ?? '', /## Tools/);
  });

  it('reads discover://workflows with start-here first and markdown rendering', () => {
    const result = readDiscoverWorkflowsResource('discover://workflows');
    const data = parseResourceText(result) as ReturnType<typeof listWorkflowEntries>;

    assert.strictEqual(result.contents.length, 2);
    assert.strictEqual(result.contents[0]?.mimeType, 'application/json');
    assert.deepStrictEqual(data, listWorkflowEntries());
    assert.deepStrictEqual(
      data.map((entry) => entry.name),
      [...PUBLIC_WORKFLOW_NAMES],
    );
    assert.strictEqual(result.contents[1]?.mimeType, 'text/markdown');
    assert.match(result.contents[1]?.text ?? '', /^# Workflow Catalog/m);
    assert.match(result.contents[1]?.text ?? '', /### start-here/);
  });

  it('reads discover://context with snapshot data and markdown rendering', async () => {
    const sessionStore = createStore();
    const result = await readDiscoverContextResource(
      'discover://context',
      async () => [],
      sessionStore,
    );
    const data = parseResourceText(result) as Awaited<
      ReturnType<typeof buildServerContextSnapshot>
    >;

    assert.strictEqual(result.contents.length, 2);
    assert.strictEqual(result.contents[0]?.mimeType, 'application/json');
    assert.ok(data.workspace.roots.length >= 1);
    assert.strictEqual(result.contents[1]?.mimeType, 'text/markdown');
    assert.match(result.contents[1]?.text ?? '', /^# Server Context/m);
  });

  it('builds discover://context from lightweight filename scans and cached token metadata', async () => {
    const sessionStore = createStore();
    const originalAllowedRoots = process.env.ROOTS;
    const originalStatus = workspaceCacheManager.getCacheStatus.bind(workspaceCacheManager);
    const root = await mkdtemp(join(tmpdir(), 'discover-context-lightweight-'));
    await writeFile(join(root, 'readme.md'), 'x'.repeat(20_000), 'utf8');
    await writeFile(join(root, 'package.json'), '{"name":"demo"}', 'utf8');
    await writeFile(join(root, 'notes.txt'), 'ignore me', 'utf8');
    process.env.ROOTS = root;

    workspaceCacheManager.getCacheStatus = () => ({
      enabled: true,
      cacheName: 'cachedContents/workspace-ctx',
      contentHash: 'hash',
      estimatedTokens: 321,
      sources: [join(root, 'readme.md')],
      createdAt: Date.now(),
      ttl: '3600s',
    });

    try {
      const snapshot = await buildServerContextSnapshot(async () => [root], sessionStore);

      assert.deepStrictEqual(snapshot.workspace.scannedFiles, ['package.json', 'readme.md']);
      assert.strictEqual(snapshot.workspace.estimatedTokens, 321);
      assert.strictEqual(snapshot.workspace.cacheStatus.fresh, true);
      assert.doesNotMatch(renderServerContextMarkdown(snapshot), /x{100}/);
    } finally {
      process.env.ROOTS = originalAllowedRoots;
      workspaceCacheManager.getCacheStatus = originalStatus;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marks cached workspace status stale once the TTL has expired', async () => {
    const sessionStore = createStore();
    const originalStatus = workspaceCacheManager.getCacheStatus.bind(workspaceCacheManager);

    workspaceCacheManager.getCacheStatus = () => ({
      enabled: true,
      cacheName: 'cachedContents/workspace-stale',
      contentHash: 'hash',
      estimatedTokens: 321,
      sources: [],
      createdAt: Date.now() - 10_000,
      ttl: '1s',
    });

    try {
      const snapshot = await buildServerContextSnapshot(async () => [], sessionStore);

      assert.strictEqual(snapshot.workspace.cacheStatus.fresh, false);
    } finally {
      workspaceCacheManager.getCacheStatus = originalStatus;
    }
  });

  it('keeps the concrete and templated resource URI ordering stable', () => {
    assert.deepStrictEqual(
      [...PUBLIC_RESOURCE_URIS].filter((uri) => !uri.includes('{')),
      [
        'discover://catalog',
        'discover://context',
        'discover://workflows',
        'memory://sessions',
        'memory://caches',
        'memory://workspace/context',
        'memory://workspace/cache',
      ],
    );
    assert.deepStrictEqual(
      [...PUBLIC_RESOURCE_URIS].filter((uri) => uri.includes('{')),
      [
        'memory://sessions/{sessionId}',
        'memory://sessions/{sessionId}/transcript',
        'memory://sessions/{sessionId}/events',
        'memory://caches/{cacheName}',
      ],
    );
  });
});

describe('workspace context resource', () => {
  it('renders markdown with token count, sources, and content', () => {
    const markdown = renderWorkspaceContextMarkdown({
      content: '## Project\n\nSome assembled context.',
      estimatedTokens: 123,
      sources: ['C:/repo/README.md', 'C:/repo/src/index.ts'],
    });

    assert.match(markdown, /^# Workspace Context/m);
    assert.match(markdown, /Estimated tokens: 123/);
    assert.match(markdown, /## Sources/);
    assert.match(markdown, /- C:\/repo\/README\.md/);
    assert.match(markdown, /- C:\/repo\/src\/index\.ts/);
    assert.match(markdown, /## Content/);
    assert.match(markdown, /Some assembled context\./);
  });

  it('returns workspace context as markdown text content', () => {
    const result = readWorkspaceContextResource('memory://workspace/context', {
      content: 'Workspace body',
      estimatedTokens: 42,
      sources: [],
    });

    assert.strictEqual(result.contents[0]?.uri, 'memory://workspace/context');
    assert.strictEqual(result.contents[0]?.mimeType, 'text/markdown');
    assert.match(result.contents[0]?.text ?? '', /^# Workspace Context/m);
    assert.throws(() => {
      JSON.parse(result.contents[0]?.text ?? '');
    });
  });

  it('renders server context markdown with cache, sessions, and config', () => {
    const markdown = renderServerContextMarkdown({
      workspace: {
        roots: ['C:/repo'],
        scannedFiles: ['README.md'],
        estimatedTokens: 42,
        cacheStatus: {
          enabled: true,
          cacheName: 'cachedContents/workspace-1',
          fresh: true,
          ttl: '3600s',
        },
      },
      sessions: {
        active: 1,
        maxSessions: 50,
        ttlMs: 1_800_000,
        ids: ['sess-1'],
      },
      config: {
        model: 'gemini-3-flash-preview',
        exposeThoughts: false,
        workspaceCacheEnabled: true,
        workspaceAutoScan: true,
      },
    });

    assert.match(markdown, /^# Server Context/m);
    assert.match(markdown, /## Workspace/);
    assert.match(markdown, /## Sessions/);
    assert.match(markdown, /## Config/);
    assert.match(markdown, /cachedContents\/workspace-1/);
  });

  it('caps displayed filenames in server context markdown', () => {
    const markdown = renderServerContextMarkdown({
      workspace: {
        roots: ['C:/repo'],
        scannedFiles: Array.from({ length: 12 }, (_, index) => `file-${String(index)}.md`),
        estimatedTokens: 42,
        cacheStatus: {
          enabled: true,
          cacheName: 'cachedContents/workspace-1',
          fresh: true,
          ttl: '3600s',
        },
      },
      sessions: {
        active: 1,
        maxSessions: 50,
        ttlMs: 1_800_000,
        ids: ['sess-1'],
      },
      config: {
        model: 'gemini-3-flash-preview',
        exposeThoughts: false,
        workspaceCacheEnabled: true,
        workspaceAutoScan: true,
      },
    });

    assert.match(markdown, /\(\+2 more\) \(12 files\)/);
    assert.doesNotMatch(markdown, /file-10\.md, file-11\.md/);
  });
});

describe('session transcript resource', () => {
  it('reads transcript entries for an active session', () => {
    const store = createStore();
    store.setSession('sess-resource-transcript', mockChat('resource-transcript'));
    store.appendSessionTranscript('sess-resource-transcript', {
      role: 'user',
      text: 'Hello',
      timestamp: 1,
    });
    store.appendSessionTranscript('sess-resource-transcript', {
      role: 'assistant',
      text: 'Hi there',
      timestamp: 2,
    });

    const result = readSessionTranscriptResource(
      store,
      'memory://sessions/sess-resource-transcript/transcript',
      'sess-resource-transcript',
    );
    assert.strictEqual(result.contents.length, 2);
    assert.strictEqual(result.contents[0]?.mimeType, 'application/json');
    assert.deepStrictEqual(
      parseResourceText(result),
      store.listSessionTranscriptEntries('sess-resource-transcript'),
    );
    assert.strictEqual(result.contents[1]?.mimeType, 'text/markdown');
    assert.match(result.contents[1]?.text ?? '', /# Session Transcript `sess-resource-transcript`/);
    assert.match(result.contents[1]?.text ?? '', /## user/);
    assert.match(result.contents[1]?.text ?? '', /## assistant/);
  });

  it('reads transcript entries for a session ID whose resource URI must be encoded', () => {
    const store = createStore();
    const sessionId = 'sess resource%/#';
    const encodedSessionId = encodeURIComponent(sessionId);
    store.setSession(sessionId, mockChat('resource-transcript-encoded'));
    store.appendSessionTranscript(sessionId, {
      role: 'user',
      text: 'Hello',
      timestamp: 1,
    });

    const result = readSessionTranscriptResource(
      store,
      `memory://sessions/${encodedSessionId}/transcript`,
      encodedSessionId,
    );

    assert.strictEqual(result.contents[0]?.uri, `memory://sessions/${encodedSessionId}/transcript`);
    assert.match(result.contents[1]?.text ?? '', /# Session Transcript `sess resource%\/#`/);
  });

  it('renders a not-found error for a missing session transcript', () => {
    const store = createStore();
    assert.throws(
      () => readSessionTranscriptResource(store, 'memory://sessions/missing/transcript', 'missing'),
      { message: /not found/i },
    );
  });

  it('throws ProtocolError for a missing session transcript', () => {
    const store = createStore();
    assert.throws(() => getSessionTranscriptResourceData(store, 'missing-session'), {
      message: /not found/i,
    });
  });

  it('maps malformed transcript URI encoding to InvalidParams', () => {
    const store = createStore();
    store.setSession('sess-resource-transcript', mockChat('resource-transcript'));

    assert.throws(
      () => readSessionTranscriptResource(store, 'memory://sessions/%E0%A4/transcript', '%E0%A4'),
      (error) => error instanceof ProtocolError && /percent-encoding/i.test(error.message),
    );
  });
});

describe('session events resource', () => {
  it('reads event entries for an active session with JSON and markdown renderings', () => {
    const store = createStore();
    store.setSession('sess-resource-events', mockChat('resource-events'));
    store.appendSessionEvent('sess-resource-events', {
      request: { message: 'Hello', toolProfile: 'search' },
      response: {
        text: 'Hi there',
        data: { status: 'ok' },
        schemaWarnings: ['normalized inspection summary'],
        thoughts: 'Reasoning summary',
        toolEvents: [{ kind: 'tool_call', id: 'tool-1', toolType: 'GOOGLE_SEARCH_WEB' }],
        usage: { totalTokenCount: 12 },
      },
      timestamp: 1,
    });

    const result = readSessionEventsResource(
      store,
      'memory://sessions/sess-resource-events/events',
      'sess-resource-events',
    );
    assert.strictEqual(result.contents.length, 2);
    assert.strictEqual(result.contents[0]?.mimeType, 'application/json');
    assert.deepStrictEqual(
      parseResourceText(result),
      store.listSessionEventEntries('sess-resource-events'),
    );
    assert.strictEqual(result.contents[1]?.mimeType, 'text/markdown');
    assert.match(result.contents[1]?.text ?? '', /# Session Events `sess-resource-events`/);
    assert.match(result.contents[1]?.text ?? '', /- Message: Hello/);
    assert.match(result.contents[1]?.text ?? '', /### Response/);
    assert.match(result.contents[1]?.text ?? '', /- tool_call \(GOOGLE_SEARCH_WEB\)/);
  });

  it('reads event entries for a session ID whose resource URI must be encoded', () => {
    const store = createStore();
    const sessionId = 'sess resource%/#';
    const encodedSessionId = encodeURIComponent(sessionId);
    store.setSession(sessionId, mockChat('resource-events-encoded'));
    store.appendSessionEvent(sessionId, {
      request: { message: 'Hello' },
      response: { text: 'Hi there' },
      timestamp: 1,
    });

    const result = readSessionEventsResource(
      store,
      `memory://sessions/${encodedSessionId}/events`,
      encodedSessionId,
    );

    assert.strictEqual(result.contents[0]?.uri, `memory://sessions/${encodedSessionId}/events`);
    assert.match(result.contents[1]?.text ?? '', /# Session Events `sess resource%\/#`/);
  });

  it('throws ProtocolError for a missing session events resource', () => {
    const store = createStore();
    assert.throws(
      () => readSessionEventsResource(store, 'memory://sessions/missing/events', 'missing'),
      { message: /not found/i },
    );
  });

  it('throws ProtocolError for a missing session events data', () => {
    const store = createStore();
    assert.throws(() => getSessionEventsResourceData(store, 'missing-session'), {
      message: /not found/i,
    });
  });
});

describe('cache detail resource', () => {
  it('maps malformed cache URI encoding to InvalidParams', async () => {
    await assert.rejects(
      () => readCacheDetailResource('memory://caches/%E0%A4', '%E0%A4'),
      (error) => error instanceof ProtocolError && /percent-encoding/i.test(error.message),
    );
  });

  it('maps cache backend failures to InternalError', async () => {
    await assert.rejects(
      () =>
        readCacheDetailResource(
          'memory://caches/cachedContents%2Fworkspace-1',
          'cachedContents%2Fworkspace-1',
          async () => {
            throw new Error('boom');
          },
        ),
      (error) => error instanceof ProtocolError && /failed to read cache/i.test(error.message),
    );
  });

  it('maps missing cache summaries to ResourceNotFound', async () => {
    await assert.rejects(
      () =>
        readCacheDetailResource(
          'memory://caches/cachedContents%2Fworkspace-1',
          'cachedContents%2Fworkspace-1',
          async () => null,
        ),
      (error) => error instanceof ProtocolError && /not found/i.test(error.message),
    );
  });
});

describe('resource URI constants', () => {
  it('match the concrete and templated resource contract strings', () => {
    assert.strictEqual(DISCOVER_CATALOG_URI, 'discover://catalog');
    assert.strictEqual(DISCOVER_WORKFLOWS_URI, 'discover://workflows');
    assert.strictEqual(DISCOVER_CONTEXT_URI, 'discover://context');
    assert.strictEqual(MEMORY_CACHES_URI, 'memory://caches');
    assert.strictEqual(MEMORY_WORKSPACE_CONTEXT_URI, 'memory://workspace/context');
    assert.strictEqual(MEMORY_WORKSPACE_CACHE_URI, 'memory://workspace/cache');
    assert.strictEqual(
      cacheDetailUri('cachedContents/workspace-1'),
      'memory://caches/cachedContents%2Fworkspace-1',
    );
    assert.ok(PUBLIC_RESOURCE_URIS.includes(`${MEMORY_CACHES_URI}/{cacheName}`));
  });
});
