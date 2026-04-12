# AGENTS.md

## Project Overview

General-purpose Gemini AI assistant exposed as an MCP (Model Context Protocol) server over stdio. Built with TypeScript (ES modules), Node.js ≥ 24, and the `@google/genai` SDK.

## Architecture

```text
src/
├── index.ts          # Entry point — creates McpServer, registers tools, connects stdio transport
├── client.ts         # Shared GoogleGenAI client instance and MODEL constant
├── sessions.ts       # In-memory multi-turn chat session store with TTL eviction
├── lib/
│   ├── errors.ts     # errorResult / geminiErrorResult helpers for MCP error responses
│   ├── file-utils.ts # MIME type mapping, MAX_FILE_SIZE constant (20 MB)
│   ├── path-validation.ts  # Resolves + validates file paths against ALLOWED_FILE_ROOTS
│   └── response.ts   # extractTextOrError — unwraps Gemini responses, handles safety/block reasons
├── schemas/
│   ├── inputs.ts     # Zod v4 input schemas for all tools
│   └── outputs.ts    # Zod v4 structured output schemas (execute_code)
└── tools/
    ├── ask.ts         # "ask" tool — single/multi-turn chat
    ├── execute-code.ts # "execute_code" tool — sandboxed code execution
    ├── search.ts      # "search" tool — Google Search grounded answers
    ├── analyze-file.ts # "analyze_file" tool — file upload + analysis
    └── cache.ts       # "create_cache" / "list_caches" / "delete_cache" tools
```

## Tools

| Tool           | Description                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| `ask`          | Send a message to Gemini. Supports multi-turn chat via `sessionId`, optional `systemInstruction` and `cacheName`.     |
| `execute_code` | Have Gemini generate and execute code in a sandbox. Returns structured `{ code, output, explanation }`.               |
| `search`       | Answer questions using Gemini with Google Search grounding. Appends source URLs.                                      |
| `analyze_file` | Upload a local file to Gemini and ask questions about it. Supports PDFs, images, code, docs, audio, video. Max 20 MB. |
| `create_cache` | Create a Gemini context cache from files and/or system instructions. Content must exceed ~32k tokens.                 |
| `list_caches`  | List all active Gemini context caches.                                                                                |
| `delete_cache` | Delete a Gemini context cache by resource name.                                                                       |

## Build & Run

```bash
npm install
npm run build        # tsc → dist/
npm start            # node dist/index.js (requires GEMINI_API_KEY)
npm run check        # tsc + eslint + prettier + knip
npm run format       # prettier --write
```

## Environment Variables

| Variable             | Required | Default                  | Description                                         |
| -------------------- | -------- | ------------------------ | --------------------------------------------------- |
| `GEMINI_API_KEY`     | Yes      | —                        | Google AI API key                                   |
| `GEMINI_MODEL`       | No       | `gemini-3-flash-preview` | Model identifier                                    |
| `SESSION_TTL_MS`     | No       | `1800000` (30 min)       | Multi-turn session expiry                           |
| `MAX_SESSIONS`       | No       | `50`                     | Max concurrent chat sessions                        |
| `ALLOWED_FILE_ROOTS` | No       | `process.cwd()`          | Comma-separated allowed directories for file access |

## Code Conventions

- **ESM-only** — all imports use `.js` extensions, `"type": "module"` in package.json
- **Strict TypeScript** — `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` enabled
- **Zod v4** — import from `zod/v4`, use `z.object()` for input schemas
- **Conditional spreads** — use `...(x ? { key: x } : {})` instead of assigning `undefined` to optional properties (required by `exactOptionalPropertyTypes`)
- **Error handling** — tools return `CallToolResult` with `isError: true`, never throw. Gemini API errors are mapped via `geminiErrorResult` with HTTP status hints.
- **Console output** — only `console.error` is allowed (stdout is reserved for JSON-RPC)
- **Linting** — ESLint with `typescript-eslint` strict + type-checked rules, Prettier for formatting
- **Unused code** — Knip for dead export/dependency detection
- **File cleanup** — uploaded files are deleted in `finally` blocks after Gemini API calls

## Session Management

Multi-turn chat sessions are stored in-memory with LRU-style eviction:

- Sessions expire after `SESSION_TTL_MS` (default 30 min)
- Max `MAX_SESSIONS` concurrent sessions (default 50); oldest evicted when full
- Evicted session IDs are tracked (up to 1000) to return clear expiry errors
- A `cacheName` cannot be applied to an existing session — must start a new one

## File Safety

- File paths must be absolute
- Paths are resolved through `realpath` to prevent symlink escapes
- All paths are validated against `ALLOWED_FILE_ROOTS` (case-insensitive on Windows)
- Max file size: 20 MB
