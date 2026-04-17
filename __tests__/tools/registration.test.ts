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
const { createSessionStore } = await import('../../src/sessions.js');
const { registerCacheTools } = await import('../../src/tools/cache.js');
const { registerAnalyzeFileTool, registerExecuteCodeTool } =
  await import('../../src/tools/execution.js');
const { registerAnalyzePrTool } = await import('../../src/tools/pr.js');
const { registerAgenticSearchTool, registerAnalyzeUrlTool, registerSearchTool } =
  await import('../../src/tools/research.js');
const { createPromptDefinitions, PUBLIC_PROMPT_NAMES, registerPrompts } =
  await import('../../src/prompts.js');
const { PUBLIC_RESOURCE_URIS, registerResources } = await import('../../src/resources.js');
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

const queue = new InMemoryTaskMessageQueue();
const sessionStore = createSessionStore();

describe('tool registration', () => {
  it('registers ask tool without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerAskTool(server, sessionStore, queue));
  });

  it('registers search tool without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerSearchTool(server, queue));
  });

  it('registers execute_code tool without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerExecuteCodeTool(server, queue));
  });

  it('registers analyze_file tool without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerAnalyzeFileTool(server, queue));
  });

  it('registers analyze_url tool without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerAnalyzeUrlTool(server, queue));
  });

  it('registers analyze_pr tool without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerAnalyzePrTool(server, queue));
  });

  it('registers cache tools (create, list, delete) without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerCacheTools(server, queue));
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
    assert.doesNotThrow(() => registerAgenticSearchTool(server, queue));
  });

  it('registers explain_error tool without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerExplainErrorTool(server, queue));
  });

  it('registers compare_files tool without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerCompareFilesTool(server, queue));
  });

  it('registers generate_diagram tool without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerGenerateDiagramTool(server, queue));
  });

  it('registers all tools, prompts, and resources on the same server', () => {
    const server = createServer();
    assert.doesNotThrow(() => {
      registerAskTool(server, sessionStore, queue);
      registerExecuteCodeTool(server, queue);
      registerSearchTool(server, queue);
      registerAgenticSearchTool(server, queue);
      registerAnalyzeFileTool(server, queue);
      registerAnalyzeUrlTool(server, queue);
      registerAnalyzePrTool(server, queue);
      registerExplainErrorTool(server, queue);
      registerCompareFilesTool(server, queue);
      registerGenerateDiagramTool(server, queue);
      registerCacheTools(server, queue);
      registerPrompts(server);
      registerResources(server);
    });
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
        'sessions://{sessionId}/events',
        'caches://list',
        'caches://{cacheName}',
        'tools://list',
        'workflows://list',
        'workspace://context',
        'workspace://cache',
      ],
    );
  });
});
