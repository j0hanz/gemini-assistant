import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { FinishReason } from '@google/genai';
import type { GenerateContentResponse, Part } from '@google/genai';

import { InMemoryTransport } from './lib/in-memory-transport.js';

import { getAI } from '../src/client.js';
import { createServerInstance } from '../src/server.js';

process.env.API_KEY ??= 'test-key-for-mcp-tools';

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcRequest extends JsonRpcNotification {
  id: number;
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

interface JsonSchemaLike {
  allOf?: JsonSchemaLike[];
  anyOf?: JsonSchemaLike[];
  oneOf?: JsonSchemaLike[];
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

interface ToolAnnotations {
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  readOnlyHint?: boolean;
}

interface ToolInfo {
  annotations?: ToolAnnotations;
  execution?: { taskSupport?: string };
  inputSchema?: JsonSchemaLike;
  name: string;
  outputSchema?: JsonSchemaLike;
  title?: string;
}

interface ToolCallResult {
  content: { name?: string; text?: string; type: string; uri?: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isJsonRpcResponse(message: unknown): message is JsonRpcResponse {
  return (
    isRecord(message) && message.jsonrpc === '2.0' && 'id' in message && !('method' in message)
  );
}

function isJsonRpcServerRequest(message: unknown): message is JsonRpcRequest {
  return isRecord(message) && message.jsonrpc === '2.0' && 'id' in message && 'method' in message;
}

function isJsonRpcFailure(message: JsonRpcResponse): message is JsonRpcFailure {
  return 'error' in message;
}

function schemaRequiresField(schema: JsonSchemaLike | undefined, field: string): boolean {
  if (!schema) {
    return false;
  }

  if (schema.required?.includes(field)) {
    return true;
  }

  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const nested = schema[key];
    if (Array.isArray(nested) && nested.some((entry) => schemaRequiresField(entry, field))) {
      return true;
    }
  }

  return false;
}

class JsonRpcTestClient {
  private nextId = 0;
  private readonly notifications: JsonRpcNotification[] = [];
  private readonly pending = new Map<number, (message: JsonRpcResponse) => void>();
  private readonly serverRequestMethods: string[] = [];
  private readonly unexpectedServerRequests: string[] = [];

  constructor(private readonly transport: InMemoryTransport) {
    this.transport.onmessage = (message) => {
      if (isJsonRpcServerRequest(message)) {
        void this.handleServerRequest(message);
        return;
      }

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

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    this.serverRequestMethods.push(request.method);

    switch (request.method) {
      case 'roots/list':
        await this.transport.send({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            roots: [{ uri: pathToFileURL(process.cwd()).href, name: 'workspace' }],
          },
        });
        return;

      case 'sampling/createMessage':
        await this.transport.send({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: {
              type: 'text',
              text: 'starter keywords\nfollow-up angles',
            },
            model: 'mock-sampler',
            role: 'assistant',
            stopReason: 'endTurn',
          },
        });
        return;

      default:
        this.unexpectedServerRequests.push(request.method);
        await this.transport.send({
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32601,
            message: `Unhandled server request: ${request.method}`,
          },
        });
    }
  }

  async start(): Promise<void> {
    await this.transport.start();
  }

  async close(): Promise<void> {
    this.pending.clear();
    await this.transport.close();
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      capabilities: {
        roots: {},
        sampling: {},
      },
      clientInfo: { name: 'mcp-tool-smoke', version: '0.0.1' },
      protocolVersion: LATEST_PROTOCOL_VERSION,
    });
    await this.notify('notifications/initialized');
  }

  async request(method: string, params?: Record<string, unknown>): Promise<JsonRpcSuccess> {
    const response = await this.requestRaw(method, params);

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

  getServerRequestMethods(): string[] {
    return [...this.serverRequestMethods];
  }

  getUnexpectedServerRequests(): string[] {
    return [...this.unexpectedServerRequests];
  }
}

interface ServerHarness {
  client: JsonRpcTestClient;
  close: () => Promise<void>;
}

async function flushEventLoop(turns = 2): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function createHarness(): Promise<ServerHarness> {
  const instance = createServerInstance();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new JsonRpcTestClient(clientTransport);

  await client.start();
  await instance.server.connect(serverTransport);
  await client.initialize();

  return {
    client,
    close: async () => {
      await flushEventLoop();
      await instance.close();
      await flushEventLoop();
      await client.close();
    },
  };
}

function makeChunk(
  parts: Part[],
  finishReason?: FinishReason,
  candidateExtras?: Record<string, unknown>,
): GenerateContentResponse {
  return {
    candidates: [
      {
        content: { parts },
        ...(finishReason ? { finishReason } : {}),
        ...(candidateExtras ?? {}),
      },
    ],
  } as GenerateContentResponse;
}

async function* fakeStream(
  chunks: readonly GenerateContentResponse[],
): AsyncGenerator<GenerateContentResponse> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function ttlToExpireTime(ttl?: string): string {
  if (!ttl) {
    return '2099-01-01T00:00:00.000Z';
  }

  const seconds = Number.parseInt(ttl.replace(/s$/, ''), 10);
  if (Number.isNaN(seconds)) {
    return '2099-01-01T00:00:00.000Z';
  }

  return new Date(Date.parse('2099-01-01T00:00:00.000Z') + seconds * 1000).toISOString();
}

class MockGeminiEnvironment {
  private readonly client = getAI();
  private readonly originalCreateCache = this.client.caches.create.bind(this.client.caches);
  private readonly originalDeleteCache = this.client.caches.delete.bind(this.client.caches);
  private readonly originalDeleteFile = this.client.files.delete.bind(this.client.files);
  private readonly originalGenerateContentStream = this.client.models.generateContentStream.bind(
    this.client.models,
  );
  private readonly originalGetCache = this.client.caches.get.bind(this.client.caches);
  private readonly originalListCaches = this.client.caches.list.bind(this.client.caches);
  private readonly originalUpdateCache = this.client.caches.update.bind(this.client.caches);
  private readonly originalUpload = this.client.files.upload.bind(this.client.files);
  private readonly cacheStore = new Map<
    string,
    { displayName?: string; expireTime: string; model: string; name: string }
  >();
  private readonly streamQueue: AsyncGenerator<GenerateContentResponse>[] = [];
  private uploadCounter = 0;
  readonly deletedUploads: string[] = [];

  install(): void {
    const cacheStore = this.cacheStore;
    const deletedUploads = this.deletedUploads;

    this.client.models.generateContentStream = (async () => {
      const next = this.streamQueue.shift();
      if (!next) {
        throw new Error('No mocked Gemini stream queued for generateContentStream');
      }

      return next;
    }) as unknown as typeof this.client.models.generateContentStream;

    this.client.files.upload = (async (opts: { file: string }) => {
      this.uploadCounter += 1;
      const fileName = opts.file.split(/[\\/]/).pop() ?? `upload-${String(this.uploadCounter)}`;
      return {
        mimeType: 'text/plain',
        name: `uploaded-${String(this.uploadCounter)}`,
        uri: `gs://mock/${fileName}`,
      };
    }) as typeof this.client.files.upload;

    this.client.files.delete = (async (opts: { name: string }) => {
      deletedUploads.push(opts.name);
      return {};
    }) as unknown as typeof this.client.files.delete;

    this.client.caches.create = (async (opts: {
      config?: { displayName?: string };
      model?: string;
    }) => {
      const name = `cachedContents/mock-${String(cacheStore.size + 1)}`;
      const cache = {
        expireTime: '2099-01-01T00:00:00.000Z',
        model: opts.model ?? 'models/mock-gemini',
        name,
        ...(opts.config?.displayName ? { displayName: opts.config.displayName } : {}),
      };
      cacheStore.set(name, cache);
      return cache;
    }) as typeof this.client.caches.create;

    this.client.caches.get = (async (opts: { name: string }) => {
      const cache = cacheStore.get(opts.name);
      if (!cache) {
        throw new Error(`Missing cache ${opts.name}`);
      }
      return cache;
    }) as typeof this.client.caches.get;

    this.client.caches.list = (async () => ({
      async *[Symbol.asyncIterator]() {
        for (const cache of cacheStore.values()) {
          yield cache;
        }
      },
    })) as unknown as typeof this.client.caches.list;

    this.client.caches.update = (async (opts: { config?: { ttl?: string }; name: string }) => {
      const existing = cacheStore.get(opts.name) ?? {
        expireTime: '2099-01-01T00:00:00.000Z',
        model: 'models/mock-gemini',
        name: opts.name,
      };
      const updated = {
        ...existing,
        expireTime: ttlToExpireTime(opts.config?.ttl),
      };
      cacheStore.set(opts.name, updated);
      return updated;
    }) as typeof this.client.caches.update;

    this.client.caches.delete = (async (opts: { name: string }) => {
      cacheStore.delete(opts.name);
      return {};
    }) as unknown as typeof this.client.caches.delete;
  }

  restore(): void {
    this.client.models.generateContentStream = this.originalGenerateContentStream;
    this.client.files.upload = this.originalUpload;
    this.client.files.delete = this.originalDeleteFile;
    this.client.caches.create = this.originalCreateCache;
    this.client.caches.get = this.originalGetCache;
    this.client.caches.list = this.originalListCaches;
    this.client.caches.delete = this.originalDeleteCache;
    this.client.caches.update = this.originalUpdateCache;
    this.streamQueue.length = 0;
    this.cacheStore.clear();
    this.deletedUploads.length = 0;
    this.uploadCounter = 0;
  }

  queueStream(...chunks: GenerateContentResponse[]): void {
    this.streamQueue.push(fakeStream(chunks));
  }
}

async function listTools(client: JsonRpcTestClient): Promise<ToolInfo[]> {
  const tools = await client.request('tools/list');
  return (tools.result.tools as ToolInfo[]) ?? [];
}

async function callTool(
  client: JsonRpcTestClient,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const response = await client.request('tools/call', { arguments: args, name });
  return response.result as unknown as ToolCallResult;
}

function expectSuccess(result: ToolCallResult): asserts result is ToolCallResult & {
  structuredContent: Record<string, unknown>;
} {
  assert.notStrictEqual(result.isError, true, result.content[0]?.text ?? 'Expected success');
  assert.ok(result.structuredContent, 'Expected structuredContent to be present');
}

function assertValidationFailure(response: JsonRpcResponse, messagePattern: RegExp): void {
  if (isJsonRpcFailure(response)) {
    assert.equal(response.error.code, -32602);
    assert.match(response.error.message, messagePattern);
    return;
  }

  assert.equal(response.result.isError, true);
  const content = (response.result.content as { text?: string }[]) ?? [];
  assert.match(content[0]?.text ?? '', messagePattern);
}

function assertToolContract(
  tool: ToolInfo | undefined,
  expected: {
    annotations: Required<ToolAnnotations>;
    requiredInput?: string[];
    requiredOutput: string[];
    taskSupport?: string;
    title: string;
  },
): void {
  assert.ok(tool, `Expected tool to be registered`);
  assert.equal(tool.title, expected.title);
  assert.equal(tool.execution?.taskSupport, expected.taskSupport);
  assert.deepStrictEqual(tool.annotations, expected.annotations);

  for (const field of expected.requiredInput ?? []) {
    assert.equal(
      schemaRequiresField(tool.inputSchema, field),
      true,
      `Expected input schema for ${tool.name} to require ${field}`,
    );
  }

  for (const field of expected.requiredOutput) {
    assert.equal(
      schemaRequiresField(tool.outputSchema, field),
      true,
      `Expected output schema for ${tool.name} to require ${field}`,
    );
  }
}

const READONLY_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: true,
} as const;

const MUTABLE_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
  readOnlyHint: false,
} as const;

const EXPECTED_TOOL_CONTRACTS = {
  analyze: {
    annotations: READONLY_ANNOTATIONS,
    requiredInput: ['goal', 'targets'],
    requiredOutput: ['status', 'targetKind', 'summary'],
    taskSupport: 'optional',
    title: 'Analyze',
  },
  chat: {
    annotations: MUTABLE_ANNOTATIONS,
    requiredInput: ['goal'],
    requiredOutput: ['status', 'answer'],
    taskSupport: 'optional',
    title: 'Chat',
  },
  discover: {
    annotations: READONLY_ANNOTATIONS,
    requiredOutput: [
      'status',
      'summary',
      'recommendedTools',
      'recommendedPrompts',
      'relatedResources',
    ],
    taskSupport: 'forbidden',
    title: 'Discover',
  },
  memory: {
    annotations: MUTABLE_ANNOTATIONS,
    requiredInput: ['action'],
    requiredOutput: ['status', 'action', 'summary'],
    taskSupport: 'optional',
    title: 'Memory',
  },
  research: {
    annotations: READONLY_ANNOTATIONS,
    requiredInput: ['mode', 'goal'],
    requiredOutput: ['status', 'mode', 'summary', 'sources'],
    taskSupport: 'optional',
    title: 'Research',
  },
  review: {
    annotations: READONLY_ANNOTATIONS,
    requiredInput: ['subject'],
    requiredOutput: ['status', 'subjectKind', 'summary'],
    taskSupport: 'optional',
    title: 'Review',
  },
} as const;

let env: MockGeminiEnvironment;

beforeEach(() => {
  env = new MockGeminiEnvironment();
  env.install();
});

afterEach(() => {
  env.restore();
});

describe('MCP tool smoke coverage', () => {
  it('advertises the full tool catalog with stable annotations and key schemas', async () => {
    const harness = await createHarness();

    try {
      const tools = await listTools(harness.client);
      const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

      assert.deepStrictEqual(
        [...toolMap.keys()].sort(),
        Object.keys(EXPECTED_TOOL_CONTRACTS).sort(),
      );

      for (const [toolName, contract] of Object.entries(EXPECTED_TOOL_CONTRACTS)) {
        assertToolContract(toolMap.get(toolName), contract);
      }

      assert.deepStrictEqual(harness.client.getUnexpectedServerRequests(), []);
    } finally {
      await harness.close();
    }
  });

  it('executes representative tool calls through the MCP protocol layer', async () => {
    const harness = await createHarness();

    try {
      env.queueStream(makeChunk([{ text: '{"status":"ok","count":2}' }], FinishReason.STOP));

      const chatResult = await callTool(harness.client, 'chat', {
        goal: 'Return JSON',
        responseSchema: {
          properties: {
            count: { type: 'integer' },
            status: { type: 'string' },
          },
          required: ['status', 'count'],
          type: 'object',
        },
        systemInstruction: 'Return only the requested JSON object.',
      });
      expectSuccess(chatResult);
      assert.deepStrictEqual(chatResult.structuredContent.data, { count: 2, status: 'ok' });
      assert.equal(chatResult.structuredContent.status, 'completed');

      env.queueStream(
        makeChunk([{ text: 'Search answer' }], FinishReason.STOP, {
          groundingMetadata: {
            groundingChunks: [{ web: { title: 'Example', uri: 'https://example.com' } }],
          },
        }),
      );

      const researchResult = await callTool(harness.client, 'research', {
        goal: 'What is in the example source?',
        mode: 'quick',
      });
      expectSuccess(researchResult);
      assert.strictEqual(researchResult.structuredContent.mode, 'quick');
      assert.strictEqual(researchResult.structuredContent.summary, 'Search answer');
      assert.deepStrictEqual(researchResult.structuredContent.sources, ['https://example.com']);

      env.queueStream(
        makeChunk(
          [{ text: 'The file exports a Gemini client factory and cache helpers.' }],
          FinishReason.STOP,
        ),
      );

      const analyzeResult = await callTool(harness.client, 'analyze', {
        goal: 'What does this file expose?',
        targets: {
          filePath: 'src/client.ts',
          kind: 'file',
        },
      });
      expectSuccess(analyzeResult);
      assert.strictEqual(analyzeResult.structuredContent.targetKind, 'file');
      assert.match(String(analyzeResult.structuredContent.summary), /Gemini client factory/);

      env.queueStream(
        makeChunk(
          [
            {
              text: '## Cause\nUndefined was passed where a string was expected.\n\n## Fix\nValidate the input before calling the parser.',
            },
          ],
          FinishReason.STOP,
        ),
      );

      const reviewResult = await callTool(harness.client, 'review', {
        subject: {
          error: 'TypeError: Cannot read properties of undefined (reading trim)',
          kind: 'failure',
          language: 'typescript',
        },
      });
      expectSuccess(reviewResult);
      assert.strictEqual(reviewResult.structuredContent.subjectKind, 'failure');
      assert.match(String(reviewResult.structuredContent.summary), /Validate the input/);

      const discoverResult = await callTool(harness.client, 'discover', {
        goal: 'I need to inspect reusable state',
        job: 'memory',
      });
      expectSuccess(discoverResult);
      assert.strictEqual(discoverResult.structuredContent.job, 'memory');
      assert.ok(Array.isArray(discoverResult.structuredContent.relatedResources));

      const sessionListResult = await callTool(harness.client, 'memory', {
        action: 'sessions.list',
      });
      expectSuccess(sessionListResult);
      assert.strictEqual(sessionListResult.structuredContent.action, 'sessions.list');
      assert.ok(Array.isArray(sessionListResult.structuredContent.sessions));

      const createCacheResult = await callTool(harness.client, 'memory', {
        action: 'caches.create',
        filePaths: ['package.json'],
        systemInstruction: 'Cache this package metadata for later questions.',
      });
      expectSuccess(createCacheResult);
      assert.strictEqual(createCacheResult.structuredContent.action, 'caches.create');

      const listCachesResult = await callTool(harness.client, 'memory', {
        action: 'caches.list',
      });
      expectSuccess(listCachesResult);
      assert.strictEqual(listCachesResult.structuredContent.action, 'caches.list');
      assert.ok(Array.isArray(listCachesResult.structuredContent.caches));

      const serverRequestMethods = harness.client.getServerRequestMethods();
      assert.ok(serverRequestMethods.includes('roots/list'));
      assert.deepStrictEqual(harness.client.getUnexpectedServerRequests(), []);
    } finally {
      await harness.close();
    }
  });

  it('surfaces validation and security failures through the protocol layer', async () => {
    const harness = await createHarness();

    try {
      const missingResearchMode = await harness.client.requestRaw('tools/call', {
        arguments: { goal: 'Tell me something current' },
        name: 'research',
      });
      assertValidationFailure(missingResearchMode, /mode/i);

      const invalidAnalyzeTargets = await harness.client.requestRaw('tools/call', {
        arguments: {
          goal: 'Inspect this',
          targets: {
            kind: 'url',
            urls: ['http://localhost/private'],
          },
        },
        name: 'analyze',
      });
      assertValidationFailure(invalidAnalyzeTargets, /public http:\/\/ or https:\/\//i);

      assert.deepStrictEqual(harness.client.getUnexpectedServerRequests(), []);
    } finally {
      await harness.close();
    }
  });
});
