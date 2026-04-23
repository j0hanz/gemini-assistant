---
goal: Replace preset-profile tool orchestration with Gemini-native composable tool sets and uniform server-side trace policy
version: 1.0
date_created: 2026-04-22
last_updated: 2026-04-22
owner: gemini-assistant maintainers
status: 'Completed'
tags: [refactor, architecture, gemini, orchestration]
---

# Introduction

> [!NOTE]
> Partially superseded by [`refactor-public-contract-integrity-1.md`](refactor-public-contract-integrity-1.md). The `additionalTools` field introduced here has been removed from both the public Zod schemas and the internal `OrchestrationRequest` type because no public surface plumbed user-supplied function declarations through it. Function-calling on `chat` remains available via the dedicated `functions` field. The rest of this plan (built-in tool array, `functionCallingMode` plumbing, chat consolidation, uniform server-side trace policy) stands.

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Refactor the Gemini built-in tool orchestration layer from a closed 8-entry preset enum (`none|search|url|search_url|code|search_code|search_url_code|url_code`) to an explicit, composable built-in tool array. The refactor (a) removes the preset bottleneck that blocks File Search, custom function calling, and mixed built-in combinations; (b) makes `includeServerSideToolInvocations` an explicit per-surface product policy instead of an incidental conditional; (c) consolidates `chat`'s three duplicate orchestration call sites; and (d) exposes `functionCallingMode` as a native option in the config builder so future function-calling work plugs in without touching the orchestration layer.

This plan adopts the verified-good parts of the external `report.md` proposal (explicit `builtInToolNames[]`, `additionalTools`, `functionCallingMode` plumbing, chat call-site consolidation) and adds the gaps that report did not address: `review.ts` server-side-trace asymmetry, dead `toolProfile` plumbing in `preflight.ts` and input schemas, `buildPerTurnConfig` tool-stripping, and test coverage for the new composition model.

## 1. Requirements & Constraints

- **REQ-001**: Preserve existing end-to-end behavior of `chat`, `research`, and `review` for the three currently-supported built-ins (`googleSearch`, `urlContext`, `codeExecution`).
- **REQ-002**: `buildOrchestrationConfig` must accept an explicit list of built-in tool names plus optional extra `Tool` objects; it must not depend on a closed string enum.
- **REQ-003**: `includeServerSideToolInvocations` must be set to `true` on every surface where server-side tool traces affect fidelity, debugging, or session replay (`chat`, `research`, `review`).
- **REQ-004**: `chat` must resolve orchestration exactly once per request; preflight, per-turn send, and `chats.create` must share one resolved result.
- **REQ-005**: `client.ts#buildGenerateContentConfig` must accept a native `functionCallingMode` option and merge it into `toolConfig.functionCallingConfig` without clobbering existing fields.
- **REQ-006**: Public Zod input surface must not silently accept dead parameters. Any removed field must be removed from the schema or deprecated with a runtime warning.
- **SEC-001**: No new surface may accept arbitrary tool objects from untrusted MCP input; `additionalTools` is an internal-only parameter (TypeScript-level, not Zod-exposed) in this phase.
- **CON-001**: No Gemini SDK version bump; stay on `@google/genai` currently pinned in `package.json`.
- **CON-002**: Do not introduce File Search or custom function-calling execution loops in this plan — only ensure the architecture admits them without further refactor.
- **CON-003**: Preserve `ToolProfile` as an exported type alias (`string`) for one release to avoid breaking downstream imports; mark as deprecated.
- **GUD-001**: Follow `AGENTS.md` implementation discipline: do not add docstrings, helpers, or error handling beyond what this plan specifies.
- **GUD-002**: Log exactly one structured `orchestration resolved` entry per resolution, as today.
- **PAT-001**: Emit tools via pure factory functions in a `BUILT_IN_TOOL_FACTORIES` record keyed by `BuiltInToolName`.
- **PAT-002**: Capability flags (`usesGoogleSearch|usesUrlContext|usesCodeExecution`) must be _derived_ from the resolved `tools` array, not stored alongside a preset lookup.

## 2. Implementation Steps

### Implementation Phase 1 — Core orchestration rewrite

- GOAL-001: Replace preset enum in `src/lib/orchestration.ts` with composable built-in tool arrays while keeping `ToolProfile` as a derived label.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                            | Completed | Date |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-001 | In [src/lib/orchestration.ts](src/lib/orchestration.ts) remove `TOOL_PROFILES` const, `ToolProfileCapabilities` interface, `TOOL_PROFILE_CAPABILITIES` record, and `normalizeToolProfile` function.                                                                                                                                                                                    |           |      |
| TASK-002 | Add `BUILT_IN_TOOL_NAMES = ['googleSearch','urlContext','codeExecution'] as const`, `type BuiltInToolName`, and `BUILT_IN_TOOL_FACTORIES: Record<BuiltInToolName, () => ToolListUnion[number]>` producing fresh `{ googleSearch: {} }` etc. per call.                                                                                                                                  |           |      |
| TASK-003 | Export `type ToolProfile = string` (deprecated alias) and add `buildToolProfile(tools: ToolListUnion): string` that joins sorted `Object.keys` of each tool with `+`, returning `'none'` for an empty array.                                                                                                                                                                           |           |      |
| TASK-004 | Rewrite `OrchestrationRequest` to `{ builtInToolNames?: readonly BuiltInToolName[]; additionalTools?: ToolListUnion; functionCallingMode?: FunctionCallingConfigMode; includeServerSideToolInvocations?: boolean; urls?: readonly string[] }`. Remove `googleSearch`, `toolProfile`, `jsonMode` fields.                                                                                |           |      |
| TASK-005 | Rewrite `buildOrchestrationConfig` to build `tools` as the concatenation of `buildBuiltInTools(names)` and cloned `additionalTools`; derive the three `usesX` flags via `hasTool(tools, key)`; attach `toolConfig.includeServerSideToolInvocations = true` only when requested; return `tools`, `toolConfig`, `functionCallingMode`, `toolProfile`, and the three capability booleans. |           |      |
| TASK-006 | Keep `resolveOrchestration` signature unchanged; confirm the single `mcpReq.log('info', ...)` and `logger.child(toolKey).info(...)` lines still fire once, and the URL/URL-Context warning still triggers when `urlCount > 0 && !config.usesUrlContext`.                                                                                                                               |           |      |
| TASK-007 | In [src/client.ts](src/client.ts) add `functionCallingMode?: FunctionCallingConfigMode` to `ConfigBuilderOptions`, add a pure `buildMergedToolConfig(toolConfig, functionCallingMode)` helper, and replace `...(toolConfig ? { toolConfig } : {})` with the merged result. Import `FunctionCallingConfigMode` type from `@google/genai`.                                               |           |      |

### Implementation Phase 2 — Call-site migration

- GOAL-002: Rewire `chat`, `research`, and `review` to the new composition API and unify `includeServerSideToolInvocations` policy.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---- |
| TASK-008 | In [src/tools/chat.ts](src/tools/chat.ts) remove `getAskToolProfile`. Add `buildChatOrchestrationRequest(args)` returning `{ builtInToolNames: [...(args.googleSearch ? ['googleSearch'] as const : []), ...((urls?.length ?? 0) > 0 ? ['urlContext'] as const : [])], includeServerSideToolInvocations: true, urls }`.                                                                                                                                                                                            |           |      |
| TASK-009 | In `validateAskRequest` ([chat.ts L319](src/tools/chat.ts)) replace the inline `buildOrchestrationConfig({ googleSearch, toolProfile, urls })` with `buildOrchestrationConfig(buildChatOrchestrationRequest(args))`.                                                                                                                                                                                                                                                                                               |           |      |
| TASK-010 | In `resolveAskTooling` ([chat.ts L373](src/tools/chat.ts)) swap to `resolveOrchestration(buildChatOrchestrationRequest(args), ctx, 'chat')`; destructure `functionCallingMode` from `resolved.config` and include it in the returned tuple.                                                                                                                                                                                                                                                                        |           |      |
| TASK-011 | In `buildAskToolingConfig` ([chat.ts L854](src/tools/chat.ts)) switch to `buildOrchestrationConfig(buildChatOrchestrationRequest(args))` and return `{ functionCallingMode, tools, toolConfig }`. Thread `functionCallingMode` through `createChat`, `rebuildChat`, and the `runAskStream` caller at [chat.ts L1000](src/tools/chat.ts).                                                                                                                                                                           |           |      |
| TASK-012 | In [src/tools/research.ts](src/tools/research.ts) add local helper `buildResearchOrchestrationRequest(names, urls)` → `{ builtInToolNames: names, includeServerSideToolInvocations: true, urls }`. Replace the three `resolveOrchestration` call sites (`searchWork`, `analyzeUrlWork`, `agenticSearchWork`) with this helper using `['googleSearch']` / `['googleSearch','urlContext']` / `['urlContext']` / `['googleSearch','codeExecution']` / `['googleSearch','urlContext','codeExecution']` as appropriate. |           |      |
| TASK-013 | In [src/tools/review.ts](src/tools/review.ts) at lines 241-245 and 335-339: replace `resolveOrchestration({ googleSearch, urls, includeServerSideToolInvocations: googleSearch === true \|\| (urls?.length ?? 0) > 0 })` with `resolveOrchestration({ builtInToolNames: [...(googleSearch ? ['googleSearch'] as const : []), ...((urls?.length ?? 0) > 0 ? ['urlContext'] as const : [])], urls, includeServerSideToolInvocations: true })`. This removes the server-side-trace asymmetry flagged in the audit.    |           |      |

### Implementation Phase 3 — Schema & preflight cleanup

- GOAL-003: Remove dead `toolProfile` plumbing so the public Zod surface and preflight checker reflect the new model.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                     | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-014 | In [src/lib/preflight.ts](src/lib/preflight.ts) remove the `toolProfile` field from `GeminiRequestPreflight` and its destructuring in `validateGeminiRequest`. The capability booleans already drive every current preflight branch; confirm no other consumer reads it.                                                                                                        |           |      |
| TASK-015 | In [src/schemas/inputs.ts](src/schemas/inputs.ts#L284-L307) collapse the three-branch `z.union` for `AskInput` into: one branch without URLs, one branch with `urls` (array, 1..20). Remove `toolProfile`, `ASK_NON_URL_TOOL_PROFILES`, `ASK_URL_TOOL_PROFILES`. Keep `googleSearch` boolean. This matches `buildChatOrchestrationRequest` which no longer reads `toolProfile`. |           |      |
| TASK-016 | Remove the `toolProfile` reference in [src/resources.ts L492-L493](src/resources.ts) or replace the rendered label with `entry.request.builtInToolNames?.join('+')` if session-event data now carries the new shape.                                                                                                                                                            |           |      |
| TASK-017 | Grep for remaining `toolProfile`/`ToolProfile`/`TOOL_PROFILES` usages outside `orchestration.ts`; eliminate or convert to derived labels. Keep the exported `ToolProfile` type alias for one release with a `@deprecated` JSDoc.                                                                                                                                                |           |      |

### Implementation Phase 4 — Tests

- GOAL-004: Cover the new composition model and guard against regressions on tool-combination and server-side-trace invariants.

| Task     | Description                                                                                                                                                                                                                                                                                                                        | Completed | Date |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-018 | Update [**tests**/lib/orchestration.test.ts](__tests__/lib/orchestration.test.ts): replace preset-based cases with table-driven tests over all 8 subsets of `BUILT_IN_TOOL_NAMES`. Assert `tools` length, capability booleans, and `toolProfile` label.                                                                            |           |      |
| TASK-019 | Add tests asserting `buildOrchestrationConfig({ includeServerSideToolInvocations: true })` yields `toolConfig.includeServerSideToolInvocations === true` and omits `toolConfig` when flag is absent.                                                                                                                               |           |      |
| TASK-020 | Add a test for `buildOrchestrationConfig({ additionalTools: [{ functionDeclarations: [{ name: 'x', parameters: {} }] }], builtInToolNames: ['googleSearch'] })` confirming both tools appear in output and `usesGoogleSearch === true`. This locks in function-calling extensibility.                                              |           |      |
| TASK-021 | Add a test for `buildGenerateContentConfig({ functionCallingMode: 'ANY', toolConfig: { includeServerSideToolInvocations: true } })` asserting merged `toolConfig === { includeServerSideToolInvocations: true, functionCallingConfig: { mode: 'ANY' } }`.                                                                          |           |      |
| TASK-022 | In [**tests**/tools/ask.test.ts](__tests__/tools/ask.test.ts) and the research/review test files, add one assertion per tool verifying `toolConfig.includeServerSideToolInvocations === true` is passed into `generateContentStream` / `chats.create`. Remove any legacy assertions that pin specific `toolProfile` string values. |           |      |
| TASK-023 | Run `npm run lint`, `npm run type-check`, `npm run test`. All must pass.                                                                                                                                                                                                                                                           |           |      |

## 3. Alternatives

- **ALT-001**: Keep the preset enum and extend it to cover `fileSearch` and function-calling combinations. Rejected: combinatorial explosion (adding one tool doubles enum size), and combinations like `fileSearch + googleSearch + functions` are not well-modeled as strings.
- **ALT-002**: Introduce a full `ToolSet` object API (`{ googleSearch?: boolean, urlContext?: boolean, codeExecution?: boolean, fileSearch?: {...}, functions?: {...} }`) on public inputs now. Rejected for this plan: couples the refactor to un-designed File Search and function-calling user surfaces; violates CON-002. Internally equivalent to `builtInToolNames[]` + `additionalTools`, which is simpler.
- **ALT-003**: Make per-turn tool overrides available by stopping `buildPerTurnConfig` from dropping `tools`. Deferred: requires product-level decision about whether mid-session capability changes are supported and how they interact with session replay. Tracked as a follow-up, not blocking.
- **ALT-004**: Leave `review.ts` conditional `includeServerSideToolInvocations` as-is to minimize diff. Rejected: audit established this is an incidental asymmetry, not a product policy; unifying is a net fidelity win with negligible cost.

## 4. Dependencies

- **DEP-001**: `@google/genai` exports `FunctionCallingConfigMode`, `ToolConfig`, `ToolListUnion` (verified in current `src/client.ts` imports).
- **DEP-002**: No new npm dependencies.
- **DEP-003**: `@modelcontextprotocol/server` — unchanged; orchestration still returns `CallToolResult` errors from URL validation.

## 5. Files

- **FILE-001**: [src/lib/orchestration.ts](src/lib/orchestration.ts) — full rewrite (Phase 1).
- **FILE-002**: [src/client.ts](src/client.ts) — add `functionCallingMode` option and merge helper.
- **FILE-003**: [src/tools/chat.ts](src/tools/chat.ts) — consolidate three orchestration call sites; thread `functionCallingMode`.
- **FILE-004**: [src/tools/research.ts](src/tools/research.ts) — replace three `toolProfile` sites with explicit `builtInToolNames`.
- **FILE-005**: [src/tools/review.ts](src/tools/review.ts) — unify `includeServerSideToolInvocations: true`.
- **FILE-006**: [src/lib/preflight.ts](src/lib/preflight.ts) — drop `toolProfile` field.
- **FILE-007**: [src/schemas/inputs.ts](src/schemas/inputs.ts) — collapse `AskInput` union; remove `ASK_*_TOOL_PROFILES`.
- **FILE-008**: [src/resources.ts](src/resources.ts) — update session-event rendering label.
- **FILE-009**: [**tests**/lib/orchestration.test.ts](__tests__/lib/orchestration.test.ts) — rewritten around composition.
- **FILE-010**: [**tests**/tools/ask.test.ts](__tests__/tools/ask.test.ts), `__tests__/tools/research.test.ts`, `__tests__/tools/pr.test.ts` — assertion updates.

## 6. Testing

- **TEST-001**: Composition table test: for each subset of `BUILT_IN_TOOL_NAMES`, `buildOrchestrationConfig({ builtInToolNames: subset })` returns `tools.length === subset.length`, matching capability booleans, and `toolProfile` equal to sorted-join of names or `'none'`.
- **TEST-002**: `includeServerSideToolInvocations` flag: true → `toolConfig.includeServerSideToolInvocations === true`; undefined/false → `toolConfig` omitted.
- **TEST-003**: `additionalTools` composition: built-in + function declaration both present in output; capability flags reflect built-ins only.
- **TEST-004**: `buildMergedToolConfig` correctness: merges `functionCallingConfig.mode` without overwriting `includeServerSideToolInvocations`.
- **TEST-005**: URL warning: `urlCount > 0 && !usesUrlContext` still triggers `mcpReq.log('warning', ...)` exactly once.
- **TEST-006**: Chat end-to-end: `googleSearch: true, urls: ['https://x']` resolves to a tool array containing both `googleSearch` and `urlContext` with `toolConfig.includeServerSideToolInvocations === true`.
- **TEST-007**: Research `agentic_search` with URLs: tool array contains `googleSearch`, `urlContext`, `codeExecution`.
- **TEST-008**: Review `diagnose_failure` and `compare_files`: `toolConfig.includeServerSideToolInvocations === true` unconditionally.
- **TEST-009**: Preflight: `responseSchema` + any built-in → rejection; unchanged behavior after removing `toolProfile` parameter.

## 7. Risks & Assumptions

- **RISK-001**: External callers importing `TOOL_PROFILES` or profile string literals. Mitigation: keep `type ToolProfile = string` alias; document removal in changelog.
- **RISK-002**: `AskInput` schema change removes `toolProfile` from the public MCP tool surface. Any MCP client sending `toolProfile: "search"` will get a validation error. Mitigation: release note; the `googleSearch: true` shortcut remains functionally equivalent for every non-URL profile, and `urls: [...]` drives URL Context automatically.
- **RISK-003**: Session-event entries persisted under the old shape may reference `toolProfile`. Mitigation: in `resources.ts` render the deprecated field if present for backward-compat display only.
- **RISK-004**: `functionCallingMode` being plumbed through `chat` without an execution loop may suggest function-calling is supported. Mitigation: do not expose it on public Zod input in this phase (CON-002, SEC-001); internal callers stay at `undefined`.
- **ASSUMPTION-001**: Gemini SDK type `FunctionCallingConfigMode` is a string-enum re-export; the merged `toolConfig` shape accepts both `includeServerSideToolInvocations` and `functionCallingConfig` simultaneously.
- **ASSUMPTION-002**: The `res.toolProfile` value stored in session events is purely presentational; no logic branches on specific profile strings (verified by grep in Phase 3).

## 8. Related Specifications / Further Reading

- [docs/specs/2026-04-18-tool-surface-consolidation-design.md](docs/specs/2026-04-18-tool-surface-consolidation-design.md)
- [docs/specs/2026-04-18-zod-schema-refinement-design.md](docs/specs/2026-04-18-zod-schema-refinement-design.md)
- [Gemini API — Built-in tools](https://ai.google.dev/gemini-api/docs/function-calling)
- [Gemini API — Grounding with Google Search](https://ai.google.dev/gemini-api/docs/grounding)
- [Gemini API — URL Context](https://ai.google.dev/gemini-api/docs/url-context)
- [Gemini API — Code Execution](https://ai.google.dev/gemini-api/docs/code-execution)
- Internal audit (prior assistant turn) establishing `includeServerSideToolInvocations` asymmetry across `chat`/`research`/`review`.
- `report.md` external proposal — Phase 1 and 2 adopted; Phase 3/4 (schema cleanup, tests, `review.ts` unification) added by this plan.
