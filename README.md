# Gemini Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](#license) [![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![MCP](https://img.shields.io/badge/MCP-2.0--alpha-7e3aaf?style=for-the-badge)](https://modelcontextprotocol.io) [![Last Commit](https://img.shields.io/github/last-commit/j0hanz/gemini-assistant?style=for-the-badge)](https://github.com/j0hanz/gemini-assistant/commits/master)

Workflow-first Model Context Protocol server for Google Gemini — chat, research, file analysis, and review under one job-first surface.

## Overview

`gemini-assistant` is an MCP server that exposes Google Gemini behind a fixed, job-first public contract: four tools (`chat`, `research`, `analyze`, `review`), three prompts, and a small set of discovery and session resources. It supports stdio, HTTP, and web-standard transports, persists replay-safe session history, and surfaces grounding, citations, and usage metadata to the orchestrator.

| Aspect       | Details                            |
| :----------- | :--------------------------------- |
| **Status**   | Active                             |
| **Language** | TypeScript (strict, ESM, NodeNext) |
| **Runtime**  | Node.js `>=24`                     |
| **Package**  | npm                                |
| **License**  | MIT                                |

## Highlights

| Feature             | Description                                                                                  |
| :------------------ | :------------------------------------------------------------------------------------------- |
| Job-first surface   | Frozen public contract: four tools, three prompts, discovery + session resources             |
| Multi-turn sessions | In-memory chat sessions with sanitized, replay-safe history and preserved thought signatures |
| Grounded research   | Quick or deep modes with Google Search, URL Context, and optional Gemini File Search         |
| Multimodal analyze  | Reason over local files, public URLs, or small file sets with one focused goal               |
| Diff-aware review   | Review local diffs, compare files, and diagnose failures behind one tool                     |
| Tasks-capable       | Optional task-aware execution with progress notifications when transport supports it         |

## Built With

[![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![Express](https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com) [![Zod](https://img.shields.io/badge/Zod-3E67B1?style=for-the-badge)](https://zod.dev) [![Gemini](https://img.shields.io/badge/Google%20Gemini-8E75B2?style=for-the-badge&logo=google&logoColor=white)](https://ai.google.dev)

| Layer      | Technology                                                           |
| :--------- | :------------------------------------------------------------------- |
| Protocol   | `@modelcontextprotocol/server` and `@modelcontextprotocol/node` (v2) |
| Model SDK  | `@google/genai`                                                      |
| HTTP       | `express`                                                            |
| Validation | `zod` v4 + `@cfworker/json-schema`                                   |
| Tooling    | `tsx`, `eslint`, `prettier`, `knip`, `typescript-eslint`             |

## Quick Start

> [!TIP]
> Get running in under 60 seconds. Requires Node.js `>=24` and a Google Gemini API key.

### Prerequisites

| Requirement    | Version / Notes                                                                         |
| :------------- | :-------------------------------------------------------------------------------------- |
| Node.js        | `>=24`                                                                                  |
| npm            | Bundled with Node.js                                                                    |
| Gemini API key | Set `API_KEY` in `.env` — get one at [aistudio.google.com](https://aistudio.google.com) |

### Install

```bash
git clone https://github.com/j0hanz/gemini-assistant.git
cd gemini-assistant
npm install
echo "API_KEY=your-gemini-api-key" > .env
npm run build
npm start
```

### Verify Installation

```bash
npm run inspector
```

```text
Launches the MCP Inspector against the built server for interactive tool, prompt, and resource testing.
```

## Usage

Run as a stdio MCP server (default) and wire it into any MCP-compatible client:

```jsonc
{
  "mcpServers": {
    "gemini-assistant": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "API_KEY": "your-gemini-api-key",
        "TRANSPORT": "stdio",
      },
    },
  },
}
```

### Public Tools

| Tool       | Best For                                                                               |
| :--------- | :------------------------------------------------------------------------------------- |
| `chat`     | Direct Gemini chat with optional structured output, grounding, and multi-turn sessions |
| `research` | Web-grounded lookup with explicit `quick` or `deep` mode                               |
| `analyze`  | Reasoning over local files, public URLs, or small file sets with one focused goal      |
| `review`   | Reviewing local diffs, comparing files, or diagnosing failures                         |

### Public Prompts

| Prompt     | Purpose                                          |
| :--------- | :----------------------------------------------- |
| `discover` | Discover available tools, prompts, and workflows |
| `research` | Drive a multi-step research deliverable          |
| `review`   | Walk through a structured code or diff review    |

## Project Structure

```text
src/
  catalog.ts            Discovery catalog (tools, prompts, resources, workflows)
  client.ts             Gemini client wiring
  config.ts             Environment-variable parsing
  index.ts              Process bootstrap and transport dispatch
  prompts.ts            Public-prompt registration
  public-contract.ts    Frozen public surface (tools, prompts, resources)
  resources.ts          Discovery + session resource registration
  server.ts             createServerInstance() — wires capabilities
  sessions.ts           In-memory session store (parts + rawParts)
  transport.ts          HTTP and web-standard transport setup
  lib/                  Orchestration, streaming, response, executor, errors
  schemas/              Zod v4 input/output schemas + JSON-Schema validators
  tools/                analyze, chat, research, review tool implementations
__tests__/              Colocated unit + e2e suites (Node test runner)
```

| Path                                       | Purpose                                                       |
| :----------------------------------------- | :------------------------------------------------------------ |
| `src/public-contract.ts`                   | Canonical source of the frozen public surface                 |
| `src/server.ts`                            | `createServerInstance()` — capability + handler wiring        |
| `src/tools/`                               | One file per public tool; each exports `registerXxxTool()`    |
| `src/lib/`                                 | Shared orchestration, streaming, validation, and task helpers |
| `__tests__/lib/mock-gemini-environment.ts` | In-memory MCP transport for e2e tests                         |

## Configuration

| Variable                                  | Required |         Default          | Purpose                                                             |
| :---------------------------------------- | :------: | :----------------------: | :------------------------------------------------------------------ |
| `API_KEY`                                 |    V     |            —             | Google Gemini API key                                               |
| `MODEL`                                   |    -     | `gemini-3-flash-preview` | Default Gemini model                                                |
| `TRANSPORT`                               |    -     |         `stdio`          | One of `stdio`, `http`, `web-standard`                              |
| `STATELESS`                               |    -     |         `false`          | Disable sessions and the tasks capability                           |
| `MCP_EXPOSE_SESSION_RESOURCES`            |    -     |         `false`          | Expose transcript, events, and raw turn-parts resources             |
| `MCP_HTTP_TOKEN`                          |    -     |            —             | Bearer token for HTTP transport (≥32 chars)                         |
| `MCP_ALLOW_UNAUTHENTICATED_LOOPBACK_HTTP` |    -     |         `false`          | Allow loopback HTTP without `MCP_HTTP_TOKEN`                        |
| `MCP_TRUST_PROXY`                         |    -     |         `false`          | Trust upstream proxy headers when running behind a reverse proxy    |
| `MCP_HTTP_RATE_LIMIT_RPS`                 |    -     |        (built-in)        | Per-token request rate (requests per second)                        |
| `MCP_HTTP_RATE_LIMIT_BURST`               |    -     |        (built-in)        | Per-token burst capacity                                            |
| `CORS_ORIGIN`                             |    -     |            —             | CORS origin allowlist; `*` is rejected when `MCP_HTTP_TOKEN` is set |
| `ALLOWED_HOSTS`                           |    -     |            —             | Comma-separated host allowlist for HTTP transport                   |
| `ROOTS`                                   |    -     |            —             | Workspace roots used by file/diff tools                             |
| `CONTEXT`                                 |    -     |            —             | Default workspace context value                                     |
| `CACHE_TTL`                               |    -     |        (built-in)        | Workspace cache TTL                                                 |
| `LOG_DIR`                                 |    -     |            —             | Directory for log files                                             |
| `GEMINI_SAFETY_SETTINGS`                  |    -     |            —             | JSON-encoded default safety settings                                |
| `GEMINI_SESSION_REDACT_KEYS`              |    -     |            —             | Comma-separated keys to redact from session payloads                |

## Scripts

| Command                | Description                                                |
| :--------------------- | :--------------------------------------------------------- |
| `npm run build`        | TypeScript compile to `dist/`                              |
| `npm start`            | Run the compiled server (`dist/index.js`)                  |
| `npm run lint`         | ESLint with `--max-warnings=0`                             |
| `npm run lint:fix`     | ESLint auto-fix                                            |
| `npm run format`       | Prettier write                                             |
| `npm run format:check` | Prettier check                                             |
| `npm run type-check`   | `tsc --noEmit`                                             |
| `npm run knip`         | Detect unused exports, files, and dependencies             |
| `npm run test`         | Node built-in test runner with `tsx/esm` and `.env`        |
| `npm run check:static` | build + type-check + eslint + prettier + knip              |
| `npm run check`        | `check:static` plus the full test suite                    |
| `npm run inspector`    | Build and launch the MCP Inspector against `dist/index.js` |

## Documentation

| Resource                                                  | Description                                             |
| :-------------------------------------------------------- | :------------------------------------------------------ |
| [AGENTS.md](AGENTS.md)                                    | Agent guidance, safety boundaries, and change checklist |
| [CLAUDE.md](CLAUDE.md)                                    | Architecture overview and contributor commands          |
| [src/public-contract.ts](src/public-contract.ts)          | Canonical frozen public surface                         |
| [Model Context Protocol](https://modelcontextprotocol.io) | MCP specification and ecosystem                         |
| [Google Gemini API](https://ai.google.dev)                | Gemini SDK and model documentation                      |

## Roadmap

- [x] Frozen job-first public contract (chat, research, analyze, review)
- [x] Replay-safe session history with raw `Part[]` resource
- [x] HTTP and web-standard transports with bearer auth and rate limiting
- [x] Tasks capability with progress notifications
- [ ] Persistent session storage backend
- [ ] Additional grounding sources beyond Google Search and URL Context

## Security

> [!IMPORTANT]
> Do not commit `.env` or API keys. The server validates `MCP_HTTP_TOKEN` length and rejects wildcard CORS when authentication is enabled.

| Topic             | Detail                                                                                                     |
| :---------------- | :--------------------------------------------------------------------------------------------------------- |
| Reporting channel | Open a private security advisory on GitHub                                                                 |
| Auth requirement  | HTTP transport requires `MCP_HTTP_TOKEN` (≥32 chars) unless `MCP_ALLOW_UNAUTHENTICATED_LOOPBACK_HTTP=true` |
| Stdio safety      | Server code never writes to `stdout` outside the JSON-RPC stream — uses `logger` instead                   |
| Input validation  | All tool inputs validated through Zod v4 `z.strictObject()` at external boundaries                         |

## Contributing

Contributions are welcome. Run the full check pipeline locally before opening a pull request and keep the public contract in `src/public-contract.ts` stable unless an explicit contract change is requested.

| Step | Action                                             |
| :--: | :------------------------------------------------- |
|  1   | Fork the repository                                |
|  2   | Create a feature branch (`git checkout -b feat/x`) |
|  3   | Commit your changes with a clear message           |
|  4   | Run `npm run check` locally                        |
|  5   | Open a pull request                                |

[![Contributors](https://contrib.rocks/image?repo=j0hanz/gemini-assistant)](https://github.com/j0hanz/gemini-assistant/graphs/contributors)

## License

Released under the MIT License. See [LICENSE](LICENSE) for details.

## Acknowledgments

| Credit                                                    | Reason                              |
| :-------------------------------------------------------- | :---------------------------------- |
| [Model Context Protocol](https://modelcontextprotocol.io) | Protocol specification and SDKs     |
| [Google Gemini](https://ai.google.dev)                    | Underlying generative model and SDK |
| [Zod](https://zod.dev)                                    | Runtime schema validation           |

---

[Back to top](#gemini-assistant)
