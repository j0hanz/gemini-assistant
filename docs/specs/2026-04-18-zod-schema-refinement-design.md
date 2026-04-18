# Zod Schema Refinement Design

Date: 2026-04-18
Status: Approved for spec review

## Goal

Refine and optimize the repository's Zod 4 schema layer across all meaningful contract boundaries, including:

- public tool input schemas
- public tool output schemas
- shared schema field and fragment builders
- prompt argument schemas
- tests that currently preserve loose or accidental behavior

This pass is intentionally contract-breaking. The design prioritizes correctness, explicitness, and maintainability over backward compatibility with currently accepted weak inputs.

## Desired End State

The repository should treat Zod schemas as the single source of truth for runtime validation and TypeScript contract inference.

After this pass:

- scalar constraints live in one canonical layer
- reusable object slices live in one canonical layer
- final tool contracts are explicit, strict, and easier to extend
- manual TypeScript interfaces do not duplicate exported schema semantics
- the Gemini response schema subset is explicitly modeled rather than loosely recursive
- tests validate intended public behavior instead of accidental permissiveness

Maintainability is the tie-breaker when UX and schema/export correctness compete.

## Design Principles

- prefer `z.strictObject()` for public contracts
- prefer schema composition over repeated inline constraints
- prefer `z.infer` over hand-maintained parallel interfaces
- prefer discriminated unions over broad structural unions when a stable selector exists
- use `superRefine()` only for cross-field invariants or when multiple issues need to be surfaced
- keep normalization explicit and minimal
- keep JSON Schema support intentionally limited and clearly documented
- place descriptions where they are easiest to keep accurate

## Architecture

The schema system should be organized into three clear layers:

### Scalar fields

[src/schemas/fields.ts](C:/gemini-assistant/src/schemas/fields.ts) should own reusable scalar contracts such as:

- trimmed required text
- bounded integers and numeric knobs
- URLs and URL arrays
- workspace-relative or absolute paths
- timestamps and cache names
- enums and common literal groups

This module should not accumulate tool-specific object structure.

### Shared fragments

[src/schemas/fragments.ts](C:/gemini-assistant/src/schemas/fragments.ts) should own reusable object slices such as:

- session continuation fields
- cache reference fields
- URL context fragments
- file-pair fragments
- shared metadata blocks for outputs

Fragments should compose higher-level contracts but should not become an unstructured dumping ground for one-off shapes.

### Final contracts

Final public request and response contracts should live in:

- [src/schemas/inputs.ts](C:/gemini-assistant/src/schemas/inputs.ts)
- [src/schemas/outputs.ts](C:/gemini-assistant/src/schemas/outputs.ts)
- [src/prompts.ts](C:/gemini-assistant/src/prompts.ts) for prompt argument schemas

These modules should consume canonical fields and fragments rather than re-declaring equivalent constraints locally.

## Current Problem Areas

The existing code already trends toward a layered schema design, but it applies that structure inconsistently.

Key issues to address:

### Duplicate type ownership

[src/schemas/inputs.ts](C:/gemini-assistant/src/schemas/inputs.ts) currently mixes `z.infer`-derived types with hand-written interfaces such as `AnalyzeInput`, `AskInput`, `SearchInput`, and `AnalyzeUrlInput`.

That creates drift risk and weakens the claim that schemas are authoritative.

### Repeated scalar constraints

The same bounds and descriptions recur across several schemas, including:

- `temperature`
- `searchDepth`
- file path arrays
- URL arrays
- diagram syntax enums
- repeated free-text fields with the same trimming and length semantics

Those constraints should be expressed once and reused consistently.

### Ambiguous unions

Some unions are valid but harder to reason about than necessary.

The main example is `AskInputSchema`, where optional `toolProfile` and optional `urls` make the contract less explicit than a clearer variant model would.

### Mixed normalization rules

Some text inputs are trimmed through shared helpers while others are plain strings. Some arrays are built from reusable primitives while others are inlined.

The redesign should make normalization intent obvious instead of incidental.

### Under-modeled Gemini response schema subset

[src/schemas/json-schema.ts](C:/gemini-assistant/src/schemas/json-schema.ts) implements a useful recursive subset, but the supported contract is still effectively "JSON Schema-like object with extra validation."

If this is a supported public boundary, it should be modeled as an explicit subset with explicit node rules.

### Description placement is inconsistent

The repo uses `.describe()` productively, but there is no clear rule for which descriptions belong on shared helpers versus exported contract fields.

That makes reused descriptions harder to trust over time.

## Schema Rules

The redesign should apply the following repo-wide rules:

1. Public input and output contracts use `z.strictObject()` unless there is a deliberate and documented reason not to.
2. Repeated primitive constraints become named field factories.
3. Repeated object slices become named fragment builders.
4. Exported contract types come from `z.infer` by default.
5. Cross-field invariants use `superRefine()` with precise issue paths.
6. Broad unions are replaced with discriminated unions wherever stable selectors exist.
7. String normalization and other preprocessing are applied only when they are clearly part of the contract.
8. The Gemini response schema subset remains intentionally limited and does not pretend to support full JSON Schema semantics.

## Concrete Refactor Targets

### [src/schemas/fields.ts](C:/gemini-assistant/src/schemas/fields.ts)

Turn this into the canonical scalar module.

Likely additions or reshaping:

- bounded float helper for temperature-like values
- bounded integer helper for search-depth-like inputs
- reusable URL-array and path-array builders
- clearer distinction between normalized text and raw text if both are required
- centralized literal groups where reuse is meaningful

### [src/schemas/inputs.ts](C:/gemini-assistant/src/schemas/inputs.ts)

This is the primary cleanup target.

Expected changes:

- factor repeated tool options into shared fields or fragments
- redesign `AskInputSchema` into clearer variants
- remove manual interfaces where schema inference is sufficient
- standardize diagram, cache, search, and URL-context options
- make target composition patterns more uniform across tools

### [src/schemas/outputs.ts](C:/gemini-assistant/src/schemas/outputs.ts)

This module should adopt the same composition discipline as inputs.

Expected changes:

- deduplicate repeated metadata and string-array patterns
- standardize discriminators and shared report fragments
- remove output-side duplicate type ownership where inference is adequate

### [src/schemas/json-schema.ts](C:/gemini-assistant/src/schemas/json-schema.ts)

This module should become an explicit contract definition, not a permissive recursive container.

Expected changes:

- separate object, array, and scalar node semantics more clearly
- tighten invariants between `type`, `properties`, `required`, `items`, `enum`, `format`, `title`, and `description`
- keep supported keywords explicit
- reject structurally valid but semantically muddled combinations

### [src/prompts.ts](C:/gemini-assistant/src/prompts.ts)

Prompt arg schemas should consume canonical shared schema builders instead of growing a parallel schema style.

Expected changes:

- reuse shared enums and text field builders where appropriate
- avoid duplicating scalar descriptions and options that already exist in canonical helpers
- keep prompt schemas aligned with the same strictness and naming rules as the rest of the repo

### Tests

Likely touch points include:

- [__tests__/schemas/inputs.test.ts](C:/gemini-assistant/__tests__/schemas/inputs.test.ts)
- [__tests__/schemas/json-schema.test.ts](C:/gemini-assistant/__tests__/schemas/json-schema.test.ts)
- prompt tests that encode current loose acceptance

Tests should be updated to reflect intended contracts, not historical permissiveness.

## Likely Breaking Changes

Because this pass is explicitly aggressive, the following changes are acceptable:

- rejecting weak or ambiguous input combinations that currently pass
- replacing optional-plus-optional unions with explicit variants
- removing duplicate interfaces that encode stale or looser semantics
- tightening the supported Gemini response schema subset
- changing test expectations when they preserve accidental behavior

No compatibility layer is required unless a later implementation plan decides a specific break is too costly.

## Error Handling Expectations

The schema pass should improve failure quality, not only strictness.

Guidelines:

- use built-in issue types where possible instead of generic custom messages
- keep schema-level custom messages only when they materially improve contract clarity
- use `superRefine()` for cross-field validation that needs exact issue paths
- ensure redesigned unions fail in understandable ways, especially for tool-mode selection

The end result should be stricter contracts with more predictable error surfaces.

## Testing Strategy

Schema testing should remain example-driven.

Required coverage patterns:

- valid examples for each public variant
- invalid examples for each strictness rule
- boundary tests for repeated numeric and collection constraints
- targeted regression tests for redesigned unions
- targeted tests for the explicit Gemini response schema subset

Avoid brittle full-error snapshots unless a particular error shape is part of the intended UX.

## Implementation Sequence

1. Normalize scalar helpers in [src/schemas/fields.ts](C:/gemini-assistant/src/schemas/fields.ts).
2. Tighten and explicitly model [src/schemas/json-schema.ts](C:/gemini-assistant/src/schemas/json-schema.ts).
3. Refactor [src/schemas/inputs.ts](C:/gemini-assistant/src/schemas/inputs.ts) around canonical fields and fragments.
4. Refactor [src/schemas/outputs.ts](C:/gemini-assistant/src/schemas/outputs.ts) and [src/prompts.ts](C:/gemini-assistant/src/prompts.ts) to match the same rules.
5. Rewrite and expand schema-focused tests.
6. Run `npm run format`.
7. Run `npm run lint`.
8. Run `npm run type-check`.
9. Run `npm run test`.

## Non-Goals

- preserving backward compatibility for weak or ambiguous schema behavior
- adding new end-user features unrelated to schema quality
- broad unrelated refactoring outside schema, prompt-schema, and adjacent test ownership
- pretending to support arbitrary JSON Schema beyond the explicitly chosen Gemini response subset

## Risks

- contract-breaking changes may invalidate callers or fixtures immediately
- removing manual interfaces can expose hidden consumer assumptions
- over-centralizing helpers can make simple schemas harder to read if abstraction is pushed too far
- tightening the response schema subset may block currently accepted edge cases that some callers rely on

## Success Criteria

- the repo has one canonical place for scalar schema constraints
- shared object slices are consistently composed rather than duplicated
- exported contract types derive from exported schemas by default
- tool and prompt schemas are stricter and easier to reason about
- the Gemini response schema subset is explicit and internally consistent
- tests validate intended behavior rather than preserving accidental permissiveness
