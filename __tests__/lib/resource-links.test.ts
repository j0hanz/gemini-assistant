import assert from 'node:assert';
import { test } from 'node:test';

import { appendResourceLinks } from '../../src/lib/resource-links.js';

test('chat tool suggests session and catalog links', () => {
  const sessionId = 'test-session-123';
  const links = appendResourceLinks('chat', { sessionId });

  assert.ok(links.length >= 3, 'chat should suggest at least 3 resources');

  // Check for session detail link
  const sessionLink = links.find((l) => l.uri.includes(sessionId));
  assert.ok(sessionLink, 'should include current session link');
  assert.strictEqual(sessionLink.name, 'Current Session');

  // Check for sessions list link
  const sessionsListLink = links.find((l) => l.uri === 'gemini://sessions');
  assert.ok(sessionsListLink, 'should include sessions list link');

  // Check for catalog link
  const catalogLink = links.find((l) => l.uri.includes('discover/catalog'));
  assert.ok(catalogLink, 'should include tool catalog link');
});

test('chat tool without sessionId suggests catalog only', () => {
  const links = appendResourceLinks('chat');

  assert.ok(links.length >= 2, 'chat should suggest at least 2 resources');

  // Check for sessions list link
  const sessionsListLink = links.find((l) => l.uri === 'gemini://sessions');
  assert.ok(sessionsListLink, 'should include sessions list link');

  // Check for catalog link
  const catalogLink = links.find((l) => l.uri.includes('discover/catalog'));
  assert.ok(catalogLink, 'should include tool catalog link');

  // Should not have session transcript without sessionId
  const transcriptLinks = links.filter((l) => l.uri.includes('transcript'));
  assert.strictEqual(transcriptLinks.length, 0, 'should not include transcript link without sessionId');
});

test('research tool suggests cache and context links', () => {
  const links = appendResourceLinks('research');

  assert.ok(links.length >= 2, 'research should suggest at least 2 resources');

  // Check for workspace cache link
  const cacheLink = links.find((l) => l.uri === 'gemini://workspace/cache');
  assert.ok(cacheLink, 'should include workspace cache link');

  // Check for context link
  const contextLink = links.find((l) => l.uri.includes('discover/context'));
  assert.ok(contextLink, 'should include context link');
});

test('analyze tool suggests file links', () => {
  const filePaths = ['src/index.ts', 'src/lib/response.ts'];
  const links = appendResourceLinks('analyze', { filePaths });

  assert.ok(links.length >= 2, 'analyze should suggest at least 2 resources');

  // Check for workspace contents link
  const contentsLink = links.find((l) => l.uri === 'gemini://workspace/cache/contents');
  assert.ok(contentsLink, 'should include workspace contents link');

  // Check for file links
  const fileLinks = links.filter((l) => l.uri.includes('workspace/files'));
  assert.strictEqual(fileLinks.length, filePaths.length, `should include ${filePaths.length} file links`);

  // Verify each file path is represented
  for (const filePath of filePaths) {
    const expectedUri = `gemini://workspace/files/${filePath}`;
    const fileLink = fileLinks.find((l) => l.uri === expectedUri);
    assert.ok(fileLink, `should include link for ${filePath}`);
  }
});

test('analyze tool without filePaths suggests workspace contents only', () => {
  const links = appendResourceLinks('analyze');

  assert.ok(links.length >= 1, 'analyze should suggest at least 1 resource');

  // Check for workspace contents link
  const contentsLink = links.find((l) => l.uri === 'gemini://workspace/cache/contents');
  assert.ok(contentsLink, 'should include workspace contents link');

  // Should not have file links without filePaths
  const fileLinks = links.filter((l) => l.uri.includes('workspace/files'));
  assert.strictEqual(fileLinks.length, 0, 'should not include file links without filePaths');
});

test('review tool suggests session links', () => {
  const sessionId = 'review-session-456';
  const links = appendResourceLinks('review', { sessionId });

  assert.ok(links.length >= 1, 'review should suggest at least 1 resource');

  // Check for session detail link
  const sessionLink = links.find((l) => l.uri.includes(sessionId));
  assert.ok(sessionLink, 'should include review session link');
  assert.strictEqual(sessionLink.name, 'Review Session');
});

test('resource links have correct structure', () => {
  const links = appendResourceLinks('chat', { sessionId: 'test-123' });

  for (const link of links) {
    assert.ok(typeof link.uri === 'string', 'link uri should be a string');
    assert.ok(link.uri.startsWith('gemini://') || link.uri.startsWith('assistant://'), 'link uri should be absolute');
    assert.ok(link.name !== undefined, 'link should have a name');
    assert.ok(link.description !== undefined, 'link should have a description');
    assert.ok(link.mimeType !== undefined, 'link should have a mimeType');
  }
});

test('resource links mimeTypes are valid', () => {
  const links = appendResourceLinks('chat', { sessionId: 'test-123' });

  const validMimeTypes = [
    'application/json',
    'text/markdown',
    'text/plain',
    'application/x-ndjson',
  ];

  for (const link of links) {
    assert.ok(
      validMimeTypes.includes(link.mimeType),
      `link mimeType should be valid: ${link.mimeType}`,
    );
  }
});

test('appendResourceLinks returns array', () => {
  const result = appendResourceLinks('chat');
  assert.ok(Array.isArray(result), 'appendResourceLinks should return an array');
});

test('appendResourceLinks handles all tool names', () => {
  const toolNames: ('chat' | 'research' | 'analyze' | 'review')[] = [
    'chat',
    'research',
    'analyze',
    'review',
  ];

  for (const toolName of toolNames) {
    const links = appendResourceLinks(toolName);
    assert.ok(Array.isArray(links), `appendResourceLinks('${toolName}') should return an array`);
    assert.ok(links.length > 0, `appendResourceLinks('${toolName}') should return at least one link`);
  }
});
