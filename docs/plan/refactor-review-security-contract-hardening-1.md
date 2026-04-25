---
goal: Harden review diff handling and public runtime boundaries
version: 1.0
date_created: 2026-04-25
last_updated: 2026-04-25
owner: gemini-assistant maintainers
status: 'Completed'
tags: ['refactor', 'security', 'contract', 'validation', 'transport']
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan resolves the review findings from the TypeScript MCP server inspection performed on 2026-04-25. The goals are to prevent sensitive untracked files from being sent to Gemini during diff review, make public `safetySettings` inputs runtime-aligned with Gemini SDK enums, and normalize explicit HTTP allowed-host configuration.

## 1. Requirements & Constraints

- **REQ-001**: `review` with `subjectKind=diff` MUST NOT include sensitive untracked files in the generated diff prompt.
- **REQ-002**: Sensitive untracked files MUST be reported in `structuredContent` as skipped, without exposing file contents.
- **REQ-003**: Public tool `safetySettings` input MUST validate `category`, `threshold`, and optional `method` before request construction.
- **REQ-004**: Public tool `safetySettings` validation MUST use the same Gemini enum sources as environment-level `GEMINI_SAFETY_SETTINGS` validation.
- **REQ-005**: Explicit `ALLOWED_HOSTS` values MUST be normalized so allowed-host config and incoming Host headers use comparable host forms.
- **SEC-001**: Secret filtering MUST cover common credential filenames and path segments, including `.env`, `.env.*`, `.npmrc`, `.pypirc`, `.netrc`, `.aws/`, `.ssh/`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, and filenames containing `secret`, `credential`, `token`, or `password`.
- **SEC-002**: Secret filtering MUST run before `readFile()` is called for untracked files in `src/tools/review.ts`.
- **SEC-003**: No skipped sensitive file path may be read from disk or included in prompt text.
- **CON-001**: Do not add runtime or development dependencies.
- **CON-002**: Do not change public tool names, resource URIs, prompt names, or workflow names.
- **CON-003**: Preserve existing diff budgeting, binary-file skipping, large-file skipping, and noisy-path filtering behavior.
- **CON-004**: Preserve default HTTP localhost behavior and broad-bind token protection.
- **PAT-001**: Use existing Zod 4 schema modules in `src/schemas/fields.ts` and `src/schemas/fragments.ts`.
- **PAT-002**: Use existing Node test runner conventions and colocated `__tests__/` files.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Prevent sensitive untracked files from entering review prompts.

| Task     | Description                                                                                                                                                                                                                                                                                                                          | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| TASK-001 | Modify `src/tools/review.ts`: add `const SENSITIVE_UNTRACKED_BASENAMES = new Set([...])` with exact lower-case names `.env`, `.env.local`, `.env.development`, `.env.production`, `.env.test`, `.npmrc`, `.pypirc`, `.netrc`, `id_rsa`, `id_ed25519`, `credentials`, `credentials.json`, `secrets.json`.                             | Yes       | 2026-04-25 |
| TASK-002 | Modify `src/tools/review.ts`: add `const SENSITIVE_UNTRACKED_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx'])`.                                                                                                                                                                                                                | Yes       | 2026-04-25 |
| TASK-003 | Modify `src/tools/review.ts`: add `const SENSITIVE_UNTRACKED_SEGMENTS = new Set(['.aws', '.ssh', '.gnupg', 'secrets', 'credentials'])`.                                                                                                                                                                                              | Yes       | 2026-04-25 |
| TASK-004 | Modify `src/tools/review.ts`: add function `isSensitiveUntrackedPath(relativePath: string): boolean` that normalizes backslashes to slashes, lowercases path segments, checks basename exact matches, `.env.` prefix, sensitive extensions, sensitive segments, and basename substrings `secret`, `credential`, `token`, `password`. | Yes       | 2026-04-25 |
| TASK-005 | Modify `src/tools/review.ts`: extend `UntrackedPatchResult.skipReason` from `'binary' \| 'too_large'` to `'binary' \| 'too_large' \| 'sensitive'`.                                                                                                                                                                                   | Yes       | 2026-04-25 |
| TASK-006 | Modify `src/tools/review.ts`: in `buildUntrackedPatch(gitRoot, relativePath, signal)`, call `isSensitiveUntrackedPath(relativePath)` immediately after `signal?.throwIfAborted()` and before `join(gitRoot, relativePath)`, `lstat()`, or `readFile()`. Return `{ path: relativePath, skipReason: 'sensitive' }` when true.          | Yes       | 2026-04-25 |
| TASK-007 | Modify `src/tools/review.ts`: add `skippedSensitivePaths: string[]` to `LocalDiffSnapshot`, `AnalyzePrStructuredContent`, and `buildStructuredContent(...)`.                                                                                                                                                                         | Yes       | 2026-04-25 |
| TASK-008 | Modify `src/tools/review.ts`: update `summarizeUntrackedResults(...)` to collect `skipReason === 'sensitive'` into sorted `skippedSensitivePaths`.                                                                                                                                                                                   | Yes       | 2026-04-25 |
| TASK-009 | Modify `src/tools/review.ts`: update `buildLocalDiffSnapshot(...)` to include `skippedSensitivePaths` in the returned snapshot.                                                                                                                                                                                                      | Yes       | 2026-04-25 |
| TASK-010 | Modify `src/tools/review.ts`: update `buildNoChangesAnalysis(...)` and `buildAnalysisPrompt(...)` to mention skipped sensitive paths by filename only as skipped paths, without contents.                                                                                                                                            | Yes       | 2026-04-25 |
| TASK-011 | Modify `src/schemas/outputs.ts`: add optional `skippedSensitivePaths: z.array(z.string()).optional().describe('Skipped untracked files that matched sensitive credential path rules')` to `ReviewOutputSchema`.                                                                                                                      | Yes       | 2026-04-25 |
| TASK-012 | Modify `src/tools/review.ts`: update `buildReviewStructuredContent(...)` to pass through `structured.skippedSensitivePaths`.                                                                                                                                                                                                         | Yes       | 2026-04-25 |

### Implementation Phase 2

- GOAL-002: Validate public `safetySettings` input with strict runtime-aligned schemas.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                            | Completed | Date       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-013 | Modify `src/schemas/fragments.ts`: import `HarmBlockMethod`, `HarmBlockThreshold`, and `HarmCategory` from `@google/genai`.                                                                                                                                                                                                                                            | Yes       | 2026-04-25 |
| TASK-014 | Modify `src/schemas/fragments.ts`: replace `SafetySettingPassthroughSchema = z.array(z.unknown()).optional()` with `SafetySettingSchema = z.strictObject({ category: z.enum(HarmCategory), threshold: z.enum(HarmBlockThreshold), method: z.enum(HarmBlockMethod).optional() })`.                                                                                      | Yes       | 2026-04-25 |
| TASK-015 | Modify `src/schemas/fragments.ts`: export `SafetySettingsSchema = z.array(SafetySettingSchema).optional().describe('Gemini SafetySetting[]')` and use it in `createGenerationConfigFields()`.                                                                                                                                                                          | Yes       | 2026-04-25 |
| TASK-016 | Modify `src/client.ts`: change `ConfigBuilderOptions.safetySettings` from `unknown[] \| undefined` to `SafetySetting[] \| undefined`.                                                                                                                                                                                                                                  | Yes       | 2026-04-25 |
| TASK-017 | Modify `src/client.ts`: change `normalizeSafetySettings(...)` parameter to `readonly SafetySetting[] \| undefined` and remove the generic object fallback that accepts arbitrary unknown entries. Keep threshold defaulting only if the type still allows absent threshold after schema parsing; otherwise return `safetySettings.map((setting) => ({ ...setting }))`. | Yes       | 2026-04-25 |
| TASK-018 | Modify `src/config.ts`: export helper functions or shared constants only if needed to avoid duplicating enum validation logic. Do not loosen existing `GEMINI_SAFETY_SETTINGS` parsing.                                                                                                                                                                                | Yes       | 2026-04-25 |
| TASK-019 | Modify `__tests__/schemas/inputs.test.ts`: add tests asserting `ChatInputSchema`, `ResearchInputSchema`, `AnalyzeInputSchema`, and `ReviewInputSchema` reject invalid `safetySettings` entries with unknown category, unknown method, unknown threshold, non-object entries, and unknown object keys.                                                                  | Yes       | 2026-04-25 |
| TASK-020 | Modify `__tests__/schemas/inputs.test.ts`: add tests asserting valid `safetySettings` entries parse successfully for all public schemas that expose generation config fields.                                                                                                                                                                                          | Yes       | 2026-04-25 |

### Implementation Phase 3

- GOAL-003: Normalize explicit HTTP allowed-host configuration.

| Task     | Description                                                                                                                                                                                                                                                                                                                 | Completed | Date       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-021 | Modify `src/lib/validation.ts`: add helper `normalizeAllowedHostEntry(host: string): string` that trims, lowercases, removes a port from IPv4 or DNS host values, preserves bracketed IPv6 form, converts bare IPv6 to bracketed form, and delegates final IPv6 bracket formatting to existing `normalizeAllowedHost(...)`. | Yes       | 2026-04-25 |
| TASK-022 | Modify `src/lib/validation.ts`: update `parseAllowedHosts()` to map every explicit `ALLOWED_HOSTS` entry through `normalizeAllowedHostEntry(...)` and dedupe normalized entries.                                                                                                                                            | Yes       | 2026-04-25 |
| TASK-023 | Modify `src/lib/validation.ts`: update `validateHostHeader(...)` to compare normalized incoming hostname to normalized allowed hosts. Keep existing rejection for missing or empty Host headers.                                                                                                                            | Yes       | 2026-04-25 |
| TASK-024 | Modify `__tests__/lib/validation.test.ts`: add tests that explicit allowed hosts accept equivalent forms: `example.com:3000` config matches `example.com`, `EXAMPLE.com` matches lowercase incoming host, bare `::1` config matches `[::1]:3000`, and `[::1]` config matches `[::1]`.                                       | Yes       | 2026-04-25 |
| TASK-025 | Modify `__tests__/transport-host-validation.test.ts`: add one HTTP transport test that sets `ALLOWED_HOSTS=localhost:3000` and verifies `Host: localhost:3000` is accepted while `Host: evil.example` is rejected.                                                                                                          | Yes       | 2026-04-25 |

### Implementation Phase 4

- GOAL-004: Verify all hardening changes and update public documentation where needed.

| Task     | Description                                                                                                                                                                                                | Completed | Date       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-026 | Modify `README.md` only if `safetySettings`, skipped review files, or `ALLOWED_HOSTS` behavior is documented there. Keep wording factual and aligned with runtime behavior.                                | Yes       | 2026-04-25 |
| TASK-027 | Modify `AGENTS.md` only if the safety boundary list needs to mention sensitive untracked review files explicitly.                                                                                          | Yes       | 2026-04-25 |
| TASK-028 | Run `npm run format`.                                                                                                                                                                                      | Yes       | 2026-04-25 |
| TASK-029 | Run `npm run lint`.                                                                                                                                                                                        | Yes       | 2026-04-25 |
| TASK-030 | Run `npm run type-check`.                                                                                                                                                                                  | Yes       | 2026-04-25 |
| TASK-031 | Run targeted tests: `node --import tsx/esm --test --no-warnings __tests__/tools/pr.test.ts __tests__/schemas/inputs.test.ts __tests__/lib/validation.test.ts __tests__/transport-host-validation.test.ts`. | Yes       | 2026-04-25 |
| TASK-032 | Run `npm run test` before final merge.                                                                                                                                                                     | Yes       | 2026-04-25 |

## 3. Alternatives

- **ALT-001**: Ignore all untracked files during `review subjectKind=diff`. Rejected because untracked source files are important review inputs and existing behavior intentionally includes safe text files.
- **ALT-002**: Redact sensitive file contents after reading them. Rejected because the file read itself is unnecessary and increases the chance of logging or prompt leakage; sensitive paths must be skipped before disk reads.
- **ALT-003**: Keep `safetySettings` as `z.unknown()` and rely on Gemini SDK errors. Rejected because public MCP schemas are the runtime boundary and should reject invalid client input deterministically.
- **ALT-004**: Require explicit `ALLOWED_HOSTS` values to be hostnames without ports. Rejected because normalizing common input forms is lower friction and does not weaken host validation.

## 4. Dependencies

- **DEP-001**: `@google/genai` already provides `HarmCategory`, `HarmBlockThreshold`, `HarmBlockMethod`, and `SafetySetting`.
- **DEP-002**: `zod/v4` already provides strict object validation and enum support.
- **DEP-003**: Node built-in test runner remains the test harness.
- **DEP-004**: No new dependencies are required.

## 5. Files

- **FILE-001**: `src/tools/review.ts` - sensitive untracked file detection, skip accounting, structured review output propagation.
- **FILE-002**: `src/schemas/outputs.ts` - `ReviewOutputSchema.skippedSensitivePaths`.
- **FILE-003**: `src/schemas/fragments.ts` - strict `SafetySetting` schema.
- **FILE-004**: `src/client.ts` - type-safe `safetySettings` normalization.
- **FILE-005**: `src/config.ts` - optional sharing of safety enum validation helpers if implementation requires it.
- **FILE-006**: `src/lib/validation.ts` - explicit allowed-host normalization.
- **FILE-007**: `__tests__/tools/pr.test.ts` - review diff sensitive file coverage.
- **FILE-008**: `__tests__/schemas/inputs.test.ts` - public `safetySettings` validation coverage.
- **FILE-009**: `__tests__/lib/validation.test.ts` - allowed-host normalization unit coverage.
- **FILE-010**: `__tests__/transport-host-validation.test.ts` - HTTP transport host validation coverage.
- **FILE-011**: `README.md` - documentation update only if existing text covers changed behavior.
- **FILE-012**: `AGENTS.md` - safety boundary update only if required.

## 6. Testing

- **TEST-001**: `buildUntrackedPatch(gitRoot, '.env', signal)` returns `{ path: '.env', skipReason: 'sensitive' }` and does not call `readFile()`.
- **TEST-002**: `buildLocalDiffSnapshot(...)` includes sensitive untracked file paths under `skippedSensitivePaths` and excludes their contents from `diff`.
- **TEST-003**: `analyzePrWork(..., { dryRun: true })` returns `structuredContent.skippedSensitivePaths` and does not include sensitive file content in `content[0].text`.
- **TEST-004**: `ReviewOutputSchema.safeParse(...)` accepts outputs with `skippedSensitivePaths`.
- **TEST-005**: Public input schemas reject `safetySettings: [{ category: 'BAD', threshold: 'BLOCK_ONLY_HIGH' }]`.
- **TEST-006**: Public input schemas reject `safetySettings: [{ category: validCategory, threshold: 'BAD' }]`.
- **TEST-007**: Public input schemas reject `safetySettings: [{ category: validCategory, threshold: validThreshold, extra: true }]`.
- **TEST-008**: Public input schemas accept valid `SafetySetting` objects with and without `method` when method is optional.
- **TEST-009**: `parseAllowedHosts()` normalizes case, strips ports from DNS/IPv4 hosts, and bracket-normalizes IPv6.
- **TEST-010**: `validateHostHeader(...)` accepts normalized equivalent allowed-host and Host header forms and rejects non-matching hosts.
- **TEST-011**: `npm run lint` passes.
- **TEST-012**: `npm run type-check` passes.
- **TEST-013**: `npm run test` passes.

## 7. Risks & Assumptions

- **RISK-001**: Sensitive filename matching may skip a legitimate untracked source file such as `tokenizer.ts`. Mitigation: match high-risk substrings on basename only for untracked files and report skipped paths so users can rename or track intentional files.
- **RISK-002**: Tightening `safetySettings` may reject clients that relied on partially formed objects. Mitigation: invalid settings were not a stable contract; clients should send Gemini enum values already documented by the SDK.
- **RISK-003**: Host normalization changes can alter behavior for malformed `ALLOWED_HOSTS` values. Mitigation: add explicit unit tests for supported forms and keep missing Host rejection unchanged.
- **ASSUMPTION-001**: `review subjectKind=diff` should continue to include safe untracked text files because this is existing user-facing behavior.
- **ASSUMPTION-002**: Explicit `ALLOWED_HOSTS` entries are intended to identify hostnames, not host and port pairs as separate authorization scopes.
- **ASSUMPTION-003**: The `@google/genai` enum exports used by `src/config.ts` are stable in the installed package version.

## 8. Related Specifications / Further Reading

- `docs/plan/refactor-review-docs-drift-2.md`
- `docs/plan/refactor-public-contract-integrity-1.md`
- `src/tools/review.ts`
- `src/schemas/fragments.ts`
- `src/lib/validation.ts`
- `__tests__/tools/pr.test.ts`
- `__tests__/schemas/inputs.test.ts`
- `__tests__/lib/validation.test.ts`
- `__tests__/transport-host-validation.test.ts`
