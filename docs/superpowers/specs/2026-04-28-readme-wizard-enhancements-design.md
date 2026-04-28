# readme-wizard Enhancements — Design Spec

**Date:** 2026-04-28
**Scope:** Depth improvements (runtime version, test framework, deploy target) + breadth expansion (PHP, Ruby, .NET, Elixir, Swift) for the `readme-wizard` skill.

---

## 1. Goals

- **Depth (A):** Surface three commonly missing data points — runtime version, test framework, deploy target — so generated READMEs include accurate Prerequisites, Quick Start test commands, and deploy badges without manual edits.
- **Breadth (B):** Extend language stack detection to PHP/Composer, Ruby/Bundler, .NET, Elixir/Mix, and Swift/SPM so the skill produces correct output for those project types.

## 2. Out of Scope

- Monorepo support (Turborepo, Nx, Lerna, npm workspaces)
- Deno / Bun as first-class runtimes (beyond existing lockfile detection)
- Multi-language projects (picks the primary stack only)
- Windows-native `.bat`/`.ps1` script variant

---

## 3. New Scan Fields

Three new top-level fields added to the JSON output of `scan_project.sh`:

```json
{
  "runtime_version": ">=20.0.0",
  "test_framework": "vitest",
  "deploy_target": "docker"
}
```

Empty string `""` when not detected. Consumers must treat `""` as absent.

### 3.1 Runtime Version Detection

First match wins per language. Priority: explicit pin file > manifest `engines`/`requires` field.

| Language | Source                                                               | Example output |
| -------- | -------------------------------------------------------------------- | -------------- |
| Node     | `.nvmrc`, `.node-version`, `engines.node` in `package.json`          | `">=20.0.0"`   |
| Python   | `.python-version`, `python_requires` in `pyproject.toml`/`setup.cfg` | `">=3.11"`     |
| Ruby     | `.ruby-version`, `ruby` directive in `Gemfile`                       | `"3.3.0"`      |
| PHP      | `require.php` in `composer.json`                                     | `">=8.2"`      |
| .NET     | `<TargetFramework>` in first `*.csproj`                              | `"net8.0"`     |
| Elixir   | `elixir` in `.tool-versions`, `elixir` in `mix.exs`                  | `"~> 1.16"`    |
| Swift    | `// swift-tools-version:` comment in `Package.swift`                 | `"5.10"`       |
| Go       | `go` directive in `go.mod`                                           | `"1.22"`       |
| Rust     | `rust-version` in `Cargo.toml`, `rust-toolchain.toml`                | `"1.78"`       |

### 3.2 Test Framework Detection

One value per project; first match wins.

| Stack  | Detection source                                                             | Value                                                 |
| ------ | ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| Node   | `devDependencies` key scan                                                   | `"jest"`, `"vitest"`, `"mocha"`, `"ava"`, `"jasmine"` |
| Python | `pytest.ini`, `conftest.py`, `[tool.pytest.ini_options]` in `pyproject.toml` | `"pytest"`                                            |
| Ruby   | `spec/` directory                                                            | `"rspec"`                                             |
| Ruby   | `test/` directory (fallback)                                                 | `"minitest"`                                          |
| PHP    | `phpunit.xml` or `phpunit` in `require-dev`                                  | `"phpunit"`                                           |
| .NET   | package refs in `*.csproj`: xunit, nunit, mstest                             | `"xunit"`, `"nunit"`, `"mstest"`                      |
| Go     | Always built-in                                                              | `"builtin"`                                           |
| Rust   | Always built-in                                                              | `"builtin"`                                           |
| Elixir | Always ExUnit                                                                | `"builtin"`                                           |
| Swift  | Always XCTest                                                                | `"builtin"`                                           |

### 3.3 Deploy Target Detection

First match wins.

| Detection                                      | Value            |
| ---------------------------------------------- | ---------------- |
| `vercel.json` or `.vercel/` directory          | `"vercel"`       |
| `fly.toml`                                     | `"fly"`          |
| `railway.toml` or `railway.json`               | `"railway"`      |
| `render.yaml`                                  | `"render"`       |
| `netlify.toml`                                 | `"netlify"`      |
| `Procfile`                                     | `"heroku"`       |
| `Dockerfile` or `docker-compose.yml`           | `"docker"`       |
| `serverless.yml` or `cdk.json`                 | `"aws"`          |
| GH Actions workflow containing `pages` keyword | `"github-pages"` |

### 3.4 New Language Stacks

Extends the existing `package_manager` detection block.

| Detection file        | `package_manager` value | Framework sniff                                             |
| --------------------- | ----------------------- | ----------------------------------------------------------- |
| `composer.json`       | `"composer"`            | Laravel (`artisan`), Symfony (`symfony.lock`)               |
| `Gemfile`             | `"bundler"`             | Rails (`config/routes.rb`), Sinatra (`require 'sinatra'`)   |
| `*.sln` or `*.csproj` | `"dotnet"`              | ASP.NET (`<PackageReference Include="Microsoft.AspNetCore`) |
| `mix.exs`             | `"mix"`                 | Phoenix (`deps :phoenix`)                                   |
| `Package.swift`       | `"spm"`                 | —                                                           |

A new `framework` field is added to the JSON output (empty string when not detected):

```json
{ "framework": "laravel" }
```

---

## 4. Script Restructuring

`scan_project.sh` is refactored from sequential inline code into named functions. No behavioral changes to existing detections — purely structural.

### 4.1 Function Map

```
scan_project.sh
│
├── json_escape()                 # unchanged helper
│
├── detect_project_identity()     # sets PROJECT_NAME, DESCRIPTION
├── detect_license()              # sets LICENSE
├── detect_git_remote()           # sets OWNER, REPO
├── detect_language_stack()       # sets PACKAGE_MANAGER, FRAMEWORK
├── detect_runtime_version()      # sets RUNTIME_VERSION        [NEW]
├── detect_test_framework()       # sets TEST_FRAMEWORK          [NEW]
├── detect_deploy_target()        # sets DEPLOY_TARGET           [NEW]
├── detect_ci()                   # sets CI_PROVIDER, CI_WORKFLOWS
├── collect_social_links()        # returns JSON object (already a function)
├── detect_directory_structure()  # sets DIR_STRUCTURE
│
└── output_json()                 # assembles final JSON
```

### 4.2 Call Sequence

```bash
detect_project_identity
detect_license
detect_git_remote
detect_language_stack
detect_runtime_version
detect_test_framework
detect_deploy_target
detect_ci
SOCIAL_LINKS=$(collect_social_links)
detect_directory_structure
output_json
```

---

## 5. SKILL.md Workflow Updates

### 5.1 Step 1 — Scan table (3 new rows)

| Field           | Purpose                                              |
| --------------- | ---------------------------------------------------- |
| Runtime version | Prerequisites section + runtime version badge        |
| Test framework  | Quick Start test command row                         |
| Deploy target   | Deploy badge in hero; Deploy section when non-Docker |

### 5.2 Step 3 — Optional sections table (1 new row)

| Optional Section | Include When                                                            |
| ---------------- | ----------------------------------------------------------------------- |
| Deploy           | `deploy_target` is set and is not `"docker"` (Docker gets a badge only) |

### 5.3 Step 3 — Quick Start guidance (new rule)

> When `test_framework` is set, always include a test command row in the Quick Start table. For `"builtin"` values (Go, Rust, Elixir, Swift), use the canonical command: `go test ./...`, `cargo test`, `mix test`, `swift test`.

### 5.4 Step 4 — Badges (new entries)

| Badge                                              | Include When             |
| -------------------------------------------------- | ------------------------ |
| Runtime version badge                              | `runtime_version` is set |
| Deploy platform badge (Vercel, Fly, Railway, etc.) | `deploy_target` is set   |

### 5.5 Step 6 — Validation table (2 new checks)

| Check           | Pass Criteria                                                     |
| --------------- | ----------------------------------------------------------------- |
| Runtime version | Prerequisites section present when `runtime_version` is non-empty |
| Test command    | Quick Start includes test row when `test_framework` is non-empty  |

---

## 6. Files Changed

| File                      | Change                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `scripts/scan_project.sh` | Refactor into functions + add 3 new detections + 5 new language stacks + `framework` field |
| `SKILL.md`                | Update Steps 1, 3, 4, 6 per Section 5 above                                                |
