import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert';
import { test } from 'node:test';

import {
  createWorkspaceAccess,
  createWorkspaceCacheManager,
} from '../../src/lib/workspace-context.js';
import { WORKSPACE_CACHE_CONTENTS_URI, WORKSPACE_CACHE_URI } from '../../src/resources/uris.js';
import { registerWorkspaceResources } from '../../src/resources/workspace.js';

interface MockServer {
  registerResource: (
    id: string,
    _uri: string | Record<string, unknown>,
    _opts: unknown,
    handler: (uri: { href: string }) => Promise<unknown>,
  ) => void;
}

test('workspace resources — registers gemini:// workspace resources', () => {
  const workspaceCacheManager = createWorkspaceCacheManager();
  const workspaceAccess = createWorkspaceAccess(workspaceCacheManager);

  // Create a minimal mock server that tracks registerResource calls
  const registeredResources: string[] = [];
  const mockServer: MockServer = {
    registerResource: (id: string): void => {
      registeredResources.push(id);
    },
  };

  // Should not throw
  registerWorkspaceResources(mockServer as never, {
    workspace: workspaceAccess,
  });

  // Verify resources were registered
  assert(registeredResources.includes('workspace-cache-gemini'));
  assert(registeredResources.includes('workspace-cache-contents-gemini'));
  assert(registeredResources.includes('workspace-files-gemini'));
});

test('workspace resources — reads workspace cache metadata', async () => {
  const workspaceCacheManager = createWorkspaceCacheManager();
  const workspaceAccess = createWorkspaceAccess(workspaceCacheManager);

  const resourceHandlers = new Map<string, (uri: { href: string }) => Promise<unknown>>();
  const mockServer: MockServer = {
    registerResource: (id: string, _uri: unknown, _opts: unknown, handler) => {
      resourceHandlers.set(id, handler);
    },
  };

  registerWorkspaceResources(mockServer as never, {
    workspace: workspaceAccess,
  });

  const handler = resourceHandlers.get('workspace-cache-gemini');
  assert(handler);

  const result = (await handler({ href: WORKSPACE_CACHE_URI })) as {
    contents: { uri: string; mimeType: string; text: string }[];
  };

  assert(result.contents);
  assert(result.contents.length > 0);

  // Extract JSON content (before _meta block)
  const text = result.contents[0].text;
  const metaIndex = text.lastIndexOf('\n\n_meta:');
  const jsonPart = metaIndex > -1 ? text.substring(0, metaIndex) : text;

  const content = JSON.parse(jsonPart) as unknown;
  assert(typeof content === 'object');
  assert(content !== null);
  assert('enabled' in content);
});

test('workspace resources — reads workspace cache contents', async () => {
  const workspaceCacheManager = createWorkspaceCacheManager();
  const workspaceAccess = createWorkspaceAccess(workspaceCacheManager);

  const resourceHandlers = new Map<string, (uri: { href: string }) => Promise<unknown>>();
  const mockServer: MockServer = {
    registerResource: (id: string, _uri: unknown, _opts: unknown, handler) => {
      resourceHandlers.set(id, handler);
    },
  };

  registerWorkspaceResources(mockServer as never, {
    workspace: workspaceAccess,
  });

  const handler = resourceHandlers.get('workspace-cache-contents-gemini');
  assert(handler);

  const result = (await handler({ href: WORKSPACE_CACHE_CONTENTS_URI })) as {
    contents: { uri: string; mimeType: string; text: string }[];
  };

  assert(result.contents);
  assert(result.contents.length > 0);

  // Extract JSON content (before _meta block)
  const text = result.contents[0].text;
  const metaIndex = text.lastIndexOf('\n\n_meta:');
  const jsonPart = metaIndex > -1 ? text.substring(0, metaIndex) : text;

  const content = JSON.parse(jsonPart) as unknown;
  assert(typeof content === 'object');
  assert(content !== null);
  assert('metadata' in content);
  assert('files' in content);
});

test('workspace resources — reads file with path validation', async () => {
  const workspaceCacheManager = createWorkspaceCacheManager();
  const workspaceAccess = createWorkspaceAccess(workspaceCacheManager);

  const resourceHandlers = new Map<string, (uri: { href: string }) => Promise<unknown>>();
  const mockServer: MockServer = {
    registerResource: (id: string, _uri: unknown, _opts: unknown, handler) => {
      resourceHandlers.set(id, handler);
    },
  };

  registerWorkspaceResources(mockServer as never, {
    workspace: workspaceAccess,
  });

  const handler = resourceHandlers.get('workspace-files-gemini');
  assert(handler);

  // Test with a valid relative path (this will fail with file not found, but validates path)
  try {
    await handler({ href: 'gemini://workspace/files/test.txt' });
  } catch (err) {
    // Expected to throw ProtocolError for file not found or other reason
    assert(err instanceof ProtocolError || err instanceof Error);
  }
});

test('workspace resources — rejects path traversal attack', async () => {
  const workspaceCacheManager = createWorkspaceCacheManager();
  const workspaceAccess = createWorkspaceAccess(workspaceCacheManager);

  const resourceHandlers = new Map<string, (uri: { href: string }) => Promise<unknown>>();
  const mockServer: MockServer = {
    registerResource: (id: string, _uri: unknown, _opts: unknown, handler) => {
      resourceHandlers.set(id, handler);
    },
  };

  registerWorkspaceResources(mockServer as never, {
    workspace: workspaceAccess,
  });

  const handler = resourceHandlers.get('workspace-files-gemini');
  assert(handler);

  // Test with path traversal attempt
  let threwExpected = false;
  try {
    await handler({ href: 'gemini://workspace/files/..%2Fetc%2Fpasswd' });
  } catch (err) {
    if (err instanceof ProtocolError) {
      const errorCode = err.code;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- ProtocolErrorCode enum comparison
      threwExpected = errorCode === ProtocolErrorCode.InvalidParams;
    }
  }
  assert(threwExpected, 'Should reject path traversal');
});
