import { InMemoryTaskStore } from '@modelcontextprotocol/server';
import type { Request as McpRequest } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bridgeTaskCancellationToSignal,
  createSharedTaskInfra,
  ObservableTaskStore,
} from '../../src/lib/tasks.js';

describe('task lifecycle helpers', () => {
  it('aborts the signal synchronously when the task is cancelled', async () => {
    const store = new ObservableTaskStore(new InMemoryTaskStore());
    const task = await store.createTask({ ttl: 5000 }, 'req-1', {} as McpRequest);

    const signal = bridgeTaskCancellationToSignal(new AbortController().signal, task.taskId, store);

    // Wait for the initial getTask check to settle before counting listeners.
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(
      store.emitter.listenerCount('task'),
      1,
      'expected 1 listener after subscribe',
    );

    await store.updateTaskStatus(task.taskId, 'cancelled');

    // The event fires synchronously inside updateTaskStatus; give microtasks a turn.
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(signal.aborted, true, 'signal should be aborted after cancellation');
    assert.strictEqual(
      store.emitter.listenerCount('task'),
      0,
      'listener should be removed after terminal status',
    );
  });

  it('removes the listener without aborting the signal when the task completes', async () => {
    const store = new ObservableTaskStore(new InMemoryTaskStore());
    const task = await store.createTask({ ttl: 5000 }, 'req-2', {} as McpRequest);

    const signal = bridgeTaskCancellationToSignal(new AbortController().signal, task.taskId, store);

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(
      store.emitter.listenerCount('task'),
      1,
      'expected 1 listener after subscribe',
    );

    await store.updateTaskStatus(task.taskId, 'completed');

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(signal.aborted, false, 'signal should NOT be aborted for completed status');
    assert.strictEqual(
      store.emitter.listenerCount('task'),
      0,
      'listener should be removed after completed status',
    );
  });

  it('removes the listener when a task result is stored', async () => {
    const store = new ObservableTaskStore(new InMemoryTaskStore());
    const task = await store.createTask({ ttl: 5000 }, 'req-3', {} as McpRequest);

    const signal = bridgeTaskCancellationToSignal(new AbortController().signal, task.taskId, store);

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(
      store.emitter.listenerCount('task'),
      1,
      'expected 1 listener after subscribe',
    );

    await store.storeTaskResult(task.taskId, 'completed', {
      content: [{ type: 'text', text: 'done' }],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(signal.aborted, false, 'signal should NOT be aborted after storeTaskResult');
    assert.strictEqual(
      store.emitter.listenerCount('task'),
      0,
      'listener should be removed after result event',
    );
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
