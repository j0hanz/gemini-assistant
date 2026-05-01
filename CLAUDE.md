# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Prefer `node scripts/tasks.mjs` over individual `npm run` commands for the dev loop — it runs checks in parallel, auto-fixes where possible, and writes structured failure output.

```bash
node scripts/tasks.mjs           # format → [lint, type-check, knip] → [test, rebuild] (fail-fast)
node scripts/tasks.mjs --fix     # auto-fix format/lint/knip, then re-run all checks
node scripts/tasks.mjs --quick   # skip test + rebuild (fast static checks only)
node scripts/tasks.mjs --all     # continue past failures instead of stopping at first
node scripts/tasks.mjs --detail <n>  # show source window for the Nth test failure from last run
node scripts/tasks.mjs --watch   # run node --test in watch mode
```

Individual commands (use when you need only one step):

```bash
npm run build          # Compile TypeScript to dist/
npm run type-check     # Type-check without emitting
npm run lint           # ESLint (0 warnings allowed)
npm run inspector      # Launch MCP inspector for manual testing
```

Run a single test file:

```bash
node --import tsx/esm --env-file=.env --test --no-warnings __tests__/sessions.test.ts
```

## Architecture

This is a **workflow-first MCP server** that exposes Google Gemini as MCP tools with session management, workspace context, and multi-transport support.

### Entry Points

- **`src/index.ts`** — `main()` wires transport + server, handles graceful shutdown (SIGINT/SIGTERM, uncaught exceptions).
- **`src/server.ts`** — `createServerInstance()` creates the `McpServer`, registers all tools/prompts/resources, returns a cleanup closure.
- **`src/transport.ts`** — `startHttpTransport()` (Express) and `startWebStandardTransport()` (Bun/Deno/Workers).
- **`src/config.ts`** — Parses all env vars at startup; fail-fast on invalid config.

### Transport Model

Three modes controlled by `MCP_TRANSPORT` env var:

- `stdio` (default) — single-session, no auth
- `http` — Express server with bearer token auth, host validation, rate limiting, stateful session pooling with LRU eviction and TTL sweep
- `web-standard` — Same logic as http but for Web-standard runtimes (Bun, Deno, Cloudflare Workers)

HTTP/WebStandard transports maintain a **stateful pair** (McpServer instance + transport) per session, separate from the logical `SessionStore`.

### Tool Registration Pattern

Each tool is in `src/tools/` and exports `registerXxxTool(server, toolServices)`. All registrars are listed in `SERVER_TOOL_REGISTRARS` in `server.ts`. Tools receive `ToolServices` (session access, workspace cache, root fetcher, capabilities).

Current tools: `chat`, `research`, `analyze`, `review`.

### Session Model

`SessionStore` (`src/sessions.ts`) is an in-memory store (process-local) keyed by session ID. Each session holds: transcripts (turn history), events, and raw Gemini `Part[]` per turn. Sessions emit change events consumed by `ResourceNotifier` to push MCP resource change notifications to subscribers.

### Resource Model

Resources live in `src/resources/` and are URI-based (e.g., `gemini://sessions/{id}/events`). Three categories:

- **Discover** — catalog, workflows, context
- **Sessions** — session list, transcripts, events, turn-parts (only when `MCP_EXPOSE_SESSION_RESOURCES=true`)
- **Workspace** — cache metadata, cache contents, workspace file access

### Schemas and Validation

All tool input/output schemas use Zod (`src/schemas/`). `src/lib/tool-profiles.ts` handles per-tool schema selection; `src/lib/validation.ts` handles root fetching and host validation.

### Key Infrastructure (`src/lib/`)

| File                   | Purpose                                                   |
| ---------------------- | --------------------------------------------------------- |
| `tool-executor.ts`     | Core tool execution engine                                |
| `orchestration.ts`     | Gemini function-calling loop                              |
| `streaming.ts`         | Streaming response parsing                                |
| `interactions.ts`      | Builds Gemini interaction parameters                      |
| `model-prompts.ts`     | System instruction templates                              |
| `event-store.ts`       | In-memory event log per session                           |
| `rate-limit.ts`        | Per-session / per-IP / per-token rate limiting            |
| `workspace-context.ts` | Workspace file cache                                      |
| `tasks.ts`             | Task queue and state (disabled when `MCP_STATELESS=true`) |

### Environment Variables

| Variable                          | Purpose                             |
| --------------------------------- | ----------------------------------- |
| `API_KEY`                         | Google Gemini API key (required)    |
| `MCP_TRANSPORT`                   | `stdio` \| `http` \| `web-standard` |
| `MCP_HTTP_PORT` / `MCP_HTTP_HOST` | HTTP bind address                   |
| `MCP_HTTP_TOKEN`                  | Bearer token for HTTP auth          |
| `MCP_SESSION_TTL_MS`              | Session TTL in milliseconds         |
| `MCP_MAX_SESSIONS`                | Max concurrent sessions             |
| `MCP_STATELESS`                   | Disable task capability             |
| `MCP_EXPOSE_SESSION_RESOURCES`    | Enable session/transcript resources |

### Tests

Tests use Node's built-in `node:test` framework with `tsx/esm` loader. Test files live in `__tests__/` (excluded from TypeScript compilation via `tsconfig.json`). The `.env` file is loaded automatically during test runs.

### TypeScript Config

Strict mode with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`. Target is ES2024, module system is NodeNext. `verbatimModuleSyntax` is on — always use `import type` for type-only imports.
