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
- `gemini://sessions/{sessionId}/turns/{turnIndex}/parts`
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
- `gemini://sessions/{sessionId}/turns/{turnIndex}/parts`

`session://{sessionId}/events` is a normalized inspection summary, not a replay-ready Gemini history.
Large event payloads may be truncated into previews.
`gemini://sessions/{sessionId}/turns/{turnIndex}/parts` exposes the raw persisted Gemini `Part[]`
for replay-safe orchestration of a specific model turn.

Internally, sessions keep two separate records: a replay substrate made from raw Gemini `Content[]`
parts plus the original generation contract, and a normalized audit log for session resources.
Rebuilt sessions use only the replay substrate so thinking signatures, function/tool call pairs,
function responses, system instructions, tool declarations, and response format settings survive
live chat eviction without changing the public session resources.
Non-thought signature-bearing text parts are preserved for Gemini replay; `thought: true` parts are
not replayed.

Workspace context state is exposed through `discover://context`, `workspace://context`, and `workspace://cache`.

## Capability Notes

The job-first surface is intentionally opinionated:

- `research.mode` is required and chooses between quick lookup and deeper multi-step research.
- `outputKind` is required for `analyze` and chooses between summary analysis and diagram generation.
- `subjectKind="failure"` is the public failure-diagnosis path.
- `chat.responseSchemaJson` is intended for single-turn calls and brand-new sessions.
- The public surface does not expose the legacy `discover` callable tool or the retired standalone `search`, `analyze_url`, `agentic_search`, `explain_error`, `diagram`, or `execute_code` tools.
- `chat` and `research` can use Gemini File Search stores; Live API sessions are not exposed.
- `thinkingBudget` is available anywhere `thinkingLevel` is accepted and maps directly to
  Gemini `thinkingConfig.thinkingBudget`.

### Structured Output Notes

Successful tool results may include these optional metadata fields in `structuredContent`:

- `usage.toolUsePromptTokenCount`, `usage.promptTokensDetails`, `usage.cacheTokensDetails`, and
  `usage.candidatesTokensDetails` when Gemini returns them.
- `safetyRatings`, `finishMessage`, and `citationMetadata` from the selected candidate.
- `functionCalls[]` may omit `name` if Gemini emitted a nameless function-call part; nameless calls
  are not counted in tool usage rollups.

Research results separate Google Search grounding from URL Context:

- `grounded` is true only when Google Search grounding sources exist.
- `urlContextUsed` and `urlContextSources[]` report successful URL Context retrieval.
- `sourceDetails[].origin` is `googleSearch`, `urlContext`, or `both`.
- `warnings[]` may include dropped non-public grounding-support counts; private URLs are never
  surfaced.
- Google Search Suggestions are returned in both `structuredContent.searchEntryPoint` and
  `content[]` for clients that render only content blocks.

### Tool Capability Matrix

Orchestration composes server-side tool capabilities per call. `googleSearch`, `urls`, File Search, Code Execution, and chat function declarations are additive when supported by the selected job.

| Profile       | Google Search | URL Context | Code Execution |
| ------------- | :-----------: | :---------: | :------------: |
| `none`        |       -       |      -      |       -        |
| `search`      |       ✓       |      -      |       -        |
| `url`         |       -       |      ✓      |       -        |
| `code`        |       -       |      -      |       ✓        |
| `search_url`  |       ✓       |      ✓      |       -        |
| `search_code` |       ✓       |      -      |       ✓        |
| `url_code`    |       -       |      ✓      |       ✓        |

| Tool       | `googleSearch?` | `urls?` | `fileSearch?` | `functions?` | Notes                                                         |
| ---------- | :-------------: | :-----: | :-----------: | :----------: | ------------------------------------------------------------- |
| `chat`     |        ✓        |    ✓    |       ✓       |      ✓       | Function execution is owned by the MCP client.                |
| `research` |        ✓        |    ✓    |       ✓       |      -       | `mode="deep"` always enables Google Search.                   |
| `analyze`  |        ✓        |    ✓    |       -       |      -       | Diagram + URL target auto-selects `url_code` when validating. |
| `review`   |        ✓        |    ✓    |       -       |      -       | `urls` available on `comparison` and `failure` subjects.      |

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
- `AUTO_SCAN`: auto-scan workspace roots for known project files, default `false`

Workspace cache:

- `CACHE`: enable automatic workspace context caching for `chat` calls when set to `true`, default `true`
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
- `MCP_HTTP_TOKEN`: bearer token required when `HOST` is not `127.0.0.1`, `::1`, or `localhost`; must be at least 32 characters
- `MCP_HTTP_RATE_LIMIT_RPS`: per-session/IP request refill rate for `/mcp`, default `10`
- `MCP_HTTP_RATE_LIMIT_BURST`: per-session/IP request burst for `/mcp`, default `20`
- `MAX_TRANSPORT_SESSIONS`: maximum stateful HTTP transport sessions, default `100`
- `TRANSPORT_SESSION_TTL_MS`: idle TTL for stateful HTTP transport sessions, default `1800000`
- `SESSION_REPLAY_MAX_BYTES`: byte budget for rebuilt chat history, default `200000`
- `SESSION_REPLAY_INLINE_DATA_MAX_BYTES`: max inline media bytes retained in replay history, default `65536`

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

For non-loopback HTTP binds, set `MCP_HTTP_TOKEN` and send requests with
`Authorization: Bearer <token>`. Requests over the configured burst return `429`
with `Retry-After`.

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
