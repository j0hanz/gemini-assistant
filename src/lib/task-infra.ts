import { InMemoryTaskMessageQueue, InMemoryTaskStore } from '@modelcontextprotocol/server';

export interface SharedTaskInfra {
  taskStore: InMemoryTaskStore;
  taskMessageQueue: InMemoryTaskMessageQueue;
  close: () => void;
}

/**
 * Shared task store/queue across per-request `ServerInstance`s for HTTP and
 * Web-Standard transports so task results created by one request can be
 * polled in a later request. Stdio servers create their own infra.
 */
export function createSharedTaskInfra(): SharedTaskInfra {
  const taskStore = new InMemoryTaskStore();
  const taskMessageQueue = new InMemoryTaskMessageQueue();
  return {
    taskStore,
    taskMessageQueue,
    close: () => {
      taskStore.cleanup();
    },
  };
}
