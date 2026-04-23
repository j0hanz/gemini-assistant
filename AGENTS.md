# AGENTS.md

`gemini-assistant` is an MCP server that exposes a job-first public surface over Google Gemini.

## Tooling

- **Manager**: npm
- **Runtime**: Node.js `>=24`
- **Languages**: TypeScript, JavaScript, Shell, PowerShell
- **Frameworks**: express, zod, `@google/genai`, `@modelcontextprotocol/express`, `@modelcontextprotocol/node`, `@modelcontextprotocol/server`
- **Tooling**: typescript, eslint, prettier, tsx, knip, `@trivago/prettier-plugin-sort-imports`, `eslint-config-prettier`

## Architecture

- Tool-based
- Session history is sanitized on write and on rebuild via `sanitizeHistoryParts`.
- Thought-summary parts are never replayed; `thoughtSignature` is preserved on functionCall/toolCall/executableCode parts only.
- Persisted chat turns carry both replay-filtered `parts` and SDK-faithful `rawParts`; the `gemini://sessions/{id}/turns/{n}/parts` resource serves `rawParts` (with only oversized `inlineData` elided) so orchestrators can replay thought signatures verbatim.

## Testing Strategy

- Tests are colocated under `__tests__/`.
- `npm run test` uses Node's built-in test runner with `tsx/esm` and `.env`.
- The repository scan found 31 test files, including end-to-end coverage.

## Commands

- **Format**: `npm run format`
- **Test**: `npm run test`
- **Lint**: `npm run lint`
- **Type Check**: `npm run type-check`
- **Build**: `npm run build`

## Safety Boundaries

- **Always**: `npm run lint`, `npm run type-check`, `npm run test`
- **Ask First**: `installing dependencies`, `deleting files`, `running full builds or e2e suites`, `database/schema migrations`, `deploy or infrastructure changes`, `git push / force push`, `npm run build`
- **Never**: read or exfiltrate sensitive files like `.env` or migration artifacts under `.agents/`; edit generated/vendor directories like `.git`, `dist`, or `node_modules`; commit or expose secrets/credentials; change production config without approval

## Directory Overview

```text
├── __tests__/          # test suites
├── .github/            # CI/workflows and repo automation
├── logs/
├── scripts/            # automation scripts
├── src/                # application source
├── .prettierignore     # formatter config
├── .prettierrc         # formatter config
├── AGENTS.md           # agent guidance
├── eslint.config.js    # lint config
├── package.json        # scripts and dependencies
├── README.md           # usage and setup docs
├── tsconfig.json       # TypeScript config
└── tsconfig.test.json  # TypeScript config
```

## Navigation

- **Entry Points**: `package.json`, `README.md`, `src/index.ts`, `src/server.ts`
- **Key Configs**: `.prettierrc`, `eslint.config.js`, `tsconfig.json`

## Don'ts

- Don't bypass existing lint/type rules without approval.
- Don't ignore test failures in CI.
- Don't use unapproved third-party packages without checking package manager manifests.
- Don't hardcode secrets or sensitive info in code, tests, docs, or config.
- Don't commit secrets/credentials to the repo.
- Don't edit generated files directly.

## Change Checklist

1. Run `npm run format`
2. Run `npm run lint`
3. Run `npm run type-check`
4. Run `npm run test`
