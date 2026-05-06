# MCP v2 Refinement Design

This document outlines the architectural changes required to modernize the `gemini-assistant` codebase by replacing custom boilerplate with native MCP v2 primitives.

## 1. Transport Layer Migration

**Goal**: Replace custom Server-Sent Events (SSE) logic with the native v2 Streamable HTTP transports.

*   **Remove Custom Infrastructure**: Delete all custom SSE endpoint handling, connection lifecycle tracking, and message serialization from `src/transport.ts`.
*   **Express Transport**: Replace the current HTTP implementation with `NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/server/express`. This will natively handle chunked encoding and the `/message` routes.
*   **Web Standard Transport**: Replace the current Web Standard implementation with `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/server/hono`.
*   **Lifecycle Hooks**: Bind the existing `SessionStore` cleanup logic to the `onclose` and `onerror` events provided by the streamable transports.

## 2. Tasks API & Server Context Migration

**Goal**: Eliminate the custom task queue and adopt the native MCP v2 Tasks API for long-running operations.

*   **Remove Custom Tasks**: Delete `src/lib/tasks.ts` and any custom REST/RPC endpoints used for task polling (`tasks/get`, etc.).
*   **Task Store**: Instantiate an `InMemoryTaskStore` (from `@modelcontextprotocol/server`) in `src/server.ts` and attach it to the `McpServer` configuration.
*   **`registerToolTask` Migration**: Convert long-running tools (e.g., `research` in deep mode, `analyze`, `ingest`) to use `server.experimental.tasks.registerToolTask()`. The SDK will handle polling, result storage, and async delivery.
*   **Adopt `ServerContext`**: 
    *   Inject `ServerContext` into tool handlers instead of relying on custom `ToolServices` for progress tracking.
    *   Use `ctx.progress()` for status updates.
    *   Pass `ctx.signal` (native `AbortSignal`) to internal routines to handle client cancellations natively.

## 3. Completables & Standard Alignments

**Goal**: Improve client-side UX with native autocompletion and ensure standard compliance with the v2 SDK.

*   **Implement Completables**: Add the `{ completable: true }` modifier to relevant tool parameters when registering them with the SDK.
    *   Target `filePath` in the `ingest` tool.
    *   Target `filePath`, `filePathA`, and `filePathB` in the `analyze` and `review` tools.
*   **Native Schema Validation**: Ensure tool definitions pass raw `z.object()` schemas directly into `registerTool`/`registerToolTask`. The v2 SDK natively handles `.toJSONSchema()` conversion and runtime validation.
*   **Dependency Audit**: Ensure no legacy `@modelcontextprotocol/sdk` imports remain in the codebase. All imports must originate from `@modelcontextprotocol/server` or its environment-specific sub-packages (`/node`, `/express`, `/hono`).
