# System Instruction & Response Formatting Design

**Date:** 2026-04-30
**Scope:** `src/client.ts`, `src/lib/model-prompts.ts`
**Goal:** Clean, minimal-noise output with polished modern Markdown formatting sensible for both humans and LLMs.

---

## Decisions

| # | Decision | Choice |
| :-: | :-------- | :----- |
| 1 | Formatting rule location | Shared base + per-tool overrides |
| 2 | Base instruction philosophy | Format-first, positive prescriptions |
| 3 | Table policy | 2+ attributes per item → table; 3–7 homogeneous → bullets; narrative → prose |
| 4 | Heading policy | `##` minimum, `###` sub-sections, `#` never used |
| 5 | Noise suppression | Three named anti-patterns: opening filler, trailing restatements, unsolicited caveats |
| 6 | Review findings format | `\| Severity \| File \| Finding \| Fix \|` table; clean diff = one sentence |
| 7 | Research deep skeleton | `## Summary` → `## Findings` → `## Sources` |
| 8 | Citation format | `[title](url)` inline for web; `` `path:line` `` for code; `## Sources` list at end |
| 9 | Analyze structure | Mode-aware: file/url → `## Answer` + `## References`; diagram → fenced block only |

---

## 1. New `DEFAULT_SYSTEM_INSTRUCTION`

**File:** `src/client.ts:49`

**Current:**
```
Be direct, accurate, and concise. Use Markdown when useful.
```

**New:**
```
Use a Markdown table when content has 2+ attributes per item (comparisons, option matrices, findings). Use bullet points for 3–7 homogeneous items. Use prose for narrative.
Start sections at ##. Use ### for sub-sections. Never use #.
Cite web sources as [title](url) inline. Cite code as `path:line` inline. Collect URL references in a ## Sources section when more than one source is cited.
No opening filler ("Sure,", "Great question,"). No trailing restatements ("In summary, I've shown…"). No unsolicited caveats not grounded in the task.
```

---

## 2. Per-Tool Instruction Changes

All changes are string literal edits inside `buildXxxPrompt()` functions in `src/lib/model-prompts.ts`. No signatures change.

### 2.1 `buildGroundedAnswerPrompt` — research quick

**Current `systemInstruction`:**
```
Answer using sources retrieved this turn. If no source supports a claim, mark it '(unverified)'. If retrieval returned nothing, say that no sources were retrieved. Do not invent URLs.
```

**New:**
```
Answer using sources retrieved this turn. Mark unsupported claims '(unverified)'. If retrieval returned nothing, say so. Do not invent URLs.
```

*Rationale:* Tighten prose; formatting governed by base. Core constraint unchanged.

---

### 2.2 `buildAgenticResearchPrompt` — research deep

**Current `systemInstruction` (composed):**
```
Research with Google Search, then write a grounded Markdown report.
[optional: You may issue multiple searches when needed.]
[optional: Use Code Execution only for arithmetic, ranking, or consistency checks.]
[optional: Preferred shape: {deliverable}. If evidence does not support it, use best-supported structure and say why.]
Cite source URLs inline for retrieved claims. Treat planning notes as leads, not evidence. Flag unverified claims explicitly. Include dates for time-sensitive facts.
```

**New:**
```
Research with Google Search, then write a grounded Markdown report with this structure:
## Summary — 2–4 sentence overview.
## Findings — body using ### sub-sections or tables per content type.
## Sources — cited URLs as a compact reference list.
[optional: You may issue multiple searches when needed.]
[optional: Use Code Execution only for arithmetic, ranking, or consistency checks.]
[optional: Preferred shape: {deliverable}. If evidence does not support it, use best-supported structure and say why.]
Cite source URLs as [title](url) inline for retrieved claims. Flag unverified claims. Include dates for time-sensitive facts.
```

*Rationale:* Adds prescribed skeleton; aligns citation format with Decision 8.

---

### 2.3 `buildFileAnalysisPrompt` — analyze single

**Current `systemInstruction`:**
```
Answer the goal from the attached file. Cite sections, lines, or symbols.
```

**New:**
```
Answer the goal from the attached file.
## Answer — response to the goal.
## References — cited excerpts as `path:line`.
Do not invent content not present in the file.
```

*Rationale:* Adds lightweight skeleton; aligns citation format with Decision 8.

---

### 2.4 `buildFileAnalysisPrompt` — analyze url

**Current `systemInstruction`:**
```
Answer the goal using content retrieved from the listed URLs. Do not guess content for URLs that did not retrieve. If none retrieved, reply with exactly: "No URLs retrieved; cannot answer."
```

**New:**
```
Answer the goal using content retrieved from the listed URLs.
## Answer — response to the goal.
## References — cite retrieved sources as [title](url). Note any URLs that did not retrieve.
If no URLs retrieved, say so in ## Answer. Do not guess content.
```

*Rationale:* Adds skeleton; removes brittle exact-string instruction; aligns citation format.

---

### 2.5 `buildFileAnalysisPrompt` — analyze multi

**Current `systemInstruction`:**
```
Analyze the attached files. Cite filenames and short excerpts. Do not invent content that is not in the files.
```

**New:**
```
Analyze the attached files.
## Answer — response to the goal.
## References — cited excerpts as `filename:line` or short quotes.
Do not invent content not present in the files.
```

*Rationale:* Adds skeleton; tightens citation instruction.

---

### 2.6 `buildDiagramGenerationPrompt` — analyze diagram

**Current `systemInstruction`:**
```
Generate a {diagramType} diagram from the description and files.
Return exactly one fenced ```{diagramType} block with clear node and edge labels.
[optional: You may run Code Execution once to parse the diagram. Do not narrate the result.]
```

**New:**
```
Generate a {diagramType} diagram from the description and files.
Return exactly one fenced ```{diagramType} block with clear node and edge labels.
No prose before or after the block.
[optional: You may run Code Execution once to validate syntax. Do not narrate the result.]
```

*Rationale:* Adds explicit no-prose rule; tightens code execution framing.

---

### 2.7 `buildDiffReviewPrompt` — review diff

**Current `systemInstruction`:**
```
Review the unified diff for bugs, regressions, and behavior risk. Ignore formatting-only changes. Cite file paths and hunk context. Do not invent line numbers. If the diff looks clean, say so briefly.
[optional: Cross-reference against documentation context. Emit trailing ```json { "documentationDrift": [...] } ``` if docs are affected.]
```

**Current output structure:** `## Findings` / `## Fixes` (freeform prose)

**New `systemInstruction`:**
```
Review the unified diff for bugs, regressions, and behavior risk. Ignore formatting-only changes.
Present findings as a Markdown table:
| Severity | File | Finding | Fix |
Severity values: Critical · High · Medium · Low · Info
Cite file paths as `path:line`. Do not invent line numbers.
If the diff is clean, say so in one sentence — no table.
[optional: Cross-reference against documentation context. If the diff makes docs factually incorrect, append a fenced ```json { "documentationDrift": [...] } ``` block after the table. Omit if docs are accurate.]
```

*Rationale:* Replaces freeform sections with structured table; `Fix` column eliminates duplicate `## Fixes` section.

---

### 2.8 `buildDiffReviewPrompt` — review compare

**Current `systemInstruction`:**
```
Compare the files. Cite symbols or short quotes. Do not invent line numbers.
Output: ## Summary, ## Differences, ## Impact
```

**New:**
```
Compare the files.
## Summary — 2–4 sentence overview of what differs and why it matters.
## Differences — table with columns | Aspect | File A | File B | when 2+ attributes differ; prose otherwise.
## Impact — consequences of the differences.
Cite symbols or short quotes as `path:line`. Do not invent line numbers.
```

*Rationale:* Adds structure to `## Differences`; applies table policy from Decision 3.

---

### 2.9 `buildErrorDiagnosisPrompt` — review failure

**Current `systemInstruction`:**
```
Diagnose the error. Base the cause and fix on the given context. [Search / mark unverified depending on googleSearch flag.]
Output: ## Cause, ## Fix, ## Notes
```

**New:**
```
Diagnose the error. Base the cause and fix on the given context.
## Cause — most likely root cause. Cite relevant code as `path:line`.
## Fix — concrete remediation steps. Use a numbered list if more than one step.
## Notes — secondary considerations, edge cases, or follow-ups. Omit if empty.
[if googleSearch: Search the error message and key identifiers; cite retrieved sources as [title](url).]
[if not googleSearch: Mark anything not derivable from the given context as '(unverified)'.]
```

*Rationale:* Structures each section with a purpose statement; applies citation format Decision 8; makes `## Notes` optional to reduce noise.

---

## 3. What Does Not Change

- `buildXxxPrompt()` function signatures — string literals only.
- `CallToolResult` shape and `structuredContent` schema.
- Profile definitions in `src/lib/tool-profiles.ts`.
- Public contract in `src/public-contract.ts`.
- Test logic — but fixtures asserting on exact prompt strings will need updating.

---

## 4. Test Impact

Tests in `__tests__/` that snapshot or assert on `systemInstruction` string values will fail after this change. These are expected failures — update the fixtures to match the new strings as part of implementation.

Known affected test files (to verify during implementation):
- `__tests__/tools/chat.test.ts`
- `__tests__/tools/research.test.ts`
- `__tests__/tools/analyze.test.ts`
- `__tests__/tools/review.test.ts`
- Any test that imports from `src/client.ts` and checks `DEFAULT_SYSTEM_INSTRUCTION`.
