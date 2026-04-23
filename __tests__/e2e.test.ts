import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  assertProtocolError,
  assertStablePublicSurface,
  assertToolExecutionError,
} from './lib/mcp-contract-assertions.js';
import {
  createServerHarness,
  isJsonRpcFailure,
  type ToolCallResult,
} from './lib/mcp-contract-client.js';

import {
  PUBLIC_PROMPT_NAMES,
  PUBLIC_RESOURCE_URIS,
  PUBLIC_TOOL_NAMES,
} from '../src/public-contract.js';
import { createServerInstance } from '../src/server.js';

process.env.API_KEY ??= 'test-key-for-e2e';

const cleanupCallbacks: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanupCallbacks.length > 0) {
    await cleanupCallbacks.pop()?.();
  }
});

function expectedConcreteResourceUris(): string[] {
  return [
    'session://',
    'discover://catalog',
    'discover://workflows',
    'discover://context',
    'workspace://context',
    'workspace://cache',
  ];
}

function expectedTemplateResourceUris(): string[] {
  return [...PUBLIC_RESOURCE_URIS].filter((uri) => uri.includes('{'));
}

describe('in-memory MCP server e2e', () => {
  it('completes initialization and exposes the discovery surface', async () => {
    const harness = await createServerHarness(createServerInstance, {
      capabilities: { roots: {} },
    });
    cleanupCallbacks.push(harness.close);

    const initialize = await harness.client.initialize();
    const tools = await harness.client.request('tools/list');
    const resources = await harness.client.request('resources/list');
    const resourceTemplates = await harness.client.request('resources/templates/list');
    const prompts = await harness.client.request('prompts/list');
    const discoveryCatalog = await harness.client.request('resources/read', {
      uri: 'discover://catalog',
    });
    const discoverPrompt = await harness.client.request('prompts/get', {
      arguments: {},
      name: 'discover',
    });

    assert.equal(initialize.result.protocolVersion, LATEST_PROTOCOL_VERSION);
    assert.equal((initialize.result.serverInfo as { name: string }).name, 'gemini-assistant');
    assert.equal(typeof initialize.result.instructions, 'string');

    assertStablePublicSurface(
      ((tools.result.tools as { name: string }[]) ?? []).map((tool) => tool.name),
      [...PUBLIC_TOOL_NAMES],
    );
    assertStablePublicSurface(
      ((resources.result.resources as { uri: string }[]) ?? []).map((resource) => resource.uri),
      expectedConcreteResourceUris(),
    );
    assertStablePublicSurface(
      ((resourceTemplates.result.resourceTemplates as { uriTemplate: string }[]) ?? []).map(
        (resource) => resource.uriTemplate,
      ),
      expectedTemplateResourceUris(),
    );
    assertStablePublicSurface(
      ((prompts.result.prompts as { name: string }[]) ?? []).map((prompt) => prompt.name),
      [...PUBLIC_PROMPT_NAMES],
    );

    const discoveryText =
      ((discoveryCatalog.result.contents as { text?: string }[]) ?? []).find(
        (entry) => typeof entry.text === 'string',
      )?.text ?? '';
    assert.match(discoveryText, /chat/);
    assert.match(discoveryText, /session:\/\//);

    const promptText =
      ((discoverPrompt.result.messages as { content?: { text?: string } }[]) ?? []).find(
        (entry) => typeof entry.content?.text === 'string',
      )?.content?.text ?? '';
    assert.match(promptText, /Workflow: `start-here`/);
    assert.match(promptText, /discover:\/\/catalog/);

    assert.equal(
      ((discoveryCatalog.result.contents as { uri?: string }[]) ?? [])[0]?.uri,
      'discover://catalog',
    );
    assert.equal(harness.client.getNotifications().length, 0);
    assert.deepStrictEqual(harness.client.getUnexpectedServerRequests(), []);
  });

  it('materializes task-tool request-shape validation as tool errors', async () => {
    const harness = await createServerHarness(createServerInstance, {
      capabilities: { roots: {} },
    });
    cleanupCallbacks.push(harness.close);

    await harness.client.initialize();

    const invalidAnalyzeRequest = await harness.client.requestRaw('tools/call', {
      arguments: { goal: 'Summarize this file' },
      name: 'analyze',
    });
    assert.equal(isJsonRpcFailure(invalidAnalyzeRequest), false);
    if (isJsonRpcFailure(invalidAnalyzeRequest)) {
      assert.fail(`Unexpected JSON-RPC failure: ${invalidAnalyzeRequest.error.message}`);
    }
    assertToolExecutionError(invalidAnalyzeRequest.result as ToolCallResult, /filePath/i);

    const invalidChatSchema = await harness.client.requestRaw('tools/call', {
      arguments: {
        goal: 'Return JSON',
        responseSchemaJson: JSON.stringify({
          properties: {
            status: { type: 123 },
          },
          type: 'object',
        }),
      },
      name: 'chat',
    });
    assert.equal(isJsonRpcFailure(invalidChatSchema), false);
    if (isJsonRpcFailure(invalidChatSchema)) {
      assert.fail(`Unexpected JSON-RPC failure: ${invalidChatSchema.error.message}`);
    }
    assertToolExecutionError(
      invalidChatSchema.result as ToolCallResult,
      /responseSchemaJson|type|number/i,
    );
  });

  it('reads workspace://context as markdown through MCP', async () => {
    const harness = await createServerHarness(createServerInstance, {
      capabilities: { roots: {} },
    });
    cleanupCallbacks.push(harness.close);

    await harness.client.initialize();
    const response = await harness.client.request('resources/read', {
      uri: 'workspace://context',
    });

    const text =
      ((response.result.contents as { text?: string }[]) ?? []).find(
        (entry) => typeof entry.text === 'string',
      )?.text ?? '';

    assert.match(text, /^# Workspace Context/m);
    assert.match(text, /Estimated tokens:/);
    assert.match(text, /## Sources/);
    assert.match(text, /## Content/);
  });

  it('does not fall back to cwd when workspace context is restricted by ROOTS', async () => {
    const originalAllowedRoots = process.env.ROOTS;
    const originalContextFile = process.env.CONTEXT;
    const restrictedRoot = await mkdtemp(join(tmpdir(), 'workspace-context-restricted-'));
    process.env.ROOTS = restrictedRoot;
    process.env.CONTEXT = join(process.cwd(), 'package.json');

    const harness = await createServerHarness(createServerInstance, {
      capabilities: { roots: {} },
    });
    cleanupCallbacks.push(harness.close);

    try {
      await harness.client.initialize();
      const response = await harness.client.request('resources/read', {
        uri: 'workspace://context',
      });

      const text =
        ((response.result.contents as { text?: string }[]) ?? []).find(
          (entry) => typeof entry.text === 'string',
        )?.text ?? '';

      assert.match(text, /^# Workspace Context/m);
      assert.match(text, /- None/);
      assert.match(text, /## Content\s+# Workspace Context/m);
      assert.doesNotMatch(text, /package\.json/);
    } finally {
      process.env.ROOTS = originalAllowedRoots;
      process.env.CONTEXT = originalContextFile;
      await rm(restrictedRoot, { recursive: true, force: true });
    }
  });

  it('surfaces an unknown resources/read URI through the protocol boundary', async () => {
    const harness = await createServerHarness(createServerInstance, {
      capabilities: { roots: {} },
    });
    cleanupCallbacks.push(harness.close);

    await harness.client.initialize();
    const response = await harness.client.requestRaw('resources/read', {
      uri: 'memory://does-not-exist/nope',
    });

    assertProtocolError(response, -32002, /resource|uri|not found|invalid/i);
  });

  it('surfaces prompts/get with invalid argument shape through the protocol boundary', async () => {
    const harness = await createServerHarness(createServerInstance, {
      capabilities: { roots: {} },
    });
    cleanupCallbacks.push(harness.close);

    await harness.client.initialize();
    const response = await harness.client.requestRaw('prompts/get', {
      arguments: { mode: 'not-a-valid-mode' },
      name: 'research',
    });

    assertProtocolError(response, -32602, /mode|invalid|enum/i);
  });
});
