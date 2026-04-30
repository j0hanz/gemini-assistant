# Design: AnalyzeOutputSchema Discriminated Union + BaseOutputSchema

**Date:** 2026-04-30
**Status:** Approved

---

## Problem

`AnalyzeOutputSchema` is a flat `z.strictObject` that allows `status: "completed"` with no `summary`
and no `diagram` — a structurally valid but semantically empty response. A consumer receiving this
payload has no way to know which output mode was used, and cannot narrow the TypeScript type without
manual field presence checks.

---

## Decisions

| #   | Question                        | Decision                                                              |
| --- | ------------------------------- | --------------------------------------------------------------------- |
| 1   | Primary fix target              | Output contract gap in `AnalyzeOutputSchema`                          |
| 2   | Fix strategy                    | Discriminated union on `outputKind`                                   |
| 3   | Diagram variant required fields | `status`, `diagramType`, `diagram`, `outputKind: "diagram"`           |
| 4   | Summary variant status values   | All four: `grounded \| partially_grounded \| ungrounded \| completed` |
| 5   | `outputKind` on output          | Yes — literal discriminant on both variants                           |
| 6   | Shared base                     | Extract `BaseOutputSchema` from `publicCoreOutputFields`              |

---

## Design

### 1. `BaseOutputSchema` (fields.ts)

Replace the plain `publicCoreOutputFields` object with a proper Zod schema:

```typescript
export const BaseOutputSchema = z.strictObject({
  warnings: z.array(z.string()).optional().describe('Non-fatal warnings for the result'),
});
```

All four tool output schemas use `...BaseOutputSchema.shape` in their `z.strictObject({...})` spread
(same pattern as today, but now derived from a real schema rather than a plain object).

`publicCoreOutputFields` is removed. Its only consumer is `outputs.ts`.

---

### 2. Discriminated `AnalyzeOutputSchema` (outputs.ts)

#### Summary variant

```typescript
export const AnalyzeSummaryOutputSchema = z.strictObject({
  ...BaseOutputSchema.shape,
  outputKind: z.literal('summary'),
  status: z
    .enum(['grounded', 'partially_grounded', 'ungrounded', 'completed'])
    .describe('Grounding or completion status'),
  summary: z.string().describe('Analysis summary text'),
});
```

Required: `outputKind`, `status`, `summary`
Optional: `warnings`

#### Diagram variant

```typescript
export const AnalyzeDiagramOutputSchema = z.strictObject({
  ...BaseOutputSchema.shape,
  outputKind: z.literal('diagram'),
  status: z.literal('completed').describe('Stable status for successful tool executions'),
  diagramType: enumField(DIAGRAM_TYPES, 'Diagram syntax used'),
  diagram: z.string().describe('Generated diagram source'),
  explanation: z.string().optional().describe('Short explanation or caveats for the diagram'),
  syntaxErrors: z.array(z.string()).optional().describe('Diagram syntax validation errors'),
  syntaxValid: z.boolean().optional().describe('Whether diagram syntax validated successfully'),
});
```

Required: `outputKind`, `status`, `diagramType`, `diagram`
Optional: `explanation`, `syntaxValid`, `syntaxErrors`, `warnings`

#### Union

```typescript
export const AnalyzeOutputSchema = z.discriminatedUnion('outputKind', [
  AnalyzeSummaryOutputSchema,
  AnalyzeDiagramOutputSchema,
]);
```

`export type AnalyzeOutput = z.infer<typeof AnalyzeOutputSchema>` narrows automatically on
`result.outputKind`.

---

### 3. `buildAnalyzeStructuredContent` (analyze.ts)

Add `outputKind` literal to both branches. No other logic changes.

```typescript
// diagram branch
return pickDefined({
  ...buildSuccessfulStructuredContent({
    warnings,
    domain: {
      outputKind: 'diagram' as const,   // ← add
      status: 'completed' as const,
      diagramType,
      diagram: getDiagramString(structured.diagram),
      ...
    },
  }),
});

// summary branch
return pickDefined({
  ...buildSuccessfulStructuredContent({
    warnings,
    domain: {
      outputKind: 'summary' as const,   // ← add
      status: typeof structured.status === 'string' ? structured.status : 'ungrounded',
      summary: typeof structured.summary === 'string' ? structured.summary : '',
    },
  }),
});
```

---

## Files Changed

| File                     | Change                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/schemas/fields.ts`  | Replace `publicCoreOutputFields` plain object with `BaseOutputSchema` (exported)                                                |
| `src/schemas/outputs.ts` | Split `AnalyzeOutputSchema` into two variants + discriminated union; update other three schemas to use `BaseOutputSchema.shape` |
| `src/tools/analyze.ts`   | Add `outputKind` literal to both branches of `buildAnalyzeStructuredContent`                                                    |

## Files Unchanged

- All input schemas
- `ChatOutputSchema`, `ResearchOutputSchema`, `ReviewOutputSchema` (structure unchanged, only base spread source changes)
- `src/public-contract.ts`
- All tool handlers except `buildAnalyzeStructuredContent`

---

## Verification

Run `node scripts/tasks.mjs` — all checks must pass (format, lint, type-check, knip, tests, build).
