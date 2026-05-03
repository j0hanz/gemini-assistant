import assert from 'node:assert';
import { test } from 'node:test';

import { buildResourceMeta } from '../../src/resources/metadata.js';

// ────────────────────────────────────────────────────────────────────────────
// buildResourceMeta tests
// ────────────────────────────────────────────────────────────────────────────

test('buildResourceMeta — returns object with required fields', () => {
  const meta = buildResourceMeta({});

  assert(meta.generatedAt);
  assert.strictEqual(meta.source, 'gemini-assistant');
  assert.strictEqual(meta.cached, false);
});

test('buildResourceMeta — sets generatedAt to current time if not provided', () => {
  const before = new Date().toISOString();
  const meta = buildResourceMeta({});
  const after = new Date().toISOString();

  assert(meta.generatedAt >= before);
  assert(meta.generatedAt <= after);
});

test('buildResourceMeta — uses provided generatedAt if given', () => {
  const timestamp = '2026-01-15T10:30:00Z';
  const meta = buildResourceMeta({ generatedAt: timestamp });

  assert.strictEqual(meta.generatedAt, timestamp);
});

test('buildResourceMeta — includes cached field', () => {
  const meta = buildResourceMeta({ cached: true });

  assert.strictEqual(meta.cached, true);
});

test('buildResourceMeta — includes ttlMs when provided', () => {
  const meta = buildResourceMeta({ ttlMs: 300000 });

  assert.strictEqual(meta.ttlMs, 300000);
});

test('buildResourceMeta — includes size when provided', () => {
  const meta = buildResourceMeta({ size: 12345 });

  assert.strictEqual(meta.size, 12345);
});

test('buildResourceMeta — does not include ttlMs when not provided', () => {
  const meta = buildResourceMeta({});

  assert.strictEqual(meta.ttlMs, undefined);
});

test('buildResourceMeta — does not include size when not provided', () => {
  const meta = buildResourceMeta({});

  assert.strictEqual(meta.size, undefined);
});

test('buildResourceMeta — adds self link when selfUri provided', () => {
  const uri = 'assistant://discover/catalog';
  const meta = buildResourceMeta({ selfUri: uri });

  assert(meta.links);
  assert(meta.links.self);
  assert.strictEqual(meta.links.self.uri, uri);
});

test('buildResourceMeta — throws error for invalid source', () => {
  assert.throws(
    () => {
      buildResourceMeta({ source: 'invalid-source' });
    },
    (error: unknown) => {
      return error instanceof Error && error.message.includes('Invalid source');
    },
  );
});

test('buildResourceMeta — accepts valid source', () => {
  const meta = buildResourceMeta({ source: 'gemini-assistant' });

  assert.strictEqual(meta.source, 'gemini-assistant');
});

// ────────────────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────────────
