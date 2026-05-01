import assert from 'node:assert';
import { test } from 'node:test';

import type { GroundingMetadata, Part } from '@google/genai';

import { createSessionStore, sanitizeSessionText } from '../src/sessions.js';

test('sanitizeSessionText — redacts API key patterns', () => {
  const text = 'API_KEY=abc123xyz apikey=secret OTHER=keep';
  const result = sanitizeSessionText(text);
  assert(result.includes('[REDACTED]'));
  assert(!result.includes('abc123xyz'));
  assert(!result.includes('secret'));
  assert(result.includes('keep'));
});

test('sanitizeSessionText — redacts password patterns', () => {
  const text = 'password: supersecret token="xyz" api-key=hidden';
  const result = sanitizeSessionText(text);
  assert(result.includes('[REDACTED]'));
  assert(!result.includes('supersecret'));
  assert(!result.includes('hidden'));
});

test('sanitizeSessionText — preserves unrelated text', () => {
  const text = 'This is a normal message with no secrets';
  const result = sanitizeSessionText(text);
  assert.strictEqual(result, text);
});

test('SessionStore — initializeSession creates new session', () => {
  const store = createSessionStore();
  const sessionId = 'test-session-1';
  const interactionId = 'interaction-123';

  const result = store.initializeSession(sessionId, interactionId);
  assert.strictEqual(result, true, 'Should return true on first init');

  const entry = store.getSessionEntry(sessionId);
  assert(entry, 'Session should exist after init');
  assert.strictEqual(entry.id, sessionId);
});

test('SessionStore — initializeSession returns false for existing session', () => {
  const store = createSessionStore();
  const sessionId = 'test-session-2';
  const interactionId = 'interaction-456';

  store.initializeSession(sessionId, interactionId);
  const result = store.initializeSession(sessionId, 'different-interaction');
  assert.strictEqual(result, false, 'Should return false for existing session');
});

test('SessionStore — listTurnIndices returns empty array for new session', () => {
  const store = createSessionStore();
  const sessionId = 'test-session-3';

  store.initializeSession(sessionId, 'interaction-789');
  const indices = store.listTurnIndices(sessionId);

  assert.deepStrictEqual(indices, [], 'Should return empty array for new session');
});

test('SessionStore — listTurnIndices returns turn indices for session with turns', () => {
  const store = createSessionStore();
  const sessionId = 'test-session-4';

  store.initializeSession(sessionId, 'interaction-abc');

  // Add some turn data
  const part: Part = { text: 'hello' };
  store.appendTurnParts(sessionId, 0, [part], [part]);
  store.appendTurnParts(sessionId, 1, [part], [part]);
  store.appendTurnParts(sessionId, 2, [part], [part]);

  const indices = store.listTurnIndices(sessionId);
  assert.deepStrictEqual(indices, [0, 1, 2], 'Should return [0, 1, 2]');
});

test('SessionStore — getTurnRawParts returns raw parts for turn', () => {
  const store = createSessionStore();
  const sessionId = 'test-session-5';

  store.initializeSession(sessionId, 'interaction-def');

  const part: Part = { text: 'test content' };
  const rawPart: Part = { text: 'raw test content' };

  store.appendTurnParts(sessionId, 0, [part], [rawPart]);

  const retrieved = store.getTurnRawParts(sessionId, 0);
  assert(retrieved, 'Should return raw parts');
  assert.strictEqual(retrieved?.length, 1);
  assert.strictEqual(retrieved?.[0].text, 'raw test content');
});

test('SessionStore — getTurnRawParts returns undefined for non-existent turn', () => {
  const store = createSessionStore();
  const sessionId = 'test-session-6';

  store.initializeSession(sessionId, 'interaction-ghi');

  const retrieved = store.getTurnRawParts(sessionId, 99);
  assert.strictEqual(retrieved, undefined, 'Should return undefined for non-existent turn');
});

test('SessionStore — getTurnRawParts returns undefined for non-existent session', () => {
  const store = createSessionStore();

  const retrieved = store.getTurnRawParts('non-existent-session', 0);
  assert.strictEqual(retrieved, undefined, 'Should return undefined for non-existent session');
});

test('SessionStore — getTurnGrounding returns grounding metadata for turn', () => {
  const store = createSessionStore();
  const sessionId = 'test-session-7';

  store.initializeSession(sessionId, 'interaction-jkl');

  const part: Part = { text: 'test' };
  const mockGroundingMetadata: GroundingMetadata[] = [
    {
      web_search: {
        queries: ['test query'],
        results: [
          {
            uri: 'https://example.com',
            title: 'Example',
            snippet: 'An example site',
          },
        ],
      },
    } as GroundingMetadata,
  ];

  store.appendTurnParts(sessionId, 0, [part], [part], mockGroundingMetadata);

  const grounding = store.getTurnGrounding(sessionId, 0);
  assert(grounding, 'Should return grounding metadata');
  assert(grounding.raw, 'Should have raw grounding data');
  const rawEvent = (grounding.raw as unknown[])[0] as Record<string, unknown>;
  assert.strictEqual((rawEvent.web_search as Record<string, unknown>)?.queries?.[0], 'test query');
});

test('SessionStore — getTurnGrounding returns undefined for turn with no grounding', () => {
  const store = createSessionStore();
  const sessionId = 'test-session-8';

  store.initializeSession(sessionId, 'interaction-mno');

  const part: Part = { text: 'test' };
  store.appendTurnParts(sessionId, 0, [part], [part]); // No grounding metadata

  const grounding = store.getTurnGrounding(sessionId, 0);
  assert.strictEqual(grounding, undefined, 'Should return undefined when no grounding metadata');
});

test('SessionStore — appendTurnParts persists grounding with web search and url context', () => {
  const store = createSessionStore();
  const sessionId = 'test-session-9';

  store.initializeSession(sessionId, 'interaction-pqr');

  const part: Part = { text: 'test' };
  const mockGroundingMetadata: GroundingMetadata[] = [
    {
      web_search: {
        queries: ['what is AI?', 'machine learning'],
        results: [
          {
            uri: 'https://ai.example.com',
            title: 'AI Guide',
            snippet: 'Learning about AI',
            score: 0.95,
          },
          {
            uri: 'https://ml.example.com',
            title: 'ML Tutorial',
            snippet: 'Machine learning basics',
            score: 0.87,
          },
        ],
      },
      url_context: [
        {
          url: 'https://context.example.com',
          title: 'Context Page',
          snippet: 'Contextual information',
          retrieved_at: '2026-01-01T00:00:00Z',
          status: 'success',
        },
      ],
    } as GroundingMetadata,
  ];

  store.appendTurnParts(sessionId, 0, [part], [part], mockGroundingMetadata);

  const grounding = store.getTurnGrounding(sessionId, 0);
  assert(grounding, 'Should have grounding');
  const rawEvents = grounding.raw as unknown[];
  const event = rawEvents[0] as Record<string, unknown>;
  assert.strictEqual((event.web_search as Record<string, unknown>)?.queries?.length, 2);
  assert.strictEqual((event.web_search as Record<string, unknown>)?.results?.length, 2);
  assert.strictEqual((event.url_context as unknown[])?.length, 1);
});

test('SessionStore — appendTurnParts returns false for non-existent session', () => {
  const store = createSessionStore();
  const part: Part = { text: 'test' };

  const result = store.appendTurnParts('non-existent', 0, [part], [part]);
  assert.strictEqual(result, false, 'Should return false for non-existent session');
});

test('SessionStore — appendTurnParts returns true for valid session', () => {
  const store = createSessionStore();
  const sessionId = 'test-session-10';

  store.initializeSession(sessionId, 'interaction-stu');

  const part: Part = { text: 'test' };
  const result = store.appendTurnParts(sessionId, 0, [part], [part]);

  assert.strictEqual(result, true, 'Should return true for valid session');
});

test('SessionStore — appendTurnParts notifies subscribers', () => {
  const store = createSessionStore();
  const sessionId = 'test-session-11';

  store.initializeSession(sessionId, 'interaction-vwx');

  const notifications: {
    listChanged: boolean;
    turnPartsAdded?: { sessionId: string; turnIndex: number };
  }[] = [];
  const unsubscribe = store.subscribe((event) => {
    notifications.push(event);
  });

  const part: Part = { text: 'test' };
  store.appendTurnParts(sessionId, 0, [part], [part]);

  unsubscribe();

  assert(notifications.length > 0, 'Should have notifications');
  const lastNotification = notifications[notifications.length - 1];
  assert.deepStrictEqual(lastNotification.turnPartsAdded, { sessionId, turnIndex: 0 });
});

test('SessionStore — transformGroundingMetadata handles empty metadata', () => {
  const store = createSessionStore();
  const sessionId = 'test-session-12';

  store.initializeSession(sessionId, 'interaction-yza');

  const part: Part = { text: 'test' };
  store.appendTurnParts(sessionId, 0, [part], [part], undefined);

  const grounding = store.getTurnGrounding(sessionId, 0);
  assert.strictEqual(grounding, undefined);
});

test('SessionStore — multiple turns maintain separate data', () => {
  const store = createSessionStore();
  const sessionId = 'test-session-13';

  store.initializeSession(sessionId, 'interaction-bcd');

  const part1: Part = { text: 'turn 1' };
  const part2: Part = { text: 'turn 2' };

  store.appendTurnParts(sessionId, 0, [part1], [part1]);
  store.appendTurnParts(sessionId, 1, [part2], [part2]);

  const rawParts0 = store.getTurnRawParts(sessionId, 0);
  const rawParts1 = store.getTurnRawParts(sessionId, 1);

  assert.strictEqual(rawParts0?.[0].text, 'turn 1');
  assert.strictEqual(rawParts1?.[0].text, 'turn 2');
});
