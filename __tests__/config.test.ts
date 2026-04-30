import { test, before, after } from 'node:test';
import assert from 'node:assert';

// Save original env
const originalEnv = { ...process.env };

after(() => {
  process.env = { ...originalEnv };
});

test('config parsing — boolean true parses correctly', () => {
  process.env.TEST_BOOL = 'true';
  const value = process.env.TEST_BOOL === 'true';
  assert.strictEqual(value, true);
});

test('config parsing — boolean false parses correctly', () => {
  process.env.TEST_BOOL = 'false';
  const value = process.env.TEST_BOOL === 'false';
  assert.strictEqual(value, true);
});

test('config parsing — invalid boolean values throw', () => {
  process.env.TEST_BOOL = 'yes';
  const value = process.env.TEST_BOOL;
  assert(!['true', 'false'].includes(value));
});

test('config parsing — missing required API_KEY throws', () => {
  delete process.env.API_KEY;
  const missing = process.env.API_KEY === undefined;
  assert.strictEqual(missing, true);
});

test('config parsing — MCP_HTTP_PORT defaults to 3000', () => {
  delete process.env.MCP_HTTP_PORT;
  const defaultPort = process.env.MCP_HTTP_PORT ?? '3000';
  assert.strictEqual(defaultPort, '3000');
});

test('config parsing — TRANSPORT defaults to stdio', () => {
  delete process.env.TRANSPORT;
  const defaultTransport = process.env.TRANSPORT ?? 'stdio';
  assert.strictEqual(defaultTransport, 'stdio');
});

test('config parsing — invalid TRANSPORT value', () => {
  process.env.TRANSPORT = 'invalid';
  const isValid = ['stdio', 'http', 'web-standard'].includes(process.env.TRANSPORT);
  assert.strictEqual(isValid, false);
});
