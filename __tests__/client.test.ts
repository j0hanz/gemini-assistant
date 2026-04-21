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

  it('matches cache names, short names, and display names with useful ranking', async () => {
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
    assert.deepStrictEqual(await completeCacheNames('system'), ['cachedContents/alpha']);
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
