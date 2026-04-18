# Zod Schema Maintainability Refactor Design

Date: 2026-04-18

## Summary

Refactor the Zod schema layer to reduce repetition and drift while keeping the public contract stable. The target state is a small internal schema kit built from reusable field primitives, reusable object-shape fragments, and explicit public schema assembly. This is a maintainability-first refactor, not a schema feature expansion project.

## Goals

- Reduce repeated field definitions and near-duplicate object shapes across input and output schemas.
- Keep public contracts readable and explicit in the assembled schema files.
- Preserve existing public behavior unless the current behavior is clearly a contract leak.
- Make shared validation rules easier to apply consistently.
- Improve test coverage around current edge cases and approved validation tightenings.

## Non-Goals

- Redesigning the public job-first API surface.
- Broadening JSON Schema support beyond what the product actually needs.
- Replacing Zod with a declarative generator or large internal DSL.
- Hiding public contracts behind configuration-heavy schema builders.
- Refactoring unrelated tool logic outside the schema layer.

## Current Problems

### Repetition

The current schema files repeat the same semantic fields in multiple places:

- trimmed non-empty text
- optional text
- thinking level
- cache name
- workspace path
- public HTTP URL lists
- output metadata such as usage, warnings, request IDs, and stream details

This repetition increases the cost of changes and makes contract tightening uneven.

### Drift Risk

Repeated shapes are easy to evolve differently over time. Similar concerns are expressed with slightly different inline definitions depending on the file, which increases the chance of inconsistent validation or documentation.

### Concrete Leaks

The current implementation has a few behavior leaks worth fixing as part of the refactor:

- empty `sessionId` and `session.id` are accepted
- `prefixItems` is listed as a supported response-schema shape key but is rejected by the strict schema object
- Windows drive-relative path forms are too loosely accepted at the schema layer
- `CreateCacheInputSchema` currently accepts `filePaths: []` when `systemInstruction` is present, even though omission is the clearer contract

## Design

### 1. Layering

Split the schema layer into three levels:

1. `field primitives`
2. `schema fragments`
3. `assembled public schemas`

This keeps reusable logic centralized without obscuring the final contracts.

### 2. Field Primitives

Field primitives should contain reusable leaf-level builders and stable enums only.

Examples:

- required trimmed text
- optional trimmed text
- session ID
- cache name
- thinking level
- workspace path
- URL list builders
- timestamps
- non-negative integers

Rules:

- Extract fields when the same semantic contract appears in multiple places.
- Do not create multiple builders for the same semantic concept unless the contract really differs.
- Keep field builders small and unsurprising.

### 3. Schema Fragments

Fragments should return plain object shapes or stable reusable schema components for repeated concerns.

Examples:

- session continuation fragments
- cache-aware fragments
- file-pair fragments
- source detail fragments
- shared stream metadata
- public output base metadata
- URL context fragments

Rules:

- Fragments are for stable reuse, not for every local coincidence.
- Fragments should stay readable enough that public schema files still read as contracts.
- Prefer object-shape composition over abstract factory APIs.

### 4. Validators

Cross-field rules reused in more than one place should live in a dedicated validator module.

Examples:

- mutually exclusive field groups
- “at least one of these inputs must be provided”
- bounds consistency
- property-key list checks for response schemas

Validators should remain close to plain Zod `.refine()` and `.superRefine()` usage. The refactor should not introduce a custom rule engine.

### 5. Assembled Public Schemas

Public input and output schemas should remain explicit Zod declarations assembled from shared pieces.

Preferred pattern:

- keep `z.strictObject(...)` and `z.discriminatedUnion(...)` at the public contract layer
- compose with imported fields and fragments
- avoid hiding contract structure behind `buildToolSchema({ ... })` style helpers

This preserves readability for maintainers who need to understand the public surface quickly.

## File Layout

Recommended structure:

- `src/schemas/fields.ts`
- `src/schemas/fragments.ts`
- `src/schemas/validators.ts`
- `src/schemas/inputs.ts`
- `src/schemas/outputs.ts`
- `src/schemas/json-schema.ts`

`json-schema.ts` should remain separate because it models a recursive domain with specialized rules. It should be cleaned up where useful, but not folded into a generic helper system.

## Behavioral Boundaries

### Preserve

The refactor should preserve:

- public field names
- discriminators
- strict unknown-key rejection
- current defaults such as `searchDepth: 3` and `diagramType: 'mermaid'`
- current output structure and metadata conventions

### Tighten

The refactor should intentionally tighten:

- empty `sessionId`
- empty `session.id`
- unsupported `prefixItems` claims in response-schema validation
- path validation consistency for Windows drive-relative forms
- `CreateCacheInputSchema.filePaths: []` when `systemInstruction` is present

For `prefixItems`, the maintainability-first choice is to remove unsupported claims instead of expanding implementation unless there is a real product requirement to support it.

## Migration Plan

1. Extract stable field primitives with the lowest behavioral risk.
2. Extract repeated output metadata fragments.
3. Extract repeated input fragments.
4. Reassemble public schemas using the shared pieces.
5. Apply the approved contract tightenings.
6. Add targeted regression tests for the tightened behavior.

This order keeps the refactor incremental and reduces the chance of mixing behavior changes with structural cleanup.

## Testing Strategy

Validation of the refactor should rely on public behavior, not internal composition.

Required coverage:

- existing schema and contract tests continue to pass
- regression tests for empty session IDs
- regression tests for response-schema keyword support consistency
- regression tests for Windows drive-relative path handling
- regression tests for rejecting `CreateCacheInputSchema.filePaths: []` when `systemInstruction` is present

Test assertions should stay focused on contract outcomes so future cleanup remains cheap.

## Risks

### Over-Abstraction

If too much logic is pushed into generic builders, the schema layer becomes harder to read and debug than it is today.

Mitigation:

- keep assembly explicit
- extract only stable repeated patterns
- avoid config-driven schema factories

### Hidden Contract Changes

A maintainability refactor can accidentally change validation behavior.

Mitigation:

- preserve current contracts by default
- isolate approved tightenings
- add narrow regression tests for tightened cases

### Fragment Sprawl

Too many tiny fragments can make schema navigation worse instead of better.

Mitigation:

- keep fragment count small
- group by stable concern
- avoid single-use abstraction

## Acceptance Criteria

- The schema layer has materially less repeated field and metadata definition code.
- Public input and output schema files remain readable as contract definitions.
- No intentional public contract changes occur beyond the approved tightenings.
- Tests cover the tightened edge cases explicitly.
- The resulting structure makes future schema changes cheaper and less error-prone.
