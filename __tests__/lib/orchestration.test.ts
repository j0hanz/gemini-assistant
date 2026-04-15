import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FunctionCallingConfigMode } from '@google/genai';

import { buildOrchestrationConfig, normalizeToolProfile } from '../../src/lib/orchestration.js';

describe('orchestration', () => {
  it('normalizes backward-compatible googleSearch requests', () => {
    assert.strictEqual(normalizeToolProfile({ googleSearch: true }), 'search');
    assert.strictEqual(
      normalizeToolProfile({ googleSearch: true, urls: ['https://example.com'] }),
      'search_url',
    );
  });

  it('builds search-only orchestration', () => {
    const result = buildOrchestrationConfig({ toolProfile: 'search' });

    assert.strictEqual(result.toolProfile, 'search');
    assert.deepStrictEqual(result.tools, [{ googleSearch: {} }]);
    assert.strictEqual(result.toolConfig, undefined);
  });

  it('builds url-only orchestration', () => {
    const result = buildOrchestrationConfig({ toolProfile: 'url' });

    assert.strictEqual(result.toolProfile, 'url');
    assert.deepStrictEqual(result.tools, [{ urlContext: {} }]);
  });

  it('builds search + url orchestration', () => {
    const result = buildOrchestrationConfig({ toolProfile: 'search_url' });

    assert.strictEqual(result.toolProfile, 'search_url');
    assert.deepStrictEqual(result.tools, [{ googleSearch: {} }, { urlContext: {} }]);
  });

  it('builds code-only orchestration', () => {
    const result = buildOrchestrationConfig({ toolProfile: 'code' });

    assert.strictEqual(result.toolProfile, 'code');
    assert.deepStrictEqual(result.tools, [{ codeExecution: {} }]);
  });

  it('builds search + code orchestration', () => {
    const result = buildOrchestrationConfig({ toolProfile: 'search_code' });

    assert.strictEqual(result.toolProfile, 'search_code');
    assert.deepStrictEqual(result.tools, [{ googleSearch: {} }, { codeExecution: {} }]);
  });

  it('enables validated function calling when built-ins are combined with functions', () => {
    const result = buildOrchestrationConfig({
      functionDeclarations: [
        {
          name: 'lookupWeather',
          parameters: {
            properties: {
              city: { type: 'string' },
            },
            required: ['city'],
            type: 'object',
          },
        },
      ],
      toolProfile: 'search',
    });

    assert.strictEqual(result.functionCallingMode, FunctionCallingConfigMode.VALIDATED);
    assert.deepStrictEqual(result.toolConfig, { includeServerSideToolInvocations: true });
    assert.deepStrictEqual(result.tools, [
      { googleSearch: {} },
      {
        functionDeclarations: [
          {
            name: 'lookupWeather',
            parameters: {
              properties: {
                city: { type: 'string' },
              },
              required: ['city'],
              type: 'object',
            },
          },
        ],
      },
    ]);
  });
});
