# Local Config Vars Rewrite Design

## Goal

Refine the environment variable surface for local MCP usage. This is a breaking cleanup, so the new names replace the current longer names instead of adding backward-compatible aliases.

The config should stay small, readable in an MCP client `env` block, and focused on startup-level decisions. Request-specific generation settings should remain tool arguments rather than global process configuration.

## Config Surface

Required:

- `API_KEY`: Gemini API key.

Model:

- `MODEL`: Gemini model name. Defaults to the project default model.
- `THOUGHTS`: `true` exposes Gemini thought text in outputs. Defaults to `false`.

Workspace:

- `ROOTS`: comma-separated allowed file roots for file tools, workspace context, and workspace caching.
- `CONTEXT`: optional custom context file path.
- `AUTO_SCAN`: `true` enables automatic workspace scanning. Defaults to `true`.

Workspace Cache:

- `CACHE`: `true` enables automatic workspace context caching. Defaults to `false`.
- `CACHE_TTL`: Gemini cache TTL for workspace context. Defaults to `3600s`.

Debug:

- `LOG_PAYLOADS`: `true` enables verbose payload logging. Defaults to `false`.

Optional local transport:

- `TRANSPORT`: `stdio`, `http`, or `web-standard`. Defaults to `stdio`.
- `HOST`: local HTTP bind host. Defaults to `127.0.0.1`.
- `PORT`: local HTTP bind port. Defaults to `3000`.

Advanced hosted/server controls such as CORS origins, allowed host headers, max session counts, transcript limits, and transport session TTLs are intentionally outside the normal local config surface. If they remain in the codebase, they should be treated as internal constants or later reintroduced behind a separate hosted-service design.

## Architecture

All environment reads should go through `src/config.ts`. The module should expose typed getters or a typed config object for each group: Gemini, workspace, cache, debug, and local transport.

`src/client.ts` should not read `process.env.API_KEY` directly. It should ask config for the API key so required-secret validation is centralized.

The parser helpers should remain simple:

- strict booleans accept only `true` or `false`;
- integers trim whitespace and validate ranges;
- strings used as configured values trim whitespace and reject empty values;
- comma-separated lists are parsed where they are consumed or through a small helper if multiple consumers need them.

## Data Flow

At startup or first use, runtime code asks `src/config.ts` for the relevant value. `src/config.ts` reads `process.env`, applies defaults, validates shape, and returns typed values.

Examples:

- Gemini client construction reads `API_KEY` through config and fails with a direct missing-key error.
- Model selection reads `MODEL` once and exports the selected model.
- Workspace validation reads `ROOTS`.
- Workspace context assembly reads `CONTEXT`, `AUTO_SCAN`, `CACHE`, and `CACHE_TTL`.
- Logging reads `LOG_PAYLOADS`.
- Transport startup reads `TRANSPORT`, `HOST`, and `PORT`.

## Error Handling

Invalid config should fail loudly with the exact variable name. Examples:

- `API_KEY environment variable is required.`
- `THOUGHTS must be "true" or "false" when set.`
- `PORT must be >= 1.`
- `MODEL must be a non-empty string when set.`

No legacy alias fallback should be provided. If an old variable such as `GEMINI_MODEL` or `ALLOWED_FILE_ROOTS` is set, it should have no effect.

## Testing

Update config tests to cover the new names and remove tests for old names. Important cases:

- missing `API_KEY` fails when the Gemini client is first requested;
- `MODEL`, `HOST`, and other string settings reject empty strings;
- booleans reject non-`true`/`false` values;
- `AUTO_SCAN` defaults to `true`;
- `CACHE` and `THOUGHTS` default to `false`;
- `PORT` validates integer and range;
- old variable names do not influence returned config values.

Update affected integration and unit tests to set the new env names. Documentation should show the local-first `.env` example as the primary config path and move HTTP transport options into a short optional section.

## Out Of Scope

- Adding config files in JSON, YAML, or TOML.
- Supporting old env var aliases.
- Making per-request settings such as temperature, max output tokens, or seed global environment variables.
- Adding hosted deployment controls to the local-first config surface.
