# Gemini Assistant

`gemini-assistant` is an MCP server that exposes a job-first public surface over Google Gemini.
The public contract is five tools:

- `chat`
- `research`
- `analyze`
- `review`
- `memory`
- `discover`

## Start Here

Recommended first-run flow:

1. Read `discover://catalog` for the full public catalog.
2. Read `discover://workflows` for guided entry points.
3. Use the `discover` prompt if you want a recommendation before choosing a job.
4. Use `chat` once the right starting point is clear.

Public prompts:

- `discover`
- `research`
- `review`
- `memory`

Public resources:

- `discover://catalog`
- `discover://context`
- `discover://workflows`
- `memory://sessions`
- `memory://sessions/{sessionId}`
- `memory://sessions/{sessionId}/transcript`
- `memory://sessions/{sessionId}/events`
- `memory://caches`
- `memory://caches/{cacheName}`
- `memory://workspace/context`
- `memory://workspace/cache`

Workflow entries:

- `start-here`
- `chat`
- `research`
- `analyze`
- `review`
- `memory`

## Common Jobs

- Direct Gemini chat with optional server-managed sessions: `chat`
- Quick or deep research with grounded results: `research`
- Analyze a local file, public URLs, a small file set, or generate a diagram: `analyze`
- Review a diff, compare files, or diagnose a failure through `subjectKind="failure"`: `review`
- Inspect or mutate sessions, caches, and workspace memory state: `memory`

## Sessions And Caches

`chat` uses server-managed in-memory sessions. Session state is inspectable through:

- `memory://sessions`
- `memory://sessions/{sessionId}`
- `memory://sessions/{sessionId}/transcript`
- `memory://sessions/{sessionId}/events`

`memory://sessions/{sessionId}/events` is a normalized inspection summary, not a replay-ready Gemini history.
Large event payloads may be truncated into previews.

Use `memory` cache actions when the same large context should be reused across multiple calls.
Cache state is exposed through `memory://caches` and `memory://caches/{cacheName}`.
Server context state is exposed through `discover://context`.

## Capability Notes

The job-first surface is intentionally opinionated:

- `research.mode` is required and chooses between quick lookup and deeper multi-step research.
- `outputKind` is required for `analyze` and chooses between summary analysis and diagram generation.
- `subjectKind="failure"` is the public failure-diagnosis path.
- `memory.action` is a discriminated union; it does not accept generic target/input bags.
- `chat.responseSchemaJson` is intended for single-turn calls and brand-new sessions.
- The public surface does not expose the legacy `discover` callable tool or the retired standalone `search`, `analyze_url`, `agentic_search`, `explain_error`, `diagram`, or `execute_code` tools.
- The public surface does not expose Gemini File Search stores or Live API sessions.

## Notification Surface

The server emits four MCP notification methods with narrow, contract-stable rules:

- `notifications/progress` — emitted only when the caller supplies `_meta.progressToken`. Inside a task context every progress frame also carries `_meta["io.modelcontextprotocol/related-task"] = { taskId }` so clients can correlate async progress to the owning task.
- `notifications/resources/list_changed` — fired only when collection membership actually changes (e.g., a session is added or removed). In-place replacements of an existing entry do not trigger `list_changed`.
- `notifications/resources/updated` — fired at the collection level (for example `memory://sessions`, `memory://caches`). Per-URI detail updates are not broadcast because the server does not advertise `resources.subscribe`. Clients should re-read the affected collection after a `list_changed` or collection-level `updated`.
- `notifications/message` — reserved for diagnostic log output. Streaming tool content is delivered through the normal `tools/call` response (and `tasks/result` when running under a task); it is never published on the logging channel.

Session-scoped resources such as `discover://context` update only the originating server/session — they are never fanned out to other concurrent clients.

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
- `GEMINI_EXPOSE_THOUGHTS`: expose Gemini thought text in outputs when set to `true`
- `MCP_TRANSPORT`: `stdio`, `http`, or `web-standard`
- `MCP_HTTP_PORT`: HTTP bind port, default `3000`
- `MCP_HTTP_HOST`: HTTP bind host, default `127.0.0.1`
- `MCP_STATELESS`: enable stateless streamable HTTP mode when set to `true`
- `MCP_CORS_ORIGIN`: optional `Access-Control-Allow-Origin` for HTTP mode
- `MCP_ALLOWED_HOSTS`: optional comma-separated explicit host allowlist for HTTP/web-standard mode
- `ALLOWED_FILE_ROOTS`: optional comma-separated absolute roots allowed for file tools, `memory://workspace/context`, and automatic workspace caching
- `SESSION_TTL_MS`: session idle TTL in milliseconds, default `1800000`
- `MAX_SESSIONS`: max in-memory chat sessions before LRU eviction, default `50`
- `WORKSPACE_CACHE_ENABLED`: enable automatic workspace context caching for `chat` calls when set to `true`, default `false`
- `WORKSPACE_CONTEXT_FILE`: optional path to a custom context file to include in workspace context
- `WORKSPACE_CACHE_TTL`: Gemini cache TTL for workspace context, default `3600s`
- `WORKSPACE_AUTO_SCAN`: auto-scan workspace roots for known project files when set to `true` (default), set `false` to disable
- `CONTEXT_BUDGET_TOKENS`: max token budget for request-aware context assembly, default `8192`

Host validation defaults:

- localhost binds accept `localhost`, `127.0.0.1`, and `[::1]`
- broad binds such as `0.0.0.0` and `::` remain unrestricted unless `MCP_ALLOWED_HOSTS` is set
- any other `MCP_HTTP_HOST` is treated as the default allowed Host header when `MCP_ALLOWED_HOSTS` is unset

If clients reach the server through a DNS alias, reverse proxy, or load balancer hostname that differs from `MCP_HTTP_HOST`, set `MCP_ALLOWED_HOSTS` to the externally visible hostnames or those requests will be rejected.

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
- In Node, `startWebStandardTransport()` returns a `handler` but does not start a listener.

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

## Safety Boundaries

- File inputs require workspace-relative or absolute paths inside configured roots.
- URL inputs accept only public `http/https` URLs.
- Sessions and transcripts are in-memory only and disappear on expiry or eviction.
- The public surface intentionally has no backward-compatible aliases for the legacy tool names.

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
