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
const { registerResearchTool } = await import('../../src/tools/research.js');
const { registerReviewTool } = await import('../../src/tools/review.js');
const { createPromptDefinitions, PUBLIC_PROMPT_NAMES, registerPrompts } =
  await import('../../src/prompts.js');
const { PUBLIC_RESOURCE_URIS, registerResources } = await import('../../src/resources.js');
const { createSessionStore } = await import('../../src/sessions.js');
const { PUBLIC_TOOL_NAMES } = await import('../../src/public-contract.js');
const { createWorkspaceCacheManager } = await import('../../src/lib/workspace-context.js');

const rootsFetcher = async (): Promise<string[]> => [];

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

const sessionStore = createSessionStore();
const workspaceCacheManager = createWorkspaceCacheManager();

describe('tool registration', () => {
  it('registers chat without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerChatTool(server, sessionStore, workspaceCacheManager));
  });

  it('registers research without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerResearchTool(server, workspaceCacheManager));
  });

  it('registers analyze without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerAnalyzeTool(server, workspaceCacheManager, rootsFetcher));
  });

  it('registers review without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerReviewTool(server, workspaceCacheManager, rootsFetcher));
  });

  it('registers resources without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerResources(server, sessionStore, workspaceCacheManager));
  });

  it('registers prompts without error', () => {
    const server = createServer();
    assert.doesNotThrow(() => registerPrompts(server));
  });

  it('registers all public tools, prompts, and resources on the same server', () => {
    const server = createServer();
    assert.doesNotThrow(() => {
      registerChatTool(server, sessionStore, workspaceCacheManager);
      registerResearchTool(server, workspaceCacheManager);
      registerAnalyzeTool(server, workspaceCacheManager, rootsFetcher);
      registerReviewTool(server, workspaceCacheManager, rootsFetcher);
      registerPrompts(server);
      registerResources(server, sessionStore, workspaceCacheManager);
    });
  });

  it('keeps the exported prompt and resource surface aligned with discoverability docs', () => {
    assert.deepStrictEqual(
      createPromptDefinitions().map((definition) => definition.name),
      [...PUBLIC_PROMPT_NAMES],
    );
    assert.deepStrictEqual(
      [...PUBLIC_RESOURCE_URIS],
      [
        'discover://catalog',
        'discover://context',
        'discover://workflows',
        'session://',
        'workspace://context',
        'workspace://cache',
        'session://{sessionId}',
        'session://{sessionId}/transcript',
        'session://{sessionId}/events',
        'gemini://sessions/{sessionId}/turns/{turnIndex}/parts',
      ],
    );
    assert.deepStrictEqual([...PUBLIC_TOOL_NAMES], ['chat', 'research', 'analyze', 'review']);
  });
});
