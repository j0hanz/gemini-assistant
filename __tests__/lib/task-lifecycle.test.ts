import type { RequestTaskStore } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSharedTaskInfra } from '../../src/lib/task-infra.js';
import { bridgeTaskCancellationToSignal } from '../../src/lib/task-utils.js';

describe('task lifecycle helpers', () => {
  it('clears the cancellation poller when the task is pruned from the store', async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;

    let intervalCallback: (() => void) | undefined;
    let cleared = 0;

    const fakeTimer = {
      unref() {
        return undefined;
      },
    } as unknown as ReturnType<typeof setInterval>;

    globalThis.setInterval = ((callback: TimerHandler) => {
      intervalCallback = callback as () => void;
      return fakeTimer;
    }) as typeof setInterval;
    globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
      if (timer === fakeTimer) {
        cleared += 1;
      }
    }) as typeof clearInterval;

    try {
      const signal = bridgeTaskCancellationToSignal(
        new AbortController().signal,
        'task-missing',
        {
          getTask: async () => {
            throw new Error('task not found');
          },
        } as RequestTaskStore,
        100,
      );

      assert.ok(intervalCallback, 'expected poller interval to be registered');
      intervalCallback();
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.strictEqual(cleared, 1);
      assert.strictEqual(signal.aborted, false);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  it('cleans up the shared task message queue on shutdown', () => {
    const infra = createSharedTaskInfra();
    let queueCleaned = 0;

    Object.assign(infra.taskMessageQueue as object, {
      cleanup: () => {
        queueCleaned += 1;
      },
    });

    infra.close();

    assert.strictEqual(queueCleaned, 1);
  });
});
