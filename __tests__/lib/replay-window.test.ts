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

    assert.deepStrictEqual(selectReplayWindow(contents, 20), { kept: [contents[2]], dropped: 2 });
  });

  it('uses a strict sliding window without pair extension', () => {
    const contents = [
      entry('model', [{ functionCall: { id: 'call-1', name: 'lookup', args: { q: 'x' } } }], 1),
      entry(
        'user',
        [{ functionResponse: { id: 'call-1', name: 'lookup', response: { ok: true } } }],
        2,
      ),
    ];

    assert.deepStrictEqual(selectReplayWindow(contents, 90), { kept: [contents[1]], dropped: 1 });
  });

  it('keeps trailing model turns when they fit the strict window', () => {
    const contents = [
      entry('user', [{ text: 'call lookup' }], 1),
      entry('model', [{ functionCall: { name: 'lookup', args: { q: 'x' } } }], 2),
    ];

    assert.deepStrictEqual(selectReplayWindow(contents, 200_000), {
      kept: contents,
      dropped: 0,
    });
  });

  it('drops oversized built-in tool pairs instead of extending the window', () => {
    const contents = [
      entry('model', [{ toolCall: { id: 'tool-1', toolType: 'GOOGLE_SEARCH_WEB' } }], 1),
      entry(
        'user',
        [{ toolResponse: { id: 'tool-1', toolType: 'GOOGLE_SEARCH_WEB', response: { ok: true } } }],
        2,
      ),
    ];

    assert.deepStrictEqual(selectReplayWindow(contents, 90), { kept: [contents[1]], dropped: 1 });
  });

  it('drops older entries completely when the strict window is exceeded', () => {
    const contents = [
      entry('user', [{ text: 'old' }], 1),
      entry('model', [{ text: 'newer' }], 2),
      entry('user', [{ text: 'newest' }], 3),
    ];

    const newestOnlyBytes = JSON.stringify(contents[2]?.parts).length;

    assert.deepStrictEqual(selectReplayWindow(contents, newestOnlyBytes), {
      kept: [contents[2]],
      dropped: 2,
    });
  });
});
