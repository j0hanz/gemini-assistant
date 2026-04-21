# Tool Surface Consolidation Design

Date: 2026-04-18
Status: Approved for spec review

## Goal

Reduce the public MCP tool surface to a smaller, cleaner job-first contract by removing low-value standalone tools and integrating their capabilities into stronger existing public tools.

This pass is intentionally contract-breaking. Removed public tools and public schemas will be deleted outright rather than kept as aliases or deprecations.

## Desired End State

The server exposes exactly five public tools:

- `chat`
- `research`
- `analyze`
- `review`
- `memory`

The following are removed from the public tool surface:

- `discover`
- `search`
- `analyze_url`
- `agentic_search`
- `explain_error`
- `diagram`
- `execute_code`

The contract rule is:

- Public tools represent stable user intent.
- Internal helpers represent execution strategy and should not appear as separate public tools.

## Public Tool Responsibilities

### `chat`

Owns direct Gemini interaction, structured generation, and optional server-managed sessions.

No contract change is required in this pass beyond removal of `discover` references from surrounding metadata.

### `research`

Owns all public current-information and web-grounded investigation flows.

Public behavior:

- `mode="quick"` covers the public role previously associated with `search`
- `mode="deep"` covers the public role previously associated with `agentic_search`

Implications:

- standalone public registration for `search` is removed
- standalone public registration for `agentic_search` is removed
- research internals may keep helper functions for quick and deep execution, but those helpers are no longer part of the public contract

### `analyze`

Owns bounded artifact understanding and representation.

Public behavior:

- file analysis
- URL analysis
- small multi-file analysis
- diagram generation from known artifacts

`analyze_url` is no longer a public tool. URL analysis is expressed only as `analyze.targets.kind="url"`.

Diagram generation also moves under `analyze` instead of existing as a separate public tool.

Recommended contract direction:

- keep `goal`
- keep explicit `targets`
- add an output selector:
  - `output.kind="summary"` for normal analysis
  - `output.kind="diagram"` for diagram generation
  - `output.diagramType="mermaid" | "plantuml"` when `output.kind="diagram"`
  - `output.validateSyntax?` only for diagram output

Why this shape:

- target selection stays separate from requested output form
- new output forms can be added later without creating new top-level tools
- diagram generation remains typed and job-first instead of being pushed into generic chat

Implementation note:

- any syntax validation or model code execution used to support diagrams remains internal to `analyze`
- no public `execute_code` or `diagram` registration remains

### `review`

Owns evaluative work over diffs, file comparisons, and failures.

Public behavior:

- `subject.kind="diff"`
- `subject.kind="comparison"`
- `subject.kind="failure"`

`explain_error` is removed as a public concept. Failure diagnosis is expressed only through `review.subject.kind="failure"`.

This means:

- standalone public registration for `explain_error` is removed
- standalone public schema ownership for `ExplainErrorInputSchema` is removed
- failure diagnosis logic is owned directly by `review`

### `memory`

Owns sessions, caches, and workspace memory state.

No major contract reshaping is required in this pass.

## `discover` Decision

`discover` is removed as a public callable tool.

Reasoning:

- it is useful for onboarding, but not essential
- it adds a public entry point without adding core execution capability
- the better simplification target is the callable surface, not necessarily the descriptive resources

Recommended handling:

- remove `discover` tool registration
- remove `discover` from public tool enums, workflow recommendations, server description, server instructions, and tests
- keep `discover://catalog`, `discover://workflows`, and `discover://context` as resources for now unless a later cleanup decides to remove discovery resources entirely

This keeps self-description available without spending one of the public tool slots on a callable tool.

## Module Ownership

After consolidation, each public tool should have exactly one owning tool module:

- `src/tools/chat.ts`
- `src/tools/research.ts`
- `src/tools/analyze.ts`
- `src/tools/review.ts`
- `src/tools/memory.ts`

Expected removals or ownership changes:

- remove `src/tools/explain-error.ts`
- remove `src/tools/discover.ts` as a public-tool module
- remove `src/tools/diagram.ts` as a public-tool module
- keep reusable helpers only if they serve an owning public tool
- move reusable prompt/build/result helpers either into the owning public tool module or into `src/lib`

Registration rule:

- `src/server.ts` registers only `chat`, `research`, `analyze`, `review`, and `memory`

## Public Contract Changes

The public contract must be updated everywhere it is represented:

- tool registration in `src/server.ts`
- tool and workflow metadata in `src/public-contract.ts`
- discover/catalog rendering logic if it assumes `discover` is a public tool
- server description and instructions strings
- README wording describing the public jobs
- tests that assert the public tool list or standalone schemas

The public contract should no longer expose or imply the existence of removed standalone tools.

## Schema Changes

### Remove standalone public schemas for removed tools

Delete or stop exporting standalone public schemas whose only purpose was a removed public tool, including:

- `ExplainErrorInputSchema`
- any output schemas that only existed for removed public tools

### Keep only umbrella-job schemas public

Public schemas should center on:

- `ChatInputSchema`
- `ResearchInputSchema`
- `AnalyzeInputSchema`
- `ReviewInputSchema`
- `MemoryInputSchema`

### `analyze` schema refinement

`AnalyzeInputSchema` should be expanded to express output form explicitly, so diagram generation becomes first-class inside `analyze`.

The expected result shape should support:

- standard analysis summary output
- diagram output with optional explanation and source metadata

### `review` schema refinement

`ReviewInputSchema` remains the public owner for failure diagnosis through `subject.kind="failure"`.

No parallel standalone failure-diagnosis schema should remain public.

## Error Handling Expectations

Removed tools should disappear completely from registration. They should not silently redirect.

Integrated flows must preserve or improve behavior quality:

- failure diagnosis errors surface through `review`
- URL retrieval and URL analysis errors surface through `analyze`
- quick and deep web-grounded failures surface through `research`
- diagram validation failures surface through `analyze`

Internal execution details such as hidden code execution should not leak into the public contract unless needed in structured output for the owning public tool.

## Testing Changes

Update tests to reflect the new five-tool contract.

Required test updates:

- registration tests assert only five public tools are registered
- public contract tests remove `discover` as a public tool
- schema tests remove coverage that only validates removed standalone public schemas
- research tests focus on `research.mode="quick"` and `research.mode="deep"` as the only public research paths
- review tests focus on `review.subject.kind="failure"` as the only public failure-diagnosis path
- analyze tests add coverage for diagram output mode

Remove tests whose only purpose was validating obsolete public tool registrations.

## Implementation Sequence

1. Reshape schemas and outputs around the five-tool contract.
2. Move failure diagnosis fully under `review`.
3. Move diagram generation fully under `analyze`.
4. Stop registering removed public tools.
5. Remove obsolete tool modules and public-contract entries.
6. Update docs and tests to match the new contract.
7. Run `npm run format`.
8. Run `npm run lint`.
9. Run `npm run type-check`.
10. Run `npm run test`.

## Non-Goals

- preserving backwards compatibility for removed public tools
- retaining deprecated aliases for one release
- broad unrelated refactoring outside public-tool ownership alignment
- deciding in this pass whether `discover://...` resources should also be deleted

## Risks

- contract-breaking changes may affect existing clients immediately
- stale tests and public-contract metadata may drift if updates are incomplete
- moving diagram behavior under `analyze` can complicate the schema if the output selector is not kept simple
- hidden internal helpers may linger unless file ownership is cleaned up decisively

## Success Criteria

- the server exposes exactly five public tools
- each remaining public tool maps to a distinct user intent
- removed capabilities are available only through their owning umbrella tools
- no standalone public schema remains for removed standalone tools
- docs, contract metadata, and tests all describe the same five-tool surface
