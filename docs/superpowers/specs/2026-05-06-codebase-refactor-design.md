# Codebase Refactor — Consolidate, Reorganise, Dedup Narrowly

**Status:** Draft
**Date:** 2026-05-06
**Author:** brainstorming session

## Goal

Make the gemini-assistant MCP server codebase easier to navigate and maintain
without growing the file tree. Reduce duplication across the five tool files,
break up the two non-tool kitchen sinks (`transport.ts` and `response.ts`) by
internal regions rather than file splits, and delete the slack left over from
prior refactors.

## Non-goals

- No generic templated tool pipeline. The five tools have enough quirks
  (sessions, deep-research polling, git-diff plumbing, file-search admin) that
  a single abstraction would leak. Light, narrow helpers only.
- No splitting `transport.ts` into `transport-http.ts` / `transport-web.ts`.
  One file with internal regions is preferred.
- No undoing the recent `host-guard` / `url-guard` / `path-guard` /
  `git-reader` extractions. Those modules are deep and earn their place.
- No public API changes. Tool names, resource URIs, structured-content shapes,
  notification methods, and environment variables stay stable.
- No behaviour changes. This is a pure refactor; existing tests are the
  regression net.

## Background

The codebase is ~20,389 lines across 53 source files in `src/`. Recent work
(visible in `docs/superpowers/plans/2026-05-05-architecture-deepening.md` and
the last ~30 commits) split out validation guards and a `GitReader` seam.
Those extractions left two artefacts that no longer earn their existence:
`lib/validation.ts` (83-line re-export barrel) and `lib/tool-context.ts`
(38-line re-export barrel).

The largest remaining files concentrate most of the maintenance pain:

| File                     | Lines |
| ------------------------ | ----- |
| `src/tools/review.ts`    | 1445  |
| `src/transport.ts`       | 1220  |
| `src/tools/research.ts`  | 1149  |
| `src/tools/chat.ts`      | 1122  |
| `src/lib/streaming.ts`   | 1048  |
| `src/lib/tasks.ts`       | 795   |
| `src/lib/response.ts`    | 744   |
| `src/lib/workspace-context.ts` | 713 |
| `src/tools/ingest.ts`    | 667   |

`tools/review.ts` is really three sub-tools (diff review, file comparison,
failure diagnosis) sharing path-classification heuristics and git plumbing.
`tools/chat.ts` and `tools/research.ts` each interleave validation, request
construction, streaming consumption, response shaping, and session
persistence in one long flow. The same response/persistence patterns repeat
across all five tools with small variations.

`transport.ts` blends auth, rate limiting, host validation, CORS, session
pool with LRU+TTL, and two transport runtimes (Express HTTP and Web-Standard
for Bun/Deno/Workers) into one undifferentiated module.

`response.ts` mixes JSON parsing, structured-content building, warnings,
URL-metadata collection, grounding citations, and source details.

## Design

### File-level changes

**Deletes**

- `src/lib/validation.ts` — already a thin barrel re-exporting from
  `host-guard`, `url-guard`, `path-guard`. Inline the ~13 importers and
  remove the file.
- `src/lib/tool-context.ts` — mostly re-exports (`isPathWithinRoot`,
  `buildContextUsed`, `emptyContextUsed`). Move the real types
  (`ToolServices`, `ToolRootsFetcher`, `ToolWorkspaceAccess`,
  `ToolWorkspaceCacheManager`) and `createDefaultToolServices` into
  `src/lib/tool-executor.ts`, which already owns "tool plumbing".

**Merges**

- `src/schemas/ingest-input.ts` + `src/schemas/ingest-output.ts` →
  `src/schemas/ingest.ts`. They are paired and used together; one file is
  enough.

**Net file count change**

Before: 53 source files. After: 50 source files. No new files added in this
refactor.

**Untouched (despite small size)**

- `lib/host-guard.ts`, `lib/url-guard.ts`, `lib/path-guard.ts`,
  `lib/git-reader.ts`, `lib/store-registry.ts` — recently extracted, single
  responsibility, well-tested. Folding them back would undo deep modules.

### Internal reorganisation (no new files)

Three monolith files get a uniform region layout using the
`// ── Section ──` style already in use elsewhere in the codebase. No code
movement between files; only ordering within each file and section headers.

#### `transport.ts` (1220 lines)

```
// ── Types & runtime config ──
// ── Auth (bearer token, timing-safe compare) ──
// ── Rate limiting (per-session / per-IP / per-token) ──
// ── Host validation ──
// ── CORS ──
// ── Session pool (LRU + TTL sweep, async creation lock) ──
// ── Request orchestration (managed pair lifecycle) ──
// ── HTTP transport (Express) ──
// ── Web-standard transport (Bun/Deno/Workers) ──
// ── Public entry: startHttpTransport / startWebStandardTransport ──
```

#### `response.ts` (744 lines)

```
// ── pickDefined / stripEmpty / mergeStructured ──
// ── JSON parsing (tryParseJsonResponse, parseJson) ──
// ── Warnings & schema validation ──
// ── URL metadata collection ──
// ── Grounding citations ──
// ── Source details ──
// ── Structured content builders ──
// ── Resource link helpers ──
```

#### `tools/review.ts` (1445 lines)

```
// ── Constants (extension sets, risk segments, diff budget) ──
// ── Types (DiffStats, LocalDiffSnapshot, BudgetedSnapshotDiff, etc.) ──
// ── Path classification (high-risk / low-signal heuristics) ──
// ── Git diff plumbing (uses injected GitReader) ──
// ── Diff budgeting & truncation ──
// ── Sub-tool: diff review (analyzePrWork) ──
// ── Sub-tool: file comparison (compareFileWork) ──
// ── Sub-tool: failure diagnosis (diagnoseFailureWork) ──
// ── Tool registration (registerReviewTool) ──
```

#### `tools/chat.ts` (1122 lines)

```
// ── Types (AskArgs, AskStructuredContent, AskDependencies) ──
// ── Validation (validateAskRequest, conflict checks) ──
// ── Schema validation & JSON repair ──
// ── Request building (buildAskPrompt, buildChatResolvedProfile) ──
// ── Streaming execution (runWithoutSession, runWithSession) ──
// ── Response shaping (buildAskStructuredContent, formatStructuredResult) ──
// ── Session persistence ──
// ── Tool registration (registerChatTool) ──
```

#### `tools/research.ts` (1149 lines)

```
// ── Types (research-specific input/output shapes) ──
// ── Sampling enrichment ──
// ── Quick research mode ──
// ── Deep research mode (interactions API + polling) ──
// ── Response shaping (sources, citations, findings) ──
// ── Tool registration (registerResearchTool) ──
```

The cost is one comment line per region. The benefit is that locating the
diff-review code path or the failure-diagnosis branch becomes a search
operation, not a 1000-line scroll.

### Shared helpers (narrow, where duplication is real)

Three narrow helpers land inside `tool-executor.ts`. They replace duplication
that already exists across tools; they do not introduce a generic pipeline.

#### `buildToolResponse(...)`

Signature (sketch):

```ts
buildToolResponse({
  structuredContent,
  textBody,
  links,
  warnings,
  contextUsed,
  taskId,
}): CallToolResult;
```

Replaces the four near-identical helpers in `chat.ts`, `research.ts`,
`analyze.ts`, and `review.ts` that each build
`{ structured, content[], warnings text block, resource_link items }` with
small variations. Each tool's specific shaping stays in the tool file; the
common envelope assembly does not.

#### `persistToolEvent(...)`

Signature (sketch):

```ts
persistToolEvent({
  session,
  sessionId,
  request,
  response,
  taskId,
}): void;
```

Collapses the `appendSessionTranscript + appendSessionEvent` pattern that
`chat.ts` and `research.ts` duplicate. Applies `sanitizeSessionText` and the
`getSlimSessionEvents()` flag once, not per tool.

#### `validateSchemaOutput(...)`

Signature (sketch):

```ts
validateSchemaOutput(
  parsedData: unknown,
  jsonMode: boolean | undefined,
  responseSchema: GeminiResponseSchema | undefined,
): string[];
```

Lifts the schema-validation + warnings folding currently inlined in
`chat.ts` so any tool that accepts `responseSchemaJson` can reuse it.

#### Why these three and no more

These are duplications visible in two or more tools today. Anything beyond
this list is single-use code that belongs in its tool file. If a parameter
set grows past ~4 fields or a tool needs an "escape hatch" flag, that is a
signal the helper is too generic — keep the duplication.

### Expected size impact

Tool files lose ~15–25% by lifting envelope-assembly, persistence, and
schema-validation to the shared helpers. Across `chat.ts`, `research.ts`,
`analyze.ts`, `review.ts`, and `ingest.ts` (~4900 LOC together), that is
roughly 750–1200 lines saved, concentrated in `chat.ts` and `research.ts`.

`transport.ts`, `response.ts`, and the three big `tools/` files do not
shrink from region headers alone — those changes pay off in navigability,
not LOC.

## Phasing

Six independent landings. Each phase is a single PR / commit. Phases 1–4
are mechanical and could land in any order; phase 5 must precede phase 6
because phase 6 consumes the new helpers.

| # | Phase                                                                        | Risk    |
| - | ---------------------------------------------------------------------------- | ------- |
| 1 | Delete `validation.ts` barrel; inline imports at ~13 sites                   | Low     |
| 2 | Fold `tool-context.ts` into `tool-executor.ts`; update importers             | Low     |
| 3 | Merge `ingest-input.ts` + `ingest-output.ts` → `ingest.ts`                   | Low     |
| 4 | Reorganise `transport.ts` and `response.ts` with region headers              | Low     |
| 5 | Extract `buildToolResponse` / `persistToolEvent` / `validateSchemaOutput` into `tool-executor.ts` with unit tests | Medium |
| 6 | Reorganise `tools/review.ts`, `tools/chat.ts`, `tools/research.ts` with regions; rewire to shared helpers | Medium |

### Verification gate

After each phase: `node scripts/tasks.mjs` (format → lint → type-check →
knip → test → build) must be green. Pure refactor — no behaviour change
permitted; existing tests must continue to pass without modification beyond
import-path updates.

## Risks

- **Phase 5 helpers fit poorly.** If a parameter set grows past ~4 fields or
  one tool needs an "escape hatch" flag, the helper is too generic. Back off
  and keep the duplication for that tool. Re-test the helper signature
  against all consumers before merging phase 5.
- **Phase 6 changes structured-content shape.** Existing tool tests assert
  `structuredContent` shapes — they are the regression net. If any test
  fails, do not adjust the test; adjust the helper. Public surface must
  remain byte-identical.
- **Inlined imports in phase 1 miss a call site.** TypeScript will catch
  this at type-check; knip will catch dead exports. Trust the toolchain.

## Success criteria

- Net -3 files: 53 → 50.
- No file in `tools/` over ~1100 lines after phase 6.
- Tool layer total LOC shrinks ~750–1200 lines.
- All existing tests green throughout each phase.
- No public API change: tool names, resource URIs, structured-content
  shapes, notification methods, environment variables, and the published
  catalog/workflows resource bodies all stable.
- `knip` reports no new dead code.
- Region headers consistently applied to `transport.ts`, `response.ts`,
  `tools/review.ts`, `tools/chat.ts`, `tools/research.ts`.

## Out of scope (deferred)

- `lib/streaming.ts` (1048 lines) and `lib/tasks.ts` (795 lines) — large but
  cohesive; defer until a feature change motivates a split.
- `lib/workspace-context.ts` (713 lines) — already partially deepened in the
  `2026-05-05-architecture-deepening` plan (workspace-scanner /
  workspace-cache split). Defer further changes.
- `tools/analyze.ts` (520 lines) and `tools/ingest.ts` (667 lines) — fit in
  one screen-and-a-half each; region headers optional but not required.
- Any extraction of a generic templated tool pipeline. Explicitly rejected
  during brainstorming.
