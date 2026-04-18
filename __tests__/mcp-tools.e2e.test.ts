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

function getObjectProperty(
  schema: unknown,
  propertyName: string,
): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') {
    return undefined;
  }

  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== 'object') {
    return undefined;
  }

  const property = (properties as Record<string, unknown>)[propertyName];
  return property && typeof property === 'object'
    ? (property as Record<string, unknown>)
    : undefined;
}

function findPropertyInSchema(
  schema: unknown,
  propertyName: string,
): Record<string, unknown> | undefined {
  const directProperty = getObjectProperty(schema, propertyName);
  if (directProperty) {
    return directProperty;
  }

  if (!schema || typeof schema !== 'object') {
    return undefined;
  }

  for (const branchKey of ['anyOf', 'oneOf']) {
    const branches = (schema as Record<string, unknown>)[branchKey];
    if (!Array.isArray(branches)) {
      continue;
    }

    for (const branch of branches) {
      const branchProperty = findPropertyInSchema(branch, propertyName);
      if (branchProperty) {
        return branchProperty;
      }
    }
  }

  return undefined;
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
    requiredInput: ['goal', 'targets', 'output'],
    requiredOutput: ['status', 'kind', 'targetKind'],
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
        ['chat', 'research', 'analyze', 'review', 'memory'],
      );

      for (const [toolName, contract] of Object.entries(EXPECTED_TOOL_CONTRACTS)) {
        assertToolContract(toolMap.get(toolName), contract);
      }

      for (const toolName of ['chat', 'research', 'analyze', 'review']) {
        const thinkingLevel = findPropertyInSchema(
          toolMap.get(toolName)?.inputSchema,
          'thinkingLevel',
        );
        assert.ok(thinkingLevel, `Expected ${toolName} to advertise thinkingLevel`);
        assert.equal(
          thinkingLevel.default,
          'MEDIUM',
          `Expected ${toolName}.thinkingLevel default to be MEDIUM`,
        );
        assert.equal(
          thinkingLevel.description,
          'Reasoning depth. Default: MEDIUM. MINIMAL is fastest; HIGH is deepest.',
          `Expected ${toolName}.thinkingLevel description to stay consistent`,
        );
      }

      const chatSchema = toolMap.get('chat')?.inputSchema;
      assert.equal(getObjectProperty(chatSchema, 'session'), undefined);
      assert.equal(getObjectProperty(chatSchema, 'memory'), undefined);
      assert.equal(getObjectProperty(chatSchema, 'responseSchema'), undefined);
      assert.ok(getObjectProperty(chatSchema, 'sessionId'));
      assert.ok(getObjectProperty(chatSchema, 'cacheName'));
      assert.ok(getObjectProperty(chatSchema, 'responseSchemaJson'));

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
        responseSchemaJson: JSON.stringify({
          properties: {
            count: { type: 'integer' },
            status: { type: 'string' },
          },
          required: ['status', 'count'],
          type: 'object',
        }),
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
        output: {
          kind: 'summary',
        },
      });
      expectSuccess(analyzeResult);
      assert.strictEqual(analyzeResult.structuredContent.kind, 'summary');
      assert.strictEqual(analyzeResult.structuredContent.targetKind, 'file');
      assert.match(String(analyzeResult.structuredContent.summary), /Gemini client factory/);
      const analyzeTool = toolMap.get('analyze');
      assert.ok(analyzeTool);
      assertAdvertisedOutputSchema(analyzeTool, analyzeResult);

      env.queueStream(
        makeChunk(
          [
            {
              text: '```mermaid\nflowchart TD\nA-->B\n```',
            },
          ],
          FinishReason.STOP,
        ),
      );

      const diagramResult = await callTool(harness.client, 'analyze', {
        goal: 'Show the request flow',
        targets: {
          filePath: 'src/client.ts',
          kind: 'file',
        },
        output: {
          kind: 'diagram',
          diagramType: 'mermaid',
          validateSyntax: true,
        },
      });
      expectSuccess(diagramResult);
      assert.strictEqual(diagramResult.structuredContent.kind, 'diagram');
      assert.strictEqual(diagramResult.structuredContent.diagramType, 'mermaid');
      assert.match(String(diagramResult.structuredContent.diagram), /flowchart TD/);
      const diagramTool = toolMap.get('analyze');
      assert.ok(diagramTool);
      assertAdvertisedOutputSchema(diagramTool, diagramResult);

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

      const sessionListResult = await callTool(harness.client, 'memory', {
        action: 'sessions.list',
      });
      expectSuccess(sessionListResult);
      assert.strictEqual(sessionListResult.structuredContent.action, 'sessions.list');
      assert.ok(Array.isArray(sessionListResult.structuredContent.sessions));
      const memoryTool = toolMap.get('memory');
      assert.ok(memoryTool);
      assertAdvertisedOutputSchema(memoryTool, sessionListResult);

      env.queueStream(makeChunk([{ text: 'Session ready' }], FinishReason.STOP));

      const encodedSessionId = 'sess special%/#';
      const sessionResult = await callTool(harness.client, 'chat', {
        goal: 'Start a session',
        sessionId: encodedSessionId,
      });
      expectSuccess(sessionResult);
      assert.deepStrictEqual(sessionResult.structuredContent.session, {
        id: encodedSessionId,
        resources: {
          detail: `memory://sessions/${encodeURIComponent(encodedSessionId)}`,
          events: `memory://sessions/${encodeURIComponent(encodedSessionId)}/events`,
          transcript: `memory://sessions/${encodeURIComponent(encodedSessionId)}/transcript`,
        },
      });
      assertAdvertisedOutputSchema(chatTool, sessionResult);

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
          output: {
            kind: 'summary',
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
          responseSchemaJson: JSON.stringify({
            properties: {
              ok: { type: 42 },
            },
            type: 'object',
          }),
        },
        name: 'chat',
      });
      assertRequestValidationFailure(invalidChatSchema, -32602, /responseSchemaJson|type|number/i);

      const removedChatSession = await harness.client.requestRaw('tools/call', {
        arguments: {
          goal: 'Start a session',
          session: { id: 'sess-legacy' },
        },
        name: 'chat',
      });
      assertRequestValidationFailure(removedChatSession, -32602, /session/i);

      assert.deepStrictEqual(harness.client.getUnexpectedServerRequests(), []);
    } finally {
      await harness.close();
    }
  });
});
