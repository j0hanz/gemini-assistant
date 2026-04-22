import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { selectReplayWindow } from '../../src/lib/replay-window.js';
import type { ContentEntry } from '../../src/sessions.js';

function entry(role: ContentEntry['role'], parts: ContentEntry['parts'], timestamp: number) {
  return { role, parts, timestamp };
}

describe('selectReplayWindow', () => {
  it('truncates from the oldest end under the byte budget', () => {
    const contents = [
      entry('user', [{ text: 'oldest message that should fall out' }], 1),
      entry('model', [{ text: 'middle' }], 2),
      entry('user', [{ text: 'newest' }], 3),
    ];

    assert.deepStrictEqual(selectReplayWindow(contents, 20), [contents[2]]);
  });

  it('extends backwards when a functionResponse would otherwise lose its call', () => {
    const contents = [
      entry('model', [{ functionCall: { id: 'call-1', name: 'lookup', args: { q: 'x' } } }], 1),
      entry(
        'user',
        [{ functionResponse: { id: 'call-1', name: 'lookup', response: { ok: true } } }],
        2,
      ),
    ];

    assert.deepStrictEqual(selectReplayWindow(contents, 90), contents);
  });

  it('trims a trailing model turn with an unanswered functionCall', () => {
    const contents = [
      entry('user', [{ text: 'call lookup' }], 1),
      entry('model', [{ functionCall: { name: 'lookup', args: { q: 'x' } } }], 2),
    ];

    assert.deepStrictEqual(selectReplayWindow(contents, 200_000), [contents[0]]);
  });

  it('keeps built-in toolCall/toolResponse pairs together', () => {
    const contents = [
      entry('model', [{ toolCall: { id: 'tool-1', toolType: 'GOOGLE_SEARCH_WEB' } }], 1),
      entry(
        'user',
        [{ toolResponse: { id: 'tool-1', toolType: 'GOOGLE_SEARCH_WEB', response: { ok: true } } }],
        2,
      ),
    ];

    assert.deepStrictEqual(selectReplayWindow(contents, 90), contents);
  });
});
