# MCP v1 → v2 Migration

Use this when porting code from `@modelcontextprotocol/sdk` (v1) to v2 split packages. Based on the official SDK migration guide.

## The big picture

v1 was one monolithic package. v2 is split:

| v1                          | v2                                                            |
| --------------------------- | ------------------------------------------------------------- |
| `@modelcontextprotocol/sdk` | `@modelcontextprotocol/client` — MCP clients                  |
|                             | `@modelcontextprotocol/server` — MCP servers                  |
|                             | `@modelcontextprotocol/node` — Node.js HTTP transport         |
|                             | `@modelcontextprotocol/express` — Express integration         |
|                             | `@modelcontextprotocol/hono` — Hono integration               |
|                             | `@modelcontextprotocol/core` — **internal** (types, protocol) |

**Do not import from `@modelcontextprotocol/core` directly** — it is an internal package. Both `/client` and `/server` re-export everything you need from it.

Runtime requirements for v2:

- Node.js 20+ (dropped Node 18 and CommonJS)
- ESM only — no `require()`, no CommonJS builds

## Migration checklist

Work through in order. Each step has the smallest reproducer of the change.

### 1. Replace package and imports

```bash
npm uninstall @modelcontextprotocol/sdk
npm install @modelcontextprotocol/client   # if you build clients
npm install @modelcontextprotocol/server   # if you build servers
npm install @modelcontextprotocol/node     # for Node.js HTTP servers
npm install @modelcontextprotocol/express  # for Express integration
```

```diff
- import { Client } from "@modelcontextprotocol/sdk/client/index.js";
- import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
- import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
- import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
- import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
+ import { Client, StreamableHTTPClientTransport, StdioClientTransport } from "@modelcontextprotocol/client";
+ import { McpServer, StdioServerTransport } from "@modelcontextprotocol/server";
+ import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
```

### 2. Server transport rename + SSE removal

```diff
- import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
- const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
+ import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
+ const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
```

**Removed transports:**

- Server-side `SSEServerTransport` — gone. Migrate to `NodeStreamableHTTPServerTransport`.
- `WebSocketClientTransport` — gone. Use `StreamableHTTPClientTransport` or `StdioClientTransport`.
- Client-side `SSEClientTransport` — still present, legacy fallback only.

For web-standard runtimes (Hono, Bun, Deno, Workers):

```ts
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
```

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

```diff
- server.prompt('greet', { name: z.string() }, ({ name }) => ({ ... }));
+ server.registerPrompt('greet', { argsSchema: z.strictObject({ name: z.string() }) }, ({ name }) => ({ ... }));

- server.resource('config', 'config://app', async () => ({ ... }));
+ server.registerResource('config', 'config://app', {}, async (uri) => ({ ... }));
```

For tools with no parameters:

```ts
server.registerTool('ping', { inputSchema: z.strictObject({}) }, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));
```

### 4. Schemas must be Standard Schema

v1 accepted raw object shapes (plain `{ field: z.string() }`). v2 requires Standard Schema objects.

```diff
- inputSchema: { name: z.string(), age: z.number().optional() }
+ inputSchema: z.strictObject({ name: z.string(), age: z.number().optional() })
```

```diff
- import { z } from 'zod';
+ import { z } from 'zod/v4';
```

Accepted sources: Zod v4, ArkType, Valibot, or `fromJsonSchema(...)`:

```ts
import { fromJsonSchema } from '@modelcontextprotocol/server';

server.registerTool('search', { inputSchema: fromJsonSchema(rawJsonSchema) }, handler);
```

**Standard Schema helpers renamed in core** (only relevant if you used them directly):

| v1 (`@modelcontextprotocol/core`)                                                       | v2                                     |
| --------------------------------------------------------------------------------------- | -------------------------------------- |
| `schemaToJson(schema)`                                                                  | `standardSchemaToJsonSchema(schema)`   |
| `parseSchemaAsync(schema, data)`                                                        | `validateStandardSchema(schema, data)` |
| `SchemaInput<T>`                                                                        | `StandardSchemaWithJSON.InferInput<T>` |
| `getSchemaShape` / `getSchemaDescription` / `isOptionalSchema` / `unwrapOptionalSchema` | Removed — internal only                |

### 5. Low-level handler registration takes string method names

```diff
- import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
- server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
+ server.setRequestHandler('tools/list', async () => ({ tools: [] }));

- server.setNotificationHandler(LoggingMessageNotificationSchema, (n) => { ... });
+ server.setNotificationHandler('notifications/message', (n) => { ... });
```

Common schema → method string replacements:

| Schema constant (v1)                    | Method string (v2)                       |
| --------------------------------------- | ---------------------------------------- |
| `InitializeRequestSchema`               | `'initialize'`                           |
| `CallToolRequestSchema`                 | `'tools/call'`                           |
| `ListToolsRequestSchema`                | `'tools/list'`                           |
| `ListPromptsRequestSchema`              | `'prompts/list'`                         |
| `GetPromptRequestSchema`                | `'prompts/get'`                          |
| `ListResourcesRequestSchema`            | `'resources/list'`                       |
| `ReadResourceRequestSchema`             | `'resources/read'`                       |
| `CreateMessageRequestSchema`            | `'sampling/createMessage'`               |
| `ElicitRequestSchema`                   | `'elicitation/create'`                   |
| `LoggingMessageNotificationSchema`      | `'notifications/message'`                |
| `ToolListChangedNotificationSchema`     | `'notifications/tools/list_changed'`     |
| `ResourceListChangedNotificationSchema` | `'notifications/resources/list_changed'` |
| `PromptListChangedNotificationSchema`   | `'notifications/prompts/list_changed'`   |

### 6. Request methods no longer take a result schema

```diff
- await client.request({ method: 'tools/list' }, ListToolsResultSchema);
+ await client.request({ method: 'tools/list' });

- await client.callTool({ name: 'foo' }, CompatibilityCallToolResultSchema);
+ await client.callTool({ name: 'foo' });

- await ctx.mcpReq.send(req, CreateMessageResultSchema);
+ await ctx.mcpReq.send(req);
```

Result types are inferred from the method name via `ResultTypeMap`. If you used a schema for **runtime validation** (not just in `callTool()`), use the type guard instead:

```diff
- import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
- if (CallToolResultSchema.safeParse(value).success) { ... }
+ import { isCallToolResult } from '@modelcontextprotocol/client';
+ if (isCallToolResult(value)) { ... }
```

### 7. Handler context: flat `extra` → grouped `ctx`

The `RequestHandlerExtra` type is replaced by `ServerContext` (server) or `ClientContext` (client). Parameter renamed from `extra` to `ctx`.

```diff
- async (args, extra) => {
-   extra.signal;
-   extra._meta;
-   await extra.sendNotification({ ... });
-   await extra.sendRequest({ ... }, ResultSchema);
-   extra.requestId;
-   extra.requestInfo;
-   extra.authInfo;
-   extra.closeSSEStream;
-   extra.closeStandaloneSSEStream;
-   extra.sessionId;
-   extra.taskStore;
-   extra.taskId;
-   extra.taskRequestedTtl;
- }
+ async (args, ctx) => {
+   ctx.mcpReq.signal;
+   ctx.mcpReq._meta;
+   await ctx.mcpReq.notify({ ... });
+   await ctx.mcpReq.send({ ... });
+   ctx.mcpReq.id;
+   ctx.http?.req;            // standard Web Request (HTTP transports only)
+   ctx.http?.authInfo;
+   ctx.http?.closeSSE;
+   ctx.http?.closeStandaloneSSE;
+   ctx.sessionId;
+   ctx.task?.store;
+   ctx.task?.id;
+   ctx.task?.requestedTtl;
+ }
```

Complete mapping:

| v1 (`extra.X`)                   | v2 (`ctx.X`)                     |
| -------------------------------- | -------------------------------- |
| `extra.signal`                   | `ctx.mcpReq.signal`              |
| `extra._meta`                    | `ctx.mcpReq._meta`               |
| `extra.requestId`                | `ctx.mcpReq.id`                  |
| `extra.sendNotification(x)`      | `ctx.mcpReq.notify(x)`           |
| `extra.sendRequest(x, schema)`   | `ctx.mcpReq.send(x)` (no schema) |
| `extra.requestInfo`              | `ctx.http?.req` (Web `Request`)  |
| `extra.authInfo`                 | `ctx.http?.authInfo`             |
| `extra.closeSSEStream`           | `ctx.http?.closeSSE`             |
| `extra.closeStandaloneSSEStream` | `ctx.http?.closeStandaloneSSE`   |
| `extra.sessionId`                | `ctx.sessionId`                  |
| `extra.taskStore`                | `ctx.task?.store`                |
| `extra.taskId`                   | `ctx.task?.id`                   |
| `extra.taskRequestedTtl`         | `ctx.task?.requestedTtl`         |

Context is grouped into:

- **`mcpReq`** — request-level: id, signal, \_meta, send(), notify(), log() (server), elicitInput() (server), requestSampling() (server)
- **`http?`** — HTTP transport only: req (Web Request), authInfo, closeSSE, closeStandaloneSSE
- **`task?`** — task lifecycle: id, store, requestedTtl
- **`sessionId`** — top-level on ctx

`ctx.http` and `ctx.task` are optional — always guard with `?.`.

**New server-only convenience methods on `ctx.mcpReq`** (replaces calling server methods directly from handlers):

```ts
// replaces server.sendLoggingMessage(...)
await ctx.mcpReq.log('info', 'Processing', 'my-logger');

// replaces server.createMessage(...) / requestSampling(...)
const result = await ctx.mcpReq.requestSampling({ messages: [...], maxTokens: 100 });

// replaces server.elicitInput(...)
const input = await ctx.mcpReq.elicitInput({ message: '...', requestedSchema: {...} });
```

### 8. Headers are Web Standard `Headers`

Transport APIs and `ctx.http?.req` now use the Web Standard `Headers` object.

```diff
- const transport = new StreamableHTTPClientTransport(url, {
-   requestInit: { headers: { Authorization: 'Bearer token' } }
- });
+ const transport = new StreamableHTTPClientTransport(url, {
+   requestInit: { headers: new Headers({ Authorization: 'Bearer token' }) }
+ });
```

```diff
- const sessionId = extra.requestInfo?.headers['mcp-session-id'];
- const authHeader = extra.requestInfo?.headers['authorization'];
+ const sessionId = ctx.http?.req?.headers.get('mcp-session-id');
+ const authHeader = ctx.http?.req?.headers.get('authorization');
+ // Query params:
+ const url = new URL(ctx.http!.req!.url);
+ const debug = url.searchParams.get('debug');
```

`IsomorphicHeaders` type is removed — use `Headers` directly.

### 9. Error model

```diff
- import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
- throw new McpError(ErrorCode.InvalidParams, 'bad input');
+ import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
+ throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'bad input');
```

Two error families now:

| Family          | What it's for                                                        |
| --------------- | -------------------------------------------------------------------- |
| `ProtocolError` | Errors that cross the wire as JSON-RPC error responses (server side) |
| `SdkError`      | Local SDK errors: timeouts, closed connections, capability failures  |

```diff
- if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) { ... }
- if (err instanceof StreamableHTTPError) { ... }
+ if (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) { ... }
```

`StreamableHTTPError` was removed. HTTP transport failures are now `SdkError`:

Full `SdkErrorCode` table:

| Code                                              | Meaning                                     |
| ------------------------------------------------- | ------------------------------------------- |
| `SdkErrorCode.NotConnected`                       | Transport not connected                     |
| `SdkErrorCode.AlreadyConnected`                   | Transport already connected                 |
| `SdkErrorCode.NotInitialized`                     | Protocol not initialized                    |
| `SdkErrorCode.CapabilityNotSupported`             | Required capability not supported           |
| `SdkErrorCode.RequestTimeout`                     | Request timed out                           |
| `SdkErrorCode.ConnectionClosed`                   | Connection was closed                       |
| `SdkErrorCode.SendFailed`                         | Failed to send message                      |
| `SdkErrorCode.ClientHttpNotImplemented`           | HTTP POST failed                            |
| `SdkErrorCode.ClientHttpAuthentication`           | Server returned 401 after re-auth           |
| `SdkErrorCode.ClientHttpForbidden`                | Server returned 403 after upscoping attempt |
| `SdkErrorCode.ClientHttpUnexpectedContent`        | Unexpected content type in HTTP response    |
| `SdkErrorCode.ClientHttpFailedToOpenStream`       | Failed to open SSE stream                   |
| `SdkErrorCode.ClientHttpFailedToTerminateSession` | Failed to terminate session                 |

### 10. Express host validation moved + signature changed

```diff
- import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware.js';
- app.use(hostHeaderValidation({ allowedHosts: ['example.com'] }));
+ import { hostHeaderValidation } from '@modelcontextprotocol/express';
+ app.use(hostHeaderValidation(['example.com']));  // now takes string[], not options object
```

Or use `createMcpExpressApp()` which handles this automatically:

```ts
import { createMcpExpressApp } from '@modelcontextprotocol/express';

const app = createMcpExpressApp({ host: 'localhost', allowedHosts: ['localhost'] });
```

### 11. Server-side auth removed

Server OAuth/auth has been removed entirely from the SDK. This includes:
`mcpAuthRouter`, `OAuthServerProvider`, `OAuthTokenVerifier`, `requireBearerAuth`, `authenticateClient`, `ProxyOAuthServerProvider`, all associated types.

Use a dedicated auth library (`better-auth`, etc.) or a full Authorization Server instead. `AuthInfo` moved to core types — re-exported by both `/client` and `/server`.

### 12. Removed type aliases

| v1                        | v2                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `JSONRPCError`            | `JSONRPCErrorResponse`                                                                                                                   |
| `JSONRPCErrorSchema`      | `JSONRPCErrorResponseSchema`                                                                                                             |
| `isJSONRPCError`          | `isJSONRPCErrorResponse`                                                                                                                 |
| `isJSONRPCResponse`       | **Changed semantics** — now matches both result AND error responses. Use `isJSONRPCResultResponse` to preserve v1 behavior (result only) |
| `ResourceReferenceSchema` | `ResourceTemplateReferenceSchema`                                                                                                        |
| `ResourceReference`       | `ResourceTemplateReference`                                                                                                              |
| `IsomorphicHeaders`       | Web Standard `Headers`                                                                                                                   |

> **`isJSONRPCResponse` trap**: In v1, `isJSONRPCResponse` only matched result responses (was a deprecated alias for `isJSONRPCResultResponse`). In v2, a new `isJSONRPCResponse` with corrected semantics matches **both** result and error responses. If you migrate `isJSONRPCResponse` → `isJSONRPCResponse`, behavior silently changes. Use `isJSONRPCResultResponse` if you only want result responses.

### 13. OAuth error classes consolidated

Individual OAuth error classes are replaced by `OAuthError` with an `OAuthErrorCode` enum:

```diff
- import { InvalidClientError, InvalidGrantError, ServerError } from '@modelcontextprotocol/client';
- if (error instanceof InvalidClientError) { ... }
+ import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/client';
+ if (error instanceof OAuthError && error.code === OAuthErrorCode.InvalidClient) { ... }
```

The `OAUTH_ERRORS` constant is also removed.

### 14. `InMemoryTransport` removed from public API

```diff
- import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
+ import { InMemoryTransport } from '@modelcontextprotocol/core';  // testing only
```

`@modelcontextprotocol/core` is internal and not for production use. For production in-process connections, connect client and server via paired streams or use `StreamableHTTPClientTransport` with a local URL.

### 15. Client list methods now return empty for missing capabilities

`Client.listTools()`, `listPrompts()`, `listResources()`, `listResourceTemplates()` now return empty results when the server didn't advertise the capability (instead of throwing). To restore v1 behavior:

```ts
const client = new Client(
  { name: 'my-client', version: '1.0.0' },
  { enforceStrictCapabilities: true }, // throws when capability is missing
);
```

### 16. Tasks: `ttl: null` → omit `ttl`

```diff
- await client.callTool({ name: 'long-task', arguments: {}, task: { ttl: null } });
+ await client.callTool({ name: 'long-task', arguments: {} });
```

`ctx.task?.requestedTtl` is now `number | undefined` (not `number | null | undefined`). These are `@experimental` APIs.

## New in v2 (enhancements, not breaking)

### Automatic JSON Schema validator selection

No action needed for most projects. The SDK now auto-selects the right validator:

- Node.js → `AjvJsonSchemaValidator` (same as v1 default)
- Cloudflare Workers → `CfWorkerJsonSchemaValidator` (previously required manual config)

If you explicitly configured `CfWorkerJsonSchemaValidator` for Workers, you can remove that configuration.

## Migration playbook

For a real codebase:

1. **Inventory** — `grep -rn '@modelcontextprotocol/sdk' src/` to find every import.
2. **Update `package.json`** — swap dependencies, run `npm install`.
3. **Fix imports** — package by package. TypeScript will surface bad ones.
4. **Run type-check** — `npm run type-check`. Fix errors top-down — most map directly to the table above.
5. **Update schemas** — wrap loose shapes with `z.strictObject(...)`. Switch to `zod/v4`.
6. **Update handler bodies** — `extra.X` → `ctx.mcpReq.X` etc. using the full mapping table.
7. **Update error handling** — `McpError` → `ProtocolError`, add `SdkError` handling on client side.
8. **Remove auth code** — if you used server-side OAuth helpers, replace with your auth library.
9. **Update `isJSONRPCResponse` calls** — confirm whether you want result-only (`isJSONRPCResultResponse`) or both result+error (new `isJSONRPCResponse`).
10. **Run tests** — surface integration issues types missed.
11. **Manual smoke** — connect a real client to a real server.

## Quick spot-the-version table

| Code you see                                       | Version             |
| -------------------------------------------------- | ------------------- |
| `from '@modelcontextprotocol/sdk/...'`             | v1                  |
| `server.tool(name, desc, schema, handler)`         | v1                  |
| `server.registerTool(name, config, handler)`       | v2                  |
| `server.setRequestHandler(SchemaConst, handler)`   | v1                  |
| `server.setRequestHandler('method/name', handler)` | v2                  |
| `extra.signal`, `extra.sendNotification`           | v1                  |
| `ctx.mcpReq.signal`, `ctx.mcpReq.notify`           | v2                  |
| `new McpError(ErrorCode.X, ...)`                   | v1                  |
| `new ProtocolError(ProtocolErrorCode.X, ...)`      | v2                  |
| `StreamableHTTPServerTransport`                    | v1                  |
| `NodeStreamableHTTPServerTransport`                | v2                  |
| `instanceof StreamableHTTPError`                   | v1 (removed)        |
| `instanceof SdkError`                              | v2                  |
| `WebSocketClientTransport`                         | v1 (removed)        |
| `headers['mcp-session-id']`                        | v1 (plain object)   |
| `headers.get('mcp-session-id')`                    | v2 (Web Headers)    |
| `hostHeaderValidation({ allowedHosts: [...] })`    | v1 (options object) |
| `hostHeaderValidation([...])`                      | v2 (string array)   |
