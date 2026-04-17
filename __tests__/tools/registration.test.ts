import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
  McpServer,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.API_KEY ??= 'test-key-for-registration';

const { registerAnalyzeTool } = await import('../../src/tools/analyze.js');
const { registerChatTool } = await import('../../src/tools/chat.js');
const { registerDiscoverTool } = await import('../../src/tools/discover.js');
const { registerMemoryTool } = await import('../../src/tools/memory.js');
const { registerResearchTool } = await import('../../src/tools/research-job.js');
const { registerReviewTool } = await import('../../src/tools/review.js');
const { createPromptDefinitions, PUBLIC_PROMPT_NAMES, registerPrompts } =
  await import('../../src/prompts.js');
const { PUBLIC_RESOURCE_URIS, registerResources } = await import('../../src/resources.js');
const { createSessionStore } = await import('../../src/sessions.js');
const { PUBLIC_TOOL_NAMES } = await import('../../src/public-contract.js');

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
  it('registers chat without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerChatTool(server, sessionStore, queue));
  });

  it('registers research without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerResearchTool(server, queue));
  });

  it('registers analyze without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerAnalyzeTool(server, queue));
  });

  it('registers review without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerReviewTool(server, queue));
  });

  it('registers memory without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerMemoryTool(server, sessionStore, queue));
  });

  it('registers discover without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerDiscoverTool(server));
  });

  it('registers resources without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerResources(server));
  });

  it('registers prompts without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerPrompts(server));
  });

  it('registers all public tools, prompts, and resources on the same server', () => {
    const server = createServer();
    assert.doesNotThrow(() => {
      registerChatTool(server, sessionStore, queue);
      registerResearchTool(server, queue);
      registerAnalyzeTool(server, queue);
      registerReviewTool(server, queue);
      registerMemoryTool(server, sessionStore, queue);
      registerDiscoverTool(server);
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
        'discover://catalog',
        'discover://workflows',
        'memory://sessions',
        'memory://sessions/{sessionId}',
        'memory://sessions/{sessionId}/transcript',
        'memory://sessions/{sessionId}/events',
        'memory://caches',
        'memory://caches/{cacheName}',
        'memory://workspace/context',
        'memory://workspace/cache',
      ],
    );
    assert.deepStrictEqual(
      [...PUBLIC_TOOL_NAMES],
      ['chat', 'research', 'analyze', 'review', 'memory', 'discover'],
    );
  });
});
