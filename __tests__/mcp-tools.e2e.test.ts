import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { FinishReason, Outcome } from '@google/genai';
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

  getNotifications(): JsonRpcNotification[] {
    return [...this.notifications];
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
    taskSupport: string;
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
  agentic_search: {
    annotations: READONLY_ANNOTATIONS,
    requiredInput: ['topic'],
    requiredOutput: ['report', 'sources'],
    taskSupport: 'optional',
    title: 'Agentic Search',
  },
  analyze_file: {
    annotations: READONLY_ANNOTATIONS,
    requiredInput: ['filePath', 'question'],
    requiredOutput: ['analysis'],
    taskSupport: 'optional',
    title: 'Analyze File',
  },
  analyze_pr: {
    annotations: READONLY_ANNOTATIONS,
    requiredOutput: [
      'analysis',
      'stats',
      'reviewedPaths',
      'includedUntracked',
      'skippedBinaryPaths',
      'skippedLargePaths',
      'empty',
    ],
    taskSupport: 'optional',
    title: 'Analyze PR',
  },
  analyze_url: {
    annotations: READONLY_ANNOTATIONS,
    requiredInput: ['urls', 'question'],
    requiredOutput: ['answer'],
    taskSupport: 'optional',
    title: 'Analyze URL',
  },
  ask: {
    annotations: MUTABLE_ANNOTATIONS,
    requiredInput: ['message'],
    requiredOutput: ['answer'],
    taskSupport: 'optional',
    title: 'Ask Gemini',
  },
  compare_files: {
    annotations: READONLY_ANNOTATIONS,
    requiredInput: ['filePathA', 'filePathB'],
    requiredOutput: ['comparison'],
    taskSupport: 'optional',
    title: 'Compare Files',
  },
  create_cache: {
    annotations: MUTABLE_ANNOTATIONS,
    requiredOutput: ['name'],
    taskSupport: 'optional',
    title: 'Create Cache',
  },
  delete_cache: {
    annotations: { ...MUTABLE_ANNOTATIONS, destructiveHint: true },
    requiredInput: ['cacheName'],
    requiredOutput: ['cacheName', 'deleted'],
    taskSupport: 'optional',
    title: 'Delete Cache',
  },
  execute_code: {
    annotations: { ...MUTABLE_ANNOTATIONS, openWorldHint: false },
    requiredInput: ['task'],
    requiredOutput: ['code', 'output', 'explanation', 'runtime'],
    taskSupport: 'optional',
    title: 'Execute Code',
  },
  explain_error: {
    annotations: READONLY_ANNOTATIONS,
    requiredInput: ['error'],
    requiredOutput: ['explanation'],
    taskSupport: 'optional',
    title: 'Explain Error',
  },
  generate_diagram: {
    annotations: READONLY_ANNOTATIONS,
    requiredInput: ['description'],
    requiredOutput: ['diagram', 'diagramType'],
    taskSupport: 'optional',
    title: 'Generate Diagram',
  },
  list_caches: {
    annotations: READONLY_ANNOTATIONS,
    requiredOutput: ['caches', 'count'],
    taskSupport: 'forbidden',
    title: 'List Caches',
  },
  search: {
    annotations: READONLY_ANNOTATIONS,
    requiredInput: ['query'],
    requiredOutput: ['answer', 'sources'],
    taskSupport: 'optional',
    title: 'Web Search',
  },
  update_cache: {
    annotations: MUTABLE_ANNOTATIONS,
    requiredInput: ['cacheName', 'ttl'],
    requiredOutput: ['cacheName'],
    taskSupport: 'optional',
    title: 'Update Cache',
  },
} as const satisfies Record<
  string,
  {
    annotations: Required<ToolAnnotations>;
    requiredInput?: string[];
    requiredOutput: string[];
    taskSupport: string;
    title: string;
  }
>;

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

      const askResult = await callTool(harness.client, 'ask', {
        message: 'Return JSON',
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
      expectSuccess(askResult);
      assert.deepStrictEqual(askResult.structuredContent.data, { count: 2, status: 'ok' });
      assert.strictEqual(
        askResult.structuredContent.answer,
        '{\n  "status": "ok",\n  "count": 2\n}',
      );

      env.queueStream(
        makeChunk([{ text: 'Search answer' }], FinishReason.STOP, {
          groundingMetadata: {
            groundingChunks: [{ web: { title: 'Example', uri: 'https://example.com' } }],
          },
        }),
      );

      const searchResult = await callTool(harness.client, 'search', {
        query: 'What is in the example source?',
      });
      expectSuccess(searchResult);
      assert.strictEqual(searchResult.structuredContent.answer, 'Search answer');
      assert.deepStrictEqual(searchResult.structuredContent.sources, ['https://example.com']);
      assert.deepStrictEqual(searchResult.structuredContent.sourceDetails, [
        { title: 'Example', url: 'https://example.com' },
      ]);

      env.queueStream(
        makeChunk([{ text: 'Research notes. ' }], undefined, {
          groundingMetadata: {
            groundingChunks: [
              { web: { title: 'Research Doc', uri: 'https://example.com/research' } },
            ],
          },
        }),
        makeChunk([{ executableCode: { code: 'print(2 + 2)' } }]),
        makeChunk([{ codeExecutionResult: { output: '4', outcome: Outcome.OUTCOME_OK } }]),
        makeChunk([{ text: '# Report\n\nFinal research summary' }], FinishReason.STOP),
      );

      const researchResult = await callTool(harness.client, 'agentic_search', {
        searchDepth: 2,
        topic: 'Summarize the topic',
      });
      expectSuccess(researchResult);
      assert.match(String(researchResult.structuredContent.report), /Final research summary/);
      assert.deepStrictEqual(researchResult.structuredContent.sources, [
        'https://example.com/research',
      ]);
      assert.deepStrictEqual(researchResult.structuredContent.sourceDetails, [
        { title: 'Research Doc', url: 'https://example.com/research' },
      ]);
      assert.deepStrictEqual(researchResult.structuredContent.toolsUsed, [
        'googleSearch',
        'codeExecution',
      ]);

      env.queueStream(
        makeChunk([{ text: 'URL-grounded answer' }], FinishReason.STOP, {
          urlContextMetadata: {
            urlMetadata: [
              {
                retrievedUrl: 'https://example.com',
                urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS',
              },
            ],
          },
        }),
      );

      const analyzeUrlResult = await callTool(harness.client, 'analyze_url', {
        question: 'Summarize the page',
        urls: ['https://example.com'],
      });
      expectSuccess(analyzeUrlResult);
      assert.strictEqual(analyzeUrlResult.structuredContent.answer, 'URL-grounded answer');
      assert.deepStrictEqual(analyzeUrlResult.structuredContent.urlMetadata, [
        {
          status: 'URL_RETRIEVAL_STATUS_SUCCESS',
          url: 'https://example.com',
        },
      ]);

      env.queueStream(
        makeChunk(
          [{ text: 'The file exports a Gemini client factory and cache helpers.' }],
          FinishReason.STOP,
        ),
      );

      const analyzeFileResult = await callTool(harness.client, 'analyze_file', {
        filePath: 'src/client.ts',
        question: 'What does this file expose?',
      });
      expectSuccess(analyzeFileResult);
      assert.match(String(analyzeFileResult.structuredContent.analysis), /Gemini client factory/);

      env.queueStream(
        makeChunk(
          [
            {
              text: '## Summary\npackage.json defines scripts and dependencies, while README.md documents usage.',
            },
          ],
          FinishReason.STOP,
        ),
      );

      const compareResult = await callTool(harness.client, 'compare_files', {
        filePathA: 'package.json',
        filePathB: 'README.md',
        question: 'How do these files differ in purpose?',
      });
      expectSuccess(compareResult);
      assert.match(
        String(compareResult.structuredContent.comparison),
        /package\.json defines scripts/,
      );

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

      const explainErrorResult = await callTool(harness.client, 'explain_error', {
        codeContext: 'const value = input.trim();',
        error: 'TypeError: Cannot read properties of undefined (reading trim)',
        language: 'typescript',
      });
      expectSuccess(explainErrorResult);
      assert.match(String(explainErrorResult.structuredContent.explanation), /Validate the input/);

      env.queueStream(
        makeChunk([{ executableCode: { code: 'print([0, 1, 1, 2, 3, 5, 8, 13, 21, 34])' } }]),
        makeChunk([
          {
            codeExecutionResult: {
              outcome: Outcome.OUTCOME_OK,
              output: '[0, 1, 1, 2, 3, 5, 8, 13, 21, 34]',
            },
          },
        ]),
        makeChunk([{ text: 'Computed the first 10 Fibonacci numbers.' }], FinishReason.STOP),
      );

      const executeCodeResult = await callTool(harness.client, 'execute_code', {
        language: 'typescript',
        task: 'Print the first 10 Fibonacci numbers.',
      });
      expectSuccess(executeCodeResult);
      assert.strictEqual(executeCodeResult.structuredContent.runtime, 'python');
      assert.strictEqual(executeCodeResult.structuredContent.requestedLanguage, 'typescript');
      assert.strictEqual(
        executeCodeResult.structuredContent.output,
        '[0, 1, 1, 2, 3, 5, 8, 13, 21, 34]',
      );
      assert.match(String(executeCodeResult.structuredContent.code), /print/);

      env.queueStream(
        makeChunk(
          [
            {
              text: '```mermaid\nflowchart TD\n  A[Client] --> B[Server]\n```\n\nGenerated from the server entrypoint.',
            },
          ],
          FinishReason.STOP,
        ),
      );

      const diagramResult = await callTool(harness.client, 'generate_diagram', {
        description: 'Show a minimal server flow.',
        diagramType: 'mermaid',
        sourceFilePath: 'src/server.ts',
        validateSyntax: true,
      });
      expectSuccess(diagramResult);
      assert.strictEqual(diagramResult.structuredContent.diagramType, 'mermaid');
      assert.match(String(diagramResult.structuredContent.diagram), /flowchart TD/);
      assert.match(String(diagramResult.structuredContent.explanation), /server entrypoint/);

      const createResult = await callTool(harness.client, 'create_cache', {
        filePaths: ['package.json'],
        systemInstruction: 'Cache this package metadata for later questions.',
      });
      expectSuccess(createResult);
      const createdName = String(createResult.structuredContent.name);
      assert.match(createdName, /^cachedContents\/mock-1$/);
      assert.ok(env.deletedUploads.length >= 1);

      const listResult = await callTool(harness.client, 'list_caches', {});
      expectSuccess(listResult);
      assert.strictEqual(listResult.structuredContent.count, 1);
      assert.ok(Array.isArray(listResult.structuredContent.caches));

      const updateResult = await callTool(harness.client, 'update_cache', {
        cacheName: createdName,
        ttl: '7200s',
      });
      expectSuccess(updateResult);
      assert.strictEqual(updateResult.structuredContent.cacheName, createdName);
      assert.strictEqual(updateResult.structuredContent.expireTime, '2099-01-01T02:00:00.000Z');

      const deleteResult = await callTool(harness.client, 'delete_cache', {
        cacheName: createdName,
        confirm: true,
      });
      expectSuccess(deleteResult);
      assert.deepStrictEqual(deleteResult.structuredContent, {
        cacheName: createdName,
        deleted: true,
      });

      const emptyListResult = await callTool(harness.client, 'list_caches', {});
      expectSuccess(emptyListResult);
      assert.strictEqual(emptyListResult.structuredContent.count, 0);
      assert.deepStrictEqual(emptyListResult.structuredContent.caches, []);

      const serverRequestMethods = harness.client.getServerRequestMethods();
      assert.ok(serverRequestMethods.includes('sampling/createMessage'));
      assert.ok(serverRequestMethods.includes('roots/list'));
      assert.deepStrictEqual(harness.client.getUnexpectedServerRequests(), []);
    } finally {
      await harness.close();
    }
  });

  it('surfaces validation and security failures through the protocol layer', async () => {
    const harness = await createHarness();

    try {
      const missingSearchQuery = await harness.client.requestRaw('tools/call', {
        arguments: {},
        name: 'search',
      });
      assertValidationFailure(missingSearchQuery, /query/i);

      const invalidDiagramSources = await harness.client.requestRaw('tools/call', {
        arguments: {
          description: 'Diagram this file',
          sourceFilePath: 'src/server.ts',
          sourceFilePaths: ['src/client.ts'],
        },
        name: 'generate_diagram',
      });
      assertValidationFailure(invalidDiagramSources, /sourceFilePath or sourceFilePaths/i);

      const analyzeUrlResult = await callTool(harness.client, 'analyze_url', {
        question: 'Summarize the page',
        urls: ['http://localhost/private'],
      });
      assert.equal(analyzeUrlResult.isError, true);
      assert.match(
        analyzeUrlResult.content[0]?.text ?? '',
        /valid public http:\/\/ or https:\/\//i,
      );

      assert.deepStrictEqual(harness.client.getUnexpectedServerRequests(), []);
    } finally {
      await harness.close();
    }
  });
});
