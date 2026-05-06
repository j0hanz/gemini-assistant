# Implementation Plan: MCP v2 Refinement

## Context
This plan implements the design from `docs/specs/2026-05-07-mcp-v2-refinement-design.md`, modernizing the `gemini-assistant` codebase by migrating custom boilerplate to native MCP v2 primitives.

## Phase 1: Transport Modernization

1.  **Refactor `src/transport.ts` for Streamable Transports:**
    *   Remove custom Server-Sent Events (SSE) logic, connection maps, and message serialization.
    *   Import `NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/server/express`.
    *   Update `startHttpTransport()` to use `NodeStreamableHTTPServerTransport` to handle `/message` routes and chunked encoding natively.
    *   Import `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/server/hono`.
    *   Update `startWebStandardTransport()` to use `WebStandardStreamableHTTPServerTransport`.
    *   Ensure the existing `SessionStore` lifecycle events hook into `onclose` and `onerror` of the new streamable transports.

2.  **Verify Transports:**
    *   Run `npm run build` and `npm run test` to verify the new transport integrations don't break existing tests, adjusting tests in `__tests__/transport.test.ts` (if any exist) or `__tests__/client.test.ts` as needed.

## Phase 2: Tasks API Integration

1.  **Remove Custom Task Boilerplate:**
    *   Delete `src/lib/tasks.ts`.
    *   Remove any REST/RPC endpoints used for task polling (e.g., `tasks/get`, `tasks/list`) from `src/server.ts` or `src/transport.ts`.

2.  **Configure `InMemoryTaskStore`:**
    *   In `src/server.ts`, import `InMemoryTaskStore` from `@modelcontextprotocol/server`.
    *   Instantiate `InMemoryTaskStore` and pass it into the `McpServer` configuration block.

3.  **Migrate Long-Running Tools to Tasks:**
    *   In `src/tools/research.ts`: Change `server.registerTool(...)` to `server.experimental.tasks.registerToolTask(...)` (or the equivalent API call in `McpServer` for tasks).
    *   In `src/tools/analyze.ts`: Change to `registerToolTask(...)`.
    *   In `src/tools/ingest.ts`: Change to `registerToolTask(...)`.

4.  **Inject and Utilize `ServerContext`:**
    *   Refactor the tool handlers in `src/tools/*.ts` to receive the native `ServerContext` (`ctx`).
    *   Replace any manual timeout logic with `ctx.signal` (passing the `AbortSignal` down to execution engines like `tool-executor.ts` or `orchestration.ts`).
    *   Replace custom progress callback logic (e.g., relying on `ToolServices`) with `ctx.progress(current, total)`.

5.  **Verify Tasks:**
    *   Run tests to ensure task-based tools still function correctly using the new `ServerContext` and task registration. Update mocks in `__tests__/tools/*.test.ts` accordingly.

## Phase 3: Completables & Standard Alignments

1.  **Implement Completables in Tool Registration:**
    *   In `src/tools/ingest.ts`: Update the `filePath` parameter definition in the registration block to include `completable: true`.
    *   In `src/tools/analyze.ts`: Update the `filePath` parameter definition to include `completable: true`.
    *   In `src/tools/review.ts`: Update the `filePathA` and `filePathB` parameter definitions to include `completable: true`.

2.  **Refine Schema Validations:**
    *   Review `src/schemas/inputs.ts` and `src/schemas/outputs.ts`.
    *   Ensure tool registrations pass raw `z.object(...)` definitions rather than manually calling `zodToJsonSchema` or `.toJSONSchema()`, allowing the SDK to handle conversion and validation natively.

3.  **Dependency Audit & Cleanup:**
    *   Search the codebase for `@modelcontextprotocol/sdk`.
    *   Replace any found imports with their correct counterparts from `@modelcontextprotocol/server`, `@modelcontextprotocol/server/node`, `@modelcontextprotocol/server/express`, or `@modelcontextprotocol/server/hono`.
    *   Remove unused `zod-to-json-schema` imports if they exist.

## Phase 4: Final Verification

1.  **Full Suite Run:**
    *   Run `node scripts/tasks.mjs --fix` to format, lint, type-check, and run all tests.
    *   Ensure all 300+ tests pass.

2.  **Manual Inspector Check (Optional but recommended):**
    *   Run `npm run inspector` and verify tools (especially async ones like `research` or `analyze`) execute properly and report progress.
