# LLM-Optimized Response Payloads

**Date:** 2026-04-29
**Status:** Approved — pending implementation

## Problem

`gemini-assistant` MCP tool responses are consumed primarily by LLM orchestrators. Every field in
the response payload costs tokens. The current outputs carry significant noise: diagnostics blocks,
redundant URL arrays, echo discriminators, telemetry metadata, path lists, and empty arrays — none
of which an LLM orchestrator can act on. This design removes that noise permanently, with no
opt-in flags or tiers.

## Design Decisions

| #   | Area                      | Decision                                                                                                                                               |
| :-- | :------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Primary consumer          | LLM orchestrator only — every token is cost                                                                                                            |
| 2   | Control strategy          | Always minimal, no opt-in flags                                                                                                                        |
| 3   | `diagnostics` block       | Removed entirely from all outputs                                                                                                                      |
| 4   | URL source arrays         | `sourceDetails` only — drop `sources`, `urlContextSources`, `urlMetadata`                                                                              |
| 5   | Grounding signals         | `status` only — drop `groundingSignals` (5 fields)                                                                                                     |
| 6   | Echo discriminators       | Removed — `mode`, `kind`, `targetKind`, `subjectKind` from all outputs                                                                                 |
| 7   | Low-signal metadata       | Removed — `requestId`, `workspaceCacheApplied`, `contextUsed`                                                                                          |
| 8   | Empty array serialization | Systematic strip in `response.ts` — null/undefined/`[]` never emitted                                                                                  |
| 9   | Input schema descriptions | Policy prose stripped from variant schemas — "Allowed only when X=Y" removed                                                                           |
| 10  | Review path arrays        | Removed — all 6 path arrays (`reviewedPaths`, `includedUntracked`, `skippedBinaryPaths`, `skippedLargePaths`, `skippedSensitivePaths`, `omittedPaths`) |
| 11  | `findings` vs `citations` | `findings` kept, `citations` dropped (byte offsets have no LLM utility)                                                                                |
| 12  | Non-fatal signals         | `warnings` only — `truncated`/`empty` fold in as warning message strings                                                                               |
| 13  | Session object            | `session.id` only — drop `rebuiltAt`, `resources`                                                                                                      |
| 14  | `computations`            | Removed — synthesized prose already incorporates execution results                                                                                     |

## Output Schema Changes

### `publicCoreOutputFields` (shared base — affects all tools)

```
REMOVE: requestId
REMOVE: diagnostics
KEEP:   warnings?
```

### Chat (`ChatOutputSchema`)

```
KEEP:   status, answer, data?
CHANGE: session → { id: string } only  (drop rebuiltAt, resources)
REMOVE: computations, workspaceCacheApplied, contextUsed
```

### Research quick (`ResearchQuickOutputSchema`)

```
KEEP:   status, summary, sourceDetails?
REMOVE: mode, sources, urlContextSources, urlMetadata, groundingSignals, contextUsed
```

### Research deep (`ResearchDeepOutputSchema`)

```
KEEP:   status, summary, sourceDetails?, findings?
REMOVE: mode, sources, urlContextSources, urlMetadata, groundingSignals, contextUsed,
        citations, computations, toolsUsed
```

### Analyze summary (`AnalyzeSummaryOutputSchema`)

```
KEEP:   status, summary
REMOVE: kind, targetKind, groundingSignals, urlMetadata, analyzedPaths, contextUsed
```

### Analyze diagram (`AnalyzeDiagramOutputSchema`)

```
KEEP:   status, diagramType, diagram, explanation?, syntaxErrors?, syntaxValid?
REMOVE: kind, targetKind, urlMetadata, analyzedPaths, contextUsed
```

### Review (`ReviewOutputSchema`)

```
KEEP:   status, summary, stats?, documentationDrift?
REMOVE: subjectKind, schemaWarnings (fold into warnings), reviewedPaths,
        includedUntracked, skippedBinaryPaths, skippedLargePaths,
        skippedSensitivePaths, omittedPaths, truncated, empty, contextUsed
NOTE:   truncated → warnings.push("Diff was truncated: {n} paths omitted due to size limit.")
        empty     → warnings.push("No changes detected in the diff.")
        schemaWarnings items → spread into warnings[]
```

## Input Schema Changes

### Variant schema descriptions (`src/schemas/inputs.ts`)

Remove "Allowed only when X=Y" policy clauses from all variant-specific field descriptions. The
discriminated union already enforces these constraints structurally. Keep only the functional
purpose sentence.

Examples:

```
Before: "Workspace-relative or absolute path to analyze when targetKind=file. Allowed only when targetKind=file."
After:  "File path to analyze."

Before: "Error message or stack trace when subjectKind=failure. Allowed only when subjectKind=failure."
After:  "Error message or stack trace."
```

## Implementation Plan

### Phase 1 — Schema layer

**Files:** `src/schemas/outputs.ts`, `src/schemas/fields.ts`, `src/schemas/inputs.ts`

- Remove fields from `publicCoreOutputFields`: `requestId`, `diagnostics`
- Remove `DiagnosticsSchema` usage (keep definition only if used elsewhere; delete if not)
- Strip each tool output schema per the table above
- Remove `ContextUsedSchema` usage from all output schemas
- Remove `SessionResourceLinksSchema` and simplify session object in `ChatOutputSchema`
- Remove `schemaWarnings` from `ReviewOutputSchema`
- Remove `truncated` and `empty` from `ReviewOutputSchema`
- Strip policy prose from variant-schema field descriptions in `inputs.ts`

### Phase 2 — Strip function

**File:** `src/lib/response.ts`

Add a `stripEmpty` function that recursively walks an object and deletes any key whose value is
`null`, `undefined`, or an empty array (`[]`). Apply it to the output object before building
`CallToolResult`. This handles all current and future optional array fields automatically.

```typescript
function stripEmpty(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripEmpty);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      result[k] = stripEmpty(v);
    }
    return result;
  }
  return obj;
}
```

### Phase 3 — Handler cleanup

**Files:** `src/tools/chat.ts`, `src/tools/research.ts`, `src/tools/analyze.ts`, `src/tools/review.ts`

- **chat.ts**: Stop populating `computations`, `workspaceCacheApplied`, `contextUsed`. Reduce
  session construction to `{ id }`.
- **research.ts**: Stop populating `sources`, `urlContextSources`, `urlMetadata`,
  `groundingSignals`, `contextUsed`, `citations`, `computations`, `toolsUsed`, `mode`.
- **analyze.ts**: Stop populating `groundingSignals`, `urlMetadata`, `analyzedPaths`,
  `contextUsed`, `kind`, `targetKind`.
- **review.ts**: Stop populating the 6 path arrays, `truncated`, `empty`, `schemaWarnings`,
  `subjectKind`, `contextUsed`. Instead: conditionally push to `warnings[]` for truncation and
  empty-diff cases; spread `schemaWarnings` items into `warnings[]`.
- **All tools**: Stop populating `requestId`, `diagnostics`.

### Phase 4 — Test updates

**Files:** `__tests__/**/*.test.ts`, `__tests__/**/*.e2e.test.ts`

Update all test fixtures and assertions that reference removed fields. Tests expecting
`diagnostics`, `requestId`, `mode`, `kind`, `targetKind`, `subjectKind`, `groundingSignals`,
`contextUsed`, `computations`, `citations`, `truncated`, `empty`, `schemaWarnings`,
`reviewedPaths`, etc. must be updated to the new schema shape.

## Estimated Token Reduction

| Tool                     | Estimated savings per call |
| :----------------------- | :------------------------- |
| Chat (with session)      | ~40–60 tokens              |
| Research quick           | ~80–120 tokens             |
| Research deep (grounded) | ~200–400 tokens            |
| Analyze                  | ~60–100 tokens             |
| Review (non-empty diff)  | ~150–300 tokens            |

Savings compound in long agentic sessions (50–200 tool calls).

## Breaking Changes

This is a **breaking change** for any MCP client that reads removed fields. There is no
compatibility shim — the "always minimal" decision means no opt-in to the old shape. Fields that
are removed are gone. Clients relying on `diagnostics.usage`, `requestId`, `contextUsed`,
`session.resources`, `reviewedPaths`, or any other removed field must be updated.
