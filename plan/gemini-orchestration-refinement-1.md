# Gemini 3 Orchestration Refinement — Design Spec

**Status:** Approved design, ready for plan/implementation.
**Scope:** Full orchestration overhaul (Option C). Gemini 3 first-class. Breaking input changes allowed. Profile + targeted overrides. All 11 profiles. Modifiers orthogonal.
**Public surface impact:** Breaking — input schemas of all 4 public tools change. Public tool _names_ (`chat`, `research`, `analyze`, `review`) and resource/prompt names are preserved.

---

## 1. Goals

1. Replace ad-hoc per-tool spec assembly with a declarative, validated profile system aligned with Google's documented Gemini 3 tool combinations.
2. Reject invalid built-in combinations at schema/validation time (most importantly: File Search exclusivity).
3. Centralize thinking-level, temperature, function-calling-mode, and `includeServerSideToolInvocations` policy so individual tool handlers stop re-deriving them.
4. Surface the resolved orchestration decisions to callers (`structuredContent`, MCP resource, logs) for transparency.
5. Reduce orchestration code duplication across `chat.ts`, `research.ts`, `analyze.ts`, `review.ts`.

## 2. Non-goals

- Adding new public tools/prompts/resources beyond `gemini://profiles`.
- Supporting Gemini 2.5 feature parity. Model is set to a Gemini 3 family by config; older models may work but are not validated.
- Live API, Computer Use, Maps Grounding, image generation tools (out of scope).
- Changing session storage layout or thought-signature handling (already correct per `sanitizeHistoryParts`).

---

## 3. Profile catalog

Defined once in `src/lib/tool-profiles.ts`.

| Profile              | Built-ins                                     | Default `thinkingLevel`      | Notes                                                      |
| -------------------- | --------------------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| `plain`              | —                                             | `minimal`                    | Pure generation.                                           |
| `grounded`           | `googleSearch`                                | `medium`                     | Real-time facts + citations.                               |
| `web-research`       | `googleSearch`, `urlContext`                  | `medium`                     | Search + read specific pages.                              |
| `deep-research`      | `googleSearch`, `urlContext`, `codeExecution` | `high`                       | Search + synthesis + computation.                          |
| `urls-only`          | `urlContext`                                  | `medium`                     | Caller-supplied URLs only.                                 |
| `code-math`          | `codeExecution`                               | `medium`                     | Calc/plot/CSV.                                             |
| `code-math-grounded` | `codeExecution`, `googleSearch`               | `medium`                     | Compute over fresh facts.                                  |
| `visual-inspect`     | `codeExecution`                               | `high` (required ≥ `medium`) | Gemini 3 Flash image zoom/annotate.                        |
| `rag`                | `fileSearch`                                  | `medium`                     | Mutually exclusive with all other built-ins.               |
| `agent`              | (composes)                                    | `high`                       | Meta: requires `functions` modifier; layers over any base. |
| `structured`         | (composes)                                    | inherits                     | Meta: requires `responseSchemaJson` modifier.              |

`agent` and `structured` do not pick built-ins themselves — they assert modifier requirements and adjust function-calling-mode/server-side-invocations policy.

## 4. Compatibility matrix

Single declarative table (`COMBO_MATRIX`) in `tool-profiles.ts`.

|               | googleSearch | urlContext | codeExecution | fileSearch | functions |
| ------------- | ------------ | ---------- | ------------- | ---------- | --------- |
| googleSearch  | ✓            | ✓          | ✓             | ✗          | ✓         |
| urlContext    | ✓            | ✓          | ✓             | ✗          | ✓         |
| codeExecution | ✓            | ✓          | ✓             | ✗          | ✓         |
| fileSearch    | ✗            | ✗          | ✗             | ✓          | ✓         |
| functions     | ✓            | ✓          | ✓             | ✓          | ✓         |

Validator error codes:

- `FILE_SEARCH_EXCLUSIVE` — `fileSearch` combined with any other built-in.
- `FUNCTIONS_REQUIRED_FOR_PROFILE` — `agent` profile without `functions` modifier.
- `RESPONSE_SCHEMA_REQUIRED_FOR_PROFILE` — `structured` profile without `responseSchemaJson`.
- `THINKING_LEVEL_TOO_LOW` — `visual-inspect` with `thinkingLevel: 'minimal'`.
- `TOO_MANY_FUNCTIONS` — > 20 declarations.
- `URLS_NOT_PERMITTED_BY_PROFILE` — `urls` provided but profile lacks `urlContext`.
- `FILE_SEARCH_STORES_REQUIRED` — `rag` profile without `fileSearchStores`.

## 5. Public input shape (breaking)

All 4 tools share a common `tools` field (Zod v4, `z.strictObject` at boundaries):

```ts
const ToolsSpecSchema = z.strictObject({
  profile: z.enum([
    'plain',
    'grounded',
    'web-research',
    'deep-research',
    'urls-only',
    'code-math',
    'code-math-grounded',
    'visual-inspect',
    'rag',
    'agent',
    'structured',
  ]),
  thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  overrides: z
    .strictObject({
      urls: z.array(z.url()).max(20).optional(),
      fileSearchStores: z.array(z.string()).min(1).max(32).optional(),
      functions: z.array(FunctionDeclarationSchema).min(1).max(20).optional(),
      responseSchemaJson: z.record(z.string(), z.unknown()).optional(),
      functionCallingMode: z.enum(['AUTO', 'ANY', 'NONE', 'VALIDATED']).optional(),
      allowedFunctionNames: z.array(z.string()).optional(),
    })
    .optional(),
});
```

### Removed from public inputs

- Top-level booleans: `googleSearch`, `urlContext`, `codeExecution`, `fileSearch`.
- Top-level `functions`, `functionResponses`, `serverSideToolInvocations` (functions/responses move into `overrides`; SSTI is auto-managed).
- `temperature` (locked to SDK default 1.0 per Gemini 3 guidance).
- `urls` becomes `overrides.urls` and is rejected unless profile includes `urlContext`.

### Per-tool defaults

| Tool / mode       | Default profile                                                                                 | Default modifiers                                               |
| ----------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `chat`            | `plain` (auto-promote to `grounded` if `overrides.urls` _and_ server-allowed; otherwise reject) | none                                                            |
| `research.quick`  | `web-research`                                                                                  | none                                                            |
| `research.deep`   | `deep-research`                                                                                 | `structured` if `responseSchemaJson` provided                   |
| `analyze.diagram` | `code-math`                                                                                     | auto `visual-inspect` if image input + `thinkingLevel ≥ medium` |
| `analyze.file`    | `code-math`                                                                                     | same as above                                                   |
| `review.diff`     | `plain`                                                                                         | none                                                            |
| `review.failure`  | `web-research`                                                                                  | `agent` if `overrides.functions` provided                       |
| `review.compare`  | `urls-only` if URLs supplied, else `plain`                                                      | none                                                            |

`chat` URL handling: providing `overrides.urls` without an explicit profile silently upgrades default `plain` → `grounded`. Providing both `urls` and an explicit incompatible profile (e.g. `code-math`) is rejected with `URLS_NOT_PERMITTED_BY_PROFILE`.

## 6. Modifier semantics

- **`functions`** — adds `functionDeclarations`; sets `functionCallingMode = VALIDATED` (overridable via `overrides.functionCallingMode`); sets `includeServerSideToolInvocations = true` iff any built-in active. Cap: **20 declarations** (down from 32).
- **`responseSchemaJson`** — sets `responseMimeType: 'application/json'`, `responseJsonSchema`. Forces `VALIDATED` mode when `functions` also present.
- **`thinkingLevel`** — passed verbatim to `thinkingConfig.thinkingLevel`. Profile-specific minimums enforced (`visual-inspect ≥ medium`).

`functionCallingMode` override rules:

- `ANY` permitted only when no built-in is active (per docs: ANY forces a function call, conflicts with grounding flow). Otherwise rejected with `FUNCTION_MODE_INCOMPATIBLE_WITH_BUILTINS`.
- `NONE` permitted always.
- `AUTO` permitted only when no built-in is active (otherwise `VALIDATED` is required).
- `VALIDATED` always permitted when `functions` present.

## 7. Module changes

### New: `src/lib/tool-profiles.ts`

- `ToolProfileName` union, `ProfileDefinition` interface, `PROFILES` const map.
- `COMBO_MATRIX` constant.
- `resolveProfile(input, toolKey, mode): ResolvedProfile` — picks default if absent, applies tool-specific auto-promotion (chat URL, analyze image).
- `validateProfile(resolved): void` — throws typed errors with codes from §4.
- `buildToolsArray(resolved): Tool[]` — emits `Tool` objects for the SDK.
- `buildToolConfig(resolved): ToolConfig | undefined`.
- `defaultThinkingConfig(resolved): ThinkingConfig | undefined`.

### Refactored: `src/lib/orchestration.ts`

- Drop `BUILT_IN_TOOL_NAMES` from public surface; keep internal alias.
- `resolveOrchestration(input, ctx, toolKey)` becomes:
  1. `resolveProfile(input, toolKey, mode)`
  2. `validateProfile(resolved)`
  3. Build `GenerateContentConfig` from profile + modifiers + system instruction + abortSignal.
- Delete `resolveServerSideToolInvocations` and `resolveFunctionCallingMode` user-facing variants; replace with internal helpers driven by the resolved profile.
- Remove temperature plumbing entirely.
- Keep URL validation (public-only, ≤ 20, ≤ 34MB documented in error messages).

### Refactored: `src/schemas/inputs.ts` and `src/schemas/fields.ts`

- Add `ToolsSpecSchema`, `ProfileNameSchema`, `OverridesSchema`.
- Tool input schemas (`createChatInputSchema`, `createResearchInputSchema`, `createAnalyzeInputSchema`, `createReviewInputSchema`) drop legacy boolean flags; embed optional `tools: ToolsSpecSchema`.
- Cross-field refinements run _after_ parse to throw the `validateProfile` error codes.

### Refactored: `src/tools/{chat,research,analyze,review}.ts`

- Each tool deletes its bespoke `buildXxxSpecs` / spec-assembly helper.
- Each tool computes `resolved = resolveProfile(input, toolKey, mode)` once, passes to `resolveOrchestration`.
- `structuredContent.toolProfile = { profile, builtIns, modifiers, thinkingLevel, functionCallingMode }` echoed in every result.

### Refactored: `src/public-contract.ts`

- Update tool input examples and discovery metadata to reflect new `tools` field.
- Add `gemini://profiles` to the resource registry.

### New: `gemini://profiles` resource (`src/resources.ts`)

- Returns JSON: `{ profiles: ProfileDefinition[], comboMatrix, modifiers, perToolDefaults }`.
- Read-only; safe to expose unconditionally (no session data).

### Logging

- Replace scattered `logger.warn` for "URLs without urlContext" / "fileSearch without stores" with a single structured `logger.info('tool.profile.resolved', { tool, profile, builtIns, modifiers, thinkingLevel })`.
- Validation rejections logged at `warn` with the error code.

## 8. Tests

New / updated:

- `__tests__/lib/tool-profiles.test.ts` (new) — exhaustive: every profile resolves correctly; every invalid combo rejected with expected error code; modifier composition; per-tool default selection; cap enforcement (20 functions, 20 URLs, 32 stores).
- `__tests__/lib/orchestration.test.ts` — rewrite: drop boolean-flag cases, add `resolveProfile` → `GenerateContentConfig` cases. Assert `includeServerSideToolInvocations`, `functionCallingMode`, `thinkingConfig`, and that `temperature` is never set.
- `__tests__/schemas/inputs.test.ts` — new schema shape; reject removed fields.
- `__tests__/tools/research.test.ts`, `__tests__/tools/pr.test.ts` (review), `__tests__/tools/analyze-*.test.ts`, `__tests__/tools/ask.test.ts` (chat) — assert profile defaults and `structuredContent.toolProfile`.
- `__tests__/schemas/public-contract.test.ts` — updated discovery output.
- `__tests__/resources.test.ts` — `gemini://profiles` returns the expected catalog.
- E2E (`__tests__/mcp-tools.e2e.test.ts`) — at least one happy-path call per public tool with the new shape; at least one rejected invalid combo (e.g. `rag` + `urls`).

## 9. Migration / rollout

- Single hard-cut PR. No deprecation window — public surface freeze is lifted in this change; bump server `version` in `package.json` (semver major) and update `discover://catalog`.
- Update `README.md`, `AGENTS.md`, `CLAUDE.md` to reflect the new input shape and profile catalog.
- No database/state migration (sessions store SDK parts, not raw inputs).

## 10. Risks & mitigations

| Risk                                                              | Mitigation                                                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Existing MCP clients break on the new input shape                 | Documented breaking change; old fields produce a clear schema error pointing at `tools.profile`.           |
| Over-restrictive validator blocks a valid combo Google adds later | `COMBO_MATRIX` is a single declarative table — extending it is a one-line change with a test.              |
| Profile auto-promotion (chat URL → grounded) surprises callers    | `structuredContent.toolProfile` always reports the resolved profile; logged at info.                       |
| `functionCallingMode: ANY` still useful for non-grounded callers  | Allowed when no built-in is active; rejected otherwise with explicit error code.                           |
| Loss of fine-grained per-tool flexibility                         | `overrides` covers all documented variants; future profiles can be added without further breaking changes. |

## 11. Out-of-scope follow-ups (track separately)

- Maps Grounding profile (when promoted out of preview).
- Computer Use integration profile.
- Per-profile token-budget hints surfaced in `structuredContent`.
- Auto-selecting `media_resolution` per profile (e.g. `visual-inspect` → `media_resolution_high`).

## 12. Acceptance criteria

1. `npm run lint`, `npm run type-check`, `npm run test` all pass.
2. All 4 public tools accept the new `tools` field and reject removed legacy fields with a Zod error referencing `tools.profile`.
3. Calling any tool without `tools` resolves to the per-tool default profile and echoes it in `structuredContent.toolProfile`.
4. `rag` + any other built-in is rejected with `FILE_SEARCH_EXCLUSIVE` at schema time (not at SDK time).
5. `gemini://profiles` resource enumerates all 11 profiles with the matrix.
6. No call path sets `temperature`; SDK uses default 1.0.
7. `functionDeclarations` capped at 20.
8. `agent` profile without `overrides.functions` rejected with `FUNCTIONS_REQUIRED_FOR_PROFILE`.
9. `visual-inspect` with `thinkingLevel: 'minimal'` rejected with `THINKING_LEVEL_TOO_LOW`.
10. No remaining references to `BUILT_IN_TOOL_NAMES` in tool handlers (`src/tools/*.ts`).
