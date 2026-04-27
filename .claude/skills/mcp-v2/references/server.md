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

`McpServer` is the high-level surface — use it by default. The lower-level `Server` class is only needed when you must intercept raw JSON-RPC.

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

  ctx.http?.req;                // raw HTTP request (HTTP transports only)
  ctx.http?.closeSSE();         // close the SSE channel for resumability tests

  ctx.task?.store;              // task store, when the call is task-aware
};
```

`ctx.http` and `ctx.task` are optional — guard with `?.` and feature-detect.

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
});

await server.connect(transport);

// Hono example:
app.all('/mcp', async (c) => transport.handleRequest(c.req.raw));
```

### Stateful vs stateless

| Mode      | When                                            | Key rule                                                  |
| --------- | ----------------------------------------------- | --------------------------------------------------------- |
| Stateful  | Long sessions, resumable streams, subscriptions | Set `sessionIdGenerator`, persist session state           |
| Stateless | Serverless, horizontally scaled                 | Omit `sessionIdGenerator`, use `enableJsonResponse: true` |

In stateless mode, do not rely on `mcp-session-id` headers — they don't exist. Don't attempt resource subscriptions.

## Tasks (long-running and interactive work)

Tasks let a tool return immediately and continue work in the background. Clients poll or stream task updates.

### Server setup

```ts
const taskStore = new InMemoryTaskStore();
const taskQueue = new InMemoryTaskMessageQueue();

const server = new McpServer(
  { name: 'my-server', version: '1.0.0' },
  {
    capabilities: {
      tasks: {
        requests: { tools: { call: {} } },
        taskStore,
        taskMessageQueue: taskQueue,
      },
    },
  },
);
```

`InMemoryTaskStore` is for development. Production needs durable storage.

### Task-aware tool

The tool body works like a normal tool — the SDK handles task lifecycle automatically when the caller opts in via `task` parameters on `tools/call`. Inside the handler:

```ts
async (args, ctx): Promise<CallToolResult> => {
  // Update status (only meaningful when called as a task)
  if (ctx.task) {
    await ctx.task.updateStatus({ status: 'working', statusMessage: 'Stage 1' });
    // ...later...
    await ctx.task.updateStatus({ status: 'working', statusMessage: 'Stage 2' });
  }

  // Returning a result automatically transitions the task to `completed`
  return { content: [{ type: 'text', text: 'done' }], structuredContent: {...} };
};
```

Status values: `working`, `input_required`, `completed` (terminal), `failed` (terminal), `cancelled` (terminal).

### Critical task rule

Queued task **messages** (sent via the task message queue) and the terminal task **result** are different things. Don't conflate them — clients fetch them with separate methods (`tasks/get`, `tasks/result`).

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
const result = await ctx.mcpReq.elicitInput({
  mode: 'url',
  message: 'Please complete payment in the browser',
  url: 'https://checkout.example.com/session/xyz',
  elicitationId: 'payment-session-xyz',
});
```

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

console.log(result.content);
```

Only works if the client advertised `sampling: {}` capability. Use sampling when:

- The server genuinely benefits from LLM participation
- The client is the right place for model choice and approval
- Graceful degradation is OK if unsupported

Don't make sampling load-bearing for non-LLM clients.

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
import { InMemoryEventStore } from './inMemoryEventStore.js';

// example impl in SDK examples

const transport = new NodeStreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  eventStore: new InMemoryEventStore(),
});
```

Clients reconnect with `Last-Event-ID`. The transport replays events from the store. Production needs durable event storage.

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

- `console.log` in stdio code corrupts JSON-RPC. Always stderr or MCP logging.
- Forgetting `content` when returning `structuredContent` breaks legacy clients.
- Loose `z.object(...)` lets typos through at the boundary.
- Marking a destructive tool as `readOnlyHint: true`.
- Throwing on tool runtime failures — use `isError: true`.
- Sending progress notifications without checking for a `progressToken`.
- Mixing v1 imports (`@modelcontextprotocol/sdk/...`) into a v2 codebase.
- Using `StreamableHTTPServerTransport` (v1) when you should use `NodeStreamableHTTPServerTransport` (v2).
- Putting `requestedSchema` (elicitation) in Zod — it's raw JSON Schema.
- Treating queued task messages as the task result.
