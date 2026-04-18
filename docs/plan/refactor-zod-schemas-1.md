# Refactor Zod Schemas for Consistency, Reusability, and Strictness

This implementation plan executes the approved schema redesign in [docs/specs/2026-04-18-zod-schema-refinement-design.md](C:/gemini-assistant/docs/specs/2026-04-18-zod-schema-refinement-design.md). The plan restructures the schema layer so that canonical scalar helpers live in `src/schemas/fields.ts`, canonical object fragments live in `src/schemas/fragments.ts`, final public contracts live in `src/schemas/inputs.ts` and `src/schemas/outputs.ts`, prompt argument schemas in `src/prompts.ts` consume shared helpers, and schema tests assert the new strict contract instead of preserving accidental permissiveness.

## 1. Requirements & Constraints

- **REQ-001**: Preserve the public tool set and tool ownership established by [docs/specs/2026-04-18-tool-surface-consolidation-design.md](C:/gemini-assistant/docs/specs/2026-04-18-tool-surface-consolidation-design.md).
- **REQ-002**: Make exported Zod schemas the primary source of truth for runtime validation and TypeScript contract inference.
- **REQ-003**: Remove duplicate hand-written TypeScript interfaces in [src/schemas/inputs.ts](C:/gemini-assistant/src/schemas/inputs.ts) and [src/schemas/outputs.ts](C:/gemini-assistant/src/schemas/outputs.ts) when `z.infer` can express the same contract.
- **REQ-004**: Redesign ambiguous unions, especially `createAskInputSchema()` in [src/schemas/inputs.ts](C:/gemini-assistant/src/schemas/inputs.ts), into explicit variants with predictable validation behavior.
- **REQ-005**: Tighten [src/schemas/json-schema.ts](C:/gemini-assistant/src/schemas/json-schema.ts) so `GeminiResponseSchema` is an explicit supported subset rather than a loosely recursive JSON-Schema-like object.
- **REQ-006**: Keep completion wiring intact for cache and session completable fields created through `completableCacheName()` and `createSessionContinuationFields()`.
- **REQ-007**: Align prompt argument schemas in [src/prompts.ts](C:/gemini-assistant/src/prompts.ts) with the same scalar helpers, enum sources, and strictness rules as the tool schemas.
- **REQ-008**: Update schema tests in [**tests**/schemas/inputs.test.ts](C:/gemini-assistant/__tests__/schemas/inputs.test.ts) and [**tests**/schemas/json-schema.test.ts](C:/gemini-assistant/__tests__/schemas/json-schema.test.ts) to verify the new intended contract.
- **CON-001**: Do not edit generated or vendor directories such as `dist`, `.git`, or `node_modules`.
- **CON-002**: Follow repository safety boundaries. Verification commands are `npm run format`, `npm run lint`, `npm run type-check`, and `npm run test`.
- **CON-003**: The pass is intentionally contract-breaking. Backward compatibility is not required unless a break blocks the five-tool public contract or testability.
- **CON-004**: Keep all schema code on Zod 4 using `import { z } from 'zod/v4'`.
- **GUD-001**: Prefer `z.strictObject()` for public contracts and shared fragments unless a non-strict object is explicitly required.
- **GUD-002**: Prefer built-in schema composition over `refine()` when the invariant can be expressed structurally.
- **GUD-003**: Reserve `superRefine()` for cross-field invariants and multiple issue emission.
- **PAT-001**: Canonical scalar helpers belong in [src/schemas/fields.ts](C:/gemini-assistant/src/schemas/fields.ts).
- **PAT-002**: Canonical reusable object slices belong in [src/schemas/fragments.ts](C:/gemini-assistant/src/schemas/fragments.ts).
- **PAT-003**: Public request and response contracts belong in [src/schemas/inputs.ts](C:/gemini-assistant/src/schemas/inputs.ts) and [src/schemas/outputs.ts](C:/gemini-assistant/src/schemas/outputs.ts).
- **PAT-004**: Prompt arg schemas belong in [src/prompts.ts](C:/gemini-assistant/src/prompts.ts) and should consume canonical shared helpers instead of re-declaring equivalent scalar rules.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Establish canonical scalar helpers and literal groups in [src/schemas/fields.ts](C:/gemini-assistant/src/schemas/fields.ts) and remove repeated primitive constraints from downstream schemas.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---- |
| TASK-001 | Audit repeated scalar constraints in [src/schemas/inputs.ts](C:/gemini-assistant/src/schemas/inputs.ts), [src/schemas/outputs.ts](C:/gemini-assistant/src/schemas/outputs.ts), [src/schemas/fragments.ts](C:/gemini-assistant/src/schemas/fragments.ts), and [src/prompts.ts](C:/gemini-assistant/src/prompts.ts). Record exact reuse targets for `temperature`, `searchDepth`, diagram type enums, repeated text fields, URL arrays, path arrays, timestamps, and cache-name fields.            |           |      |
| TASK-002 | Extend [src/schemas/fields.ts](C:/gemini-assistant/src/schemas/fields.ts) with canonical helpers for bounded numeric values, repeated literal groups, reusable URL-array builders, reusable workspace-path-array builders, and any required distinction between normalized text and raw text. Keep existing helpers such as `textField()`, `goalText()`, `workspacePath()`, `ttlSeconds()`, `publicHttpUrlArray()`, `thinkingLevel()`, and `mediaResolution()` coherent rather than duplicative. |           |      |
| TASK-003 | Replace inline primitive constraints in downstream modules with the new canonical helpers. Update concrete call sites including `searchDepth`, `temperature`, `diagramType`, repeated `z.array(z.string())` path lists where appropriate, and repeated `z.string()` metadata fields when a canonical helper is appropriate.                                                                                                                                                                      |           |      |
| TASK-004 | Validate that helper extraction does not break `completable()` behavior for cache and session fields by preserving the current wiring paths that tests introspect through `Symbol.for('mcp.completable')`.                                                                                                                                                                                                                                                                                       |           |      |

### Implementation Phase 2

- **GOAL-002**: Normalize shared fragments in [src/schemas/fragments.ts](C:/gemini-assistant/src/schemas/fragments.ts) so object slices are reusable, explicit, and consistent with the scalar helper layer.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                 | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-005 | Refactor [src/schemas/fragments.ts](C:/gemini-assistant/src/schemas/fragments.ts) to centralize shared object shapes for URL context, cache references, session continuation, file-pair inputs, usage metadata, URL metadata, source details, diff stats, and output stream metadata. Remove fragment-level duplication that can now be expressed through Phase 1 helpers.                                                                  |           |      |
| TASK-006 | Review fragment return shapes from `createFilePairFields()`, `createOptionalCacheReferenceFields()`, `createUrlContextFields()`, and `createSessionContinuationFields()` and standardize naming, descriptions, and optionality rules so all consumers in inputs, outputs, and prompts inherit the same contract.                                                                                                                            |           |      |
| TASK-007 | Move repeated output-side object fragments out of [src/schemas/outputs.ts](C:/gemini-assistant/src/schemas/outputs.ts) into [src/schemas/fragments.ts](C:/gemini-assistant/src/schemas/fragments.ts) when the shape is reused by more than one exported output schema. Candidate shapes include context transparency metadata, session resource links, transcript/event summaries, and shared path or warning collections if reuse is real. |           |      |
| TASK-008 | Keep fragment scope disciplined. Reject fragment extraction for one-off shapes that reduce readability or couple unrelated contracts.                                                                                                                                                                                                                                                                                                       |           |      |

### Implementation Phase 3

- **GOAL-003**: Tighten [src/schemas/json-schema.ts](C:/gemini-assistant/src/schemas/json-schema.ts) into an explicit Gemini response schema subset with deterministic cross-field validation.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                | Completed | Date |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-009 | Redesign `GeminiResponseSchema` in [src/schemas/json-schema.ts](C:/gemini-assistant/src/schemas/json-schema.ts) as an explicit supported subset. Separate allowed object-node, array-node, and scalar-node semantics instead of relying on a single permissive recursive object shape.                                                                     |           |      |
| TASK-010 | Extract or reuse validation helpers in [src/schemas/validators.ts](C:/gemini-assistant/src/schemas/validators.ts) for cross-field rules such as `required` requiring `properties`, duplicate property-key detection, invalid key references in `required`, and any new rules introduced for `type`, `items`, `enum`, `format`, `title`, and `description`. |           |      |
| TASK-011 | Decide and codify exact allowed combinations for `nullable`, `properties`, `required`, `items`, `enum`, `format`, `title`, and `description`. Reject semantically muddled combinations even if they were previously accepted. Document those combinations in schema descriptions or comments only where needed for maintainability.                        |           |      |
| TASK-012 | Update [**tests**/schemas/json-schema.test.ts](C:/gemini-assistant/__tests__/schemas/json-schema.test.ts) to cover the redesigned subset with explicit valid and invalid examples. Keep tests focused on supported semantics, exact property preservation, and clearer invalid-shape failures.                                                             |           |      |

### Implementation Phase 4

- **GOAL-004**: Refactor public input schemas in [src/schemas/inputs.ts](C:/gemini-assistant/src/schemas/inputs.ts) to consume canonical helpers, remove duplicate type ownership, and redesign ambiguous unions into explicit variants.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                                                                     | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-013 | Refactor `createChatInputSchema()`, `ResearchInputSchema`, `AnalyzeInputSchema`, `ReviewInputSchema`, `createMemoryInputSchema()`, `createAskInputSchema()`, `CreateCacheInputSchema`, `DeleteCacheInputSchema`, `UpdateCacheInputSchema`, `AnalyzePrInputSchema`, `CompareFilesInputSchema`, and `GenerateDiagramInputSchema` to consume Phase 1 helpers and Phase 2 fragments instead of repeating inline scalar constraints. |           |      |
| TASK-014 | Replace hand-written exported interfaces in [src/schemas/inputs.ts](C:/gemini-assistant/src/schemas/inputs.ts), including `AnalyzeInput`, `AskInput`, `SearchInput`, and `AnalyzeUrlInput`, with `z.infer`-derived types unless a type must intentionally differ from the runtime contract. If an intentional difference remains, document the reason inline.                                                                   |           |      |
| TASK-015 | Redesign `createAskInputSchema()` so URL-capable and non-URL-capable variants are explicit and predictable. Remove optional-plus-optional ambiguity between `toolProfile` and `urls`. Ensure the new variant model still supports the required tool profiles and preserves strict-object behavior.                                                                                                                              |           |      |
| TASK-016 | Standardize repeated target and output selector patterns across `AnalyzeInputSchema`, `ReviewInputSchema`, cache-related schemas, and research-related schemas. Ensure the public contract remains aligned with the five-tool model from the approved tool-surface spec.                                                                                                                                                        |           |      |
| TASK-017 | Keep custom validators in [src/schemas/validators.ts](C:/gemini-assistant/src/schemas/validators.ts) only where structural schema composition cannot express the rule. Revisit `validateExclusiveSourceFileFields()` and `validateMeaningfulCacheCreateInput()` after the contract redesign and simplify or remove them if the new structure makes them unnecessary.                                                            |           |      |

### Implementation Phase 5

- **GOAL-005**: Refactor public output schemas and prompt argument schemas so they follow the same canonical schema architecture and eliminate duplicate type ownership.

| Task     | Description                                                                                                                                                                                                                                                                                                                               | Completed | Date |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-018 | Refactor [src/schemas/outputs.ts](C:/gemini-assistant/src/schemas/outputs.ts) to consume canonical fields and fragments, especially for shared path arrays, warning arrays, metadata blocks, context reporting, and repeated string-based identifiers. Remove redundant local shapes where a fragment is the correct owner.               |           |      |
| TASK-019 | Replace manual output type declarations in [src/schemas/outputs.ts](C:/gemini-assistant/src/schemas/outputs.ts) with `z.infer` where possible, including `UsageMetadata`, `ContextSourceReport`, `ContextUsed`, `UrlMetadataEntry`, and `SourceDetail`. Preserve aliases only if they add real readability without duplicating semantics. |           |      |
| TASK-020 | Refactor prompt arg schemas in [src/prompts.ts](C:/gemini-assistant/src/prompts.ts), including `DiscoverPromptSchema`, `ResearchPromptSchema`, `ReviewPromptSchema`, and `MemoryPromptSchema`, to use canonical shared enums and text-field helpers. Remove duplicated literal arrays or scalar rules when a schema helper can own them.  |           |      |
| TASK-021 | Review `definePrompt()` typing in [src/prompts.ts](C:/gemini-assistant/src/prompts.ts) after prompt schema refactoring. Tighten generic typing only if it reduces ambiguity without forcing unsafe casts or broad `z.ZodType` escape hatches.                                                                                             |           |      |

### Implementation Phase 6

- **GOAL-006**: Replace permissive or legacy tests with deterministic tests that verify the redesigned contract and repository invariants.

| Task     | Description                                                                                                                                                                                                                                                                            | Completed | Date |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-022 | Rewrite [**tests**/schemas/inputs.test.ts](C:/gemini-assistant/__tests__/schemas/inputs.test.ts) so it validates the new input contracts rather than removed or legacy standalone schemas. Delete or replace tests for removed exports that no longer belong to the five-tool surface. |           |      |
| TASK-023 | Add targeted tests for the redesigned `AskInputSchema`, cache/session completion wiring, stricter path and URL array helpers, and any new discriminated union branches introduced in [src/schemas/inputs.ts](C:/gemini-assistant/src/schemas/inputs.ts).                               |           |      |
| TASK-024 | Add or update prompt tests if prompt schema helper reuse changes behavior in [src/prompts.ts](C:/gemini-assistant/src/prompts.ts). Verify prompt args remain strict and completable where expected.                                                                                    |           |      |
| TASK-025 | Run `npm run format`, `npm run lint`, `npm run type-check`, and `npm run test`. Resolve all failures without weakening the schema design goals. Record any irreducible breakage directly in the implementation PR or follow-up issue, not as silent TODOs in code.                     |           |      |

## 3. Alternatives

- **ALT-001**: Keep the current architecture and only patch individual weak schemas. Rejected because it preserves duplicate type ownership, repeated scalar logic, and ambiguous unions.
- **ALT-002**: Optimize the entire pass around JSON Schema/export correctness first. Rejected because it would improve one boundary while leaving input and prompt maintainability problems mostly intact.
- **ALT-003**: Restrict the pass to `src/schemas/json-schema.ts` and related tests. Rejected because the approved design explicitly covers all schema layers and adjacent prompt/test surfaces.
- **ALT-004**: Preserve hand-written TypeScript interfaces as public documentation even when they duplicate schema output. Rejected because duplicate type ownership is one of the primary maintenance problems in the current repo.

## 4. Dependencies

- **DEP-001**: [src/schemas/fields.ts](C:/gemini-assistant/src/schemas/fields.ts) must stabilize before large-scale refactoring of inputs, outputs, and prompts.
- **DEP-002**: [src/schemas/fragments.ts](C:/gemini-assistant/src/schemas/fragments.ts) depends on Phase 1 helpers and must stabilize before final contract cleanup in inputs and outputs.
- **DEP-003**: [src/schemas/json-schema.ts](C:/gemini-assistant/src/schemas/json-schema.ts) and [src/schemas/validators.ts](C:/gemini-assistant/src/schemas/validators.ts) should stabilize before `responseSchema`-using contracts are finalized in [src/schemas/inputs.ts](C:/gemini-assistant/src/schemas/inputs.ts).
- **DEP-004**: [src/prompts.ts](C:/gemini-assistant/src/prompts.ts) depends on canonical enum and text helpers established in earlier phases.
- **DEP-005**: Test rewrites depend on the final schema exports and contract decisions from Phases 3 through 5.
- **DEP-006**: Verification commands depend on repository scripts defined in [package.json](C:/gemini-assistant/package.json).

## 5. Files

- **FILE-001**: [src/schemas/fields.ts](C:/gemini-assistant/src/schemas/fields.ts) - canonical scalar helper ownership.
- **FILE-002**: [src/schemas/fragments.ts](C:/gemini-assistant/src/schemas/fragments.ts) - canonical shared object-fragment ownership.
- **FILE-003**: [src/schemas/json-schema.ts](C:/gemini-assistant/src/schemas/json-schema.ts) - explicit Gemini response schema subset.
- **FILE-004**: [src/schemas/validators.ts](C:/gemini-assistant/src/schemas/validators.ts) - cross-field schema validation helpers.
- **FILE-005**: [src/schemas/inputs.ts](C:/gemini-assistant/src/schemas/inputs.ts) - public tool input contracts and inferred type exports.
- **FILE-006**: [src/schemas/outputs.ts](C:/gemini-assistant/src/schemas/outputs.ts) - public tool output contracts and inferred type exports.
- **FILE-007**: [src/prompts.ts](C:/gemini-assistant/src/prompts.ts) - prompt arg schemas and prompt definition typing.
- **FILE-008**: [**tests**/schemas/inputs.test.ts](C:/gemini-assistant/__tests__/schemas/inputs.test.ts) - input schema regression and contract tests.
- **FILE-009**: [**tests**/schemas/json-schema.test.ts](C:/gemini-assistant/__tests__/schemas/json-schema.test.ts) - Gemini response schema subset tests.
- **FILE-010**: [docs/specs/2026-04-18-zod-schema-refinement-design.md](C:/gemini-assistant/docs/specs/2026-04-18-zod-schema-refinement-design.md) - approved source specification for the implementation.

## 6. Testing

- **TEST-001**: Verify each exported public input schema in [src/schemas/inputs.ts](C:/gemini-assistant/src/schemas/inputs.ts) accepts the intended minimal valid shape and rejects unknown keys.
- **TEST-002**: Verify redesigned `AskInputSchema` variants reject ambiguous `toolProfile` and `urls` combinations and still accept the intended explicit variants.
- **TEST-003**: Verify `CreateCacheInputSchema` and related cache contracts preserve required invariants and completion behavior after helper extraction.
- **TEST-004**: Verify workspace path helpers reject root-escaping relative paths and Windows drive-relative forms across all path-consuming schemas.
- **TEST-005**: Verify `GeminiResponseSchema` accepts intended explicit subset nodes and rejects invalid `required`, `properties`, `items`, `enum`, and `format` combinations.
- **TEST-006**: Verify prompt schemas in [src/prompts.ts](C:/gemini-assistant/src/prompts.ts) remain strict and use the expected completable enum behavior.
- **TEST-007**: Run `npm run format` and confirm no formatting diffs remain.
- **TEST-008**: Run `npm run lint` and confirm zero lint errors.
- **TEST-009**: Run `npm run type-check` and confirm zero TypeScript errors.
- **TEST-010**: Run `npm run test` and confirm the full test suite passes with the new contract expectations.

## 7. Risks & Assumptions

- **RISK-001**: Removing manual interfaces may break consumers that were importing those names rather than inferring from schemas.
- **RISK-002**: Over-extracting helpers or fragments can reduce readability if abstractions become more complex than the repeated code they replace.
- **RISK-003**: Tightening `GeminiResponseSchema` may reject payloads currently accepted by tests or callers that rely on loosely modeled combinations.
- **RISK-004**: Refactoring `createAskInputSchema()` can change error shapes or branch-matching behavior in ways that require broad test updates.
- **ASSUMPTION-001**: The repo intends to keep the five-tool public contract stable while allowing schema-level breaking changes inside those tool contracts.
- **ASSUMPTION-002**: Prompt schemas are part of the same schema-governance surface and should follow the same canonical helper rules.
- **ASSUMPTION-003**: Current tests that reference removed standalone schemas represent legacy coverage and may be deleted or replaced.
- **ASSUMPTION-004**: No new external dependencies are required; the refactor is achievable with the existing Zod 4 and MCP packages in [package.json](C:/gemini-assistant/package.json).

## 8. Related Specifications / Further Reading

- [docs/specs/2026-04-18-zod-schema-refinement-design.md](C:/gemini-assistant/docs/specs/2026-04-18-zod-schema-refinement-design.md)
- [docs/specs/2026-04-18-tool-surface-consolidation-design.md](C:/gemini-assistant/docs/specs/2026-04-18-tool-surface-consolidation-design.md)
- [src/schemas/inputs.ts](C:/gemini-assistant/src/schemas/inputs.ts)
- [src/schemas/outputs.ts](C:/gemini-assistant/src/schemas/outputs.ts)
- [src/schemas/json-schema.ts](C:/gemini-assistant/src/schemas/json-schema.ts)
