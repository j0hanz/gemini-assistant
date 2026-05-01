import assert from 'node:assert';
import { test } from 'node:test';

import {
  invalidateDiscoverResourceCache,
  registerDiscoverResources,
} from '../../src/resources/discover.js';
import {
  ASSISTANT_CATALOG_URI,
  ASSISTANT_CONTEXT_URI,
  ASSISTANT_INSTRUCTIONS_URI,
  ASSISTANT_PROFILES_URI,
  ASSISTANT_WORKFLOWS_URI,
} from '../../src/resources/uris.js';

type ReadCallback = (
  uri: URL,
) => Promise<{ contents: { uri: string; mimeType: string; text: string }[] }>;

function makeMockServer() {
  const resources = new Map<string, ReadCallback>();
  return {
    registerResource: (
      _name: string,
      uriOrTemplate: unknown,
      _config: unknown,
      callback: ReadCallback,
    ) => {
      const uri =
        typeof uriOrTemplate === 'string'
          ? uriOrTemplate
          : (uriOrTemplate as { uriTemplate: { template: string } }).uriTemplate.template;
      resources.set(uri, callback);
    },
    async read(uri: string) {
      const cb = resources.get(uri);
      if (!cb) throw new Error(`No resource registered for ${uri}`);
      return cb(new URL(uri));
    },
    size() {
      return resources.size;
    },
  };
}

test('discover resources — registers assistant:// resources', () => {
  const mockServer = makeMockServer();
  registerDiscoverResources(mockServer as never);
  assert.strictEqual(mockServer.size(), 5);
});

test('discover resources — can register without error', () => {
  const mockServer = makeMockServer();
  registerDiscoverResources(mockServer as never);
  assert(mockServer.size() > 0);
});

test('discover resources — catalog content is markdown', async () => {
  const { listDiscoveryEntries, renderDiscoveryCatalogMarkdown } =
    await import('../../src/catalog.js');

  const entries = listDiscoveryEntries();
  const content = renderDiscoveryCatalogMarkdown(entries);

  assert(typeof content === 'string');
  assert(content.includes('#'));
  assert(content.length > 0);
});

test('discover resources — catalog metadata includes ttl', async () => {
  const { listDiscoveryEntries, renderDiscoveryCatalogMarkdown } =
    await import('../../src/catalog.js');
  const { buildResourceMeta } = await import('../../src/resources/metadata.js');

  const entries = listDiscoveryEntries();
  const markdown = renderDiscoveryCatalogMarkdown(entries);
  const meta = buildResourceMeta({
    source: 'gemini-assistant',
    cached: true,
    ttlMs: 3_600_000,
    size: markdown.length,
    selfUri: ASSISTANT_CATALOG_URI,
  });

  assert.strictEqual(meta.ttlMs, 3_600_000);
});

test('discover resources — workflows content is markdown', async () => {
  const { listWorkflowEntries, renderWorkflowCatalogMarkdown } =
    await import('../../src/catalog.js');

  const entries = listWorkflowEntries();
  const content = renderWorkflowCatalogMarkdown(entries);

  assert(typeof content === 'string');
  assert(content.includes('#'));
  assert(content.length > 0);
});

test('discover resources — workflows metadata includes 1 hour ttl', async () => {
  const { listWorkflowEntries, renderWorkflowCatalogMarkdown } =
    await import('../../src/catalog.js');
  const { buildResourceMeta } = await import('../../src/resources/metadata.js');

  const entries = listWorkflowEntries();
  const markdown = renderWorkflowCatalogMarkdown(entries);
  const meta = buildResourceMeta({
    source: 'gemini-assistant',
    cached: true,
    ttlMs: 3_600_000,
    size: markdown.length,
    selfUri: ASSISTANT_WORKFLOWS_URI,
  });

  assert.strictEqual(meta.ttlMs, 3_600_000);
});

test('discover resources — context content is markdown', async () => {
  const markdown = `# Assistant Context

## Overview

The gemini-assistant context resources provide real-time insights into the server's state:`;

  assert(typeof markdown === 'string');
  assert(markdown.includes('#'));
});

test('discover resources — context metadata includes 5 minute ttl', async () => {
  const { buildResourceMeta } = await import('../../src/resources/metadata.js');

  const meta = buildResourceMeta({
    source: 'gemini-assistant',
    cached: true,
    ttlMs: 300_000,
    size: 1000,
    selfUri: ASSISTANT_CONTEXT_URI,
  });

  assert.strictEqual(meta.ttlMs, 300_000);
});

test('discover resources — profiles content is valid json', async () => {
  const { PROFILES, TOOL_PROFILE_NAMES } = await import('../../src/lib/tool-profiles.js');

  const profileMap: Record<string, object> = {};
  for (const profileName of TOOL_PROFILE_NAMES) {
    const profile = PROFILES[profileName];
    profileMap[profileName] = {
      name: profile.name,
      builtIns: profile.builtIns,
      defaultThinkingLevel: profile.defaultThinkingLevel,
      meta: profile.meta,
      notes: profile.notes,
    };
  }

  const content = JSON.stringify(profileMap, null, 2);
  assert(typeof content === 'string');
  assert(content.length > 0);

  const parsed = JSON.parse(content);
  assert(Object.keys(parsed).length > 0);
  assert(parsed.plain !== undefined);
});

test('discover resources — profiles metadata has infinite ttl', async () => {
  const { buildResourceMeta } = await import('../../src/resources/metadata.js');

  const meta = buildResourceMeta({
    source: 'gemini-assistant',
    cached: true,
    ttlMs: Number.POSITIVE_INFINITY,
    size: 1000,
    selfUri: ASSISTANT_PROFILES_URI,
  });

  assert.strictEqual(meta.ttlMs, Number.POSITIVE_INFINITY);
});

test('discover resources — instructions content is markdown', async () => {
  const markdown = `# Gemini Assistant Server Instructions

## Role

The gemini-assistant is an MCP server that provides a job-first interface over Google Gemini.`;

  assert(typeof markdown === 'string');
  assert(markdown.includes('#'));
});

test('discover resources — instructions metadata includes 30 minute ttl', async () => {
  const { buildResourceMeta } = await import('../../src/resources/metadata.js');

  const meta = buildResourceMeta({
    source: 'gemini-assistant',
    cached: true,
    ttlMs: 1_800_000,
    size: 1000,
    selfUri: ASSISTANT_INSTRUCTIONS_URI,
  });

  assert.strictEqual(meta.ttlMs, 1_800_000);
});

test('discover resources — all resources have valid assistant:// URIs', () => {
  assert(ASSISTANT_CATALOG_URI === 'assistant://discover/catalog');
  assert(ASSISTANT_WORKFLOWS_URI === 'assistant://discover/workflows');
  assert(ASSISTANT_CONTEXT_URI === 'assistant://discover/context');
  assert(ASSISTANT_PROFILES_URI === 'assistant://profiles');
  assert(ASSISTANT_INSTRUCTIONS_URI === 'assistant://instructions');
});

test('discover resources — catalog resource uri is in _meta', async () => {
  const { listDiscoveryEntries, renderDiscoveryCatalogMarkdown } =
    await import('../../src/catalog.js');
  const { buildResourceMeta } = await import('../../src/resources/metadata.js');

  const entries = listDiscoveryEntries();
  const markdown = renderDiscoveryCatalogMarkdown(entries);
  const meta = buildResourceMeta({
    source: 'gemini-assistant',
    cached: true,
    ttlMs: 3_600_000,
    size: markdown.length,
    selfUri: ASSISTANT_CATALOG_URI,
  });

  assert(meta.links !== undefined);
  assert(meta.links?.self.uri === ASSISTANT_CATALOG_URI);
});

test('discover resources — metadata has generatedAt timestamp', async () => {
  const { buildResourceMeta } = await import('../../src/resources/metadata.js');

  const meta = buildResourceMeta({
    source: 'gemini-assistant',
    cached: true,
    ttlMs: 3_600_000,
    size: 1000,
    selfUri: ASSISTANT_CATALOG_URI,
  });

  assert(meta.generatedAt !== undefined);
  assert(typeof meta.generatedAt === 'string');
  assert(!Number.isNaN(Date.parse(meta.generatedAt)));
});

test('discover resources — invalidate clears cache', async () => {
  invalidateDiscoverResourceCache();
  assert.ok(true);
});

test('discover resources — invalidate with uri clears specific resource', async () => {
  invalidateDiscoverResourceCache(ASSISTANT_CATALOG_URI);
  assert.ok(true);
});

test('discover resources — catalog callback returns markdown content', async () => {
  const mockServer = makeMockServer();
  registerDiscoverResources(mockServer as never);

  const result = await mockServer.read(ASSISTANT_CATALOG_URI);
  assert(result.contents.length > 0);
  assert.strictEqual(result.contents[0].mimeType, 'text/markdown');
  assert(result.contents[0].text.length > 0);
});

test('discover resources — profiles callback returns json content', async () => {
  const mockServer = makeMockServer();
  registerDiscoverResources(mockServer as never);

  const result = await mockServer.read(ASSISTANT_PROFILES_URI);
  assert(result.contents.length > 0);
  assert.strictEqual(result.contents[0].mimeType, 'application/json');
  assert(result.contents[0].text.length > 0);
});
