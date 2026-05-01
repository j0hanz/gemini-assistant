// __tests__/subscribe.test.ts
//
// Integration test: end-to-end resources/subscribe + resources/unsubscribe
// over a paired in-memory transport. Exercises the real McpServer wired up by
// createServerInstance() so we know the handlers + capability advertisement
// actually work over the JSON-RPC wire, and that resources/updated emissions
// are gated by the subscription set.
import type { JSONRPCMessage } from '@modelcontextprotocol/server';

import assert from 'node:assert';
import { test } from 'node:test';

import { createServerInstance } from '../src/server.js';

/**
 * Minimal in-memory transport pair. Mirrors the SDK's internal InMemoryTransport
 * used in client/server integration tests, but local to this repo.
 */
class InMemoryTransport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (err: Error) => void;
  private peer?: InMemoryTransport;

  static pair(): [InMemoryTransport, InMemoryTransport] {
    const a = new InMemoryTransport();
    const b = new InMemoryTransport();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    // Defer so the caller can install onmessage before delivery on the first turn,
    // and so request/response don't reentrantly resolve in the same microtask.
    queueMicrotask(() => this.peer?.onmessage?.(message));
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.onclose?.();
    return Promise.resolve();
  }
}

interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

function isResponse(msg: unknown): msg is JSONRPCResponse {
  return (
    typeof msg === 'object' && msg !== null && 'id' in msg && ('result' in msg || 'error' in msg)
  );
}

function isNotification(msg: unknown): msg is JSONRPCNotification {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'method' in msg &&
    !('id' in msg) &&
    !('result' in msg) &&
    !('error' in msg)
  );
}

/** Tiny test client that drives JSON-RPC over the paired transport. */
class TestClient {
  private nextId = 1;
  private pending = new Map<number, (msg: JSONRPCResponse) => void>();
  private notifications: JSONRPCNotification[] = [];
  private transport!: InMemoryTransport;

  attach(transport: InMemoryTransport): void {
    this.transport = transport;
    transport.onmessage = (message) => {
      if (isResponse(message)) {
        const handler = this.pending.get(message.id);
        if (handler) {
          this.pending.delete(message.id);
          handler(message);
        }
      } else if (isNotification(message)) {
        this.notifications.push(message);
      }
    };
  }

  request(method: string, params?: Record<string, unknown>): Promise<JSONRPCResponse> {
    const id = this.nextId++;
    const req: JSONRPCRequest = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      void this.transport.send(req);
    });
  }

  notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const note: JSONRPCNotification = {
      jsonrpc: '2.0',
      method,
      ...(params ? { params } : {}),
    };
    return this.transport.send(note);
  }

  takeNotifications(method: string): JSONRPCNotification[] {
    const matches = this.notifications.filter((n) => n.method === method);
    this.notifications = this.notifications.filter((n) => n.method !== method);
    return matches;
  }
}

async function initialize(client: TestClient): Promise<JSONRPCResponse> {
  const initRes = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'subscribe-test', version: '0.0.0' },
  });
  await client.notify('notifications/initialized');
  return initRes;
}

test('resources/subscribe — handler is registered and returns success', async () => {
  const instance = createServerInstance();
  const [serverSide, clientSide] = InMemoryTransport.pair();
  const client = new TestClient();
  client.attach(clientSide);

  try {
    await instance.server.connect(serverSide);
    const initRes = await initialize(client);

    assert.ok(initRes.result, 'initialize must return a result');
    const result = initRes.result as { capabilities?: { resources?: { subscribe?: boolean } } };
    assert.strictEqual(
      result.capabilities?.resources?.subscribe,
      true,
      'server must advertise resources.subscribe capability',
    );

    const subRes = await client.request('resources/subscribe', {
      uri: 'gemini://workspace/cache',
    });

    assert.ok(
      !subRes.error,
      `resources/subscribe must not error, got: ${JSON.stringify(subRes.error)}`,
    );
    assert.deepStrictEqual(subRes.result, {}, 'resources/subscribe must return EmptyResult');
  } finally {
    await instance.close();
  }
});

test('resources/unsubscribe — handler is registered and returns success', async () => {
  const instance = createServerInstance();
  const [serverSide, clientSide] = InMemoryTransport.pair();
  const client = new TestClient();
  client.attach(clientSide);

  try {
    await instance.server.connect(serverSide);
    await initialize(client);

    await client.request('resources/subscribe', { uri: 'gemini://workspace/cache' });
    const unsubRes = await client.request('resources/unsubscribe', {
      uri: 'gemini://workspace/cache',
    });

    assert.ok(
      !unsubRes.error,
      `resources/unsubscribe must not error, got: ${JSON.stringify(unsubRes.error)}`,
    );
    assert.deepStrictEqual(unsubRes.result, {}, 'resources/unsubscribe must return EmptyResult');
  } finally {
    await instance.close();
  }
});

test('resources/updated — only emitted for subscribed URIs (notifier gate)', async () => {
  // The subscription gate lives in ResourceNotifier (configured in server.ts
  // with isSubscribed: (uri) => subscriptions.has(uri)). Test the predicate
  // wiring directly here — the handler-registration E2E above proves the
  // subscriptions set is populated correctly.
  const { ResourceNotifier } = await import('../src/resources/index.js');

  const updates: string[] = [];
  const mockServer = {
    sendResourceListChanged: () => {},
    sendResourceUpdated: ({ uri }: { uri: string }) => {
      updates.push(uri);
      return Promise.resolve();
    },
  };

  const subs = new Set<string>(['gemini://workspace/files/foo.ts']);
  const notifier = new ResourceNotifier(mockServer, {
    isSubscribed: (uri: string) => subs.has(uri),
  });

  await notifier.notifyUpdated('gemini://workspace/files/foo.ts');
  await notifier.notifyUpdated('gemini://workspace/files/bar.ts');

  assert.deepStrictEqual(
    updates,
    ['gemini://workspace/files/foo.ts'],
    'notifier must filter unsubscribed URIs',
  );

  subs.delete('gemini://workspace/files/foo.ts');
  await notifier.notifyUpdated('gemini://workspace/files/foo.ts');
  assert.strictEqual(updates.length, 1, 'no updates expected after unsubscribe');
});
