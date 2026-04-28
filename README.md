# Gemini Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](LICENSE) [![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![Stars](https://img.shields.io/github/stars/j0hanz/gemini-assistant?style=for-the-badge&logo=github)](https://github.com/j0hanz/gemini-assistant/stargazers) [![Last commit](https://img.shields.io/github/last-commit/j0hanz/gemini-assistant?style=for-the-badge&logo=git&logoColor=white)](https://github.com/j0hanz/gemini-assistant/commits)

**A workflow-first Model Context Protocol server that exposes Google Gemini for chat, research, file analysis, and review.**

## Overview

`gemini-assistant` is an MCP server that wraps the Google Gemini API behind a fixed, job-first public surface. Instead of one mega-tool, it presents four focused jobs (`chat`, `research`, `analyze`, `review`), three guidance prompts, and a small set of discovery and session resources — so MCP clients can ground users in real workflows rather than raw API knobs.

| Aspect       | Details                       |
| :----------- | :---------------------------- |
| **Status**   | Active                        |
| **Language** | TypeScript (ESM, strict mode) |
| **Runtime**  | Node.js `>=24`                |
| **Package**  | npm                           |
| **License**  | MIT                           |

## Highlights

| Feature                  | Description                                                                               |
| :----------------------- | :---------------------------------------------------------------------------------------- |
| Job-first public surface | Four fixed tools (`chat`, `research`, `analyze`, `review`) — no surprise capability drift |
| Multi-transport          | Stdio, streamable HTTP, and web-standard `Request`/`Response` transports                  |
| In-memory chat sessions  | Replay-safe history with sanitized parts and SDK-faithful raw turn parts                  |
| Workspace-aware          | File reading, automatic context cache, and root negotiation through MCP                   |
| Discovery resources      | Static `discover://catalog`, `discover://workflows`, and `discover://context` endpoints   |
| Task-aware execution     | Optional task lifecycle for long jobs with progress, abort, and rich logging              |

## Built With

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org) [![Express](https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com) [![Zod](https://img.shields.io/badge/Zod-3E67B1?style=for-the-badge)](https://zod.dev) [![Google Gemini](https://img.shields.io/badge/Google%20Gemini-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white)](https://ai.google.dev)

| Layer       | Technology                                                                 |
| :---------- | :------------------------------------------------------------------------- |
| Runtime     | Node.js `>=24` (ESM, `NodeNext` module resolution)                         |
| Language    | TypeScript with `strict`, `exactOptionalPropertyTypes`                     |
| MCP SDK     | `@modelcontextprotocol/server` and `@modelcontextprotocol/node` (v2 alpha) |
| Gemini SDK  | `@google/genai`                                                            |
| HTTP server | `express` v5                                                               |
| Schemas     | `zod` v4 + `@cfworker/json-schema`                                         |

## Quick Start

> [!TIP]
> Get running in under 60 seconds. Requires Node.js `>=24` and a Google Gemini API key.

### Prerequisites

| Requirement    | Version / Notes                                     |
| :------------- | :-------------------------------------------------- |
| Node.js        | `>=24`                                              |
| npm            | Bundled with Node.js                                |
| Gemini API key | Set `API_KEY` (see [Configuration](#configuration)) |

### Install

```bash
git clone https://github.com/j0hanz/gemini-assistant.git
cd gemini-assistant
npm install
npm run build
API_KEY=your-gemini-key npm start
```

### Verify Installation

```bash
npm run test
```

```text
# tests pass via Node's built-in test runner under tsx/esm
ok ...
# pass <n>
```

## Usage

Run as a stdio MCP server (default) and wire it into any MCP-compatible client:

```jsonc
{
  "mcpServers": {
    "gemini-assistant": {
      "command": "node",
      "args": ["./dist/index.js"],
      "env": {
        "API_KEY": "your-gemini-api-key",
        "MODEL": "gemini-3-flash-preview",
      },
    },
  },
}
```

Or run as an authenticated HTTP server:

```bash
TRANSPORT=http \
MCP_HTTP_TOKEN=$(openssl rand -hex 24) \
API_KEY=your-gemini-key \
npm start
```

### Public tools

| Tool       | Best For                                                                               |
| :--------- | :------------------------------------------------------------------------------------- |
| `chat`     | Direct Gemini chat with optional in-memory server-managed sessions                     |
| `research` | Quick grounded lookup or deeper multi-step research with explicit mode selection       |
| `analyze`  | Reasoning over local files, public URLs, or a small set of files with one focused goal |
| `review`   | Reviewing local diffs, comparing two files, or diagnosing a failing change             |

### Public prompts

| Prompt     | Best For                                                                 |
| :--------- | :----------------------------------------------------------------------- |
| `discover` | Orienting a user to the public jobs and the most relevant starting point |
| `research` | Packaging a research goal into the quick-versus-deep decision flow       |
| `review`   | Helping a client frame a diff review, file comparison, or failure triage |

## Project Structure

```text
gemini-assistant/
├── __tests__/            # colocated test suites (unit + e2e)
├── plan/                 # in-flight refactor and hardening plans
├── src/
│   ├── lib/              # shared infrastructure (orchestration, streaming, tasks, logging)
│   ├── schemas/          # zod v4 input/output schemas + JSON Schema validators
│   ├── tools/            # public tool implementations (chat, research, analyze, review)
│   ├── catalog.ts        # discovery catalog wiring
│   ├── client.ts         # Gemini SDK client factory
│   ├── config.ts         # all environment-variable parsing
│   ├── index.ts          # process bootstrap + signal handling
│   ├── prompts.ts        # public prompt registration
│   ├── public-contract.ts # frozen public surface (tools, prompts, resources)
│   ├── resources.ts      # discovery, session, and workspace resources
│   ├── server.ts         # McpServer construction + capability wiring
│   ├── sessions.ts       # in-memory session state and replay sanitization
│   └── transport.ts      # HTTP and web-standard transport setup
├── AGENTS.md
├── CLAUDE.md
├── eslint.config.js
├── knip.json
├── package.json
├── tsconfig.json
└── tsconfig.test.json
```

| Path                       | Purpose                                                                 |
| :------------------------- | :---------------------------------------------------------------------- |
| `src/index.ts`             | Process bootstrap; injectable `MainDependencies` for testability        |
| `src/server.ts`            | `createServerInstance()` that registers tools, prompts, and resources   |
| `src/public-contract.ts`   | Canonical, frozen public surface — do not extend without updating here  |
| `src/lib/orchestration.ts` | Builds Gemini `GenerateContentConfig` from tool inputs                  |
| `src/sessions.ts`          | Replay-safe session store (`parts` for replay, `rawParts` for fidelity) |

## Configuration

All configuration is parsed in `src/config.ts`. Boolean variables accept only the literal strings `true` or `false`.

| Variable                                  | Required | Default                  | Purpose                                                          |
| :---------------------------------------- | :------: | :----------------------- | :--------------------------------------------------------------- |
| `API_KEY`                                 |    V     | —                        | Google Gemini API key                                            |
| `MODEL`                                   |    -     | `gemini-3-flash-preview` | Default Gemini model                                             |
| `TRANSPORT`                               |    -     | `stdio`                  | Transport mode: `stdio`, `http`, or `web-standard`               |
| `HOST`                                    |    -     | `127.0.0.1`              | HTTP bind host                                                   |
| `PORT`                                    |    -     | `3000`                   | HTTP port (1–65535)                                              |
| `MCP_HTTP_TOKEN`                          |    -     | —                        | Bearer token for HTTP transport (≥32 chars)                      |
| `MCP_ALLOW_UNAUTHENTICATED_LOOPBACK_HTTP` |    -     | `false`                  | Allow unauthenticated HTTP only on loopback                      |
| `STATELESS`                               |    -     | `false`                  | Stateless mode (disables tasks capability)                       |
| `THOUGHTS`                                |    -     | `false`                  | Surface Gemini thought summaries                                 |
| `MCP_EXPOSE_SESSION_RESOURCES`            |    -     | `false`                  | Expose transcript / events / raw-turn-parts session resources    |
| `LOG_PAYLOADS`                            |    -     | `false`                  | Log full request/response payloads                               |
| `LOG_DIR`                                 |    -     | —                        | Directory for log files                                          |
| `LOG_TO_STDERR`                           |    -     | `false`                  | Mirror logs to stderr                                            |
| `CACHE`                                   |    -     | `true`                   | Enable automatic workspace context cache                         |
| `CACHE_TTL`                               |    -     | —                        | Workspace cache TTL                                              |
| `CONTEXT`                                 |    -     | —                        | Override workspace context source                                |
| `AUTO_SCAN`                               |    -     | `true`                   | Auto-scan workspace files                                        |
| `ROOTS`                                   |    -     | —                        | Static fallback roots when MCP `roots` capability is unavailable |
| `ROOTS_FALLBACK_CWD`                      |    -     | `false`                  | Fall back to `process.cwd()` if no roots are negotiated          |
| `GEMINI_MAX_OUTPUT_TOKENS`                |    -     | `2048`                   | Max output tokens                                                |
| `GEMINI_THINKING_BUDGET_CAP`              |    -     | `16384`                  | Cap for Gemini thinking budget                                   |
| `CHAT_MESSAGE_MAX_CHARS`                  |    -     | `100000`                 | Per-message char limit for `chat`                                |
| `SESSION_REPLAY_MAX_BYTES`                |    -     | `50000`                  | Replay-budget cap when rebuilding session history                |
| `GEMINI_SAFETY_SETTINGS`                  |    -     | —                        | JSON override for Gemini safety thresholds                       |
| `GEMINI_SESSION_REDACT_KEYS`              |    -     | (built-in)               | Comma-separated regex list for session redaction                 |

## Scripts

| Command                | Description                                            |
| :--------------------- | :----------------------------------------------------- |
| `npm run build`        | Compile TypeScript to `dist/`                          |
| `npm start`            | Run the compiled server                                |
| `npm run lint`         | ESLint with `--max-warnings=0`                         |
| `npm run type-check`   | `tsc --noEmit`                                         |
| `npm run test`         | Node built-in test runner with `tsx/esm` and `.env`    |
| `npm run format`       | Prettier write across the repo                         |
| `npm run knip`         | Detect unused exports, files, and dependencies         |
| `npm run check`        | Static checks plus the full test suite                 |
| `npm run check:static` | Build, type-check, lint, prettier, knip — no tests     |
| `npm run inspector`    | Build and launch the MCP Inspector for interactive use |

## Documentation

| Resource                                         | Description                                    |
| :----------------------------------------------- | :--------------------------------------------- |
| [AGENTS.md](AGENTS.md)                           | Agent guidance, tooling, and safety boundaries |
| [CLAUDE.md](CLAUDE.md)                           | Architecture overview and key constraints      |
| [src/public-contract.ts](src/public-contract.ts) | Frozen public surface and discovery metadata   |

## Roadmap

- [x] Job-first public surface (`chat`, `research`, `analyze`, `review`)
- [x] Stdio, HTTP, and web-standard transports
- [x] Replay-safe in-memory chat sessions
- [x] Task-aware tool execution with progress and abort
- [ ] Persistent session storage adapter
- [ ] Additional review presets and built-in failure-triage workflows

## Security

> [!IMPORTANT]
> Do not commit `API_KEY`, `MCP_HTTP_TOKEN`, or other secrets. The HTTP transport rejects tokens shorter than 32 characters and trivially repeated patterns. Report security issues privately via a GitHub security advisory rather than a public issue.

| Topic              | Detail                                                                                         |
| :----------------- | :--------------------------------------------------------------------------------------------- |
| Reporting channel  | [GitHub security advisory](https://github.com/j0hanz/gemini-assistant/security/advisories/new) |
| Auth model         | Bearer token (HTTP) or stdio-only by default                                                   |
| Loopback exception | `MCP_ALLOW_UNAUTHENTICATED_LOOPBACK_HTTP=true` only — never on public hosts                    |
| Redaction          | Session payloads are redacted via `GEMINI_SESSION_REDACT_KEYS` regex list                      |

## Contributing

Contributions are welcome. Run `npm run lint`, `npm run type-check`, and `npm run test` locally before opening a pull request, and keep changes within the boundaries described in [AGENTS.md](AGENTS.md).

| Step | Action                                             |
| :--: | :------------------------------------------------- |
|  1   | Fork the repository                                |
|  2   | Create a feature branch (`git checkout -b feat/x`) |
|  3   | Commit your changes with a clear message           |
|  4   | Run lint, type-check, and tests locally            |
|  5   | Open a pull request                                |

[![Contributors](https://contrib.rocks/image?repo=j0hanz/gemini-assistant)](https://github.com/j0hanz/gemini-assistant/graphs/contributors)

## License

Released under the MIT License. See [LICENSE](LICENSE) for details.

## Acknowledgments

| Credit                                                    | Reason                                    |
| :-------------------------------------------------------- | :---------------------------------------- |
| [Model Context Protocol](https://modelcontextprotocol.io) | The protocol and reference SDKs           |
| [Google Gemini](https://ai.google.dev)                    | The underlying generative model and SDK   |
| [Zod](https://zod.dev)                                    | Schema validation across input boundaries |

---

[Back to top](#gemini-assistant)
