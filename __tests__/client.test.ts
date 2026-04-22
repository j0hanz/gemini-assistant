import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { MockGeminiEnvironment } from './lib/mock-gemini-environment.js';

import { getAI } from '../src/client.js';
import { completeCacheNames } from '../src/client.js';

process.env.API_KEY ??= 'test-key-for-client';

describe('completeCacheNames', () => {
  const env = new MockGeminiEnvironment();

  beforeEach(() => {
    env.install();
  });

  afterEach(() => {
    env.restore();
  });

  it('matches cache names, short names, and display names with prefix-only ranking', async () => {
    const client = getAI();
    client.caches.list = (async () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          name: 'cachedContents/design-review',
          displayName: 'Review Cache',
          expireTime: '2099-01-01T00:00:00.000Z',
          model: 'models/mock-gemini',
        };
        yield {
          name: 'cachedContents/alpha',
          displayName: 'Design System',
          expireTime: '2099-01-01T00:00:00.000Z',
          model: 'models/mock-gemini',
        };
        yield {
          name: 'cachedContents/archive',
          displayName: 'Design Archive',
          expireTime: '2000-01-01T00:00:00.000Z',
          model: 'models/mock-gemini',
        };
      },
    })) as typeof client.caches.list;

    assert.deepStrictEqual(await completeCacheNames('design'), [
      'cachedContents/design-review',
      'cachedContents/alpha',
      'cachedContents/archive',
    ]);
    assert.deepStrictEqual(await completeCacheNames('review'), ['cachedContents/design-review']);
    // Infix-only matches (prefix 'system' appears inside 'Design System' but
    // is not a prefix of any candidate field) must NOT surface. Completion
    // is prefix-oriented per MCP spec.
    assert.deepStrictEqual(await completeCacheNames('system'), []);
  });

  it('excludes cache names whose fields contain but do not start with the prefix', async () => {
    const client = getAI();
    client.caches.list = (async () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          name: 'cachedContents/prod-foo',
          displayName: 'Production Foo',
          expireTime: '2099-01-01T00:00:00.000Z',
          model: 'models/mock-gemini',
        };
        yield {
          name: 'cachedContents/bar-foo',
          displayName: 'Bar Foo Bundle',
          expireTime: '2099-01-01T00:00:00.000Z',
          model: 'models/mock-gemini',
        };
      },
    })) as typeof client.caches.list;

    // 'foo' is a prefix of neither name/short-name nor display name of
    // either cache — only appears as an infix. Both must be excluded.
    assert.deepStrictEqual(await completeCacheNames('foo'), []);
  });

  it('returns fresh caches before expired ones when no prefix is supplied', async () => {
    const client = getAI();
    client.caches.list = (async () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          name: 'cachedContents/expired-cache',
          displayName: 'Expired Cache',
          expireTime: '2000-01-01T00:00:00.000Z',
          model: 'models/mock-gemini',
        };
        yield {
          name: 'cachedContents/fresh-cache',
          displayName: 'Fresh Cache',
          expireTime: '2099-01-01T00:00:00.000Z',
          model: 'models/mock-gemini',
        };
      },
    })) as typeof client.caches.list;

    assert.deepStrictEqual(await completeCacheNames(), [
      'cachedContents/fresh-cache',
      'cachedContents/expired-cache',
    ]);
  });

  it('returns an empty list when cache listing fails', async () => {
    const client = getAI();
    client.caches.list = async () => {
      throw new Error('boom');
    };

    assert.deepStrictEqual(await completeCacheNames('cache'), []);
  });
});
