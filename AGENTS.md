# AGENTS.md

Uses TypeScript, JavaScript.

## Tooling

- **Manager**: npm
- **Frameworks**: typescript, eslint, @trivago/prettier-plugin-sort-imports, eslint, eslint-config-prettier, prettier, tsx, typescript

## Architecture

- Tool-based

## Testing Strategy

- Unit tests located in `__tests__/` directory, using Jest as the test runner and assertion library. Tests cover individual functions and modules to ensure correctness and reliability.

## Commands

- **Format**: `npm run format`
- **Test**: `npm run test`
- **Lint**: `npm run lint`
- **Type Check**: `npm run type-check`
- **Build**: `npm run build`

## Safety Boundaries

- **Always**: `npm run lint`, `npm run type-check`, `npm run test`
- **Ask First**: `installing dependencies`, `deleting files`, `running full builds or e2e suites`, `database/schema migrations`, `deploy or infrastructure changes`, `git push / force push`, `npm run build`
- **Never**: Never edit generated files like `.git` manually.; commit or expose secrets/credentials; edit vendor/generated directories; change production config without approval.

## Directory Overview

```text
├── __tests__/          # test suites
├── .github/            # CI/workflows and repo automation
├── scripts/            # automation scripts
├── src/                # application source
├── .prettierignore     # formatter config
├── .prettierrc         # formatter config
├── eslint.config.js    # lint config
├── package.json        # scripts and dependencies
├── README.md           # usage and setup docs
├── tsconfig.json       # TypeScript config
└── tsconfig.test.json  # TypeScript config
```

## Navigation

- **Entry Points**: `package.json`, `README.md`, `src/index.ts`
- **Key Configs**: `.prettierrc`, `eslint.config.js`, `tsconfig.json`

## Don'ts

- Don't bypass existing lint/type rules without approval.
- Don't ignore test failures in CI.
- Don't use unapproved third-party packages without checking package manager manifests.
- Don't hardcode secrets or sensitive info in code, tests, docs, or config.
- Don't commit secrets/credentials to the repo.
- Don't edit generated files directly.

## Change Checklist

- **Format**: `npm run format`
- **Test**: `npm run test`
- **Lint**: `npm run lint`
- **Type Check**: `npm run type-check`
- **Build**: `npm run build`
