import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { FinishReason } from '@google/genai';

import {
  assertAdvertisedOutputSchema,
  assertRequestValidationFailure,
  schemaRequiresField,
} from './lib/mcp-contract-assertions.js';
import {
  createServerHarness,
  type JsonRpcTestClient,
  type ToolAnnotations,
  type ToolCallResult,
  type ToolInfo,
} from './lib/mcp-contract-client.js';
import { makeChunk, MockGeminiEnvironment } from './lib/mock-gemini-environment.js';

import { createServerInstance } from '../src/server.js';

process.env.API_KEY ??= 'test-key-for-mcp-tools';

const DISCOVER_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
} as const;

async function createHarness() {
  return await createServerHarness(
    createServerInstance,
    {
      capabilities: {
        roots: {},
        sampling: {},
      },
      serverRequestHandlers: {
        'sampling/createMessage': async () => ({
          result: {
            content: {
              type: 'text',
              text: 'starter keywords\nfollow-up angles',
            },
            model: 'mock-sampler',
            role: 'assistant',
            stopReason: 'endTurn',
          },
        }),
      },
    },
    {
      autoInitialize: true,
      flushAfterServerClose: 2,
      flushBeforeClose: 2,
    },
  );
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

function assertToolContract(
  tool: ToolInfo | undefined,
  expected: {
    annotations: Required<ToolAnnotations>;
    requiredInput?: readonly string[];
    requiredOutput: readonly string[];
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
    annotations: DISCOVER_ANNOTATIONS,
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
        [...toolMap.keys()],
        ['chat', 'research', 'analyze', 'review', 'memory', 'discover'],
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
      const toolMap = new Map((await listTools(harness.client)).map((tool) => [tool.name, tool]));

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
      const chatTool = toolMap.get('chat');
      assert.ok(chatTool);
      assertAdvertisedOutputSchema(chatTool, chatResult);

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
      const researchTool = toolMap.get('research');
      assert.ok(researchTool);
      assertAdvertisedOutputSchema(researchTool, researchResult);

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
      const analyzeTool = toolMap.get('analyze');
      assert.ok(analyzeTool);
      assertAdvertisedOutputSchema(analyzeTool, analyzeResult);

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
      const reviewTool = toolMap.get('review');
      assert.ok(reviewTool);
      assertAdvertisedOutputSchema(reviewTool, reviewResult);

      const discoverResult = await callTool(harness.client, 'discover', {
        goal: 'I need to inspect reusable state',
        job: 'memory',
      });
      expectSuccess(discoverResult);
      assert.strictEqual(discoverResult.structuredContent.job, 'memory');
      assert.ok(Array.isArray(discoverResult.structuredContent.relatedResources));
      const discoverTool = toolMap.get('discover');
      assert.ok(discoverTool);
      assertAdvertisedOutputSchema(discoverTool, discoverResult);

      const sessionListResult = await callTool(harness.client, 'memory', {
        action: 'sessions.list',
      });
      expectSuccess(sessionListResult);
      assert.strictEqual(sessionListResult.structuredContent.action, 'sessions.list');
      assert.ok(Array.isArray(sessionListResult.structuredContent.sessions));
      const memoryTool = toolMap.get('memory');
      assert.ok(memoryTool);
      assertAdvertisedOutputSchema(memoryTool, sessionListResult);

      const createCacheResult = await callTool(harness.client, 'memory', {
        action: 'caches.create',
        filePaths: ['package.json'],
        systemInstruction: 'Cache this package metadata for later questions.',
      });
      expectSuccess(createCacheResult);
      assert.strictEqual(createCacheResult.structuredContent.action, 'caches.create');
      assertAdvertisedOutputSchema(memoryTool, createCacheResult);

      const listCachesResult = await callTool(harness.client, 'memory', {
        action: 'caches.list',
      });
      expectSuccess(listCachesResult);
      assert.strictEqual(listCachesResult.structuredContent.action, 'caches.list');
      assert.ok(Array.isArray(listCachesResult.structuredContent.caches));
      assertAdvertisedOutputSchema(memoryTool, listCachesResult);

      const serverRequestMethods = harness.client.getServerRequestMethods();
      assert.ok(serverRequestMethods.includes('roots/list'));
      assert.deepStrictEqual(harness.client.getUnexpectedServerRequests(), []);
    } finally {
      await harness.close();
    }
  });

  it('surfaces invalid public tool payloads through the request boundary', async () => {
    const harness = await createHarness();

    try {
      const missingResearchMode = await harness.client.requestRaw('tools/call', {
        arguments: { goal: 'Tell me something current' },
        name: 'research',
      });
      assertRequestValidationFailure(missingResearchMode, -32602, /mode/i);

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
      assertRequestValidationFailure(
        invalidAnalyzeTargets,
        -32602,
        /public http:\/\/ or https:\/\//i,
      );

      const invalidMemoryAction = await harness.client.requestRaw('tools/call', {
        arguments: {
          action: 'caches.create',
        },
        name: 'memory',
      });
      assertRequestValidationFailure(invalidMemoryAction, -32602, /filePaths|systemInstruction/i);

      const invalidChatSchema = await harness.client.requestRaw('tools/call', {
        arguments: {
          goal: 'Return JSON',
          responseSchema: {
            properties: {
              ok: { type: 42 },
            },
            type: 'object',
          },
        },
        name: 'chat',
      });
      assertRequestValidationFailure(invalidChatSchema, -32602, /responseSchema|type/i);

      assert.deepStrictEqual(harness.client.getUnexpectedServerRequests(), []);
    } finally {
      await harness.close();
    }
  });
});
