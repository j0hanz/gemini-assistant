import { test } from 'node:test';
import assert from 'node:assert';
import { isPathWithinRoot, parseAllowedHosts, validateHostHeader, isPublicHttpUrl } from '../../src/lib/validation.js';

test('isPathWithinRoot — path within root returns true', () => {
  const result = isPathWithinRoot('/root/path/file.txt', '/root');
  assert.strictEqual(result, true);
});

test('isPathWithinRoot — path with ../ traversal rejected', () => {
  const result = isPathWithinRoot('/root/../etc/passwd', '/root');
  assert.strictEqual(result, false);
});

test('parseAllowedHosts — returns allowed hosts from env', () => {
  const hosts = parseAllowedHosts();
  // May be undefined or an array
  assert(hosts === undefined || Array.isArray(hosts));
});

test('validateHostHeader — host in allowlist passes', () => {
  const allowed = validateHostHeader('example.com', ['example.com']);
  assert.strictEqual(allowed, true);
});

test('validateHostHeader — host not in allowlist fails', () => {
  const allowed = validateHostHeader('untrusted.com', ['example.com']);
  assert.strictEqual(allowed, false);
});

test('validateHostHeader — null header and empty allowlist', () => {
  const allowed = validateHostHeader(null, []);
  assert.strictEqual(allowed, false);
});

test('isPublicHttpUrl — http URL passes', () => {
  const valid = isPublicHttpUrl('http://example.com');
  assert.strictEqual(valid, true);
});

test('isPublicHttpUrl — https URL passes', () => {
  const valid = isPublicHttpUrl('https://example.com');
  assert.strictEqual(valid, true);
});

test('isPublicHttpUrl — non-http URL fails', () => {
  const valid = isPublicHttpUrl('ftp://example.com');
  assert.strictEqual(valid, false);
});

test('isPublicHttpUrl — relative path fails', () => {
  const valid = isPublicHttpUrl('/path/to/file');
  assert.strictEqual(valid, false);
});
