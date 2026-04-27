# MCP v1 → v2 Migration

Use this when porting code from `@modelcontextprotocol/sdk` (v1) to v2 split packages.

## The big picture

v1 was one monolithic package. v2 is split:

| v1                          | v2                                                             |
| --------------------------- | -------------------------------------------------------------- |
| `@modelcontextprotocol/sdk` | `@modelcontextprotocol/client`, `/server`, `/node`, `/express` |

Runtime requirements for v2:

- Node.js 20+
- ESM only (`"type": "module"`, `moduleResolution: NodeNext`)
- Imports must include `.js` extensions

## Migration checklist

Work through these in order. Each step has the smallest reproducer of the change.

### 1. Replace package and imports

```diff
- import { Client } from "@modelcontextprotocol/sdk/client/index.js";
- import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
- import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
- import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
- import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
+ import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
+ import { McpServer, StdioServerTransport } from "@modelcontextprotocol/server";
+ import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
```

Update `package.json`:

```diff
  "dependencies": {
-   "@modelcontextprotocol/sdk": "^1.x"
+   "@modelcontextprotocol/client": "^2.x",
+   "@modelcontextprotocol/server": "^2.x",
+   "@modelcontextprotocol/node": "^2.x",
+   "@modelcontextprotocol/express": "^2.x"
  }
```

### 2. Server transport rename

```diff
- import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
- const transport = new StreamableHTTPServerTransport({ ... });
+ import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
+ const transport = new NodeStreamableHTTPServerTransport({ ... });
```

For web-standard runtimes (Hono, Bun, Deno, Workers):

```ts
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
```

**Removed transports**:

- Server-side `SSEServerTransport` — gone. Use `NodeStreamableHTTPServerTransport`.
- `WebSocketClientTransport` — gone. Use `StreamableHTTPClientTransport`.
- Client-side `SSEClientTransport` — still available, legacy fallback only.

### 3. Variadic registration helpers → register functions

```diff
- server.tool('add', 'Add two numbers', { a: z.number(), b: z.number() }, async ({ a, b }) => ({
-   content: [{ type: 'text', text: String(a + b) }],
- }));
+ server.registerTool(
+   'add',
+   {
+     description: 'Add two numbers',
+     inputSchema: z.strictObject({ a: z.number(), b: z.number() }),
+   },
+   async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
+ );
```

Same shape for prompts and resources:

```diff
- server.prompt('greet', { name: z.string() }, ({ name }) => ({ ... }));
+ server.registerPrompt('greet', { argsSchema: z.strictObject({ name: z.string() }) }, ({ name }) => ({ ... }));

- server.resource('config', 'config://app', async () => ({ ... }));
+ server.registerResource('config', 'config://app', { mimeType: 'application/json' }, async (uri) => ({ ... }));
```

### 4. Schemas must be Standard Schema

v1 accepted raw Zod object shapes. v2 requires Standard Schema objects. Use `zod/v4`, ArkType, Valibot, or `fromJsonSchema(...)`.

```diff
- inputSchema: { name: z.string(), age: z.number().optional() }
+ inputSchema: z.strictObject({ name: z.string(), age: z.number().optional() })
```

```diff
- import { z } from 'zod';
+ import { z } from 'zod/v4';
```

For raw JSON Schema sources:

```ts
import { fromJsonSchema } from '@modelcontextprotocol/server';

server.registerTool('search', { inputSchema: fromJsonSchema(rawJsonSchema) }, handler);
```

### 5. Low-level handler registration takes string method names

```diff
- import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
- server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
+ server.setRequestHandler('tools/list', async () => ({ tools: [] }));

- server.setNotificationHandler(LoggingMessageNotificationSchema, (n) => { ... });
+ server.setNotificationHandler('notifications/message', (n) => { ... });
```

### 6. Request methods no longer take a result schema

```diff
- await client.request({ method: 'tools/list' }, ListToolsResultSchema);
+ await client.request({ method: 'tools/list' });

- await client.callTool({ name: 'foo' }, CallToolResultSchema);
+ await client.callTool({ name: 'foo' });

- await ctx.mcpReq.send(req, ResultSchema);
+ await ctx.mcpReq.send(req);
```

Result types are inferred from the method name.

### 7. Handler context: flat `extra` → grouped `ctx`

```diff
- async (args, extra) => {
-   extra.signal;
-   extra._meta;
-   await extra.sendNotification({ ... });
-   extra.requestInfo;
-   extra.taskStore;
- }
+ async (args, ctx) => {
+   ctx.mcpReq.signal;
+   ctx.mcpReq._meta;
+   await ctx.mcpReq.notify({ ... });
+   ctx.http?.req;
+   ctx.task?.store;
+ }
```

Mapping:

| v1                          | v2                     |
| --------------------------- | ---------------------- |
| `extra.signal`              | `ctx.mcpReq.signal`    |
| `extra._meta`               | `ctx.mcpReq._meta`     |
| `extra.sendNotification(x)` | `ctx.mcpReq.notify(x)` |
| `extra.requestInfo`         | `ctx.http?.req`        |
| `extra.taskStore`           | `ctx.task?.store`      |

`ctx.http` and `ctx.task` are optional — guard with `?.`.

### 8. Error model

```diff
- import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
- throw new McpError(ErrorCode.InvalidParams, 'bad input');
+ import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
+ throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'bad input');
```

Two error families now:

| Family          | Use for                                        |
| --------------- | ---------------------------------------------- |
| `ProtocolError` | JSON-RPC protocol errors (server side)         |
| `SdkError`      | Local SDK runtime errors (client side, mostly) |

```diff
- if (err instanceof StreamableHTTPError) { ... }
+ if (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) { ... }
```

`StreamableHTTPError` was removed. HTTP transport failures now use `SdkError` with `SdkErrorCode` values.

### 9. Headers are Web Standard `Headers`

```diff
- const headers: Record<string, string> = response.headers;
+ const headers: Headers = response.headers;
+ const auth = headers.get('Authorization');
```

Stop expecting plain record objects from transports.

### 10. Express host validation moved

If you used `express()` directly with v1 host validation middleware:

```diff
- import express from 'express';
- import { hostValidator } from '@modelcontextprotocol/sdk/server/express.js';
- const app = express();
- app.use(hostValidator({ allowedHosts: ['localhost'] }));
+ import { createMcpExpressApp } from '@modelcontextprotocol/express';
+ const app = createMcpExpressApp({ host: 'localhost', allowedHosts: ['localhost'] });
```

`createMcpExpressApp()` handles host validation, DNS rebinding protection, MCP CORS headers.

### 11. Tasks: TTL no longer accepts `null`

```diff
- await client.callTool({ name: 'x', arguments: {}, task: { ttl: null } });
+ await client.callTool({ name: 'x', arguments: {} /* omit ttl */ });
```

Just omit `ttl` instead of setting `ttl: null`.

### 12. Stdio servers: stop using stdout for logs

This was always best practice, but v2's stricter transport will surface it faster:

```diff
- console.log('Server starting...');
+ console.error('Server starting...');
+ // or use MCP logging via server.server.sendLoggingMessage(...)
```

stdout is the JSON-RPC channel. `console.log` corrupts it.

## Migration playbook

When tackling a real codebase:

1. **Inventory** — `grep -rn '@modelcontextprotocol/sdk' src/` to find every import.
2. **Update `package.json`** — swap dependencies, run `npm install`.
3. **Fix imports** — package by package. TypeScript will surface bad ones.
4. **Run type-check** — `npm run type-check`. Fix the type errors top-down. Most map to one of the changes above.
5. **Update schemas** — wrap loose object shapes with `z.strictObject(...)`. Switch to `zod/v4`.
6. **Update handler bodies** — `extra.X` → `ctx.mcpReq.X` etc.
7. **Update error handling** — `McpError` → `ProtocolError`, add `SdkError` handling on client side.
8. **Run tests** — many will surface integration issues that types missed.
9. **Manual smoke** — connect a real client to a real server to confirm end-to-end.

## Quick spot-the-version table

If you're staring at a file and not sure:

| Code you see                                       | Likely version |
| -------------------------------------------------- | -------------- |
| `from '@modelcontextprotocol/sdk/...'`             | v1             |
| `server.tool(name, desc, schema, handler)`         | v1             |
| `server.registerTool(name, config, handler)`       | v2             |
| `server.setRequestHandler(SchemaConst, handler)`   | v1             |
| `server.setRequestHandler('method/name', handler)` | v2             |
| `extra.signal`, `extra.sendNotification`           | v1             |
| `ctx.mcpReq.signal`, `ctx.mcpReq.notify`           | v2             |
| `new McpError(ErrorCode.X, ...)`                   | v1             |
| `new ProtocolError(ProtocolErrorCode.X, ...)`      | v2             |
| `StreamableHTTPServerTransport`                    | v1             |
| `NodeStreamableHTTPServerTransport`                | v2             |
| `instanceof StreamableHTTPError`                   | v1             |
| `instanceof SdkError`                              | v2             |
| `WebSocketClientTransport`                         | v1 (removed)   |
