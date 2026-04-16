# Gemini Assistant

`gemini-assistant` is an MCP server that packages Google Gemini around clear workflows: chat, deep research, file analysis, local diff review, caches, and session inspection.

## Start Here

First-run MCP flow:

1. Read `tools://list` for the full discovery catalog of tools, prompts, and resources.
2. Read `workflows://list` and start with `getting-started`.
3. Use the `getting-started` prompt or call `ask` directly for the first task.
4. If you create a multi-turn chat, inspect `sessions://list`, `sessions://{sessionId}`, `sessions://{sessionId}/transcript`, and `sessions://{sessionId}/events`.

Key workflow prompts:

- `getting-started`
- `deep-research`
- `project-memory`
- `diff-review`
- `analyze-file`

## Common Jobs

- Quick Gemini chat or structured JSON output: `ask`
- Advanced built-in tool orchestration in chat: `ask` with `toolProfile`
- Grounded web answer: `search`
- Multi-step research with sources: `agentic_search` or `deep-research`
- Analyze one local file: `analyze_file` or `analyze-file`
- Review the current repo diff: `analyze_pr` or `diff-review`
- Compare two local files: `compare_files`
- Diagnose an error message: `explain_error` or `explain-error`
- Reuse large project context: `create_cache`, `list_caches`, `update_cache`, `delete_cache`

## Capability Matrix

| Capability        | Status        | Notes                                                                                        |
| ----------------- | ------------- | -------------------------------------------------------------------------------------------- |
| Code Execution    | `partial`     | Implemented through Gemini code execution. Runtime is Python-only.                           |
| Structured Output | `partial`     | Implemented on `ask` with `responseSchema`, but only for single-turn calls and new sessions. |
| Tool Combination  | `partial`     | Implemented through normalized tool/function events and selected tool presets.               |
| File Search       | `unsupported` | This server does not expose Gemini File Search stores or persistent indexed retrieval.       |
| Live API          | `unsupported` | This server does not expose Gemini Live API sessions, audio, or video flows.                 |

## Sessions Versus Caches

Use sessions when the context is conversational and should evolve turn by turn. Sessions are created by `ask` with a `sessionId`, listed in `sessions://list`, and inspectable through `sessions://{sessionId}`, `sessions://{sessionId}/transcript`, and `sessions://{sessionId}/events`.

If `ask` uses Gemini built-in tools, `sessions://{sessionId}/events` exposes a normalized tool/function inspection summary for that live session. It is not a raw replay-ready Gemini history. Tool-combination state is in-memory only and disappears when the session expires or is evicted.

`ask.responseSchema` is supported for single-turn calls and brand-new sessions. It cannot be applied to an existing session.

Use caches when the same large context should be reused across multiple asks or across different sessions. Cache state is exposed through `caches://list` and `caches://{cacheName}`.

The practical split:

- Session: live working memory for one thread
- Cache: reusable reference context for many calls
- Transcript resource: read-only visibility into the live session history
- Events resource: read-only visibility into the normalized Gemini tool/function activity summary for the live session

## Discovery Resources

Public resources:

- `tools://list`
- `workflows://list`
- `sessions://list`
- `sessions://{sessionId}`
- `sessions://{sessionId}/transcript`
- `sessions://{sessionId}/events`
- `caches://list`
- `caches://{cacheName}`
- `workspace://context`
- `workspace://cache`

`tools://list` returns a concise JSON catalog of tools, prompts, and resources. `workflows://list` returns opinionated starter workflows, with `getting-started` first.

Each tool entry in `tools://list` may also include `limitations` when the public contract is narrower than the underlying Google docs.

## Requirements

- Node.js `>=24`
- `npm`
- Gemini API key in `API_KEY`

## Environment

Minimal `.env` example:

```env
API_KEY=your-gemini-api-key
MCP_TRANSPORT=stdio
```

Useful optional variables:

- `GEMINI_MODEL`: override the default model (`gemini-3-flash-preview`)
- `GEMINI_EXPOSE_THOUGHTS`: expose Gemini thought text in non-JSON outputs when set to `true`
- `MCP_TRANSPORT`: `stdio`, `http`, or `web-standard`
- `MCP_HTTP_PORT`: HTTP bind port, default `3000`
- `MCP_HTTP_HOST`: HTTP bind host, default `127.0.0.1`
- `MCP_STATELESS`: enable stateless streamable HTTP mode when set to `true`
- `MCP_CORS_ORIGIN`: optional `Access-Control-Allow-Origin` for HTTP mode
- `MCP_ALLOWED_HOSTS`: optional comma-separated host allowlist for HTTP/web-standard mode
- `ALLOWED_FILE_ROOTS`: optional comma-separated absolute roots allowed for file tools
- `SESSION_TTL_MS`: session idle TTL in milliseconds, default `1800000`
- `MAX_SESSIONS`: max in-memory chat sessions before LRU eviction, default `50`

File path handling:

- File-input fields accept either workspace-relative paths like `src/index.ts` or absolute paths.
- Relative paths resolve against the active MCP workspace root when the client provides one.
- If the client does not expose workspace roots, relative paths resolve against the server `cwd`.
- If the same relative path matches more than one active workspace root, the server returns an ambiguity error.
- `ALLOWED_FILE_ROOTS` remains an absolute-root security boundary for file access.

Gemini tool-combination notes:

- Built-in tool combination remains a Gemini 3 preview feature.
- This server preserves tool/function event history in session memory only.
- `sessions://{sessionId}/events` is an inspection surface, not a replay contract.
- `ask.toolProfile` supports `none`, `search`, `url`, `search_url`, `code`, and `search_code`.

## Run

Install dependencies:

```bash
npm install
```

Development entrypoint without a build:

```bash
npx tsx src/index.ts
```

Run built output:

```bash
npm run build
npm start
```

HTTP transport:

```bash
MCP_TRANSPORT=http npx tsx src/index.ts
```

Web-standard transport:

- Auto-serves only when the process is running under Bun or Deno.
- In Node, `startWebStandardTransport()` returns a `handler` but does not start a listener, so `MCP_TRANSPORT=web-standard npx tsx src/index.ts` is not a runnable server entrypoint.
- If you are running from Node, use `stdio` or `http` unless you are importing the transport and wiring the handler yourself.

Bun example:

```bash
MCP_TRANSPORT=web-standard bun run src/index.ts
```

## MCP Client Setup

Minimal stdio client configuration:

```json
{
  "mcpServers": {
    "gemini-assistant": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "cwd": "/absolute/path/to/gemini-assistant",
      "env": {
        "API_KEY": "your-gemini-api-key",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

## Tool Surface

Tools:

- `ask`
- `search`
- `agentic_search`
- `analyze_url`
- `analyze_file`
- `execute_code`
- `analyze_pr`
- `explain_error`
- `compare_files`
- `generate_diagram`
- `create_cache`
- `list_caches`
- `update_cache`
- `delete_cache`

Prompt wrappers:

- `getting-started`
- `deep-research`
- `project-memory`
- `diff-review`
- `analyze-file`
- `code-review`
- `summarize`
- `explain-error`

## Safety Boundaries

- File tools require workspace-relative or absolute paths inside configured roots.
- URL tools accept only public `http/https` URLs.
- Sessions and transcripts are in-memory only and disappear on expiry or eviction.
- `execute_code` uses Gemini's Python runtime; `language` is advisory only.
- Cache tooling does not change the core Gemini tool set or transport model.
- `list_caches` is the single non-tasked read-only outlier in the tool surface.

## Commands

Required checks:

```bash
npm run lint
npm run type-check
npm run test
```

Optional:

```bash
npm run format
npm run build
```
