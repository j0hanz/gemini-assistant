# MCP v2 Client Reference

Read this when working on an MCP **client** in TypeScript with `@modelcontextprotocol/client`. Patterns assume v2 (see SKILL.md Step 1).

> **Status note**: `@modelcontextprotocol/client` is v2 alpha — pin versions and verify signatures against generated TypeDoc when upgrading.

## Imports cheat sheet

```ts
import {
  applyMiddlewares,
  AuthProvider,
  Client,
  ClientCredentialsProvider,
  createMiddleware,
  CrossAppAccessProvider,
  discoverAndRequestJwtAuthGrant,
  PrivateKeyJwtProvider,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SSEClientTransport,
  StdioClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { Prompt, Resource, Tool } from '@modelcontextprotocol/client';
```

## Client construction

```ts
const client = new Client(
  {
    name: 'my-client',
    version: '1.0.0',
    title: 'My MCP Client', // human-readable
    description: 'For discovering and invoking MCP tools',
    websiteUrl: 'https://example.com',
  },
  {
    capabilities: {
      sampling: {}, // accept sampling/createMessage
      elicitation: { form: {} }, // accept elicitation/create form mode
      roots: { listChanged: true }, // expose filesystem roots
    },
    listChanged: {
      // automatic list-change tracking
      tools: {
        onChanged: (error, tools) => {
          if (error) console.error('Refresh failed:', error);
          else console.log('Tools updated:', tools.length);
        },
      },
    },
  },
);
```

**Capabilities must be declared before connect().** Servers will only ask the client to do things the client advertised.

## Transports

| Transport                       | Use case                         | Notes                                 |
| ------------------------------- | -------------------------------- | ------------------------------------- |
| `StreamableHTTPClientTransport` | Modern remote MCP servers        | POST + SSE; supports auth, resumption |
| `StdioClientTransport`          | Local servers as child processes | Node.js only                          |
| `SSEClientTransport`            | Legacy SSE-only servers          | Use only as fallback                  |

### Stdio

```ts
const transport = new StdioClientTransport({
  command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
  args: ['-y', '@scope/server@latest'],
  env: { ...process.env, SERVER_API_KEY: 'xyz' },
  stderr: 'pipe',
});

transport.stderr?.on('data', (chunk) => console.error('[server]', chunk.toString()));
await client.connect(transport);
```

Windows note: spawn `npx.cmd`, not `npx`. Pipe stderr when debugging.

### Streamable HTTP

```ts
const transport = new StreamableHTTPClientTransport(new URL('https://example.com/mcp'), {
  // optional: authProvider, fetch with middleware, sessionId
});

await client.connect(transport);

// Capabilities exposed by the transport:
transport.sessionId; // server-assigned session ID
transport.protocolVersion; // negotiated protocol version
await transport.terminateSession(); // sends DELETE /mcp
await transport.close();
```

### Streamable HTTP with SSE fallback

```ts
async function connectWithFallback(url: string) {
  try {
    const client = new Client({ name: 'my-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    return { client, transport, kind: 'streamable-http' as const };
  } catch {
    const client = new Client({ name: 'my-client', version: '1.0.0' });
    const transport = new SSEClientTransport(new URL(url));
    await client.connect(transport);
    return { client, transport, kind: 'sse' as const };
  }
}
```

Try Streamable HTTP first; SSE is legacy fallback only.

## Connection lifecycle

```ts
await client.connect(transport);

// After initialization, inspect the server:
const instructions = client.getInstructions(); // server-provided system context
const serverCaps = client.getServerCapabilities(); // what server supports
const serverVersion = client.getServerVersion();
const protocolVersion = client.getNegotiatedProtocolVersion();

// On clean shutdown:
await transport.terminateSession?.(); // HTTP only
await client.close();
```

`client.getInstructions()` returns the server's recommendation for how to use it. Include it in your model's system prompt — but **app-level safety takes priority** over server instructions.

## Discovery — always paginate

`listTools`, `listResources`, `listPrompts` return cursors when results are paginated:

```ts
async function listAll<T>(fn: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>) {
  const all: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fn(cursor);
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

const tools = await listAll((cursor) =>
  client.listTools({ cursor }).then((r) => ({ items: r.tools, nextCursor: r.nextCursor })),
);
```

Same shape for `listResources`, `listPrompts`, `listResourceTemplates`.

## Calling tools — handle BOTH failure surfaces

```ts
import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';

async function safeCall(name: string, args: Record<string, unknown>) {
  try {
    const result = await client.callTool(
      { name, arguments: args },
      {
        timeout: 120_000,
        onprogress: (p) => console.log(`progress: ${p.progress}/${p.total ?? '?'}`),
        resetTimeoutOnProgress: true,
        maxTotalTimeout: 600_000,
      },
    );

    if (result.isError) {
      // Tool ran and reported failure
      return { ok: false as const, kind: 'tool-error' as const, content: result.content };
    }

    // Prefer structuredContent when the tool declared an outputSchema
    return {
      ok: true as const,
      content: result.content,
      structuredContent: result.structuredContent,
    };
  } catch (err) {
    if (err instanceof ProtocolError) {
      return {
        ok: false as const,
        kind: 'protocol-error' as const,
        code: err.code,
        message: err.message,
      };
    }
    if (err instanceof SdkError) {
      return {
        ok: false as const,
        kind: 'sdk-error' as const,
        code: err.code,
        message: err.message,
        timedOut: err.code === SdkErrorCode.RequestTimeout,
      };
    }
    throw err;
  }
}
```

Handling only `isError` misses timeouts, disconnects, and protocol failures. Handling only thrown errors misses tool-reported failures. **Both paths are required.**

### Common SDK error codes

| Code                                  | Meaning                                    |
| ------------------------------------- | ------------------------------------------ |
| `SdkErrorCode.RequestTimeout`         | Request exceeded its timeout               |
| `SdkErrorCode.ConnectionClosed`       | Transport closed before reply              |
| `SdkErrorCode.CapabilityNotSupported` | Used a feature the server didn't advertise |

### Common ProtocolError codes

JSON-RPC standard codes — invalid params, method not found, internal error, etc. Inspect `error.code` to branch.

## Reading resources

```ts
const { contents } = await client.readResource({ uri: 'config://app' });
for (const item of contents) {
  if ('text' in item) {
    console.log(item.text);
  } else if ('blob' in item) {
    // base64 binary
  }
}
```

Preserve `uri` and `mimeType` when piping to model context. Treat resource content as **untrusted** — they're data, not instructions.

### Resource subscriptions

```ts
await client.subscribeResource({ uri: 'config://app' });

client.setNotificationHandler('notifications/resources/updated', async (n) => {
  if (n.params.uri === 'config://app') {
    const { contents } = await client.readResource({ uri: 'config://app' });
    // re-read; the notification doesn't include the new value
  }
});
```

The notification only signals "it changed" — always re-read.

## Prompts

```ts
const { messages } = await client.getPrompt({
  name: 'review-code',
  arguments: { code: 'console.log("hi")', language: 'typescript' },
});

// messages is PromptMessage[] — feed into your model
```

Prompts are templates. App-level safety still takes priority — don't auto-send a prompt you got from a server without policy checks.

## Argument completion

```ts
const { completion } = await client.complete({
  ref: { type: 'ref/prompt', name: 'review-code' },
  argument: { name: 'language', value: 'type' },
});

// completion.values: ['typescript', ...]
```

Use for autocomplete UIs. Resource templates support the same shape with `ref/resource`.

## Server-initiated requests

The server can ask the client for things during tool execution. Register handlers for the capabilities you advertised:

### Sampling — server asks for an LLM completion

```ts
client.setRequestHandler('sampling/createMessage', async (request) => {
  const lastMessage = request.params.messages.at(-1);
  // Route through your normal LLM provider
  const response = await myLLM.complete({ messages: request.params.messages });
  return {
    model: 'my-model',
    role: 'assistant' as const,
    content: { type: 'text' as const, text: response.text },
    stopReason: 'endTurn' as const,
  };
});
```

Apply the same policy/cost/safety layer you use for normal completions. Sampling can be expensive — set token and recursion limits.

### Elicitation — server asks for user input

```ts
client.setRequestHandler('elicitation/create', async (request) => {
  if (request.params.mode === 'form') {
    // Show request.params.requestedSchema as a form to the user
    const userInput = await showFormUI(request.params.message, request.params.requestedSchema);
    return userInput
      ? { action: 'accept' as const, content: userInput }
      : { action: 'decline' as const };
  }
  if (request.params.mode === 'url') {
    // Open request.params.url in a browser; wait for completion
    await openUrl(request.params.url);
    return { action: 'accept' as const };
  }
  return { action: 'decline' as const };
});
```

**Never fabricate user approval.** Always actually ask.

### Roots — server asks what filesystem paths are in scope

```ts
client.setRequestHandler('roots/list', async () => ({
  roots: [
    { uri: 'file:///home/user/projects/my-app', name: 'My App' },
    { uri: 'file:///home/user/data', name: 'Data' },
  ],
}));

// When roots change:
await client.sendRootsListChanged();
```

**Expose narrow roots.** Don't grant the whole home directory by default — least privilege matters when the server can list and read files.

## Notifications

### Automatic list-change tracking

Pass `listChanged` to `ClientOptions` to let the SDK debounce, refresh, and call you back:

```ts
const client = new Client(
  { name: 'my-client', version: '1.0.0' },
  {
    listChanged: {
      tools: {
        onChanged: (err, tools) => {
          /* ... */
        },
      },
      prompts: {
        onChanged: (err, prompts) => {
          /* ... */
        },
      },
      resources: {
        onChanged: (err, resources) => {
          /* ... */
        },
      },
    },
  },
);
```

### Manual handler

```ts
client.setNotificationHandler('notifications/message', (n) => {
  console.log(`[${n.params.level}]`, n.params.data);
});

await client.setLoggingLevel('warning');
```

**Don't use both** automatic `listChanged` and `setNotificationHandler('notifications/tools/list_changed', ...)` for the same notification — the manual handler overwrites the automatic one.

## Lifecycle event handlers

```ts
client.onerror = (err) => console.error('[transport]', err.message);
client.onclose = () => console.log('[connection closed]');
```

`onerror` catches out-of-band transport errors (parse failures, disconnects). `onclose` fires when the connection drops. Pending requests reject after close.

## Timeouts and cancellation

```ts
const result = await client.callTool(
  { name: 'slow-task', arguments: {} },
  {
    timeout: 120_000, // override default 60s
    signal: abortController.signal, // explicit cancellation
    onprogress: (p) => {
      /* ... */
    },
    resetTimeoutOnProgress: true, // each progress notif resets timeout
    maxTotalTimeout: 600_000, // hard ceiling
  },
);
```

For UI-driven flows, prefer short timeouts. For known-slow tools, combine `resetTimeoutOnProgress` + `maxTotalTimeout` so a hung server can't keep the request alive forever.

## Authentication

### Bearer token (simplest)

```ts
const authProvider: AuthProvider = {
  token: async () => getStoredToken(),
  onUnauthorized: async () => {
    await tokenStore.refresh();
  },
};

const transport = new StreamableHTTPClientTransport(url, { authProvider });
```

`token()` is called before every request. If `onUnauthorized` is provided, the transport retries once after a 401.

### Client credentials (service-to-service)

```ts
const authProvider = new ClientCredentialsProvider({
  clientId: 'my-service',
  clientSecret: 'my-secret',
});
```

Standard OAuth `client_credentials` grant with `client_secret_basic`.

### Private-key JWT (no shared secret)

```ts
const authProvider = new PrivateKeyJwtProvider({
  clientId: 'my-service',
  privateKey: pemEncodedKey,
  algorithm: 'RS256',
});
```

Preferred over shared client secrets when the runtime can hold a key.

### Full OAuth user authorization

Implement `OAuthClientProvider` — owns client metadata, redirect URL, PKCE, token persistence, dynamic registration. Flow:

```ts
try {
  await client.connect(transport);
} catch (err) {
  // On authorization-required:
  // 1. Open authorization URL in browser
  // 2. Capture authorization code from redirect
  // 3. Finish auth and reconnect
  await transport.finishAuth(authorizationCode);
  await client.connect(transport);
}
```

### Cross-App Access (enterprise IdP)

`CrossAppAccessProvider` — exchanges an enterprise IdP ID token for an MCP server access token. Use when the user authenticated with an enterprise SSO and the client is acting on their behalf:

```ts
const authProvider = new CrossAppAccessProvider({
  assertion: async (ctx) => {
    const result = await discoverAndRequestJwtAuthGrant({
      idpUrl: 'https://idp.example.com',
      audience: ctx.authorizationServerUrl,
      resource: ctx.resourceUrl,
      idToken: await getIdToken(),
      clientId: 'my-idp-client',
      clientSecret: 'my-idp-secret',
      scope: ctx.scope,
      fetchFn: ctx.fetchFn,
    });
    return result.jwtAuthGrant;
  },
  clientId: 'my-mcp-client',
  clientSecret: 'my-mcp-secret',
});
```

### Auth rules

- Store tokens **per user/session/server**. Don't cross-pollinate.
- Never log bearer tokens, refresh tokens, authorization codes, or client secrets.
- Use HTTPS for remote servers, always.
- Prefer private-key JWT or managed identity over long-lived shared secrets.

## Middleware (wrapping fetch)

```ts
const addCorrelationId = createMiddleware(async (next, input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('X-Correlation-Id', crypto.randomUUID());
  return next(input, { ...init, headers });
});

const transport = new StreamableHTTPClientTransport(url, {
  fetch: applyMiddlewares(addCorrelationId)(fetch),
});
```

Use middleware for: custom headers, correlation IDs, retries (idempotent only), structured logging. **Don't smuggle credentials into arbitrary URLs** — scope middleware to the target server.

## Stream resumption

For long SSE streams that need to survive reconnects:

```ts
let lastToken: string | undefined;

const result = await client.request(
  { method: 'tools/call', params: { name: 'long-task', arguments: {} } },
  {
    resumptionToken: lastToken,
    onresumptiontoken: (token) => {
      lastToken = token;
      // Persist if the process may restart
    },
  },
);
```

Or at the transport level:

```ts
await transport.resumeStream(lastEventId, {
  onresumptiontoken: (token) => {
    lastToken = token;
  },
});
```

When reconnecting after a process restart, recreate the transport with the same negotiated protocol version (`client.getNegotiatedProtocolVersion()`).

## Experimental tasks

Mark as experimental — APIs may change.

```ts
const stream = client.experimental.tasks.callToolStream({
  name: 'long-running-tool',
  arguments: {},
});

for await (const message of stream) {
  switch (message.type) {
    case 'taskCreated':
      console.log('started:', message.task.taskId);
      break;
    case 'taskStatus':
      console.log('status:', message.task.status);
      break;
    case 'result':
      console.log('result:', message.result);
      break;
    case 'error':
      console.error('error:', message.error);
      break;
  }
}
```

Other task methods:

```ts
await client.experimental.tasks.getTask(taskId);
await client.experimental.tasks.getTaskResult(taskId);
await client.experimental.tasks.listTasks();
await client.experimental.tasks.cancelTask(taskId);
```

Persist task IDs if the client may reconnect. Respect `pollInterval`. Always handle `failed` and `cancelled` terminal states.

## Reusable client wrapper pattern

Centralize connect, discovery, safe call, and shutdown:

```ts
export async function createMcpClient(target: { type: 'stdio' | 'http'; ... }) {
  const client = new Client({ name: 'wrapper', version: '1.0.0' }, {
    capabilities: { roots: {}, sampling: {}, elicitation: { form: {} } },
  });

  client.onerror = (e) => console.error('[mcp]', e.message);
  client.onclose = () => console.info('[mcp] closed');

  const transport = await createTransport(target, client);

  return {
    client,
    transport,
    async listAllTools() { /* paginate */ },
    async callToolSafely(name, args) { /* dual error handling */ },
    async close() {
      if (transport instanceof StreamableHTTPClientTransport) {
        try { await transport.terminateSession(); } catch {}
      }
      await client.close();
    },
  };
}
```

Wrapping isolates SDK changes — when v2 stabilizes or signatures shift, you only fix the wrapper.

## Agent loop with MCP tools

Standard structure:

1. Connect to servers, read instructions, discover tools (paginated).
2. Convert tool input schemas into your model's tool/function format.
3. Send messages + tools to the model.
4. If model requests a tool call:
   - Validate tool exists.
   - Validate args (server schema is authoritative).
   - Apply local policy / user approval.
   - Execute via `callToolSafely`.
   - Return result to model.
5. Loop until model returns a normal final message.
6. Close clients.

### Guardrails

- Server instructions are **context**, not absolute authority. Your safety/policy layer is higher priority.
- Tool descriptions and outputs are **untrusted text**. Don't let them override system prompts.
- Don't auto-approve destructive tools unless your product explicitly allows it and the user has configured that policy.
- Filesystem roots: least privilege. Don't expose `~` by default.
- Authentication tokens must not be exposed to the model.

## Common client pitfalls

- Handling only `isError` and missing thrown errors (timeouts, disconnects).
- Handling only thrown errors and missing tool-reported `isError: true`.
- Not paginating list calls — silently truncated results.
- Auto-approving tool calls without policy checks.
- Treating server instructions or tool descriptions as trusted authority.
- Logging tokens, secrets, or sensitive tool args.
- Forgetting `terminateSession()` for Streamable HTTP — leaks server-side session.
- Mixing `listChanged` automatic and manual notification handlers for the same method.
- Calling `transport.start()` manually (already done by `client.connect`).
- Granting overly-broad filesystem roots.
- Persisting the same OAuth tokens across users/sessions.
