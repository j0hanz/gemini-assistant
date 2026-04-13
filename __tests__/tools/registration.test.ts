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
const { registerSearchTool } = await import('../../src/tools/search.js');
const { registerExecuteCodeTool } = await import('../../src/tools/execute-code.js');
const { registerAnalyzeFileTool } = await import('../../src/tools/analyze-file.js');
const { registerAnalyzeUrlTool } = await import('../../src/tools/analyze-url.js');
const { registerCacheTools } = await import('../../src/tools/cache.js');
const { registerResources } = await import('../../src/resources.js');

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

  it('registers cache tools (create, list, delete) without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerCacheTools(server));
  });

  it('registers resources without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerResources(server));
  });

  it('registers all tools on the same server', () => {
    const server = createServer();
    assert.doesNotThrow(() => {
      registerAskTool(server);
      registerExecuteCodeTool(server);
      registerSearchTool(server);
      registerAnalyzeFileTool(server);
      registerAnalyzeUrlTool(server);
      registerCacheTools(server);
      registerResources(server);
    });
  });
});
