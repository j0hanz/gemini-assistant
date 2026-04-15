# Gemini Assistant

Gemini Assistant is a Model Context Protocol server that exposes Google Gemini as a tool-oriented assistant. It supports multi-turn chat, grounded web research, URL analysis, file analysis, sandboxed code execution, cache management, PR review, file comparison, and diagram generation.

## Requirements

- Node.js `>=24`
- An `API_KEY` for the Gemini API
- `npm`

## Install

```bash
npm install
```

## Run

Stdio transport for local MCP clients:

```bash
API_KEY=your-key npm start
```

Development entrypoint without a build:

```bash
API_KEY=your-key npx tsx src/index.ts
```

HTTP transport:

```bash
API_KEY=your-key MCP_TRANSPORT=http npx tsx src/index.ts
```

Web-standard transport:

```bash
API_KEY=your-key MCP_TRANSPORT=web-standard npx tsx src/index.ts
```

## Environment

- `API_KEY`: required Gemini API key.
- `GEMINI_MODEL`: optional model override. Default: `gemini-3-flash-preview`.
- `GEMINI_EXPOSE_THOUGHTS`: optional. Default: `false`. When `true`, non-JSON tool responses may include Gemini thought text in structured output.
- `MCP_TRANSPORT`: `stdio`, `http`, or `web-standard`. Default: `stdio`.
- `MCP_HTTP_PORT`: HTTP bind port. Default: `3000`.
- `MCP_HTTP_HOST`: HTTP bind host. Default: `127.0.0.1`.
- `MCP_STATELESS`: when `true`, streamable HTTP uses stateless per-request transports. When unset or `false`, HTTP/Web transports keep per-session transport instances.
- `MCP_CORS_ORIGIN`: optional `Access-Control-Allow-Origin` value for HTTP mode.
- `MCP_ALLOWED_HOSTS`: optional comma-separated host allowlist for Host-header validation.
- `ALLOWED_FILE_ROOTS`: optional comma-separated absolute roots allowed for file tools. Default: current working directory.
- `SESSION_TTL_MS`: session idle TTL in milliseconds. Default: `1800000`.
- `MAX_SESSIONS`: max in-memory chat sessions before LRU eviction. Default: `50`.

## Tools

- `ask`: single-turn or multi-turn Gemini chat with optional structured output and Google Search.
- `search`: Gemini web-grounded answering with optional public URL analysis.
- `agentic_search`: deeper research using Google Search and code execution.
- `analyze_url`: analyze one or more public `http/https` URLs.
- `analyze_file`: upload and analyze a local file from allowed roots.
- `execute_code`: generate and run code in Gemini's sandbox.
- `analyze_pr`: build a local git diff, include reviewable untracked files, and ask Gemini for a review.
- `explain_error`: diagnose stack traces and error output.
- `compare_files`: upload two files and compare them.
- `generate_diagram`: generate Mermaid or PlantUML diagrams.
- `create_cache`, `list_caches`, `update_cache`, `delete_cache`: manage Gemini cached context.

## Prompts And Resources

Registered prompts:

- `analyze-file`
- `code-review`
- `summarize`
- `explain-error`

Registered resources:

- `sessions://list`
- `sessions://{sessionId}`
- `caches://list`
- `caches://{cacheName}`

## Workflow Notes

- Task-aware tools run through MCP task support and bridge progress updates into task status messages.
- Session and cache resources emit resource-list and resource-update notifications when state changes.
- Session expiry is enforced both by periodic cleanup and immediately on read, so stale sessions cannot be revived by access timing.
- Search-style outputs keep legacy `sources: string[]` and now also expose structured `sourceDetails` entries when available.
- `analyze_pr` budgets reviews by whole-file diff units and reports omitted paths when the review budget is exceeded.
- `delete_cache` uses interactive confirmation when available; otherwise callers must pass `confirm=true`.

## Safety Boundaries

- File tools require absolute paths and restrict access to configured roots.
- URL tools only accept public `http/https` URLs and reject localhost, loopback, and private-network literals.
- Host-header validation is supported for HTTP and web-standard transports through `MCP_ALLOWED_HOSTS`.
- Uploaded Gemini file handles must contain a non-empty `name`; incomplete handles are treated as failures.

## Commands

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
