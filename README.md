# Gemini Assistant

`gemini-assistant` is an MCP server that exposes a job-first public surface over Google Gemini.
The public contract is four tools:

- `chat`
- `research`
- `analyze`
- `review`

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

Public resources:

- `discover://catalog`
- `discover://context`
- `discover://workflows`
- `session://`
- `session://{sessionId}`
- `session://{sessionId}/transcript`
- `session://{sessionId}/events`
- `workspace://context`
- `workspace://cache`

Workflow entries:

- `start-here`
- `chat`
- `research`
- `analyze`
- `review`

## Common Jobs

- Direct Gemini chat with optional server-managed sessions: `chat`
- Quick or deep research with grounded results: `research`
- Analyze a local file, public URLs, a small file set, or generate a diagram: `analyze`
- Review a diff, compare files, or diagnose a failure through `subjectKind="failure"`: `review`

## Sessions And Caches

`chat` uses server-managed in-memory sessions. Session state is inspectable through:

- `session://`
- `session://{sessionId}`
- `session://{sessionId}/transcript`
- `session://{sessionId}/events`

`session://{sessionId}/events` is a normalized inspection summary, not a replay-ready Gemini history.
Large event payloads may be truncated into previews.

Workspace context state is exposed through `discover://context`, `workspace://context`, and `workspace://cache`.

## Capability Notes

The job-first surface is intentionally opinionated:

- `research.mode` is required and chooses between quick lookup and deeper multi-step research.
- `outputKind` is required for `analyze` and chooses between summary analysis and diagram generation.
- `subjectKind="failure"` is the public failure-diagnosis path.
- `chat.responseSchemaJson` is intended for single-turn calls and brand-new sessions.
- The public surface does not expose the legacy `discover` callable tool or the retired standalone `search`, `analyze_url`, `agentic_search`, `explain_error`, `diagram`, or `execute_code` tools.
- The public surface does not expose Gemini File Search stores or Live API sessions.

### Tool Capability Matrix

Orchestration resolves one of seven server-side tool profiles per call. `googleSearch` and `urls` are additive flags — supplying both yields a combined profile.

| Profile       | Google Search | URL Context | Code Execution |
| ------------- | :-----------: | :---------: | :------------: |
| `none`        |       -       |      -      |       -        |
| `search`      |       ✓       |      -      |       -        |
| `url`         |       -       |      ✓      |       -        |
| `code`        |       -       |      -      |       ✓        |
| `search_url`  |       ✓       |      ✓      |       -        |
| `search_code` |       ✓       |      -      |       ✓        |
| `url_code`    |       -       |      ✓      |       ✓        |

| Tool       | `googleSearch?` | `urls?` | Notes                                                         |
| ---------- | :-------------: | :-----: | ------------------------------------------------------------- |
| `chat`     |        ✓        |    ✓    | URLs are retrieved via URL Context when active.               |
| `research` |        ✓        |    ✓    | `mode="deep"` always enables Google Search.                   |
| `analyze`  |        ✓        |    ✓    | Diagram + URL target auto-selects `url_code` when validating. |
| `review`   |        ✓        |    ✓    | `urls` available on `comparison` and `failure` subjects.      |

## Notification Surface

The server emits four MCP notification methods with narrow, contract-stable rules:

- `notifications/progress` — emitted only when the caller supplies `_meta.progressToken`. Inside a task context every progress frame also carries `_meta["io.modelcontextprotocol/related-task"] = { taskId }` so clients can correlate async progress to the owning task.
- `notifications/resources/list_changed` — fired only when collection membership actually changes (e.g., a session is added or removed). In-place replacements of an existing entry do not trigger `list_changed`.
- `notifications/resources/updated` — fired at the collection level (for example `session://`). Per-URI detail updates are not broadcast because the server does not advertise `resources.subscribe`. Clients should re-read the affected collection after a `list_changed` or collection-level `updated`.
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
TRANSPORT=stdio
```

Useful optional variables:

Model:

- `MODEL`: override the default model (`gemini-3-flash-preview`)
- `THOUGHTS`: expose Gemini thought text in outputs when set to `true`

Workspace:

- `ROOTS`: optional comma-separated absolute roots allowed for file tools, `workspace://context`, and automatic workspace caching
- `CONTEXT`: optional path to a custom context file to include in workspace context
- `AUTO_SCAN`: auto-scan workspace roots for known project files, default `true`

Workspace cache:

- `CACHE`: enable automatic workspace context caching for `chat` calls when set to `true`, default `false`
- `CACHE_TTL`: Gemini cache TTL for workspace context, default `3600s`

Debug:

- `LOG_PAYLOADS`: enable verbose payload logging when set to `true`

Optional local transport:

- `TRANSPORT`: `stdio`, `http`, or `web-standard`, default `stdio`
- `HOST`: HTTP bind host, default `127.0.0.1`
- `PORT`: HTTP bind port, default `3000`
- `CORS_ORIGIN`: optional CORS origin for HTTP transports; use `*` or one `http(s)` origin
- `STATELESS`: enable stateless HTTP transport behavior when set to `true`, default `false`
- `ALLOWED_HOSTS`: optional comma-separated Host header allow-list for HTTP transports
- `MAX_TRANSPORT_SESSIONS`: maximum stateful HTTP transport sessions, default `100`
- `TRANSPORT_SESSION_TTL_MS`: idle TTL for stateful HTTP transport sessions, default `1800000`

Booleans accept only the literal strings `true` or `false` when set. Old variable names (`GEMINI_MODEL`, `ALLOWED_FILE_ROOTS`, `WORKSPACE_*`, `MCP_TRANSPORT`, `MCP_HTTP_HOST`, `MCP_HTTP_PORT`, `LOG_VERBOSE_PAYLOADS`, etc.) are not supported and have no effect.

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
TRANSPORT=http npx tsx src/index.ts
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
        "TRANSPORT": "stdio"
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
