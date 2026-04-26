# MCP TypeScript SDK v2 Correctness — 2026-04-26

Addresses the highly-recommended remediation items surfaced by the SDK v2 review.
Plan: [docs/plan/refactor-mcp-sdk-v2-correctness-1.md](../plan/refactor-mcp-sdk-v2-correctness-1.md).

## Changelog

- **Phase 1 — Implementation info**: dropped non-standard `description` and `websiteUrl` from the `McpServer` `Implementation` literal; added `title: 'Gemini Assistant'`. Replaced `tools: { listChanged: false }` with `tools: {}` because the tool inventory is static and `sendToolListChanged` is never called.
- **Phase 2 — Single shared `rootsFetcher`**: `createServerInstance()` builds one `RootsFetcher` and threads it through `ServerServices` to `registerAnalyzeTool`, `registerReviewTool`, and `registerResources`. The per-tool `buildServerRootsFetcher(server)` calls were removed.
- **Phase 3 — URI honesty**: split `PUBLIC_RESOURCE_URIS` into `PUBLIC_STATIC_RESOURCE_URIS` and `PUBLIC_RESOURCE_TEMPLATES` and derived the union from those tuples. `STATIC_RESOURCE_URIS` in `server.ts` now uses the static tuple directly. Softened the chat tool's discovery `returns` text to flag that `gemini://sessions/{sessionId}/turns/{turnIndex}/parts` is "available only when sessions persist `Part[]`" and added an explicit limitation entry for legacy sessions.
- **Phase 4 — Stateless-mode session safety**: added `getStatelessTransportFlag()` to `config.ts`. `validateAskRequest` (chat) now rejects calls that include a `sessionId` while the transport is stateless HTTP/web-standard, returning a typed `CallToolResult` with an actionable message. The chat discovery limitation now reads "Stateless transport rejects chat calls that include sessionId".
- **Phase 5 — Logger / progress / elicitation**: documented why `Logger.broadcastToServers` skips traced lines; documented the 80-char truncation in `reportFailure` (full message remains in the failed task result). `elicitTaskInput` rewraps SDK `CapabilityNotSupported` rejections (`/client does not support elicitation/i`) into `AppError('chat', 'Elicitation is not supported by the connected client.')` while preserving the existing `working`-status restoration. Added a code comment to `createSdkPassthroughInputSchema` clarifying why task tools deliberately bypass SDK input validation.

## Verification

- `npm run format`
- `npm run lint`
- `npm run type-check`
- `npm run test` — 877 tests, 0 failures.
