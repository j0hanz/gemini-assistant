---
goal: Make gemini-assistant MCP server cost-effective by default so repeated tool calls are not a financial concern
version: 1.0
date_created: 2026-04-23
last_updated: 2026-04-23
owner: j0hanz
status: 'Completed'
tags: ['refactor', 'cost', 'performance', 'architecture']
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

This plan rewires `gemini-assistant` defaults, per-tool cost profiles, deep-research orchestration, session replay strategy, and response envelopes so routine tool calls are cheap by default and expensive modes are explicit opt-ins. It consolidates the highest-value findings from two independent cost reviews (internal audit + `.github/report.md`) and limits work to changes that are verifiable against the existing codebase and test suite.

The plan is scoped to `src/` and `__tests__/`. No public contract fields are removed; only defaults, caps, envelope fields, and replay/caching wiring change. MCP input schemas keep their fields but with tighter descriptions and narrower default behavior.

## 1. Requirements & Constraints

- **REQ-001**: Default `maxOutputTokens` MUST be reduced to a value appropriate for routine Flash answers; per-tool overrides MUST be added rather than raising the global ceiling.
- **REQ-002**: Default `thinkingLevel` MUST be lowered and MUST be tuned per tool/mode (quick/summary = minimal/low; deep/diagram = medium).
- **REQ-003**: Deep research (`mode=deep` / `searchDepth>=3`) MUST stop inheriting the global `maxOutputTokens` on every intermediate turn and MUST not re-feed full synthesis text into the contradiction turn without compaction.
- **REQ-004**: Session replay MUST default to a smaller byte window and MUST drop verbose `toolResponse` / `codeExecutionResult` / grounding payloads from replayed history.
- **REQ-005**: Session events MUST persist a slim default record; full verbose payloads MUST be gated behind a debug flag.
- **REQ-006**: Prompt caching (`cachedContent`) MUST be reachable from `analyze`, `review`, and `research` paths — not only `chat` session rebuilds.
- **REQ-007**: `MIN_CACHE_TOKENS` MUST be lowered to align with Gemini 3 Flash explicit-cache minimums so small workspaces actually cache.
- **REQ-008**: `structuredContent` envelopes MUST drop fields that duplicate other fields or are completely empty, but MUST preserve populated `toolEvents`, `safetyRatings`, `citationMetadata`, `findings`, and `claimLinkedSources` by default to avoid breaking client UX.
- **REQ-009**: Chat JSON-mode MUST NOT serialize the parsed JSON into both `content[0].text` and `structuredContent.data`.
- **REQ-010**: JSON repair retry (max 1) MUST run on `MINIMAL` thinking level to cap retry cost.
- **SEC-001**: Safety redaction, prompt-injection guards, and URL-validation behavior MUST NOT regress. Existing `sanitizeHistoryParts`, `isPublicHttpUrl`, and safety-setting wiring remain.
- **CON-001**: Do NOT change the public tool names (`chat`, `research`, `analyze`, `review`), public prompts, or public resource URIs.
- **CON-002**: Default Gemini model stays `gemini-3-flash-preview`. Do NOT introduce `gemini-2.5-flash` anywhere.
- **CON-003**: `exactOptionalPropertyTypes` compliance MUST be preserved; use conditional spreads rather than `T | undefined` assignments for optional envelope fields.
- **CON-004**: All changes MUST keep `npm run lint`, `npm run type-check`, `npm run test` passing.
- **GUD-001**: Prefer config-level changes and per-tool profile objects over ad-hoc literals scattered across tool files.
- **GUD-002**: Avoid hiding standard MCP schema fields behind environment variables; prefer omitting only explicitly empty values to save tokens while keeping the public contract predictable.
- **PAT-001**: Follow the existing `pickDefined` + conditional-spread pattern when emitting structured content.
- **PAT-002**: Follow the existing `parse*Env` pattern in `src/config.ts` when adding new env-driven defaults.

## 2. Implementation Steps

### Implementation Phase 1 — Config & client defaults (foundation)

- GOAL-001: Lower global output/thinking/cache ceilings and introduce per-tool cost profiles that downstream phases consume.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | In `src/config.ts`, change `DEFAULT_MAX_OUTPUT_TOKENS` from `32_768` to `4_096`. Keep env override `GEMINI_MAX_OUTPUT_TOKENS` and `max: 1_048_576` so callers can still raise it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Yes       | 2026-04-23 |
| TASK-002 | In `src/config.ts`, change `DEFAULT_SESSION_REPLAY_MAX_BYTES` from `200_000` to `50_000` and `DEFAULT_SESSION_REPLAY_INLINE_DATA_MAX_BYTES` from `65_536` to `16_384`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Yes       | 2026-04-23 |
| TASK-003 | In `src/config.ts`, add `parseIntEnv('GEMINI_THINKING_BUDGET_CAP', 32_768, {min:0, max:1_048_576})` exported as `getThinkingBudgetCap()`; enforce cap in `buildThinkingConfig` (Phase 2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Yes       | 2026-04-23 |
| TASK-004 | In `src/config.ts`, flip `AUTO_SCAN` default to `false` and `CACHE` default to `true` (via `parseBooleanEnv` fallbacks). Add `getSlimSessionEvents()` returning `parseBooleanEnv('SESSION_EVENTS_VERBOSE', false) === false`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Yes       | 2026-04-23 |
| TASK-005 | In `src/client.ts`, change `DEFAULT_THINKING_LEVEL` from `'MEDIUM'` to `'LOW'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Yes       | 2026-04-23 |
| TASK-006 | In `src/client.ts`, add `DEFAULT_TOOL_COST_PROFILES` record mapping `'chat' \| 'research.quick' \| 'research.deep.plan' \| 'research.deep.retrieval' \| 'research.deep.synthesis' \| 'research.deep.contradiction' \| 'analyze.summary' \| 'analyze.diagram' \| 'review.diff' \| 'review.comparison' \| 'review.failure' \| 'chat.jsonRepair'` → `{ thinkingLevel: AskThinkingLevel, maxOutputTokens: number }`. Values: chat=LOW/4096, research.quick=LOW/4096, research.deep.plan=MINIMAL/1024 (existing), research.deep.retrieval=LOW/2048, research.deep.synthesis=MEDIUM/8192, research.deep.contradiction=LOW/1024, analyze.summary=LOW/4096, analyze.diagram=MEDIUM/8192, review.diff=LOW/6144, review.comparison=LOW/4096, review.failure=LOW/4096, chat.jsonRepair=MINIMAL/2048. | Yes       | 2026-04-23 |
| TASK-007 | In `src/client.ts`, extend `buildGenerateContentConfig` to accept `costProfile?: keyof typeof DEFAULT_TOOL_COST_PROFILES`. When provided, fill missing `thinkingLevel`/`maxOutputTokens` from the profile (explicit args still win).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Yes       | 2026-04-23 |
| TASK-008 | In `src/client.ts`, enforce `getThinkingBudgetCap()` inside `buildThinkingConfig` (clamp `thinkingBudget` to cap; log warning via `logger.child('client')` when clamped).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Yes       | 2026-04-23 |
| TASK-009 | In `src/lib/workspace-context.ts`, change `MIN_CACHE_TOKENS` from `32_000` to `4_000` and `MAX_TOTAL_CONTEXT_SIZE` from `2 * 1024 * 1024` to `256 * 1024`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Yes       | 2026-04-23 |

### Implementation Phase 2 — Per-tool cost profiles

- GOAL-002: Apply `costProfile` to every Gemini call site so every tool inherits a sensible, cheap-by-default ceiling without breaking explicit caller overrides.

| Task     | Description                                                                                                                                                                                                                                                    | Completed | Date       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-010 | In `src/tools/chat.ts`, pass `costProfile: 'chat'` when assembling `buildGenerateContentConfig` for the primary chat turn. Keep explicit `thinkingLevel`/`maxOutputTokens` from args winning.                                                                  | Yes       | 2026-04-23 |
| TASK-011 | In `src/tools/chat.ts` JSON repair loop, switch the retry call to `costProfile: 'chat.jsonRepair'` and force `thinkingLevel: 'MINIMAL'` and `maxOutputTokens: 2_048` for that one attempt. Keep `JSON_REPAIR_MAX_RETRIES = 1`.                                 | Yes       | 2026-04-23 |
| TASK-012 | In `src/tools/analyze.ts`, split into `costProfile: 'analyze.summary'` for `analyzeFileWork` / `analyzeMultiFileWork` / URL summary path, and `costProfile: 'analyze.diagram'` for the diagram generation path.                                                | Yes       | 2026-04-23 |
| TASK-013 | In `src/tools/review.ts`, apply `costProfile: 'review.diff' \| 'review.comparison' \| 'review.failure'` per `subjectKind` at each `buildGenerateContentConfig` site.                                                                                           | Yes       | 2026-04-23 |
| TASK-014 | In `src/tools/research.ts` `searchWork` (quick mode), apply `costProfile: 'research.quick'`. Apply `costProfile: 'research.deep.plan'` to the plan turn (replacing the hardcoded `maxOutputTokens: 1024, thinkingLevel: 'MEDIUM'` with profile-driven values). | Yes       | 2026-04-23 |
| TASK-015 | In `src/tools/research.ts` deep-research retrieval loop, apply `costProfile: 'research.deep.retrieval'` AND ignore `args.maxOutputTokens` for intermediate retrieval turns (only the synthesis turn respects caller overrides).                                | Yes       | 2026-04-23 |
| TASK-016 | In `src/tools/research.ts` synthesis turn, apply `costProfile: 'research.deep.synthesis'`. In the contradiction turn, apply `costProfile: 'research.deep.contradiction'` and force `thinkingLevel: 'LOW'` and `maxOutputTokens: 1_024` regardless of args.     | Yes       | 2026-04-23 |

### Implementation Phase 3 — Deep research guardrails

- GOAL-003: Stop deep research from fanning into 6 oversized turns and from inheriting full generated text across turns.

| Task     | Description                                                                                                                                                                                                                                                                                                             | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-017 | In `src/tools/research.ts`, change `MAX_DEEP_RESEARCH_TURNS` from `6` to `4`. Keep the per-depth retrieval budget formula but clamp to the new ceiling.                                                                                                                                                                 | Yes       | 2026-04-23 |
| TASK-018 | In `src/schemas/inputs.ts`, change `searchDepth` default from `3` to `2` in both `ResearchInputBaseSchema` and `AgenticSearchInputSchema`. Update descriptions to state "default 2; deep research only when `mode=deep` is explicit".                                                                                   | Yes       | 2026-04-23 |
| TASK-019 | In `src/tools/research.ts`, add `summarizeRetrieval(text: string, maxChars = 1_500): string` that trims each retrieval summary to `maxChars`, preferring the first `## Findings` section when present. Use this before concatenating into `retrievalSummaries` — replacing the current `result.text` raw concatenation. | Yes       | 2026-04-23 |
| TASK-020 | In `src/tools/research.ts`, gate the contradiction turn internally based on `mode === 'deep'` and `searchDepth >= 3`. Do NOT expose a new `contradictionCheck` boolean in the public schema to avoid leaking cost-optimization details to the end user.                                                                 | Yes       | 2026-04-23 |
| TASK-021 | In `src/tools/research.ts` `enrichTopicWithSampling`, cap the injected `sampledText` at 200 chars (`sampledText.slice(0, 200)`), skip entirely when `args.searchDepth < 3`, and when `ctx.mcpReq.requestSampling` is unavailable return `topic` without logging at `info` (use `debug`).                                | Yes       | 2026-04-23 |

### Implementation Phase 4 — Session replay & event slimming

- GOAL-004: Replace raw byte-window replay with a strict sliding window and persist slim session events by default.

| Task     | Description                                                                                                                                                                                                                                                                                                                                           | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-022 | In `src/lib/replay-window.ts`, enforce a strict sliding window. When total bytes exceed the window, keep the most recent entries that fit and completely drop older entries, returning `{ kept: ContentEntry[]; dropped: number }`. This avoids the maintainability risks of text-manipulation and summarization.                                     | Yes       | 2026-04-23 |
| TASK-023 | In `src/tools/chat.ts` `buildRebuiltChatContents`, simply omit any dropped entries from the rebuilt history. Do NOT prepend a synthesized rolling summary, preventing malformed syntax risks and reducing code complexity.                                                                                                                            | Yes       | 2026-04-23 |
| TASK-024 | In `src/sessions.ts` `sanitizeHistoryParts`, additionally drop `toolResponse`, `toolCall`, `codeExecutionResult`, and `executableCode` parts from replayed history (they are recorded in events but should not re-bill on rebuild). Keep `functionCall` + `functionResponse` parts so tool-calling chat still works.                                  | Yes       | 2026-04-23 |
| TASK-025 | In `src/sessions.ts` `cloneSessionEventEntry`, when `getSlimSessionEvents()` is true, strip `groundingMetadata`, `urlContextMetadata`, `citationMetadata`, `safetyRatings`, `promptFeedback`, `toolEvents`, and `thoughts` before cloning. Keep `text`, `usage`, `functionCalls`, `schemaWarnings`, `finishReason`, `promptBlockReason`, `anomalies`. | Yes       | 2026-04-23 |
| TASK-026 | In `src/sessions.ts`, lower `DEFAULT_MAX_TRANSCRIPT_ENTRIES` from `200` to `50` and `DEFAULT_MAX_EVENT_ENTRIES` from `200` to `50` in `src/config.ts` (and the matching `getSessionLimits()` output).                                                                                                                                                 | Yes       | 2026-04-23 |

### Implementation Phase 5 — Response envelope trimming

- GOAL-005: Shrink MCP responses so the consuming LLM does not re-read redundant metadata on every call.

| Task     | Description                                                                                                                                                                                                                                                                                             | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-027 | In `src/lib/response.ts` `buildSharedStructuredMetadata`, omit `toolEvents`, `safetyRatings`, `citationMetadata`, and `finishMessage` ONLY if they are empty arrays/objects or trivial (e.g., `finishReason === 'STOP'`). Do NOT hide populated UX-critical fields behind an environment variable.      | Yes       | 2026-04-23 |
| TASK-028 | In `src/tools/chat.ts` `buildAskStructuredContent`, when `jsonMode === true` and `parsedData !== undefined` set `answer = ''` and only keep `data`. Update `content[0].text` to the empty string or omit in `formatStructuredResult` to avoid double-serializing the same JSON.                         | Yes       | 2026-04-23 |
| TASK-029 | In `src/tools/research.ts` `buildAgenticSearchResult` and `buildSearchResult`, retain `findings` and `claimLinkedSources` to preserve citation UX for clients. Only remove redundant raw `sources` and `urlContextSources` arrays if the data is already present in `sourceDetails`.                    | Yes       | 2026-04-23 |
| TASK-030 | In `src/tools/research.ts`, stop appending `Google Search Suggestions:\n${renderedContent}` into `content[]` by default; instead emit once as `content[]` when present and omit `searchEntryPoint.renderedContent` from `structuredContent`. Document in the schema that clients render from `content`. | Yes       | 2026-04-23 |
| TASK-031 | In `src/lib/response.ts` `computeGroundingSignals`, keep populating `groundingSupportsCount`, `supportedFindingsCount`, `unsupportedFindingsCount`, and `claimCoverage`. Retain these fields by default to avoid degrading transparency.                                                                | Yes       | 2026-04-23 |

### Implementation Phase 6 — Cache plumbing for analyze/review/research

- GOAL-006: Make `cachedContent` reachable from every heavy tool path so prompt-cache leverage is not confined to chat session rebuilds.

| Task     | Description                                                                                                                                                                                                                                                                                                    | Completed | Date       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-032 | In `src/lib/workspace-context.ts`, export `getWorkspaceCacheName(ctx: ServerContext): Promise<string \| undefined>` that returns the active workspace cache name when `getWorkspaceCacheEnabled()` is true and the cache is fresh (reuse existing `workspaceCacheManager`).                                    | Yes       | 2026-04-23 |
| TASK-033 | In `src/tools/analyze.ts` `runAnalyzeGeneration`, call `getWorkspaceCacheName(ctx)` and pass `cacheName` into `buildGenerateContentConfig`. When cache is active, skip injecting the workspace context into the prompt (delegate to `resolveTextPrompt`/`resolvePartPrompt` which already honors `cacheName`). | Yes       | 2026-04-23 |
| TASK-034 | In `src/tools/review.ts`, do the same for the three subject paths: pass `cacheName` into every `buildGenerateContentConfig` call.                                                                                                                                                                              | Yes       | 2026-04-23 |
| TASK-035 | In `src/tools/research.ts`, pass `cacheName` into the synthesis turn only (not retrieval — grounding tools + cached content are incompatible per Gemini 3 constraints). Plan turn stays uncached.                                                                                                              | Yes       | 2026-04-23 |

### Implementation Phase 7 — Schema description compaction

- GOAL-007: Shrink the `tools/list` payload so the MCP client's system prompt pays a smaller one-time cost per session.

| Task     | Description                                                                                                                                                                                                                                                                                                                                     | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-036 | In `src/schemas/fields.ts`, compact `temperatureField` default description to `'Sampling temperature 0-2 (default 1).'` (remove "reasoning loops" claim).                                                                                                                                                                                       | Yes       | 2026-04-23 |
| TASK-037 | In `src/schemas/fields.ts`, compact `thinkingLevel` default description to `'Reasoning depth: MINIMAL, LOW, MEDIUM, HIGH (default LOW).'`                                                                                                                                                                                                       | Yes       | 2026-04-23 |
| TASK-038 | In `src/schemas/inputs.ts` `responseSchemaJsonField`, compact description to `'JSON Schema (2020-12) for structured output. Single-turn / new-session only.'`                                                                                                                                                                                   | Yes       | 2026-04-23 |
| TASK-039 | In `src/schemas/fragments.ts`, replace `SafetySettingInputSchema` with `z.unknown()` at tool boundaries via a new `SafetySettingPassthroughSchema = z.array(z.unknown()).optional().describe('Gemini SafetySetting[]')`; keep the strict schema internally for runtime validation. Update every tool input to reference the passthrough schema. | Yes       | 2026-04-23 |
| TASK-040 | In `src/schemas/fragments.ts` `createGenerationConfigFields`, trim every `.describe()` string to <= 80 chars.                                                                                                                                                                                                                                   | Yes       | 2026-04-23 |

## 3. Alternatives

- **ALT-001**: Rolling summary via string truncation or cheap Gemini call. Rejected for Phase 4 — introduces risks of malformed JSON syntax and maintainability overhead. A strict sliding window dropping older turns is safer and simpler.
- **ALT-002**: Expose a `contradictionCheck` boolean in the public schema to let users opt-out of the extra turn. Rejected — it pollutes the public API with internal cost-optimization details. Gating internally based on depth is cleaner.
- **ALT-003**: Hide `toolEvents`/`safetyRatings`/`citationMetadata`/`findings` behind a `DEBUG_ENVELOPE` flag to save tokens. Rejected — degrades UX for clients relying on citations and safety transparency. We accept the cost of these populated fields to preserve a predictable public contract.
- **ALT-004**: Raise `MIN_CACHE_TOKENS` to `16_000` as a middle ground. Rejected — Gemini 3 Flash supports explicit caching at much lower thresholds; `4_000` matches the documented minimum and avoids stranding small workspaces.
- **ALT-005**: Replace `gemini-3-flash-preview` with a cheaper model for intermediate retrieval turns. Rejected — explicitly forbidden by repo memory; the plan respects `gemini-3-flash-preview` as the single default.

## 4. Dependencies

- **DEP-001**: `@google/genai` SDK — all cost profile values must remain compatible with Gemini 3 `thinkingLevel`/`thinkingBudget`/`maxOutputTokens` semantics.
- **DEP-002**: `@modelcontextprotocol/server` v2 — `buildSharedStructuredMetadata` and `CallToolResult` shape must keep matching SDK expectations; no schema changes that break `validateToolOutput`.
- **DEP-003**: `zod/v4` — schema edits in Phase 7 must keep `z.toJSONSchema()` output valid for MCP `tools/list` consumers.
- **DEP-004**: Existing `workspaceCacheManager` in `src/lib/workspace-context.ts` must expose an externally callable "get current cache name" method (TASK-032).

## 5. Files

- **FILE-001**: `src/config.ts` — default constants, new env flags, slim-event helper, thinking-budget cap.
- **FILE-002**: `src/client.ts` — `DEFAULT_THINKING_LEVEL`, `DEFAULT_TOOL_COST_PROFILES`, `buildGenerateContentConfig` `costProfile` param, `buildThinkingConfig` cap enforcement.
- **FILE-003**: `src/tools/chat.ts` — cost profile wiring, JSON-mode dedupe, JSON-repair MINIMAL thinking.
- **FILE-004**: `src/tools/research.ts` — deep-research turn budget, per-turn profiles, retrieval summarization, gated contradiction turn, sampling enrichment cap.
- **FILE-005**: `src/tools/analyze.ts` — cost profiles, cache plumbing.
- **FILE-006**: `src/tools/review.ts` — cost profiles, cache plumbing.
- **FILE-007**: `src/sessions.ts` — expanded `sanitizeHistoryParts`, slim-event cloning.
- **FILE-008**: `src/lib/replay-window.ts` — rolling summary split.
- **FILE-009**: `src/lib/response.ts` — envelope gating, grounding-signals slimming.
- **FILE-010**: `src/lib/workspace-context.ts` — lowered cache thresholds, `getWorkspaceCacheName` export.
- **FILE-011**: `src/schemas/inputs.ts` — searchDepth default, contradictionCheck field, compact descriptions.
- **FILE-012**: `src/schemas/outputs.ts` — mark deprecated research envelope fields optional-forever.
- **FILE-013**: `src/schemas/fields.ts` — compact descriptions.
- **FILE-014**: `src/schemas/fragments.ts` — safety settings passthrough, compact describes.

## 6. Testing

- **TEST-001**: Update `__tests__/config.test.ts` to assert new defaults (`DEFAULT_MAX_OUTPUT_TOKENS=4096`, `SESSION_REPLAY_MAX_BYTES=50000`, `CACHE` default true, `AUTO_SCAN` default false) and new env flags (`GEMINI_THINKING_BUDGET_CAP`, `SESSION_EVENTS_VERBOSE`).
- **TEST-002**: Add `__tests__/client.test.ts` cases asserting `costProfile` resolution: explicit args win; missing args fall back to profile; unknown profile throws.
- **TEST-003**: Add `__tests__/tools/research.test.ts` case asserting deep-research path uses `retrieval` profile cap (≤2048 max output tokens) and ignores caller `maxOutputTokens` on retrieval turns; synthesis respects caller override.
- **TEST-004**: Add `__tests__/tools/research.test.ts` case asserting contradiction turn runs only when `mode === 'deep'` and `searchDepth >= 3`.
- **TEST-005**: Extend `__tests__/tools/research.test.ts` to assert retrieval summaries fed into synthesis are capped at 1_500 chars each.
- **TEST-006**: Extend `__tests__/lib/replay-window.test.ts` to assert the sliding window drops older entries completely when exceeding the byte limit.
- **TEST-007**: Extend `__tests__/sessions.test.ts` to assert `sanitizeHistoryParts` now drops `toolResponse`/`codeExecutionResult`/`executableCode` and that slim-event cloning drops `groundingMetadata`/`toolEvents`/`thoughts` when `SESSION_EVENTS_VERBOSE=false`.
- **TEST-008**: Add `__tests__/lib/response.test.ts` case asserting envelope omits `toolEvents`/`safetyRatings`/`citationMetadata` only when they are empty, but retains them when populated.
- **TEST-009**: Add `__tests__/tools/ask.test.ts` case asserting JSON-mode response does not duplicate parsed JSON between `content[0].text` and `structuredContent.data`.
- **TEST-010**: Update `__tests__/schemas/outputs.test.ts` to allow absence of redundant `sources`/`urlContextSources`, while asserting presence of `findings`, `claimLinkedSources`, and `citations`.
- **TEST-011**: Add `__tests__/tools/analyze.test.ts` (or reuse existing) case asserting `cacheName` is forwarded to `buildGenerateContentConfig` when workspace cache is active.
- **TEST-012**: Run `npm run lint && npm run type-check && npm run test` at the end of each phase; block phase completion on failure.

## 7. Risks & Assumptions

- **RISK-001**: Lowering `DEFAULT_MAX_OUTPUT_TOKENS` to `4096` may truncate long-form review summaries for very large diffs. Mitigation: `review.diff` profile raises the ceiling to `6_144` and callers can override via `maxOutputTokens`.
- **RISK-002**: Dropping `toolResponse`/`codeExecutionResult` parts from replay may break chat sessions that depend on code execution state across turns. Mitigation: keep the parts in session events (non-replayed) and add a regression test; expose `SESSION_REPLAY_KEEP_TOOL_RESPONSES=true` env escape hatch if needed.
- **RISK-003**: `MIN_CACHE_TOKENS=4_000` may conflict with an actual Gemini API minimum if Google has raised it. Mitigation: wrap `createCachedContent` call in a try/catch that logs and falls back to uncached when the API rejects the cache size; verify against current `@google/genai` docs before merging Phase 1.
- **RISK-004**: Removing `findings`/`claimLinkedSources` from structured output may break downstream clients that read them. Mitigation: keep the fields optional in the Zod schema (only stop emitting); announce in CHANGELOG.
- **RISK-005**: Local deterministic rolling summary may lose semantically important prior context compared to the raw byte window. Mitigation: still keep the last 6 turns verbatim (REQ-004); long-running sessions can opt into model-summarized memory via a follow-up flag.
- **ASSUMPTION-001**: `gemini-3-flash-preview` billing today weights output tokens and thinking tokens significantly; the cost-profile values reflect that assumption. If pricing changes materially, revisit `DEFAULT_TOOL_COST_PROFILES`.
- **ASSUMPTION-002**: MCP clients consuming this server read `structuredContent` via their LLM; therefore every envelope field counts against per-call token cost on the client side.
- **ASSUMPTION-003**: Existing tests are the contract; any test failure after a phase means the plan's defaults are wrong, not the test.

## 8. Related Specifications / Further Reading

- `.github/report.md` — external cost review (source for P0 output-cap + deep-research + replay findings).
- `docs/plan/refactor-gemini-tool-orchestration-1.md` — orchestration plan these changes build on.
- `docs/plan/architecture-orchestration-extensibility-1.md` — architecture context.
- `docs/specs/2026-04-18-tool-surface-consolidation-design.md` — public tool surface the plan must not regress.
- `.agents/skills/gemini-api-dev/SKILL.md` — Gemini 3 SDK usage, thinking levels, caching semantics.
