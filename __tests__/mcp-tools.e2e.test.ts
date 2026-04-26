import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { FinishReason } from '@google/genai';

import {
  assertAdvertisedOutputSchema,
  assertToolExecutionError,
  schemaRequiresField,
} from './lib/mcp-contract-assertions.js';
import {
  createServerHarness,
  isJsonRpcFailure,
  type JsonRpcResponse,
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

function assertMaterializedToolFailure(
  response: JsonRpcResponse,
  expectedMessagePattern: RegExp,
): void {
  assert.equal(isJsonRpcFailure(response), false);
  if (isJsonRpcFailure(response)) {
    assert.fail(`Unexpected JSON-RPC failure: ${response.error.message}`);
  }
  assertToolExecutionError(response.result as ToolCallResult, expectedMessagePattern);
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

const READONLY_NON_IDEMPOTENT_ANNOTATIONS = {
  ...READONLY_ANNOTATIONS,
  idempotentHint: false,
} as const;

const EXPECTED_TOOL_CONTRACTS = {
  analyze: {
    annotations: READONLY_NON_IDEMPOTENT_ANNOTATIONS,
    requiredInput: ['goal'],
    requiredOutput: ['status', 'kind', 'targetKind'],
    taskSupport: 'optional',
    title: 'Analyze',
  },
  chat: {
    annotations: READONLY_NON_IDEMPOTENT_ANNOTATIONS,
    requiredInput: ['goal'],
    requiredOutput: ['status', 'answer'],
    taskSupport: 'optional',
    title: 'Chat',
  },
  research: {
    annotations: READONLY_NON_IDEMPOTENT_ANNOTATIONS,
    requiredInput: ['goal'],
    requiredOutput: ['status', 'mode', 'summary'],
    taskSupport: 'optional',
    title: 'Research',
  },
  review: {
    annotations: READONLY_NON_IDEMPOTENT_ANNOTATIONS,
    requiredInput: [],
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

      assert.deepStrictEqual([...toolMap.keys()], ['chat', 'research', 'analyze', 'review']);

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
          undefined,
          `Expected ${toolName}.thinkingLevel to omit schema-level default`,
        );
        assert.equal(
          thinkingLevel.description,
          'Optional reasoning depth override. Omit to use the job default.',
          `Expected ${toolName}.thinkingLevel description to stay consistent`,
        );
      }

      const chatSchema = toolMap.get('chat')?.inputSchema;
      assert.equal(getObjectProperty(chatSchema, 'session'), undefined);
      assert.equal(getObjectProperty(chatSchema, 'memory'), undefined);
      assert.equal(getObjectProperty(chatSchema, 'responseSchema'), undefined);
      assert.equal(getObjectProperty(chatSchema, 'cacheName'), undefined);
      const goal = getObjectProperty(chatSchema, 'goal');
      const sessionId = getObjectProperty(chatSchema, 'sessionId');
      const responseSchemaJson = getObjectProperty(chatSchema, 'responseSchemaJson');
      const temperature = getObjectProperty(chatSchema, 'temperature');
      const seed = getObjectProperty(chatSchema, 'seed');
      const googleSearch = getObjectProperty(chatSchema, 'googleSearch');
      const urls = getObjectProperty(chatSchema, 'urls');

      assert.ok(goal);
      assert.equal(goal.description, 'User goal or requested outcome');

      assert.ok(sessionId);
      assert.equal(
        sessionId.description,
        'Server-managed in-memory session identifier. Omitting sessionId enables structured output (responseSchemaJson) and JSON schema-repair retry.',
      );

      assert.ok(responseSchemaJson);
      assert.equal(
        responseSchemaJson.description,
        'JSON Schema (2020-12) for structured output. Single-turn / new-session only.',
      );

      assert.ok(temperature);
      assert.equal(temperature.description, 'Sampling temperature 0-2 (default 1).');

      assert.ok(seed);
      assert.equal(seed.description, 'Fixed random seed for reproducible outputs.');

      assert.ok(googleSearch);
      assert.equal(
        googleSearch.description,
        'Enable Google Search grounding for chat. Optional; additive. Combine with `urls` for URL Context.',
      );

      assert.ok(urls);
      assert.equal(urls.description, 'Public URLs to analyze with URL Context during chat.');
      assert.equal(urls.minItems, 1);
      assert.equal(urls.maxItems, 20);

      const analyzeSchema = toolMap.get('analyze')?.inputSchema;
      const analyzeTargetKind = getObjectProperty(analyzeSchema, 'targetKind');
      const analyzeOutputKind = getObjectProperty(analyzeSchema, 'outputKind');
      const analyzeMediaResolution = getObjectProperty(analyzeSchema, 'mediaResolution');

      assert.ok(analyzeTargetKind);
      assert.equal(
        analyzeTargetKind.description,
        'What to analyze: one file, one or more public URLs, or a small local file set.',
      );
      assert.equal(analyzeTargetKind.default, 'file');

      assert.ok(analyzeOutputKind);
      assert.equal(
        analyzeOutputKind.description,
        'Requested output format: summary text or a generated diagram.',
      );
      assert.equal(analyzeOutputKind.default, 'summary');

      assert.ok(analyzeMediaResolution);
      assert.equal(
        analyzeMediaResolution.description,
        'Resolution for image/video processing. Higher = more detail, more tokens.',
      );
      assert.equal(analyzeMediaResolution.default, 'MEDIA_RESOLUTION_MEDIUM');

      const reviewSchema = toolMap.get('review')?.inputSchema;
      const reviewSubjectKind = findPropertyInSchema(reviewSchema, 'subjectKind');
      const reviewFilePathA = getObjectProperty(reviewSchema, 'filePathA');
      const reviewError = getObjectProperty(reviewSchema, 'error');
      const researchSchema = toolMap.get('research')?.inputSchema;
      const researchMode = getObjectProperty(researchSchema, 'mode');

      assert.ok(reviewSubjectKind);
      assert.ok(reviewFilePathA);
      assert.ok(reviewError);
      assert.equal(
        reviewSubjectKind.description,
        'What to review: the current diff, a file comparison, or a failure report.',
      );
      assert.ok(researchMode);
      assert.equal(researchMode.description, 'Research mode selector (`quick` or `deep`).');
      assert.equal(researchMode.default, 'quick');
      assert.equal((researchSchema as { oneOf?: unknown }).oneOf, undefined);
      assert.equal((reviewSchema as { oneOf?: unknown } | undefined)?.oneOf, undefined);
      assert.equal(reviewSubjectKind.default, 'diff');

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
      assert.deepStrictEqual(researchResult.structuredContent.sources, undefined);
      assert.deepStrictEqual(researchResult.structuredContent.sourceDetails, [
        {
          domain: 'example.com',
          origin: 'googleSearch',
          title: 'Example',
          url: 'https://example.com',
        },
      ]);
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
        targetKind: 'file',
        filePath: 'src/client.ts',
        outputKind: 'summary',
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
        targetKind: 'file',
        filePath: 'src/client.ts',
        outputKind: 'diagram',
        validateSyntax: true,
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
        subjectKind: 'failure',
        error: 'TypeError: Cannot read properties of undefined (reading trim)',
        language: 'typescript',
      });
      expectSuccess(reviewResult);
      assert.strictEqual(reviewResult.structuredContent.subjectKind, 'failure');
      assert.match(String(reviewResult.structuredContent.summary), /Validate the input/);
      const reviewTool = toolMap.get('review');
      assert.ok(reviewTool);
      assertAdvertisedOutputSchema(reviewTool, reviewResult);

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
          detail: `session://${encodeURIComponent(encodedSessionId)}`,
        },
      });
      assert.ok(
        !sessionResult.content.some(
          (item) =>
            item.type === 'resource_link' &&
            item.uri === `gemini://sessions/${encodeURIComponent(encodedSessionId)}/turns/1/parts`,
        ),
      );
      assertAdvertisedOutputSchema(chatTool, sessionResult);

      const serverRequestMethods = harness.client.getServerRequestMethods();
      assert.ok(serverRequestMethods.includes('roots/list'));
      assert.deepStrictEqual(harness.client.getUnexpectedServerRequests(), []);
    } finally {
      await harness.close();
    }
  });

  it('materializes invalid public task-tool payloads as tool errors', async () => {
    const harness = await createHarness();

    try {
      const invalidAnalyzeShape = await harness.client.requestRaw('tools/call', {
        arguments: { goal: 'Summarize this file' },
        name: 'analyze',
      });
      assertMaterializedToolFailure(invalidAnalyzeShape, /filePath/i);

      const invalidAnalyzeTargets = await harness.client.requestRaw('tools/call', {
        arguments: {
          goal: 'Inspect this',
          targetKind: 'url',
          urls: ['http://localhost/private'],
          outputKind: 'summary',
        },
        name: 'analyze',
      });
      assertMaterializedToolFailure(invalidAnalyzeTargets, /public http:\/\/ or https:\/\//i);

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
      assertMaterializedToolFailure(invalidChatSchema, /responseSchemaJson|type|number/i);

      const removedChatSession = await harness.client.requestRaw('tools/call', {
        arguments: {
          goal: 'Start a session',
          session: { id: 'sess-legacy' },
        },
        name: 'chat',
      });
      assertMaterializedToolFailure(removedChatSession, /session/i);

      assert.deepStrictEqual(harness.client.getUnexpectedServerRequests(), []);
    } finally {
      await harness.close();
    }
  });
});
