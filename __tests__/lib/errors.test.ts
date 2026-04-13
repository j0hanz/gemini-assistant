import { INVALID_PARAMS, ProtocolError } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { errorResult, geminiErrorResult, throwInvalidParams } from '../../src/lib/errors.js';

describe('errorResult', () => {
  it('returns a CallToolResult with isError true', () => {
    const result = errorResult('something went wrong');
    assert.deepStrictEqual(result, {
      content: [{ type: 'text', text: 'something went wrong' }],
      isError: true,
    });
  });

  it('handles empty string', () => {
    const result = errorResult('');
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.content[0]?.text, '');
  });
});

describe('geminiErrorResult', () => {
  it('formats a generic Error', () => {
    const result = geminiErrorResult('ask', new Error('network timeout'));
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.content[0]?.text, 'ask failed: network timeout');
  });

  it('formats a non-Error value', () => {
    const result = geminiErrorResult('search', 'string error');
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.content[0]?.text, 'search failed: string error');
  });

  it('maps HTTP 429 to rate-limit message', () => {
    const err = Object.assign(new Error('Too many requests'), { status: 429 });
    const result = geminiErrorResult('ask', err);
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /Rate limited/);
  });

  it('maps HTTP 403 to permission denied', () => {
    const err = Object.assign(new Error('Forbidden'), { status: 403 });
    const result = geminiErrorResult('ask', err);
    assert.match(result.content[0]?.text ?? '', /Permission denied/);
  });

  it('maps HTTP 404 to not found', () => {
    const err = Object.assign(new Error('Not found'), { status: 404 });
    const result = geminiErrorResult('search', err);
    assert.match(result.content[0]?.text ?? '', /not found/);
  });

  it('maps HTTP 500 to server error', () => {
    const err = Object.assign(new Error('Internal'), { status: 500 });
    const result = geminiErrorResult('execute_code', err);
    assert.match(result.content[0]?.text ?? '', /server error/);
  });

  it('maps HTTP 503 to service unavailable', () => {
    const err = Object.assign(new Error('Unavailable'), { status: 503 });
    const result = geminiErrorResult('ask', err);
    assert.match(result.content[0]?.text ?? '', /unavailable/);
  });

  it('maps HTTP 400 to bad request', () => {
    const err = Object.assign(new Error('Nope'), { status: 400 });
    const result = geminiErrorResult('ask', err);
    assert.match(result.content[0]?.text ?? '', /Bad request/);
  });

  it('handles unknown HTTP status', () => {
    const err = Object.assign(new Error('wat'), { status: 418 });
    const result = geminiErrorResult('ask', err);
    assert.match(result.content[0]?.text ?? '', /HTTP 418/);
  });

  it('handles AbortError', () => {
    const err = new DOMException('Aborted', 'AbortError');
    const result = geminiErrorResult('ask', err);
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.content[0]?.text, 'ask: cancelled by client');
  });
});

describe('throwInvalidParams', () => {
  it('throws ProtocolError with INVALID_PARAMS code', () => {
    assert.throws(
      () => throwInvalidParams('bad input'),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === INVALID_PARAMS && err.message === 'bad input',
    );
  });
});
