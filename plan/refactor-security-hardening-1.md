---
goal: Remediate the eleven security findings from the src/ review (DNS rebinding, sensitive-file uploads, log redaction, CORS, SSRF predicate, ReDoS, token entropy, review root scoping, upload TOCTOU, API key trim, x-forwarded-for IP validation).
version: 1
date_created: 2026-04-27
status: Planned
plan_type: refactor
component: security-hardening
---

# Implementation Plan: Security Hardening of `src/`

## 1. Goal

Close eleven realistic security gaps surfaced in the `src/` review. After execution, the HTTP transport refuses DNS-rebinding attempts under loopback bypass mode, the `analyze`/`compareFiles` tools refuse to upload sensitive files to Gemini, the logger redacts `data` payloads at the single chokepoint, CORS no longer combines `*` with bearer auth, the URL classifier rejects numeric-IP and long-form IPv6 loopback, admin regex env vars cannot ReDoS, weak bearer tokens are rejected, the review tool only operates on roots within `ROOTS`, file uploads are bytes-stable across MIME validation and SDK transmission, the API key is trimmed, and `x-forwarded-for` values are validated as IPs. Success is observed via the validation suite passing and the new dedicated regression tests.

## 2. Requirements & Constraints

|                    ID                     | Type       | Statement                                                                                                                                                                    |
| :---------------------------------------: | :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`SEC-001`](#2-requirements--constraints) | Security   | Loopback HTTP bind with `MCP_ALLOW_UNAUTHENTICATED_LOOPBACK_HTTP=true` MUST enforce a Host allow-list of `localhost,127.0.0.1,[::1]`.                                        |
| [`SEC-002`](#2-requirements--constraints) | Security   | The `analyze` and `compareFiles` tools MUST refuse paths matched by [isSensitiveUntrackedPath](src/tools/review.ts#L441) before invoking [uploadFile](src/lib/file.ts#L155). |
| [`SEC-003`](#2-requirements--constraints) | Security   | Logger MUST redact sensitive keys and bound large payloads inside `Logger.buildEntry` for every call site, not only opt-in summaries.                                        |
| [`SEC-004`](#2-requirements--constraints) | Security   | `CORS_ORIGIN=*` combined with a non-empty `MCP_HTTP_TOKEN` MUST be rejected at startup.                                                                                      |
| [`SEC-005`](#2-requirements--constraints) | Security   | [isRejectedHost](src/lib/validation.ts#L453) MUST classify numeric-IP, dotted-shorthand, long-form IPv6 loopback, and the unspecified address as private.                    |
| [`SEC-006`](#2-requirements--constraints) | Security   | [parseRegexPattern](src/config.ts#L324) MUST cap pattern length and reject patterns containing nested-quantifier ReDoS shapes.                                               |
| [`SEC-007`](#2-requirements--constraints) | Security   | [parseOptionalTokenEnv](src/config.ts#L100) MUST require minimum entropy (≥48 chars OR ≥16 unique characters) in addition to the existing checks.                            |
| [`SEC-008`](#2-requirements--constraints) | Security   | [resolveReviewWorkingDirectory](src/tools/review.ts#L1130) MUST validate the selected root is within the configured `ROOTS` allow-list before invoking `git`.                |
| [`SEC-009`](#2-requirements--constraints) | Security   | [uploadFile](src/lib/file.ts#L155) MUST read file bytes once and submit the same buffer to MIME validation and the Gemini SDK (eliminate TOCTOU).                            |
| [`SEC-010`](#2-requirements--constraints) | Security   | [getApiKey](src/config.ts#L172) MUST trim whitespace and reject keys containing non-printable ASCII.                                                                         |
| [`SEC-011`](#2-requirements--constraints) | Security   | [parseForwardedForHeader](src/transport.ts#L202) result MUST be validated with `net.isIP` before becoming the rate-limit key.                                                |
| [`CON-001`](#2-requirements--constraints) | Constraint | All changes preserve existing public exports and tool contracts.                                                                                                             |
| [`CON-002`](#2-requirements--constraints) | Constraint | `npm run lint`, `npm run type-check`, and `npm run test` must pass after each phase.                                                                                         |
| [`PAT-001`](#2-requirements--constraints) | Pattern    | Reuse [isPathWithinRoot](src/lib/validation.ts#L128) for SEC-008 root validation.                                                                                            |
| [`PAT-002`](#2-requirements--constraints) | Pattern    | Reuse [isSensitiveUntrackedPath](src/tools/review.ts#L441) for SEC-002 by extracting it to `src/lib/validation.ts` (or keeping it in review and importing).                  |

## 3. Current Context

**Relevant files**

| File                                                                                       | Why it matters                                                            |
| :----------------------------------------------------------------------------------------- | :------------------------------------------------------------------------ |
| [src/config.ts](src/config.ts)                                                             | Token, CORS, API key, and regex env parsing.                              |
| [src/transport.ts](src/transport.ts)                                                       | HTTP bind protection, Host validation, rate-limit identity, CORS headers. |
| [src/lib/validation.ts](src/lib/validation.ts)                                             | Path/host/URL classifiers used by transport and tools.                    |
| [src/lib/logger.ts](src/lib/logger.ts)                                                     | Log entry construction and broadcast to MCP peers.                        |
| [src/lib/file.ts](src/lib/file.ts)                                                         | File upload, MIME validation, SDK call.                                   |
| [src/tools/analyze.ts](src/tools/analyze.ts)                                               | `analyze` and `compareFiles` paths that upload files to Gemini.           |
| [src/tools/review.ts](src/tools/review.ts)                                                 | Git execution, sensitive-path predicate, working-directory selection.     |
| [src/sessions.ts](src/sessions.ts)                                                         | Session redaction patterns consumer.                                      |
| [**tests**/transport-host-validation.test.ts](__tests__/transport-host-validation.test.ts) | Existing host validation regression coverage.                             |
| [**tests**/lib/validation.test.ts](__tests__/lib/validation.test.ts)                       | URL/path classifier coverage to extend.                                   |
| [**tests**/lib/logger.test.ts](__tests__/lib/logger.test.ts)                               | Logger redaction coverage to extend.                                      |
| [**tests**/config.test.ts](__tests__/config.test.ts)                                       | Env parsing regression coverage.                                          |

**Relevant symbols**

| Symbol                                                     | Why it matters                                         |
| :--------------------------------------------------------- | :----------------------------------------------------- |
| [assertHttpBindIsProtected](src/transport.ts#L188)         | Loopback bypass entry point (SEC-001).                 |
| [assertHostValidationIsConfigured](src/transport.ts#L294)  | Host allow-list enforcement entry point (SEC-001).     |
| [resolveAllowedHosts](src/lib/validation.ts#L60)           | Auto-derives the loopback host allow-list.             |
| [validateHostHeader](src/lib/validation.ts#L80)            | Compares `Host:` header to allow-list.                 |
| [parseCorsOriginEnv](src/config.ts#L132)                   | CORS origin parser (SEC-004).                          |
| [parseOptionalTokenEnv](src/config.ts#L100)                | Bearer token parser (SEC-007).                         |
| [parseRegexPattern](src/config.ts#L324)                    | Admin regex parser (SEC-006).                          |
| [getApiKey](src/config.ts#L172)                            | API key reader (SEC-010).                              |
| [parseForwardedForHeader](src/transport.ts#L202)           | Proxy-header parser (SEC-011).                         |
| [nodeRateLimitKey](src/transport.ts#L229)                  | Caller of `parseForwardedForHeader` (SEC-011).         |
| [isPublicHttpUrl](src/lib/validation.ts#L472)              | URL classifier surface (SEC-005).                      |
| [isRejectedHost](src/lib/validation.ts#L453)               | Host classifier internal (SEC-005).                    |
| [isPrivateIpv4](src/lib/validation.ts#L399)                | IPv4 predicate (SEC-005).                              |
| [isPrivateIpv6](src/lib/validation.ts#L447)                | IPv6 predicate (SEC-005).                              |
| [redactOrBoundVerboseValue](src/lib/logger.ts#L93)         | Existing redactor to be applied universally (SEC-003). |
| [uploadFile](src/lib/file.ts#L155)                         | Upload entry (SEC-002, SEC-009).                       |
| [validateUploadMimeType](src/lib/file.ts#L95)              | MIME validation that re-reads the file (SEC-009).      |
| [resolveWorkspacePath](src/lib/validation.ts#L353)         | Path resolution called before upload.                  |
| [isSensitiveUntrackedPath](src/tools/review.ts#L441)       | Sensitive-path predicate to share (SEC-002).           |
| [resolveReviewWorkingDirectory](src/tools/review.ts#L1130) | Review cwd selection (SEC-008).                        |

**Existing commands**

```bash
# Lint
npm run lint

# Type-check
npm run type-check

# Tests
npm run test

# Full chain
npm run lint && npm run type-check && npm run test
```

**Current behavior**

- Loopback HTTP with `MCP_ALLOW_UNAUTHENTICATED_LOOPBACK_HTTP=true` requires neither token nor Host allow-list, enabling DNS rebinding.
- `analyze` accepts any allowed-root path including `.env`, `id_rsa`, etc., uploading bytes to Gemini.
- `Logger.log` writes raw `data` to disk and broadcasts it to MCP peers without redaction at the chokepoint.
- `CORS_ORIGIN=*` is accepted with `MCP_HTTP_TOKEN` set; `Authorization` header is reflected in CORS allow-headers.
- `isRejectedHost` misses `2130706433`, `127.1`, `[0:0:0:0:0:0:0:1]`, `[::]` forms.
- Admin-supplied regex (`GEMINI_SESSION_REDACT_KEYS`) accepts unbounded ReDoS patterns.
- `MCP_HTTP_TOKEN` of 32 nearly-repeated chars passes; entropy is not enforced.
- `resolveReviewWorkingDirectory` picks `roots[0]` without verifying it is in the configured `ROOTS`.
- `uploadFile` reads the file twice (validation + SDK), opening a TOCTOU window.
- `getApiKey` returns the raw value without trimming.
- `parseForwardedForHeader` returns the first comma-separated value verbatim, without validating it as an IP.

## 4. Implementation Phases

### PHASE-001: Transport security

**Goal:** Enforce Host validation under the loopback unauthenticated bypass, and reject ambiguous CORS+token combinations and unvalidated forwarded identities.

#### Task Index

|                                   Task                                    | Action                                                                                                         | Depends on | Files                                | Validate       |
| :-----------------------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------- | :--------: | :----------------------------------- | :------------- |
| [`TASK-001`](#task-001-force-host-allow-list-when-loopback-bypass-active) | Auto-derive `allowedHosts` from `resolveAllowedHosts(host)` and require Host validation when bypass is active. |    none    | [src/transport.ts](src/transport.ts) | `npm run test` |
|          [`TASK-002`](#task-002-reject-cors-wildcard-with-token)          | Reject `CORS_ORIGIN=*` when `MCP_HTTP_TOKEN` is set.                                                           |    none    | [src/config.ts](src/config.ts)       | `npm run test` |
|           [`TASK-003`](#task-003-validate-forwarded-for-as-ip)            | Reject non-IP `x-forwarded-for` values; fall through to socket address.                                        |    none    | [src/transport.ts](src/transport.ts) | `npm run test` |

#### TASK-001: Force Host allow-list when loopback bypass active

| Field           | Value                                                                                                                                                                                                                                                                                                                             |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                                                                                                                                                                                              |
| Files           | [src/transport.ts](src/transport.ts); [**tests**/transport-host-validation.test.ts](__tests__/transport-host-validation.test.ts)                                                                                                                                                                                                  |
| Symbols         | [assertHttpBindIsProtected](src/transport.ts#L188); [assertHostValidationIsConfigured](src/transport.ts#L294); [resolveAllowedHosts](src/lib/validation.ts#L60)                                                                                                                                                                   |
| Action          | When `allowUnauthenticatedLoopbackHttp` is true and `token` is undefined, set `allowedHosts = resolveAllowedHosts(host) ?? ['localhost','127.0.0.1','[::1]']` before installing the Host validation middleware in both `startHttpTransport` and `startWebStandardTransport`; install the middleware unconditionally in this mode. |
| Validate        | Run `npm run test -- transport-host-validation`                                                                                                                                                                                                                                                                                   |
| Expected result | A `POST /mcp` with `Host: evil.example` and `MCP_ALLOW_UNAUTHENTICATED_LOOPBACK_HTTP=true` returns `403 Forbidden`; a request with `Host: 127.0.0.1:<port>` proceeds.                                                                                                                                                             |

#### TASK-002: Reject CORS wildcard with token

| Field           | Value                                                                                                                         |
| :-------------- | :---------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                          |
| Files           | [src/config.ts](src/config.ts); [**tests**/config.test.ts](__tests__/config.test.ts)                                          |
| Symbols         | [parseCorsOriginEnv](src/config.ts#L132); [parseOptionalTokenEnv](src/config.ts#L100)                                         |
| Action          | In `getTransportConfig`, after parsing `corsOrigin` and `token`, throw if `corsOrigin === '*'` and `token !== undefined`.     |
| Validate        | Run `npm run test -- config`                                                                                                  |
| Expected result | `getTransportConfig()` throws when `CORS_ORIGIN=*` and `MCP_HTTP_TOKEN` is set; both unset or only one set behaves as before. |

#### TASK-003: Validate forwarded-for as IP

| Field           | Value                                                                                                                                                              |
| :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                               |
| Files           | [src/transport.ts](src/transport.ts); [**tests**/transport.test.ts](__tests__/transport.test.ts)                                                                   |
| Symbols         | [parseForwardedForHeader](src/transport.ts#L202); [nodeRateLimitKey](src/transport.ts#L229)                                                                        |
| Action          | After `parseForwardedForHeader` extracts the first entry, return `undefined` when `net.isIP(entry) === 0`; same change in the web-standard `webRateLimitKey` path. |
| Validate        | Run `npm run test -- transport`                                                                                                                                    |
| Expected result | With `trustProxy=true` and `x-forwarded-for: junk-spoofed`, the rate-limit key is derived from `req.socket.remoteAddress`, not the spoofed value.                  |

### PHASE-002: Path & URL classifiers

**Goal:** Block sensitive-file uploads to Gemini, harden the public-URL classifier, and fence the review tool to configured roots.

#### Task Index

|                           Task                            | Action                                                                                |                       Depends on                        | Files                                                                                                                | Validate                     |
| :-------------------------------------------------------: | :------------------------------------------------------------------------------------ | :-----------------------------------------------------: | :------------------------------------------------------------------------------------------------------------------- | :--------------------------- |
|  [`TASK-004`](#task-004-export-sensitive-path-predicate)  | Move `isSensitiveUntrackedPath` to `src/lib/validation.ts` and re-export from review. |                          none                           | [src/lib/validation.ts](src/lib/validation.ts); [src/tools/review.ts](src/tools/review.ts)                           | `npm run type-check`         |
|      [`TASK-005`](#task-005-block-sensitive-uploads)      | Reject sensitive paths in `uploadFile`.                                               | [`TASK-004`](#task-004-export-sensitive-path-predicate) | [src/lib/file.ts](src/lib/file.ts)                                                                                   | `npm run test`               |
|       [`TASK-006`](#task-006-harden-isrejectedhost)       | Cover numeric-IP, dotted-shorthand, long-form IPv6, and unspecified address.          |                          none                           | [src/lib/validation.ts](src/lib/validation.ts); [**tests**/lib/validation.test.ts](__tests__/lib/validation.test.ts) | `npm run test -- validation` |
| [`TASK-007`](#task-007-validate-review-cwd-against-roots) | Verify the selected review cwd is within configured `ROOTS`.                          |                          none                           | [src/tools/review.ts](src/tools/review.ts)                                                                           | `npm run test -- tools`      |

#### TASK-004: Export sensitive-path predicate

| Field           | Value                                                                                                                                                                                                           |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                                                                            |
| Files           | [src/lib/validation.ts](src/lib/validation.ts); [src/tools/review.ts](src/tools/review.ts)                                                                                                                      |
| Symbols         | [isSensitiveUntrackedPath](src/tools/review.ts#L441)                                                                                                                                                            |
| Action          | Move the `PATH_RULES.isSensitive` body, the `SENSITIVE_UNTRACKED_*` constant sets, and the exported `isSensitiveUntrackedPath` to `src/lib/validation.ts`; re-export them unchanged from `src/tools/review.ts`. |
| Validate        | Run `npm run type-check`                                                                                                                                                                                        |
| Expected result | Compilation succeeds; `import { isSensitiveUntrackedPath } from './lib/validation.js'` is usable; all existing review imports of the predicate continue to resolve.                                             |

#### TASK-005: Block sensitive uploads

| Field           | Value                                                                                                                                                                                                                          |
| :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-004`](#task-004-export-sensitive-path-predicate)                                                                                                                                                                        |
| Files           | [src/lib/file.ts](src/lib/file.ts); [**tests**/lib/file.test.ts](__tests__/lib/file.test.ts)                                                                                                                                   |
| Symbols         | [uploadFile](src/lib/file.ts#L155); [resolveWorkspacePath](src/lib/validation.ts#L353); [isSensitiveUntrackedPath](src/lib/validation.ts)                                                                                      |
| Action          | After `resolveWorkspacePath`, call `isSensitiveUntrackedPath(displayPath)` (and on `relative(workspaceRoot, resolvedPath)` when `workspaceRoot` is defined); throw `Error` matching `/sensitive file/i` before the size check. |
| Validate        | Run `npm run test -- lib`                                                                                                                                                                                                      |
| Expected result | Calling `uploadFile('.env', signal, rootsFetcher)` on a workspace containing a `.env` file throws and `getAI().files.upload` is not invoked.                                                                                   |

#### TASK-006: Harden `isRejectedHost`

| Field           | Value                                                                                                                                                                                                                                                   |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on      | none                                                                                                                                                                                                                                                    |
| Files           | [src/lib/validation.ts](src/lib/validation.ts); [**tests**/lib/validation.test.ts](__tests__/lib/validation.test.ts)                                                                                                                                    |
| Symbols         | [isRejectedHost](src/lib/validation.ts#L453); [isPrivateIpv4](src/lib/validation.ts#L399); [isPrivateIpv6](src/lib/validation.ts#L447); [isPublicHttpUrl](src/lib/validation.ts#L472)                                                                   |
| Action          | Add a numeric-IPv4 normalizer (single integer `2130706433`, dotted shorthand `127.1`) that reconstructs the four-octet form before `isPrivateIpv4`; in `isPrivateIpv6`, normalize fully-expanded `0:0:0:0:0:0:0:1` to `::1` and treat `::` as rejected. |
| Validate        | Run `npm run test -- validation`                                                                                                                                                                                                                        |
| Expected result | `isPublicHttpUrl` returns `false` for `http://2130706433/`, `http://127.1/`, `http://[0:0:0:0:0:0:0:1]/`, and `http://[::]/`; existing public URLs remain `true`.                                                                                       |

#### TASK-007: Validate review cwd against ROOTS

| Field           | Value                                                                                                                                                                                                    |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                                                                     |
| Files           | [src/tools/review.ts](src/tools/review.ts); [**tests**/tools/pr.test.ts](__tests__/tools/pr.test.ts)                                                                                                     |
| Symbols         | [resolveReviewWorkingDirectory](src/tools/review.ts#L1130); [isPathWithinRoot](src/lib/validation.ts#L128)                                                                                               |
| Action          | After selecting `roots[0]`, fetch `getAllowedRoots(rootsFetcher)` and require the selected directory to satisfy `isPathWithinRoot`; throw `Error('Review root is outside ROOTS allow-list.')` otherwise. |
| Validate        | Run `npm run test -- tools`                                                                                                                                                                              |
| Expected result | When `rootsFetcher` returns `['/etc']` and `ROOTS` does not include `/etc`, `analyzePrWork` returns an error tool result and `git rev-parse` is not invoked.                                             |

### PHASE-003: Logging, env hardening, upload TOCTOU

**Goal:** Apply redaction at the logger chokepoint, harden env parsers, and remove the upload double-read.

#### Task Index

|                           Task                           | Action                                                                              | Depends on | Files                                  | Validate                 |
| :------------------------------------------------------: | :---------------------------------------------------------------------------------- | :--------: | :------------------------------------- | :----------------------- |
| [`TASK-008`](#task-008-redact-data-in-logger-chokepoint) | Apply `redactOrBoundVerboseValue` / `summarizeLogValue` inside `Logger.buildEntry`. |    none    | [src/lib/logger.ts](src/lib/logger.ts) | `npm run test -- logger` |
|     [`TASK-009`](#task-009-redos-cap-on-admin-regex)     | Cap pattern length and reject nested-quantifier shapes in `parseRegexPattern`.      |    none    | [src/config.ts](src/config.ts)         | `npm run test -- config` |
|       [`TASK-010`](#task-010-token-entropy-floor)        | Require ≥48 chars or ≥16 unique chars in `parseOptionalTokenEnv`.                   |    none    | [src/config.ts](src/config.ts)         | `npm run test -- config` |
|    [`TASK-011`](#task-011-trim-and-validate-api-key)     | Trim and reject non-printable characters in `getApiKey`.                            |    none    | [src/config.ts](src/config.ts)         | `npm run test -- config` |
|        [`TASK-012`](#task-012-single-read-upload)        | Read upload bytes once; pass buffer to MIME validation and SDK.                     |    none    | [src/lib/file.ts](src/lib/file.ts)     | `npm run test -- lib`    |

#### TASK-008: Redact `data` in logger chokepoint

| Field           | Value                                                                                                                                                                                                            |
| :-------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                                                                             |
| Files           | [src/lib/logger.ts](src/lib/logger.ts); [**tests**/lib/logger.test.ts](__tests__/lib/logger.test.ts)                                                                                                             |
| Symbols         | [redactOrBoundVerboseValue](src/lib/logger.ts#L93)                                                                                                                                                               |
| Action          | In `Logger.buildEntry`, when `data !== undefined`, replace the raw value with `maybeSummarizePayload(data, this.verbosePayloads)` so the same redaction applies to file sink and `sendLoggingMessage` broadcast. |
| Validate        | Run `npm run test -- logger`                                                                                                                                                                                     |
| Expected result | A log entry with `data: { authorization: 'Bearer abc', api_key: 'k' }` is persisted with both keys replaced by `[redacted]` and the broadcast payload is identical.                                              |

#### TASK-009: ReDoS cap on admin regex

| Field           | Value                                                                                                                                               |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Depends on      | none                                                                                                                                                |
| Files           | [src/config.ts](src/config.ts); [**tests**/config.test.ts](__tests__/config.test.ts)                                                                |
| Symbols         | [parseRegexPattern](src/config.ts#L324)                                                                                                             |
| Action          | Reject input longer than 256 chars; reject patterns matching `/(\([^)]_[+_][^)]\*\)                                                                 | \[[^\]]+\])[+*]/`(nested-quantifier shape); permit only the`i`and`u` flag set. |
| Validate        | Run `npm run test -- config`                                                                                                                        |
| Expected result | Setting `GEMINI_SESSION_REDACT_KEYS=/(a+)+$/` causes `getSessionRedactionPatterns()` to throw at parse time; safe patterns (`/^foo$/i`) still load. |

#### TASK-010: Token entropy floor

| Field           | Value                                                                                                                                                         |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | ---------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                          |
| Files           | [src/config.ts](src/config.ts); [**tests**/config.test.ts](__tests__/config.test.ts)                                                                          |
| Symbols         | [parseOptionalTokenEnv](src/config.ts#L100)                                                                                                                   |
| Action          | After the trivially-repeated check, require `trimmed.length >= 48                                                                                             |     | new Set(trimmed).size >= 16`; throw`${name} must be ≥48 chars or use ≥16 distinct characters.` |
| Validate        | Run `npm run test -- config`                                                                                                                                  |
| Expected result | `MCP_HTTP_TOKEN='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab'` (32 chars, 2 unique) throws; a 32-char hex token with ≥16 unique chars or any 48-char token still parses. |

#### TASK-011: Trim and validate API key

| Field           | Value                                                                                                                                                |
| :-------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                 |
| Files           | [src/config.ts](src/config.ts); [**tests**/config.test.ts](__tests__/config.test.ts)                                                                 |
| Symbols         | [getApiKey](src/config.ts#L172)                                                                                                                      |
| Action          | Replace `return raw` with `const trimmed = raw.trim();` then throw if `trimmed === ''` or `/[\u0000-\u001F\u007F]/.test(trimmed)`; return `trimmed`. |
| Validate        | Run `npm run test -- config`                                                                                                                         |
| Expected result | `API_KEY=' abc '` returns `'abc'`; `API_KEY="abc\u0000"` throws; existing valid keys remain unchanged.                                               |

#### TASK-012: Single-read upload

| Field           | Value                                                                                                                                                                                                                                                                             |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                                                                                                                                              |
| Files           | [src/lib/file.ts](src/lib/file.ts); [**tests**/lib/file.test.ts](__tests__/lib/file.test.ts)                                                                                                                                                                                      |
| Symbols         | [uploadFile](src/lib/file.ts#L155); [validateUploadMimeType](src/lib/file.ts#L95)                                                                                                                                                                                                 |
| Action          | Refactor `uploadFile` to call `readFile(resolvedPath)` once into a `Buffer`, change `validateUploadMimeType` to accept a `Buffer` instead of re-reading the path, then pass `{ file: new Blob([buffer], { type: mimeType }) }` (or the SDK equivalent) to `getAI().files.upload`. |
| Validate        | Run `npm run test -- lib`                                                                                                                                                                                                                                                         |
| Expected result | A test that stubs `node:fs/promises.readFile` to count calls observes exactly one read per `uploadFile` invocation; the bytes validated equal the bytes uploaded.                                                                                                                 |

## 5. Testing & Validation

### [`VAL-001`](#5-testing--validation) — Lint clean

```bash
npm run lint
```

### [`VAL-002`](#5-testing--validation) — Type-check clean

```bash
npm run type-check
```

### [`VAL-003`](#5-testing--validation) — Full test suite passes

```bash
npm run test
```

### [`VAL-004`](#5-testing--validation) — Targeted regression run for new tests

```bash
npm run test -- transport-host-validation config validation logger lib tools
```

## 6. Acceptance Criteria

|                 ID                 | Observable Outcome                                                                                                                                              |
| :--------------------------------: | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`AC-001`](#6-acceptance-criteria) | With `MCP_ALLOW_UNAUTHENTICATED_LOOPBACK_HTTP=true` and bind `127.0.0.1`, a request with `Host: evil.example` returns `403`; `Host: 127.0.0.1:<port>` succeeds. |
| [`AC-002`](#6-acceptance-criteria) | `analyze {targetKind:'file', filePath:'.env'}` returns a tool error and never invokes `getAI().files.upload`.                                                   |
| [`AC-003`](#6-acceptance-criteria) | A log entry containing `authorization`, `api_key`, or `secret` keys persists with `[redacted]` and the broadcast `sendLoggingMessage` payload matches.          |
| [`AC-004`](#6-acceptance-criteria) | `getTransportConfig()` throws when `CORS_ORIGIN=*` and `MCP_HTTP_TOKEN` is set.                                                                                 |
| [`AC-005`](#6-acceptance-criteria) | `isPublicHttpUrl` returns `false` for `http://2130706433/`, `http://127.1/`, `http://[0:0:0:0:0:0:0:1]/`, `http://[::]/`.                                       |
| [`AC-006`](#6-acceptance-criteria) | `getSessionRedactionPatterns` throws for `GEMINI_SESSION_REDACT_KEYS=/(a+)+$/` and accepts `/^foo$/i`.                                                          |
| [`AC-007`](#6-acceptance-criteria) | `MCP_HTTP_TOKEN` of 32 chars with only 2 unique characters is rejected; 32-char hex (≥16 unique) and any 48-char value are accepted.                            |
| [`AC-008`](#6-acceptance-criteria) | `analyzePrWork` returns an error tool result without invoking `git` when the resolved root is outside the configured `ROOTS`.                                   |
| [`AC-009`](#6-acceptance-criteria) | `uploadFile` invokes `readFile(resolvedPath)` exactly once per call.                                                                                            |
| [`AC-010`](#6-acceptance-criteria) | `getApiKey` returns the trimmed value and throws on non-printable input.                                                                                        |
| [`AC-011`](#6-acceptance-criteria) | With `trustProxy=true` and `x-forwarded-for: junk-spoofed`, the rate-limit key is derived from the socket address.                                              |
| [`AC-012`](#6-acceptance-criteria) | `npm run lint && npm run type-check && npm run test` exits zero.                                                                                                |

## 7. Risks / Notes

|              ID               | Type | Detail                                                                                                                                                                                                                                                        |
| :---------------------------: | :--: | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`RISK-001`](#7-risks--notes) | Risk | TASK-008 changes the persisted log format for any caller currently relying on raw `data`. Mitigation: existing log tests already assert structure; update fixtures in the same task.                                                                          |
| [`RISK-002`](#7-risks--notes) | Risk | TASK-005 may reject legitimate diagnostic uploads of `.env.example` or similar. Mitigation: `isSensitiveUntrackedPath` already excludes `.env.example` (only matches `.env` and `.env.<suffix>` other than `example`); verify against the existing test list. |
| [`RISK-003`](#7-risks--notes) | Risk | TASK-012 must keep the `@google/genai` `files.upload` call shape valid; if the SDK requires a path, fall back to writing the buffer to a verified temp file or accept the residual TOCTOU as documented and instead `realpath` + reopen-by-handle.            |
| [`NOTE-001`](#7-risks--notes) | Note | Phases are independent; TASK-005 depends on TASK-004 only. Other tasks may proceed in parallel.                                                                                                                                                               |
| [`NOTE-002`](#7-risks--notes) | Note | Run `npm run lint && npm run type-check && npm run test` after each task per `AGENTS.md` change checklist; ask before running the full build.                                                                                                                 |
