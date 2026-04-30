# MCP v2 Server Reference

Read this when working on an MCP **server** in TypeScript with `@modelcontextprotocol/server`. Patterns here assume you've already confirmed v2 (see SKILL.md Step 1).

## Imports cheat sheet

```ts
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import {
  completable,
  fromJsonSchema,
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
  StdioServerTransport,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';
```

`McpServer` is the high-level surface — use it by default. The lower-level `Server` class is `@deprecated` and only needed when you must intercept raw JSON-RPC that `McpServer` doesn't expose.

## Bootstrap shape

A healthy bootstrap separates server construction, registration, and transport:

```ts
const server = new McpServer(
  { name: 'my-server', version: '1.0.0', title: 'My Server' },
  {
    capabilities: {
      logging: {},
      prompts: {},
      resources: { listChanged: true, subscribe: true },
      tools: { listChanged: true },
    },
    instructions: 'Use this server to look up weather and schedule reminders.',
  },
);

registerTools(server);
registerPrompts(server);
registerResources(server);

await server.connect(new StdioServerTransport());
```

Rules:

- Declare capabilities **before** `connect()`. Capability negotiation runs during `initialize`.
- Register tools/prompts/resources before `connect()` if they're static.
- Use `instructions` to give the client/model durable context that should be in the system prompt. Keep it short — it's added to context every conversation.

### Useful `ServerOptions` / `ProtocolOptions` knobs

| Option                         | When to use                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `enforceStrictCapabilities`    | Set to `true` to reject outbound requests the peer didn't advertise. Defaults to `false` for back-compat.                 |
| `debouncedNotificationMethods` | Coalesce noisy notifications fired in the same tick (e.g. `['notifications/tools/list_changed']`).                        |
| `tasks: TaskManagerOptions`    | Wires the `TaskManager`. Provide `taskStore`, `taskMessageQueue`, optional `defaultTaskPollInterval`, `maxTaskQueueSize`. |
| `instructions`                 | One-time system-level guidance the client surfaces to the model.                                                          |

### Useful `RequestOptions` knobs (for outbound `ctx.mcpReq.send` / sampling / elicitation)

| Option                   | Effect                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `timeout`                | Per-request timeout. Defaults to `DEFAULT_REQUEST_TIMEOUT_MSEC` (60s). Throws `SdkError(SdkErrorCode.RequestTimeout)`.       |
| `resetTimeoutOnProgress` | If `true`, each progress notification resets the timeout. Pair with `maxTotalTimeout` to keep an absolute cap.               |
| `maxTotalTimeout`        | Hard ceiling regardless of progress activity.                                                                                |
| `signal`                 | Caller-side `AbortSignal`. Pass `ctx.mcpReq.signal` through to forward inbound cancellation.                                 |
| `task`                   | Augment a request with `TaskCreationParams` to make a request task-aware (sampling, elicitation, sub-tool calls).            |
| `relatedTask`            | Tag this request as related to an existing task — surfaced in `_meta` for transport correlation.                             |
| `onprogress`             | Stream progress notifications back. Continues firing during task-augmented requests until the task reaches a terminal state. |

## Tools

### Standard registration

```ts
server.registerTool(
  'tool-name',
  {
    title: 'Human-Readable Title', // shown in UIs
    description: 'What this tool does', // sent to the model
    inputSchema: InputSchema, // Standard Schema
    outputSchema: OutputSchema, // optional, but strongly preferred
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async (args, ctx): Promise<CallToolResult> => {
    // ...
    return {
      content: [{ type: 'text', text: 'human-readable' }],
      structuredContent: {
        /* matches OutputSchema */
      },
    };
  },
);
```

### Annotation semantics

| Annotation        | Meaning                                 |
| ----------------- | --------------------------------------- |
| `readOnlyHint`    | No side effects                         |
| `idempotentHint`  | Same input → same effect                |
| `destructiveHint` | May mutate or delete important state    |
| `openWorldHint`   | Reaches the network or external systems |

Annotations are hints for clients to gate behavior (auto-approval, prompting, etc.). Be honest — marking a destructive tool `readOnlyHint: true` will cause incidents.

### The `ctx` object (v2 grouped context)

```ts
async (args, ctx) => {
  ctx.mcpReq.signal;            // AbortSignal — bail out if cancelled
  ctx.mcpReq._meta;             // protocol metadata (incl. progressToken)
  ctx.mcpReq.notify({ ... });   // send a notification
  ctx.mcpReq.elicitInput({ ... });   // request user input via the client
  ctx.mcpReq.requestSampling({ ... }); // request an LLM completion via the client

  // ctx.mcpReq.send<M>(request, options) is method-typed: the result is inferred
  // from `ResultTypeMap[M]`. Use this for related sub-requests so the transport
  // can correlate them with the inbound request.
  const { roots } = await ctx.mcpReq.send({ method: 'roots/list' });

  ctx.http?.req;                // raw HTTP request (HTTP transports only)
  ctx.http?.closeSSE();         // close the SSE channel for resumability tests

  ctx.task?.store;              // task store, when the call is task-aware
};
```

`ctx.http` and `ctx.task` are optional — guard with `?.` and feature-detect. `ctx.mcpReq.send` and `ctx.mcpReq.notify` route through the same request lifecycle as the inbound call, so cancellation and `relatedRequestId` are wired automatically.

### Discriminated unions for modeful tools

When a tool has multiple modes, use a discriminated union — not one giant object full of unrelated optionals:

```ts
const SearchInputSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('query'),
    query: z.string().min(1),
    includeSnippets: z.boolean().default(true),
  }),
  z.strictObject({
    mode: z.literal('url'),
    urls: z.array(z.httpUrl()).min(1).max(20),
    question: z.string().min(1),
  }),
]);
```

This catches mode-specific field misuse at validation time.

### Progress notifications

Long-running tools should report progress when the caller asked for it:

```ts
async (args, ctx) => {
  const token = ctx.mcpReq._meta?.progressToken;
  for (let i = 0; i < items.length; i++) {
    await processItem(items[i]);
    if (token !== undefined) {
      await ctx.mcpReq.notify({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress: i + 1,
          total: items.length,
          message: `Processed ${items[i].name}`,
        },
      });
    }
  }
  // ...
};
```

Only emit progress when a token exists. Without one, the client did not opt in.

### Logging from tools

Use MCP logging — never `console.log` (it corrupts stdio):

```ts
async (args, ctx) => {
  // Shorthand (preferred): log(level, data, logger?)
  await ctx.mcpReq.log('info', 'starting work', 'my-tool');

  // Equivalent long form:
  await ctx.mcpReq.notify({
    method: 'notifications/message',
    params: { level: 'info', logger: 'my-tool', data: 'starting work' },
  });
};
```

### Tool error model

| Situation                                          | Mechanism                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| Upstream API returned 5xx, file missing, etc.      | Return `{ content, isError: true }`                              |
| Caller passed nonsensical args (after schema pass) | Return `{ content, isError: true }`                              |
| Schema rejected input                              | SDK throws automatically — don't swallow it                      |
| Method genuinely unsupported / wiring broken       | `throw new ProtocolError(ProtocolErrorCode.X, ...)`              |
| Capability not advertised but used                 | `throw new ProtocolError(ProtocolErrorCode.MethodNotFound, ...)` |

Use `isError: true` for everything the **model** should see and react to. Throw protocol errors only for real protocol-level wiring failures.

## Prompts

```ts
import { completable } from '@modelcontextprotocol/server';

server.registerPrompt(
  'review-code',
  {
    title: 'Code Review',
    description: 'Review code for likely bugs and style issues',
    argsSchema: z.strictObject({
      code: z.string().min(1),
      language: completable(z.string().optional(), (v) =>
        ['typescript', 'python', 'go'].filter((l) => l.startsWith((v ?? '').toLowerCase())),
      ),
    }),
  },
  ({ code, language }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Review this${language ? ' ' + language : ''} code:\n\n${code}`,
        },
      },
    ],
  }),
);
```

Prompts return `{ messages: PromptMessage[] }`. Each message has `role` and `content` — content can be text, image, audio, resource link, or embedded resource.

Use `completable()` for any argument with a small finite set of likely values. The completion runs as the user types.

## Resources

### Static (fixed URI)

```ts
server.registerResource(
  'app-config',
  'config://app',
  { title: 'App Config', mimeType: 'application/json' },
  async (uri) => ({
    contents: [{ uri: uri.href, text: JSON.stringify({ theme: 'light' }) }],
  }),
);
```

### Templated (parameterized URI)

```ts
server.registerResource(
  'session-detail',
  new ResourceTemplate('sessions://{sessionId}', {
    list: () => ({ resources: listSessions() }),
    complete: { sessionId: completeSessionIds },
  }),
  { title: 'Session', mimeType: 'application/json' },
  async (uri, { sessionId }) => ({
    contents: [{ uri: uri.href, text: JSON.stringify(await getSession(sessionId)) }],
  }),
);
```

Use `ResourceTemplate` whenever URIs are parameterized. Add `list` so resources are discoverable; add `complete` so URI variables get autocomplete.

### Subscriptions and change notifications

When backing state can change, declare `resources: { subscribe: true, listChanged: true }` and emit:

```ts
server.server.sendResourceUpdated({ uri: 'config://app' });
server.server.sendResourceListChanged();
```

Clients re-read on `notifications/resources/updated` — don't try to attach the new value to the notification.

## Transports

### Stdio (local CLI / editor integrations)

```ts
import { StdioServerTransport } from '@modelcontextprotocol/server';

await server.connect(new StdioServerTransport());
```

**Critical**: `console.log` writes to stdout, which is the JSON-RPC channel. Use `console.error` (stderr) or MCP logging for diagnostics.

### Streamable HTTP (Node + Express)

```ts
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';

import { randomUUID } from 'node:crypto';

const app = createMcpExpressApp({
  host: '127.0.0.1',
  allowedHosts: ['127.0.0.1', 'localhost'],
});

const transport = new NodeStreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(), // stateful
  // sessionIdGenerator: undefined,        // stateless
  // enableJsonResponse: true,             // POST-only JSON, no SSE
});

app.all('/mcp', async (req, res) => transport.handleRequest(req, res, req.body));
await server.connect(transport);
```

`createMcpExpressApp()` handles host validation, DNS rebinding protection, CORS for MCP headers. Use it instead of bare `express()` for production servers.

### Streamable HTTP (web-standard runtimes — Hono, Bun, Deno, Workers)

```ts
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
  // eventStore: myEventStore, // optional — enables SSE resumability
});

await server.connect(transport);

// Hono example:
app.all('/mcp', async (c) => transport.handleRequest(c.req.raw));

// Cloudflare Workers example:
export default {
  async fetch(request: Request): Promise<Response> {
    return transport.handleRequest(request);
  },
};
```

**DNS rebinding protection on `WebStandardStreamableHTTPServerTransport`:** The `allowedHosts`, `allowedOrigins`, and `enableDnsRebindingProtection` options on this transport are `@deprecated`. Use external middleware (a custom fetch wrapper, Hono middleware, or a WAF) to validate the `Host` header instead. The standalone helpers `validateHostHeader`, `localhostAllowedHostnames`, and `hostHeaderValidationResponse` are exported from `@modelcontextprotocol/server` for building your own middleware.

### Stateful vs stateless

| Mode      | When                                            | Key rule                                                  |
| --------- | ----------------------------------------------- | --------------------------------------------------------- |
| Stateful  | Long sessions, resumable streams, subscriptions | Set `sessionIdGenerator`, persist session state           |
| Stateless | Serverless, horizontally scaled                 | Omit `sessionIdGenerator`, use `enableJsonResponse: true` |

In stateless mode, do not rely on `mcp-session-id` headers — they don't exist. Don't attempt resource subscriptions.

### Transport lifecycle hooks

Track session creation and destruction for per-session resource management:

```ts
const transport = new NodeStreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  onsessioninitialized: async (sessionId) => {
    sessionRegistry.set(sessionId, { createdAt: Date.now() });
  },
  onsessionclosed: async (sessionId) => {
    await cleanupSessionResources(sessionId);
    sessionRegistry.delete(sessionId);
  },
});
```

`onsessionclosed` fires when the server closes a session (client sent `DELETE /mcp`). This is distinct from transport closure — in per-request transport setups the transport may close before the logical session does.

Non-streaming JSON responses (useful for simple request/response deployments):

```ts
const transport = new NodeStreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true, // wait for all responses, return JSON — no SSE opened
});
```

SSE reconnect interval for polling patterns:

```ts
const transport = new NodeStreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  retryInterval: 1_000, // SSE retry header sent to client (ms)
  eventStore: new InMemoryEventStore(), // required for resumable streams
});
```

Pair `retryInterval` with `ctx.http?.closeSSE()` inside a tool to explicitly close the SSE stream and let the client reconnect. Useful for long-polling patterns where work produces chunks across reconnects.

## Tasks (long-running and interactive work)

Tasks let a tool return a task ID immediately while work continues in the background. Clients poll for status and fetch the result separately.

### Server setup (required for both approaches)

```ts
import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
  McpServer,
} from '@modelcontextprotocol/server';

const taskStore = new InMemoryTaskStore();

const server = new McpServer(
  { name: 'my-server', version: '1.0.0' },
  {
    capabilities: {
      tasks: {
        requests: { tools: { call: {} } },
        taskStore,
        taskMessageQueue: new InMemoryTaskMessageQueue(),
      },
    },
  },
);
```

`InMemoryTaskStore` and `InMemoryTaskMessageQueue` are for development only. Production needs durable, persistent implementations.

### Approach A: `registerToolTask` — explicit background task (experimental)

Use when the tool must return a task ID immediately and continue work in the background after `tools/call` returns. Clients call `tasks/get` to poll status and `tasks/result` to fetch the final payload.

All three handlers are required:

```ts
server.experimental.tasks.registerToolTask(
  'analyze-large-dataset',
  {
    title: 'Analyze Large Dataset',
    description: 'Runs heavy analysis in the background.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    // execution.taskSupport defaults to 'required' for registerToolTask
  },
  {
    createTask: async (args, ctx) => {
      // Create the task record, fire background work, return immediately.
      const task = await ctx.task.store.createTask({ ttl: 300_000, pollInterval: 1_000 });
      void runBackground({ taskId: task.taskId, args, store: ctx.task.store });
      return { task };
    },

    getTask: async (_args, ctx) => {
      // Client polls this to check current status.
      return ctx.task.store.getTask(ctx.task.id);
    },

    getTaskResult: async (_args, ctx) => {
      // Client calls this once status is `completed`.
      return ctx.task.store.getTaskResult(ctx.task.id);
    },
  },
);
```

Background worker pattern — catch all errors, always reach a terminal state:

```ts
async function runBackground({
  taskId,
  args,
  store,
}: {
  taskId: string;
  args: z.infer<typeof InputSchema>;
  store: typeof taskStore;
}) {
  try {
    await store.updateTaskStatus(taskId, 'working', 'Initializing');
    const result = await doHeavyWork(args);
    const structured = OutputSchema.parse(result);
    // storeTaskResult takes the terminal status as the second arg and atomically
    // stores the result + transitions the task. Do NOT call updateTaskStatus('completed')
    // afterwards — storeTaskResult already did it.
    await store.storeTaskResult(taskId, 'completed', {
      content: [{ type: 'text', text: `Processed ${structured.itemCount} items` }],
      structuredContent: structured,
    });
  } catch {
    // Never expose stack traces, file paths, or secrets in statusMessage.
    // Either updateTaskStatus('failed', msg) OR storeTaskResult(id, 'failed', errResult) — not both.
    await store.updateTaskStatus(taskId, 'failed', 'Processing failed');
  }
}
```

Rules:

- `createTask` must return `{ task }` immediately — never `await` background work inside it. Use `void`.
- Background workers must catch all errors and set `failed` status. Unhandled errors leave tasks permanently in `working`.
- `statusMessage` must not contain stack traces, file paths, internal error messages, or secrets.
- Task IDs from `store.createTask()` are generated by the store and are already secure/unique.
- Terminal states: `completed`, `failed`, `cancelled`. Non-terminal: `working`, `input_required`.
- Clients fetch status and result via separate calls (`tasks/get`, `tasks/result`) — don't conflate them.

### `RequestTaskStore` API surface (the only methods you should call)

`ctx.task.store` is a request-scoped `RequestTaskStore`, not the raw `TaskStore`. The methods are:

| Method                                                  | Use for                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `createTask(taskParams)`                                | Allocates a `taskId` + `createdAt`. Call once in `createTask`.                      |
| `getTask(taskId)`                                       | Reads current `Task` (status, message). Used in `getTask` handler.                  |
| `updateTaskStatus(taskId, status, statusMessage?)`      | Transition `working` → `input_required` → `failed`/`cancelled` (no payload).        |
| `storeTaskResult(taskId, 'completed' \| 'failed', res)` | Atomically stores the result **and** flips status. Don't call updateTaskStatus too. |
| `getTaskResult(taskId)`                                 | Reads stored payload. Used in `getTaskResult` handler.                              |
| `listTasks(cursor?)`                                    | Paginates tasks. Rarely needed inside a tool.                                       |

**There is no `store.updateTask({...})` and no `store.setTaskResult(...)`** — those names don't exist in the SDK.

### Approach B: task-aware normal tool (status updates in-handler)

Use when the tool completes in one synchronous handler call but wants to report intermediate progress. The SDK manages the task lifecycle automatically when the client opts in.

```ts
server.registerTool(
  'process-batch',
  { inputSchema: InputSchema, outputSchema: OutputSchema },
  async (args, ctx): Promise<CallToolResult> => {
    // ctx.task is { id, store, requestedTtl } — there's no updateStatus shortcut.
    // Push status through ctx.task.store.updateTaskStatus(ctx.task.id, ...).
    if (ctx.task?.id) {
      await ctx.task.store.updateTaskStatus(ctx.task.id, 'working', 'Stage 1');
      await doStage1(args);
      await ctx.task.store.updateTaskStatus(ctx.task.id, 'working', 'Stage 2');
      await doStage2(args);
    } else {
      await doStage1(args);
      await doStage2(args);
    }
    // Returning a result automatically transitions the task to `completed`.
    const out = buildResult(args);
    return {
      content: [{ type: 'text', text: `Done` }],
      structuredContent: OutputSchema.parse(out),
    };
  },
);
```

Choose A when the tool genuinely needs to return before work finishes. Choose B when the tool can complete within a single handler invocation and just wants richer status reporting.

## Elicitation (asking the user for input mid-tool)

### Form mode (non-sensitive)

```ts
const result = await ctx.mcpReq.elicitInput({
  mode: 'form',
  message: 'Please confirm the deletion target:',
  requestedSchema: {
    type: 'object',
    properties: {
      confirm: { type: 'boolean', title: 'Confirm deletion' },
      reason: { type: 'string', title: 'Reason' },
    },
    required: ['confirm'],
  },
});

if (result.action !== 'accept' || !result.content?.confirm) {
  return { content: [{ type: 'text', text: 'Cancelled by user' }], isError: true };
}
```

`requestedSchema` is **raw JSON Schema** (not Zod). Spec restricts it to top-level primitives: string, number, boolean, enum, single/multi-select.

### URL mode (sensitive — auth, payment, etc.)

```ts
import { UrlElicitationRequiredError } from '@modelcontextprotocol/server';

try {
  const result = await ctx.mcpReq.elicitInput({
    mode: 'url',
    message: 'Please complete payment in the browser',
    url: 'https://checkout.example.com/session/xyz',
    elicitationId: 'payment-session-xyz',
  });
  if (result.action !== 'accept') {
    return { content: [{ type: 'text', text: 'Payment not completed' }], isError: true };
  }
} catch (err) {
  if (err instanceof UrlElicitationRequiredError) {
    // Client only supports form mode — URL elicitation not available
    return {
      content: [{ type: 'text', text: 'URL-based elicitation not supported by this client' }],
      isError: true,
    };
  }
  throw err;
}
```

`UrlElicitationRequiredError` is thrown when the client doesn't advertise support for URL-mode elicitation. Always catch it when using `mode: 'url'` and return a graceful `isError: true` result instead of letting the exception propagate.

Use URL mode when the input belongs in a real browser flow (OAuth consent, API key entry, payment).

### Result actions

`accept` — user provided input
`decline` — user declined this specific request
`cancel` — user cancelled the whole operation

Always handle all three.

## Sampling (asking the client to run an LLM completion)

```ts
const result = await ctx.mcpReq.requestSampling({
  messages: [{ role: 'user', content: { type: 'text', text: 'Summarize: ' + text } }],
  maxTokens: 500,
  modelPreferences: { intelligencePriority: 0.5, speedPriority: 0.5 },
});

// Use ctx.mcpReq.log (MCP logging) or console.error — never console.log in server code
await ctx.mcpReq.log('info', JSON.stringify(result.content));
```

Only works if the client advertised `sampling: {}` capability. Use sampling when:

- The server genuinely benefits from LLM participation
- The client is the right place for model choice and approval
- Graceful degradation is OK if unsupported

Don't make sampling load-bearing for non-LLM clients.

### Sampling with tools (`CreateMessageRequestParamsWithTools`)

When the request includes a `tools` array, the response type widens to `CreateMessageResultWithTools` and content can include `toolUse` blocks. Use this to delegate a single LLM-driven tool call back to the client without exposing your inner tools as MCP tools:

```ts
const result = await ctx.mcpReq.requestSampling({
  messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
  maxTokens: 1000,
  tools: [
    {
      name: 'lookup_record',
      description: 'Fetch a record by id',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  ],
  toolChoice: 'auto',
});

for (const block of result.content) {
  if (block.type === 'toolUse') {
    /* dispatch toolUse.name with toolUse.input */
  }
}
```

`tools[].inputSchema` is **raw JSON Schema**, not Zod. The MCP SDK does not validate tool-use blocks for you — validate `block.input` before dispatching.

## Roots (server requesting filesystem boundaries)

```ts
const { roots } = await server.server.listRoots();
// roots: [{ uri: 'file:///home/user/project', name: 'Project' }, ...]
```

Use roots to ask the client what filesystem paths are in-scope. Servers should respect roots when reading files. Clients with `roots: { listChanged: true }` will notify on changes.

## Structured output: keeping `outputSchema` and result aligned

```ts
const OutputSchema = z.strictObject({
  status: z.enum(['ok', 'error']),
  itemsProcessed: z.int().nonnegative(),
});

server.registerTool(
  'process',
  { inputSchema: InputSchema, outputSchema: OutputSchema },
  async (args) => {
    const raw = await doWork(args);
    const structured = OutputSchema.parse(raw); // validate before returning
    return {
      content: [{ type: 'text', text: `Processed ${structured.itemsProcessed} items` }],
      structuredContent: structured,
    };
  },
);
```

If `structuredContent` comes from an upstream/external source, **always** parse it through the output schema before returning. Drift between declared schema and actual payload is a contract violation.

## SSE resumability

For long-running streams that survive client reconnects:

```ts
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';

// InMemoryEventStore is not exported from the public SDK surface.
// Provide your own EventStore implementation (or a community package) for production.
// For development/testing, a minimal in-memory implementation:
class DevEventStore implements EventStore {
  private events = new Map<string, { streamId: string; message: JSONRPCMessage }>();
  private counter = 0;
  async storeEvent(streamId: string, message: JSONRPCMessage) {
    const eventId = String(++this.counter);
    this.events.set(eventId, { streamId, message });
    return eventId;
  }
  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (id: string, msg: JSONRPCMessage) => Promise<void> },
  ) {
    const after = Number(lastEventId);
    let lastStreamId = '';
    for (const [id, { streamId, message }] of this.events) {
      if (Number(id) > after) {
        await send(id, message);
        lastStreamId = streamId;
      }
    }
    return lastStreamId;
  }
}

const transport = new NodeStreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  eventStore: new DevEventStore(),
  retryInterval: 1_000, // ms — SSE retry hint sent to clients
});
```

Clients reconnect with `Last-Event-ID`. The transport calls `replayEventsAfter` to resend missed events. Production needs durable event storage. The `EventStore` interface is exported from `@modelcontextprotocol/server`.

## Schema source: when to use `fromJsonSchema(...)`

If the source of truth is JSON Schema (e.g., from an OpenAPI spec):

```ts
import { fromJsonSchema } from '@modelcontextprotocol/server';

const RawSchema = {
  type: 'object',
  properties: { query: { type: 'string', minLength: 1 } },
  required: ['query'],
  additionalProperties: false,
} as const;

server.registerTool('search', { inputSchema: fromJsonSchema(RawSchema) }, async ({ query }) => ({
  content: [{ type: 'text', text: `Searching: ${query}` }],
}));
```

Don't hand-translate JSON Schema to partial Zod. Use `fromJsonSchema(...)` so the SDK gets a real Standard Schema wrapper.

## Project structure that scales

A healthy split for non-trivial servers:

```text
src/
├── index.ts                  // entry, signal handling, transport dispatch
├── server.ts                 // createServerInstance(), capability declaration, registration
├── transport.ts              // HTTP/web-standard transport setup
├── config.ts                 // env-var parsing
├── tools/
│   ├── index.ts              // registerTools(server)
│   ├── tool-a.ts
│   └── tool-b.ts
├── prompts/
├── resources/
├── schemas/
│   ├── inputs.ts
│   ├── outputs.ts
│   └── shared.ts             // reusable field builders
├── lib/
│   ├── response.ts           // result helpers
│   ├── orchestration.ts      // upstream API config building
│   └── streaming.ts          // stream consumption helpers
└── public-contract.ts        // single source of truth for the public surface
```

Push registration logic out of `server.ts` into `tools/`, `prompts/`, `resources/`. Reuse schemas via shared field builders.

## Capability assertion

Don't blindly call `requestSampling()` or `elicitInput()`. Check first:

```ts
const caps = server.server.getClientCapabilities();
if (caps?.sampling) {
  await ctx.mcpReq.requestSampling({ ... });
} else {
  // graceful fallback
}
```

## Common server pitfalls

- `console.log` in stdio code corrupts JSON-RPC. Always stderr or MCP logging (`ctx.mcpReq.log(...)`).
- Forgetting `content` when returning `structuredContent` breaks legacy clients.
- Loose `z.object(...)` lets typos through at the boundary — use `z.strictObject(...)`.
- Marking a destructive tool as `readOnlyHint: true`.
- Throwing on tool runtime failures — use `isError: true`.
- Sending progress notifications without checking for a `progressToken`.
- Mixing v1 imports (`@modelcontextprotocol/sdk/...`) into a v2 codebase.
- Using `StreamableHTTPServerTransport` (v1) when you should use `NodeStreamableHTTPServerTransport` (v2).
- Using `new Server(...)` directly — `@deprecated`; use `McpServer`.
- Putting `requestedSchema` (elicitation) in Zod — it's raw JSON Schema.
- Not catching `UrlElicitationRequiredError` when calling `elicitInput({ mode: 'url', ... })`.
- Treating queued task messages as the task result.
- `await`-ing background work inside `createTask` — this blocks `tools/call`. Use `void background()` and return `{ task }` immediately.
- Missing `getTask` or `getTaskResult` handlers in `registerToolTask` — all three are required.
- Leaking `err.message` or `err.stack` into `statusMessage` — always use a safe generic message.
- Using `InMemoryTaskStore` in production — it's for development only; use durable storage.
- Using `allowedHosts`/`allowedOrigins`/`enableDnsRebindingProtection` on `WebStandardStreamableHTTPServerTransport` — deprecated; use external middleware.
- Importing from `@modelcontextprotocol/core` — internal package; use re-exports from `/server` or `/client`.
- Using `import { z } from 'zod'` (v3) instead of `import { z } from 'zod/v4'`.
