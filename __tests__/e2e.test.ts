import { LATEST_PROTOCOL_VERSION, type McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { InMemoryTransport } from './lib/in-memory-transport.js';

import { PUBLIC_PROMPT_NAMES } from '../src/prompts.js';
import { createServerInstance } from '../src/server.js';

process.env.API_KEY ??= 'test-key-for-e2e';

interface JsonRpcRequest {
  id: number;
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccess {
  id: number;
  jsonrpc: '2.0';
  result: Record<string, unknown>;
}

interface JsonRpcFailure {
  error: { code: number; message: string };
  id: number | null;
  jsonrpc: '2.0';
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

function isJsonRpcResponse(message: unknown): message is JsonRpcResponse {
  return typeof message === 'object' && message !== null && 'jsonrpc' in message && 'id' in message;
}

function isJsonRpcFailure(message: JsonRpcResponse): message is JsonRpcFailure {
  return 'error' in message;
}

class JsonRpcTestClient {
  private readonly notifications: JsonRpcNotification[] = [];
  private nextId = 0;
  private readonly pending = new Map<number, (message: JsonRpcResponse) => void>();

  constructor(private readonly transport: InMemoryTransport) {
    this.transport.onmessage = (message) => {
      if (isJsonRpcResponse(message)) {
        this.pending.get(message.id ?? -1)?.(message);
        if (typeof message.id === 'number') {
          this.pending.delete(message.id);
        }
        return;
      }

      this.notifications.push(message as JsonRpcNotification);
    };
  }

  async start(): Promise<void> {
    await this.transport.start();
  }

  async close(): Promise<void> {
    this.pending.clear();
    await this.transport.close();
  }

  async initialize(capabilities: Record<string, unknown> = { roots: {} }): Promise<JsonRpcSuccess> {
    const response = await this.request('initialize', {
      capabilities,
      clientInfo: { name: 'in-memory-e2e', version: '0.0.1' },
      protocolVersion: LATEST_PROTOCOL_VERSION,
    });
    await this.notify('notifications/initialized');
    return response;
  }

  async request(method: string, params?: Record<string, unknown>): Promise<JsonRpcSuccess> {
    const id = ++this.nextId;
    const request: JsonRpcRequest = {
      id,
      jsonrpc: '2.0',
      method,
      ...(params ? { params } : {}),
    };

    const response = await new Promise<JsonRpcResponse>((resolve) => {
      this.pending.set(id, resolve);
      void this.transport.send(request);
    });

    if (isJsonRpcFailure(response)) {
      throw new Error(`JSON-RPC ${response.error.code}: ${response.error.message}`);
    }

    return response;
  }

  async requestRaw(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = ++this.nextId;
    const request: JsonRpcRequest = {
      id,
      jsonrpc: '2.0',
      method,
      ...(params ? { params } : {}),
    };

    return await new Promise<JsonRpcResponse>((resolve) => {
      this.pending.set(id, resolve);
      void this.transport.send(request);
    });
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    await this.transport.send({
      jsonrpc: '2.0',
      method,
      ...(params ? { params } : {}),
    });
  }

  getNotifications(): JsonRpcNotification[] {
    return [...this.notifications];
  }
}

interface ServerHarness {
  client: JsonRpcTestClient;
  close: () => Promise<void>;
}

async function createHarness(): Promise<ServerHarness> {
  const instance = createServerInstance();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new JsonRpcTestClient(clientTransport);

  await client.start();
  await instance.server.connect(serverTransport as Parameters<McpServer['connect']>[0]);

  return {
    client,
    close: async () => {
      await client.close();
      await instance.close();
    },
  };
}

const cleanupCallbacks: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanupCallbacks.length > 0) {
    await cleanupCallbacks.pop()?.();
  }
});

describe('in-memory MCP server e2e', () => {
  it('completes initialization and exposes the discovery surface', async () => {
    const harness = await createHarness();
    cleanupCallbacks.push(harness.close);

    const initialize = await harness.client.initialize();
    const tools = await harness.client.request('tools/list');
    const resources = await harness.client.request('resources/list');
    const prompts = await harness.client.request('prompts/list');
    const discoveryCatalog = await harness.client.request('resources/read', {
      uri: 'tools://list',
    });
    const gettingStarted = await harness.client.request('prompts/get', {
      arguments: {},
      name: 'getting-started',
    });

    assert.equal(initialize.result.protocolVersion, LATEST_PROTOCOL_VERSION);
    assert.equal((initialize.result.serverInfo as { name: string }).name, 'gemini-assistant');
    assert.equal(typeof initialize.result.instructions, 'string');

    const toolNames = ((tools.result.tools as { name: string }[]) ?? []).map((tool) => tool.name);
    assert.ok(toolNames.includes('ask'));
    assert.ok(toolNames.includes('search'));
    assert.ok(toolNames.includes('create_cache'));

    const resourceUris = ((resources.result.resources as { uri: string }[]) ?? []).map(
      (resource) => resource.uri,
    );
    assert.ok(resourceUris.includes('tools://list'));
    assert.ok(resourceUris.includes('workspace://context'));

    const promptNames = ((prompts.result.prompts as { name: string }[]) ?? []).map(
      (prompt) => prompt.name,
    );
    assert.deepStrictEqual(promptNames, [...PUBLIC_PROMPT_NAMES]);

    const discoveryText =
      ((discoveryCatalog.result.contents as { text?: string }[]) ?? []).find(
        (entry) => typeof entry.text === 'string',
      )?.text ?? '';
    assert.match(discoveryText, /ask/);
    assert.match(discoveryText, /generate_diagram/);

    const promptText =
      ((gettingStarted.result.messages as { content?: { text?: string } }[]) ?? []).find(
        (entry) => typeof entry.content?.text === 'string',
      )?.content?.text ?? '';
    assert.match(promptText, /first-time user/i);
    assert.match(promptText, /Workflow: `getting-started`/);

    assert.equal(
      ((discoveryCatalog.result.contents as { uri?: string }[]) ?? [])[0]?.uri,
      'tools://list',
    );
    assert.equal(harness.client.getNotifications().length, 0);
  });

  it('surfaces tool input validation through the protocol layer', async () => {
    const harness = await createHarness();
    cleanupCallbacks.push(harness.close);

    await harness.client.initialize();
    const response = await harness.client.requestRaw('tools/call', {
      arguments: {},
      name: 'search',
    });

    if (isJsonRpcFailure(response)) {
      assert.equal(response.error.code, -32602);
      assert.match(response.error.message, /query/i);
      return;
    }

    assert.equal(response.result.isError, true);
    const content = (response.result.content as { text?: string }[]) ?? [];
    assert.match(content[0]?.text ?? '', /query/i);
  });

  it('reads workspace://context as markdown through MCP', async () => {
    const harness = await createHarness();
    cleanupCallbacks.push(harness.close);

    await harness.client.initialize({});
    const response = await harness.client.request('resources/read', {
      uri: 'workspace://context',
    });

    const text =
      ((response.result.contents as { text?: string }[]) ?? []).find(
        (entry) => typeof entry.text === 'string',
      )?.text ?? '';

    assert.match(text, /^# Workspace Context/m);
    assert.match(text, /Estimated tokens:/);
    assert.match(text, /## Sources/);
    assert.match(text, /## Content/);
  });
});
