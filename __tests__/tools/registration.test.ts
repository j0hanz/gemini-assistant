import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
  McpServer,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Set dummy API key so client.ts doesn't exit
process.env.API_KEY ??= 'test-key-for-registration';

const { registerAskTool } = await import('../../src/tools/ask.js');
const { registerCacheTools } = await import('../../src/tools/cache.js');
const { registerAnalyzeFileTool, registerExecuteCodeTool } =
  await import('../../src/tools/execution.js');
const { registerAnalyzePrTool } = await import('../../src/tools/pr.js');
const { registerAgenticSearchTool, registerAnalyzeUrlTool, registerSearchTool } =
  await import('../../src/tools/research.js');
const {
  createPromptDefinitions,
  PUBLIC_PROMPT_NAMES,
  PUBLIC_RESOURCE_URIS,
  registerPrompts,
  registerResources,
} = await import('../../src/server-content.js');
const { registerServerFeatures, SERVER_REGISTRARS } =
  await import('../../src/server-registration.js');
const { registerCompareFilesTool } = await import('../../src/tools/compare.js');
const { registerGenerateDiagramTool } = await import('../../src/tools/diagram.js');
const { registerExplainErrorTool } = await import('../../src/tools/explain-error.js');

function createServer(): McpServer {
  return new McpServer(
    { name: 'test-server', version: '0.0.1' },
    {
      capabilities: {
        logging: {},
        tasks: {
          requests: { tools: { call: {} } },
          taskStore: new InMemoryTaskStore(),
          taskMessageQueue: new InMemoryTaskMessageQueue(),
        },
      },
    },
  );
}

describe('tool registration', () => {
  it('registers ask tool without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerAskTool(server));
  });

  it('registers search tool without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerSearchTool(server));
  });

  it('registers execute_code tool without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerExecuteCodeTool(server));
  });

  it('registers analyze_file tool without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerAnalyzeFileTool(server));
  });

  it('registers analyze_url tool without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerAnalyzeUrlTool(server));
  });

  it('registers analyze_pr tool without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerAnalyzePrTool(server));
  });

  it('registers cache tools (create, list, delete) without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerCacheTools(server));
  });

  it('registers resources without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerResources(server));
  });

  it('registers prompts without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerPrompts(server));
  });

  it('registers agentic_search tool without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerAgenticSearchTool(server));
  });

  it('registers explain_error tool without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerExplainErrorTool(server));
  });

  it('registers compare_files tool without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerCompareFilesTool(server));
  });

  it('registers generate_diagram tool without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerGenerateDiagramTool(server));
  });

  it('registers all tools on the same server', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerServerFeatures(server));
  });

  it('keeps the shared registration list aligned with targeted coverage', () => {
    assert.deepStrictEqual(
      SERVER_REGISTRARS.map(([name]) => name),
      [
        'ask tool',
        'execute_code tool',
        'search tool',
        'agentic_search tool',
        'analyze_file tool',
        'analyze_url tool',
        'analyze_pr tool',
        'explain_error tool',
        'compare_files tool',
        'generate_diagram tool',
        'cache tools',
        'prompts',
        'resources',
      ],
    );
  });

  it('keeps the exported prompt and resource surface aligned with discoverability docs', () => {
    assert.deepStrictEqual(
      createPromptDefinitions(async () => []).map((definition) => definition.name),
      [...PUBLIC_PROMPT_NAMES],
    );
    assert.deepStrictEqual(
      [...PUBLIC_RESOURCE_URIS],
      [
        'sessions://list',
        'sessions://{sessionId}',
        'sessions://{sessionId}/transcript',
        'caches://list',
        'caches://{cacheName}',
        'tools://list',
        'workflows://list',
      ],
    );
  });
});
