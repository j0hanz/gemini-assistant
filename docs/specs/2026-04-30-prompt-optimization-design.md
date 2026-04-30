# Prompt Optimization Design

**Date**: 2026-04-30
**Goal**: Response quality — cut noise that dilutes model focus; keep every load-bearing constraint.
**Scope**: All 14 prompt builders across 5 files; one full pass.
**Style**: Directive sentences — full sentences, redundant words stripped.

## Decisions

| #   | Question         | Choice                                                                |
| :-- | :--------------- | :-------------------------------------------------------------------- |
| 1   | Primary driver   | Response quality — less noise = sharper model focus                   |
| 2   | Scope            | All builders in one pass                                              |
| 3   | Writing style    | Directive sentences (full sentences, filler stripped)                 |
| 4   | Shared fragments | Extract `CITE_CODE`, `CITE_WEB`, `REPORT_SKELETON` as named constants |
| 5   | MCP prompts      | Same pass — strip label redundancy, keep structural content           |

## Shared Constants (new, top of `model-prompts.ts`)

```typescript
const CITE_CODE = 'Cite as `path:line`.';
const CITE_WEB = 'Cite sources as [title](url).';
const REPORT_SKELETON =
  '## Summary — 2–4 sentence overview.\n' +
  '## Findings — body using ### sub-sections or tables.\n' +
  '## Sources — cited URLs as a compact reference list.';
```

## File-by-File Changes

### `src/client.ts` — `DEFAULT_SYSTEM_INSTRUCTION`

- `"Use a Markdown table when content has 2+ attributes per item (comparisons, option matrices, findings)."` → `"Use a table when content has 2+ attributes per item."`
- `"Use bullet points for 3–7 homogeneous items."` → `"Use bullets for 3–7 homogeneous items."`
- `"Cite web sources as [title](url) inline. Cite code as \`path:line\` inline. Collect URL references in a ## Sources section when more than one source is cited."`→`"Cite web sources as [title](url). Cite code as \`path:line\`. Collect URLs in ## Sources when 2+ cited."`
- `"No opening filler (\"Sure,\", \"Great question,\"). No trailing restatements. No unsolicited caveats not grounded in the task."` → `"No opening filler. No trailing restatements. No unsolicited caveats."`

### `src/lib/model-prompts.ts`

**New**: 3 shared constants (`CITE_CODE`, `CITE_WEB`, `REPORT_SKELETON`) at top of file.

**`buildGroundedAnswerPrompt`**: `"Answer using sources"` → `"Answer from sources"`

**`buildFileAnalysisPrompt`** (all 3 variants):

- `"## Answer — response to the goal."` → `"## Answer"`
- `"cited excerpts"` → `"excerpts"`
- `"Do not invent content not present in the file/files."` → `"Do not invent."`
- URL variant: `"Answer the goal using content retrieved from the listed URLs."` → `"Answer the goal from content at the listed URLs."`

**`buildDiffReviewPrompt`** (compare):

- `"table with columns | Aspect | File A | File B |"` → `"table (| Aspect | File A | File B |)"`
- `"Cite symbols or short quotes as \`path:line\`."`→`CITE_CODE`

**`buildDiffReviewPrompt`** (review):

- `"Review the unified diff for"` → `"Review the diff for"`
- `"Present findings as a Markdown table:"` → `"Present findings as a table:"`
- `"Severity values:"` → `"Severity:"`
- `"Cite file paths as \`path:line\`."`→`CITE_CODE`
- `"If the diff is clean, say so"` → `"If clean, say so"`
- doc-drift: shorten `"emit a trailing fenced JSON block exactly in the form"` → `"emit a trailing"`; `"If docs are still accurate, omit the JSON block entirely."` → `"Omit it if docs are still accurate."`; `"Do not emit an empty array or unfenced JSON."` → `"No empty array; no unfenced JSON."`

**`buildErrorDiagnosisPrompt`**:

- `"Diagnose the error. Base the cause and fix on the given context."` → `"Diagnose the error from the given context."`
- `"Cite relevant code as \`path:line\`."`→`CITE_CODE`
- `"concrete remediation steps. Use a numbered list if more than one step."` → `"remediation steps. Number them if more than one."`
- `"secondary considerations, edge cases, or follow-ups."` → `"edge cases or follow-ups."`
- search on: `"Search the error message and key identifiers; cite retrieved sources as [title](url)."` → `"Search the error and key identifiers; " + CITE_WEB`
- search off: `"Mark anything not derivable from the given context"` → `"Mark claims not derivable from context"`

**`buildDiagramGenerationPrompt`**:

- `"Return exactly one fenced"` → `"Return one fenced"`
- `"No prose before or after the block."` → `"No prose."`
- `"You may run Code Execution once"` → `"Run Code Execution once"`

**`buildAgenticResearchPrompt`**:

- Both variants use `REPORT_SKELETON`; drop `"Markdown"` before `"report"`
- `"You may issue multiple searches when needed."` → `"Issue multiple searches as needed."`
- `"If the evidence does not support it"` → `"If evidence does not support it"`
- Citation tail: `"Cite source URLs as [title](url) inline for retrieved claims."` → `CITE_WEB + " for retrieved claims."`

**`buildFunctionCallingInstructionText`**:

- NONE+traces: `"Gemini may emit server-side built-in tool invocation traces for supported tools. Treat those traces as runtime events, not user-provided evidence."` → `"Server-side tool traces may appear. Treat them as runtime events, not evidence."`
- ANY: `"You must call one or more of these declared functions when needed to complete the request: ${names}. Parallel calls are allowed."` → `"Call one or more of these functions as needed: ${names}. Parallel calls allowed."`
- VALIDATED: `"Function calls are schema-constrained by Gemini; the MCP client must still validate arguments before executing side effects."` → `"Arguments are schema-constrained; the MCP client validates before executing side effects."`
- AUTO: `"Call them only when the user's request requires it."` → `"Call them only when the request requires it."`
- traces+declared: long explanation → `"Server-side tool traces may also appear. Custom functions are executed by the MCP client. Do not fabricate results."`
- no traces: `"After issuing a declared function call, stop and wait for the client to return the function response."` → `"After a function call, wait for the client response."`

### `src/tools/research.ts`

- Planning prompt: `"Return JSON only as {\"queries\":[\"…\"]}. Produce ${N} focused public web search queries for:"` → `"Return JSON: {\"queries\":[\"…\"]}. Produce ${N} focused web search queries for:"`
- Planning system instruction: no change (already optimal)
- Contradiction system instruction: no change (already optimal)

### `src/tools/chat.ts` — `buildReducedRepairPrompt`

- `"Repair the invalid JSON response from the previous turn."` → `"Fix the invalid JSON from the previous turn."`
- `"Return ONLY valid JSON that conforms exactly to the provided schema."` → `"Return only valid JSON that matches the provided schema."`
- `"Original user request:"` → `"User request:"`
- `"Previous invalid output:"` → `"Previous output:"`

### `src/prompts.ts` — MCP prompt builders

- `buildDiscoverPrompt`: `"Preferred job:"` → `"Job:"`, `"User goal:"` → `"Goal:"`, `"to inspect first"` removed
- `buildResearchPrompt`: `"Research goal:"` → `"Goal:"`, `"Preferred mode:"` → `"Mode:"`, `"Requested deliverable:"` → `"Deliverable:"`, `"is the better fit and why"` → `"fits better and why"`
- `buildReviewPrompt`: `"Review subject:"` → `"Subject:"`, `"Recommend the correct review subject variant and the information to gather first."` → `"Recommend the review variant and what information to gather first."`

### `src/tools/review.ts` — `buildAnalysisPrompt`

Read and apply same directive-sentence principles (not yet read; inspect during implementation).

## Tests to Update

- Any test with exact string assertions on `DEFAULT_SYSTEM_INSTRUCTION`
- Any test matching specific system instruction strings from the builders above
