# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Always run `tasks.mjs` before committing.** It orchestrates format → lint/type-check/knip (parallel) → test/build (parallel) with smart failure-fast and auto-fix:

```bash
node scripts/tasks.mjs          # full check suite (fail-fast)
node scripts/tasks.mjs --fix    # auto-fix format/lint/knip, then verify
node scripts/tasks.mjs --quick  # skip test + rebuild (format/lint/type-check/knip only)
node scripts/tasks.mjs --all    # run all tasks even past failures
node scripts/tasks.mjs --llm    # emit structured failure detail to stdout (also → .tasks-last-failure.json)
```

Run a single test file:

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/path/to/test.ts
```

The plain `npm run test` command relies on Node's built-in test discovery — it walks the project
recursively for `*.test.ts` files and runs them. No shell glob expansion is required.

Other useful commands:

```bash
npm run format        # prettier write
npm run build         # tsc compile to dist/
npm run inspector     # build + launch MCP inspector for interactive testing
npm run check         # check:static + tests (without tasks.mjs orchestration)
npm run check:static  # lint, type-check, build, prettier, knip (no tests)
```

## Architecture

`gemini-assistant` is an MCP server that exposes a job-first surface over Google Gemini. The public contract is fixed: four tools (`chat`, `research`, `analyze`, `review`), three prompts (`discover`, `research`, `review`), and a set of resources. The canonical source for the public surface is [src/public-contract.ts](src/public-contract.ts).

### Entry and wiring

- [src/index.ts](src/index.ts) — process bootstrap, signal handling, transport dispatch. `main()` accepts injectable `MainDependencies` for testability.
- [src/server.ts](src/server.ts) — `createServerInstance()` constructs the `McpServer`, wires capabilities, registers all tools/prompts/resources, and returns a `ServerInstance` with a `close()` method.
- [src/transport.ts](src/transport.ts) — HTTP and web-standard transport setup. Stdio transport is handled inline in `index.ts`.
- [src/config.ts](src/config.ts) — all env-var parsing; booleans accept only the literal strings `true` or `false`.

### Tool layer

Each tool lives in [src/tools/](src/tools/) and is registered by a `registerXxxTool(server, toolServices)` function. Tools receive a `ToolServices` bag (session access, workspace access, roots fetcher) injected through `ServerContext` via a Symbol key in [src/lib/tool-context.ts](src/lib/tool-context.ts).

Shared tool infrastructure:

- [src/lib/orchestration.ts](src/lib/orchestration.ts) — builds `GenerateContentConfig` from tool inputs (Google Search, URL Context, Code Execution profiles, file search).
- [src/lib/streaming.ts](src/lib/streaming.ts) — consumes Gemini streaming responses, extracts usage/tool events.
- [src/lib/response.ts](src/lib/response.ts) — builds `CallToolResult` with `content[]` + `structuredContent`.
- [src/lib/task-utils.ts](src/lib/task-utils.ts) — `registerWorkTool()` wraps tool handlers to support optional task-aware execution.
- [src/lib/tool-executor.ts](src/lib/tool-executor.ts) — `executor()` / `createToolContext()` for running tool work with progress, logging, and abort signal.

### Sessions

[src/sessions.ts](src/sessions.ts) holds all session state. Each session stores two separate records per turn:

- `parts` — replay-filtered subset for rebuilding Gemini `Content[]` history (no thought-only parts, thought signatures preserved on function/tool call parts only).
- `rawParts` — SDK-faithful parts with oversized `inlineData` elided, served via `gemini://sessions/{sessionId}/turns/{turnIndex}/parts` for replay-safe orchestration.

Sessions are process-local in-memory only. `MCP_EXPOSE_SESSION_RESOURCES=true` is required to expose transcript, events, and raw turn-parts resources.

### Schemas

[src/schemas/](src/schemas/) uses **Zod v4** (`import { z } from 'zod/v4'`):

- [fields.ts](src/schemas/fields.ts) — reusable field builders shared across tool input schemas.
- [inputs.ts](src/schemas/inputs.ts) — full input schemas for all four tools.
- [outputs.ts](src/schemas/outputs.ts) — structured output types.
- [validators.ts](src/schemas/validators.ts) — `@cfworker/json-schema`-backed Gemini JSON Schema validation.

Always use `z.strictObject()` at external/input boundaries. The MCP v2 SDK (`@modelcontextprotocol/server`, not the legacy monolithic `@modelcontextprotocol/sdk`) requires Standard Schema objects for `inputSchema`/`outputSchema`.

### Tests

Tests live under [**tests**/](/__tests__/) mirroring the `src/` structure. The test runner is Node's built-in test runner with `tsx/esm` — not Jest or Vitest. E2e tests (files named `*.e2e.test.ts`) use [**tests**/lib/mock-gemini-environment.ts](/__tests__/lib/mock-gemini-environment.ts) and an in-memory MCP transport.

### Transport modes

`TRANSPORT` env var selects `stdio` (default), `http`, or `web-standard`. HTTP transport requires `MCP_HTTP_TOKEN` (≥32 chars) unless `MCP_ALLOW_UNAUTHENTICATED_LOOPBACK_HTTP=true`. Stateless mode (`STATELESS=true`) disables the tasks capability.

## Key constraints

- **No `console.log`** in server code — stdio transport writes to stdout and corrupts the JSON-RPC stream. Use `logger` from [src/lib/logger.ts](src/lib/logger.ts).
- **TypeScript strict mode** with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` — optional properties must use `| undefined` explicitly.
- **ESM only** (`"type": "module"`, `moduleResolution: NodeNext`). Imports must include `.js` extensions.
- **Public surface is frozen** — do not add tools, prompts, or resources outside the contract defined in [src/public-contract.ts](src/public-contract.ts) without updating the full discovery metadata there.
- **Ask before**: installing dependencies, deleting files, running builds or e2e suites, git push.
