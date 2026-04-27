---
name: mcp-v2
description: Expert guidance for Model Context Protocol (MCP) v2 server and client development in TypeScript. Use this skill whenever the user is working in a codebase that imports from `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, `@modelcontextprotocol/node`, `@modelcontextprotocol/express`, or `@modelcontextprotocol/hono` — or when they mention MCP, McpServer, registering tools/prompts/resources, MCP transports (stdio, streamable HTTP, SSE), MCP authentication, MCP tasks/sampling/elicitation/roots, or migrating from the legacy `@modelcontextprotocol/sdk` package. Also trigger on calls like `registerTool`, `callTool`, `McpServer`, `Client.connect`, even if the user does not explicitly say "MCP v2". This skill prevents common v1-vs-v2 mistakes, enforces Standard Schema usage, and guides correct transport, error, and task design.
---

# MCP v2 Development Expert

The MCP TypeScript SDK split into multiple packages in v2. Code that mixes v1 and v2 imports, or follows v1 patterns inside a v2 codebase, will silently misbehave or fail to compile. This skill encodes the v2 contract and the most common pitfalls so changes match what the SDK actually expects.

## Step 1 — Detect the version before touching anything

Before adding code, identify the SDK version. The two are not interchangeable.

| Signal                                                                               | Version            |
| ------------------------------------------------------------------------------------ | ------------------ |
| Imports from `@modelcontextprotocol/server`, `/client`, `/node`, `/express`, `/hono` | **v2**             |
| Imports from `@modelcontextprotocol/sdk/...` (subpath imports)                       | **v1**             |
| `McpServer` from `@modelcontextprotocol/server`                                      | v2                 |
| `.tool(...)`, `.prompt(...)`, `.resource(...)` variadic helpers                      | v1                 |
| `registerTool(...)`, `registerPrompt(...)`, `registerResource(...)`                  | v2                 |
| `setRequestHandler(SCHEMA_CONST, handler)` (schema constant first arg)               | v1                 |
| `setRequestHandler("method/name", handler)` (string method)                          | v2                 |
| `StreamableHTTPServerTransport` (no `Node` prefix)                                   | v1                 |
| `NodeStreamableHTTPServerTransport` or `WebStandardStreamableHTTPServerTransport`    | v2                 |
| `StreamableHTTPError`                                                                | v1 (removed in v2) |
| `WebSocketClientTransport`                                                           | v1 (removed in v2) |
| `extra.signal`, `extra._meta`, `extra.sendNotification(...)` in handler args         | v1                 |
| Grouped context: `ctx.mcpReq`, `ctx.http`, `ctx.task`                                | v2                 |

**If you see v1 patterns in a v2 codebase, fix them as part of the work.** Do not silently mix the two — they share names but not types.

To confirm quickly:

```bash
grep -r "@modelcontextprotocol" package.json
```

## Step 2 — Are you in server code or client code?

| Working on…                                       | Read                                                           | Most-used imports                                                        |
| ------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| An MCP server (exposes tools, prompts, resources) | [references/server.md](references/server.md)                   | `McpServer`, `StdioServerTransport`, `NodeStreamableHTTPServerTransport` |
| An MCP client (consumes a server)                 | [references/client.md](references/client.md)                   | `Client`, `StdioClientTransport`, `StreamableHTTPClientTransport`        |
| Migrating v1 → v2                                 | [references/migration-v1-v2.md](references/migration-v1-v2.md) | —                                                                        |
| Schema/validation questions                       | [references/schemas.md](references/schemas.md)                 | `zod/v4`, `z.strictObject`, `fromJsonSchema`                             |

The full reference files are intentionally split — load only the one(s) you need.

## The v2 package map

```
@modelcontextprotocol/client    → MCP clients
@modelcontextprotocol/server    → MCP servers (McpServer, StdioServerTransport, WebStandardStreamableHTTPServerTransport)
@modelcontextprotocol/node      → NodeStreamableHTTPServerTransport (Node-specific HTTP)
@modelcontextprotocol/express   → createMcpExpressApp() helper for Express integrations
@modelcontextprotocol/hono      → Hono integration helpers
```

Rule: never import client code from `/server` or vice versa. Never import anything from `@modelcontextprotocol/sdk` in v2 code.

## Server: the registration patterns you'll use 95% of the time

### Tool with input + output schema (the strong default)

```ts
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

const InputSchema = z.strictObject({
  city: z.string().describe('City name'),
});

const OutputSchema = z.strictObject({
  temperatureC: z.number().describe('Temperature in Celsius'),
  conditions: z.enum(['sunny', 'cloudy', 'rainy']).describe('Weather conditions'),
});

server.registerTool(
  'get-weather',
  {
    title: 'Get Weather',
    description: 'Look up current weather for a city',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ city }): Promise<CallToolResult> => {
    const data = await fetchWeather(city);
    const structured = OutputSchema.parse(data);
    return {
      content: [
        { type: 'text', text: `${city}: ${structured.temperatureC}°C, ${structured.conditions}` },
      ],
      structuredContent: structured,
    };
  },
);
```

Non-negotiables:

- Use `z.strictObject(...)` at external boundaries — `z.object(...)` silently strips unknown keys.
- Add `outputSchema` whenever clients should be able to consume results programmatically.
- Always include a `content` array even when `structuredContent` is present — clients without structured-content support fall back to `content`.
- Use `.describe(...)` on every model-facing field; descriptions are sent to clients.

### Tool error model — `isError: true` vs throw

Two failure surfaces, kept distinct:

```ts
// Tool runtime failure → return a result with isError: true
return {
  content: [{ type: 'text', text: 'Upstream timeout after 30s' }],
  isError: true,
};

// Protocol failure → throw (let the SDK surface a JSON-RPC error)
throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Missing required field');
```

`isError: true` is for "the tool ran and reported a problem the model/user should see." Throwing is for "the request was malformed or the server is wired wrong." Don't throw on ordinary tool failures — clients handle those two paths very differently.

### Prompt with completable args

```ts
import { completable } from '@modelcontextprotocol/server';

server.registerPrompt(
  'review-code',
  {
    title: 'Code Review',
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

### Static resource

```ts
server.registerResource(
  'app-config',
  'config://app',
  { title: 'App Configuration', mimeType: 'application/json' },
  async (uri) => ({
    contents: [{ uri: uri.href, text: JSON.stringify({ theme: 'light' }) }],
  }),
);
```

### Templated resource

```ts
import { ResourceTemplate } from '@modelcontextprotocol/server';

server.registerResource(
  'session-detail',
  new ResourceTemplate('sessions://{sessionId}', {
    list: () => ({ resources: listSessions() }),
    complete: { sessionId: completeSessionIds },
  }),
  { title: 'Chat Session', mimeType: 'application/json' },
  async (uri, { sessionId }) => ({
    contents: [{ uri: uri.href, text: JSON.stringify(await getSession(sessionId)) }],
  }),
);
```

### Bootstrap, stdio

```ts
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';

const server = new McpServer(
  { name: 'my-server', version: '1.0.0' },
  { capabilities: { logging: {}, prompts: {}, resources: { listChanged: true } } },
);

registerTools(server);
registerPrompts(server);
registerResources(server);

await server.connect(new StdioServerTransport());
```

### Bootstrap, Streamable HTTP (Node + Express)

```ts
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';

import { randomUUID } from 'node:crypto';

const app = createMcpExpressApp({ host: '127.0.0.1' });
const transport = new NodeStreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(), // omit / undefined for stateless
});
app.all('/mcp', async (req, res) => transport.handleRequest(req, res, req.body));
await server.connect(transport);
```

For more — tasks, elicitation, sampling, web-standard runtimes, JSON response mode, SSE resumability — read [references/server.md](references/server.md).

## Client: the patterns you'll use 95% of the time

### Connect via stdio (local server as child process)

```ts
import { Client, StdioClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'my-client', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
  args: ['-y', '@scope/server-package@latest'],
  stderr: 'pipe',
});

await client.connect(transport);
```

Windows note: spawn `npx.cmd`, not `npx`. Pipe stderr when debugging.

### Connect via Streamable HTTP (remote server)

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'my-client', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL('https://example.com/mcp'));
await client.connect(transport);

// On clean shutdown:
await transport.terminateSession(); // sends DELETE for the session
await client.close();
```

### List tools (with pagination)

```ts
const allTools = [];
let cursor: string | undefined;
do {
  const { tools, nextCursor } = await client.listTools({ cursor });
  allTools.push(...tools);
  cursor = nextCursor;
} while (cursor);
```

### Call a tool — handle BOTH failure surfaces

```ts
import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';

try {
  const result = await client.callTool({ name: 'get-weather', arguments: { city: 'Paris' } });

  if (result.isError) {
    // Tool ran and reported failure
    console.error('Tool failure:', result.content);
    return;
  }

  // Prefer structuredContent when the tool declared an outputSchema
  console.log(result.structuredContent ?? result.content);
} catch (error) {
  if (error instanceof ProtocolError) {
    // JSON-RPC protocol error (invalid params, method not found, etc.)
  } else if (error instanceof SdkError) {
    // Local SDK error (timeout, closed connection, capability not supported)
    if (error.code === SdkErrorCode.RequestTimeout) {
      /* ... */
    }
  } else {
    throw error;
  }
}
```

If you only handle `isError` you'll miss timeouts and disconnects. If you only handle thrown errors you'll miss tool-reported failures. **Always handle both.**

For more — auth (bearer, client credentials, OAuth, private-key JWT, Cross-App Access), server-initiated requests (sampling/elicitation/roots), middleware, stream resumption, experimental tasks — read [references/client.md](references/client.md).

## Critical pitfalls (the failure modes that bite hardest)

1. **`console.log` in stdio servers corrupts the protocol stream.** stdout is JSON-RPC. Use MCP logging (`server.server.sendLoggingMessage(...)`) or `console.error` (stderr). This applies to the `gemini-assistant` codebase too — use the project's `logger` instead of `console.log`.
2. **Mixing v1 and v2 imports.** They share class and method names but not types. If `package.json` has only v2 packages, treat any `@modelcontextprotocol/sdk` import as a bug.
3. **Using `z.object(...)` instead of `z.strictObject(...)` at boundaries.** `z.object` silently strips unknown fields, hiding caller mistakes.
4. **Passing raw object shapes as schemas.** v2 requires Standard Schema (Zod v4, ArkType, Valibot, or `fromJsonSchema(...)`). Plain `{ type: 'object', ... }` will not work directly — wrap it.
5. **Throwing on tool runtime failures.** Use `isError: true` instead. Throw only for protocol-level errors.
6. **Forgetting `content` when returning `structuredContent`.** Clients that don't understand structured content fall back to `content`. Always include both.
7. **Capability mismatch.** Declare `capabilities` on the server _and_ the client before `connect()`. Sampling, elicitation, and roots only work if both sides advertise them.
8. **In stateful HTTP, forgetting `terminateSession()`.** Leaks server-side session state. Call `transport.terminateSession()` before `client.close()` for Streamable HTTP.
9. **In stateless HTTP, assuming `mcp-session-id` exists.** It won't. Don't key state on it.
10. **In Node 20 ESM projects, omitting `.js` extensions in imports.** TypeScript compiles `import './foo'` to `import './foo'`, which Node ESM rejects. Write `import './foo.js'` even in `.ts` source.

## Project-specific note (gemini-assistant)

This repository has a frozen public surface defined in `src/public-contract.ts` — four tools (`chat`, `research`, `analyze`, `review`), three prompts, and a set of resources. Do not add new tools, prompts, or resources outside that contract without updating `public-contract.ts`. Schemas live under `src/schemas/` using Zod v4 (`import { z } from 'zod/v4'`); reuse field builders from `src/schemas/fields.ts` instead of redefining primitives. See [CLAUDE.md](../../../CLAUDE.md) for the full project rules.

## Workflow checklist for any MCP change

1. Confirm v2 (Step 1).
2. Confirm server vs client (Step 2).
3. If adding a tool/prompt/resource: define schemas under `src/schemas/`, then register with `registerTool/Prompt/Resource`.
4. For tools: add `outputSchema` and return `structuredContent` whenever output is structured.
5. Handle both error surfaces in clients.
6. Run `npm run lint && npm run type-check && npm run test` before declaring done.
