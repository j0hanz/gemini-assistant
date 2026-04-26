---
goal: Harden HTTP transport, rate limiting, URL validation, session redaction, and review path safety per security review
version: 1.0
date_created: 2026-04-26
last_updated: 2026-04-26
owner: gemini-assistant maintainers
status: 'Completed'
tags: ['security', 'transport', 'hardening', 'bug']
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

This plan implements all recommendations from `.github/report.md` security review. Scope: mandatory Host-header allow-list on broad HTTP binds, web-standard stateless method restriction, hashed session-ID logging, bounded rate-limiter buckets, stricter `CORS_ORIGIN` parsing, expanded private-IP literal blocking, free-text secret redaction in session events, and post-`join` path validation in untracked-file review reads.

## 1. Requirements & Constraints

- **SEC-001**: Broad HTTP binds (`0.0.0.0`, `::`, `''`) MUST refuse to start without `ALLOWED_HOSTS` configured.
- **SEC-002**: Web-standard stateless transport MUST reject non-`POST`/`OPTIONS` methods with HTTP 405 and `Allow: POST, OPTIONS`.
- **SEC-003**: Transport session IDs MUST NOT appear verbatim in logs; emit a 12-char SHA-256 prefix as `sessionRef`.
- **SEC-004**: Rate-limiter bucket `Map` MUST be bounded (default `maxBuckets=10000`) and idle-swept (default `idleTtlMs=60000`).
- **SEC-005**: `CORS_ORIGIN` MUST accept only `"*"` or a strict origin (`scheme://host[:port]`) without path, query, fragment, userinfo, or credentials.
- **SEC-006**: `isPrivateIpv4` MUST validate octets as integers in `[0,255]` and block `0.0.0.0/8`, `100.64.0.0/10` (CGNAT), `169.254.0.0/16`, `192.0.0.0/24`–`192.0.2.0/24`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, and `224.0.0.0/3` (multicast/reserved).
- **SEC-007**: `PRIVATE_IPV6_PREFIXES` MUST include `'ff'` (multicast).
- **SEC-008**: Session event entries MUST scrub free-text `Bearer ...` tokens and `api_key|authorization|password|secret|token` `key=value` patterns from `message`, `sentMessage`, `toolProfile`.
- **SEC-009**: `buildUntrackedPatch` MUST verify `join(gitRoot, relativePath)` stays within `gitRoot` via `isPathWithinRoot` before reading.
- **CON-001**: All current tests MUST continue to pass; no behavior change for loopback HTTP / stdio defaults.
- **CON-002**: No new runtime dependencies.
- **CON-003**: Use existing helpers (`AppError`, `isPathWithinRoot`, `createHash`) and existing log/error idioms.
- **GUD-001**: Use conditional spreads for optional properties under `exactOptionalPropertyTypes`.
- **PAT-001**: Hash with `createHash('sha256').update(id).digest('hex').slice(0, 12)`.
- **PAT-002**: Tests colocated under `__tests__/`, run with `npm run test` (Node test runner + tsx/esm).

## 2. Implementation Steps

### Implementation Phase 1 — Transport Host & Method Hardening

- GOAL-001: Make broad HTTP binds require `ALLOWED_HOSTS`, enforce 405 in web-standard stateless mode, and hash session IDs in logs.

| Task     | Description                                                                                                                                                                                                                                                                                                          | Completed | Date |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-001 | In `src/transport.ts`, import `createHash` from `node:crypto` and add constant `BROAD_BIND_HOSTS = new Set(['0.0.0.0', '::', ''])`.                                                                                                                                                                                  |           |      |
| TASK-002 | Add helper `assertHostValidationIsConfigured(host: string, allowedHosts: string[] \| undefined): void` in `src/transport.ts` that throws `AppError('transport', 'HTTP transport bound to ${host} requires ALLOWED_HOSTS for Host header validation.', 'server')` when `BROAD_BIND_HOSTS.has(host) && !allowedHosts`. |           |      |
| TASK-003 | Call `assertHostValidationIsConfigured(host, allowedHosts)` after `assertHttpBindIsProtected(host, token)` in both `startHttpTransport` and `startWebStandardTransport` (use destructured `allowedHosts` from `resolveTransportRuntimeConfig()`).                                                                    |           |      |
| TASK-004 | Add helper `webMethodNotAllowedResponse(corsOrigin: string): Response` returning `responseError(405, 'Method Not Allowed')` with `Allow: POST, OPTIONS` header, wrapped via `withCors`.                                                                                                                              |           |      |
| TASK-005 | In the web-standard `handler` (after CORS preflight check, before auth check), add `if (isStateless && req.method !== 'POST' && req.method !== 'OPTIONS') return webMethodNotAllowedResponse(corsOrigin);`.                                                                                                          |           |      |
| TASK-006 | Replace body of `logSessionEvent(label, sessionId)` with `log.info('transport session event', { event: label, sessionRef: createHash('sha256').update(sessionId).digest('hex').slice(0, 12) })`.                                                                                                                     |           |      |
| TASK-007 | Replace body of `logTransportSessionEviction(reason, sessionId)` with `log.info('transport session eviction', { reason, sessionRef: createHash('sha256').update(sessionId).digest('hex').slice(0, 12) })`.                                                                                                           |           |      |

### Implementation Phase 2 — Rate-Limiter Bounding

- GOAL-002: Prevent unbounded memory growth in `createRateLimiter`.

| Task     | Description                                                                                                                                                                                                                                      | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---- |
| TASK-008 | In `src/lib/rate-limit.ts`, extend `RateLimiterOptions` with optional `idleTtlMs?: number` and `maxBuckets?: number`.                                                                                                                            |           |      |
| TASK-009 | Add module-scope constants `DEFAULT_IDLE_TTL_MS = 60_000` and `DEFAULT_MAX_BUCKETS = 10_000`.                                                                                                                                                    |           |      |
| TASK-010 | In `createRateLimiter`, accept defaults from new options. Add closure variable `lastSweepAt = 0`.                                                                                                                                                |           |      |
| TASK-011 | Add inner `sweepExpiredBuckets(currentTime)`: if `currentTime - lastSweepAt < idleTtlMs` return; else set `lastSweepAt = currentTime`, compute `cutoff = currentTime - idleTtlMs`, iterate `buckets` deleting entries with `updatedAt < cutoff`. |           |      |
| TASK-012 | Add inner `boundBucketCount()`: while `buckets.size > maxBuckets`, delete the oldest key returned by `buckets.keys().next().value`.                                                                                                              |           |      |
| TASK-013 | In `take`, call `sweepExpiredBuckets(currentTime)` at top; call `boundBucketCount()` after each `buckets.set(...)`.                                                                                                                              |           |      |

### Implementation Phase 3 — Config & URL Validation

- GOAL-003: Tighten `CORS_ORIGIN` parsing and expand non-public IP literal coverage.

| Task     | Description                                                                                                                                                                                                                                                                                                                                                                         | Completed | Date |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-014 | In `src/config.ts` `parseCorsOriginEnv`, accept `"*"` directly. Otherwise `new URL(trimmed)`; require `(protocol === 'http:' \|\| protocol === 'https:') && parsed.origin === trimmed && parsed.username === '' && parsed.password === ''`. On failure throw `Error('CORS_ORIGIN must be "*" or a single http(s) origin without path, query, or credentials when set.')`.           |           |      |
| TASK-015 | In `src/lib/validation.ts` `isPrivateIpv4`, replace `Number.isNaN(part)` guard with `!Number.isInteger(part) \|\| part < 0 \|\| part > 255`.                                                                                                                                                                                                                                        |           |      |
| TASK-016 | Destructure `[a, b, c]` (cast to `[number, number, number, number]`) and add: `a === 0` → true; CGNAT `a === 100 && b >= 64 && b <= 127`; `a === 192 && b === 0` (covers TEST-NET-1/192.0.0/24); benchmark `a === 198 && (b === 18 \|\| b === 19)`; TEST-NET-2 `a === 198 && b === 51 && c === 100`; TEST-NET-3 `a === 203 && b === 0 && c === 113`; multicast/reserved `a >= 224`. |           |      |
| TASK-017 | Add `'ff'` to `PRIVATE_IPV6_PREFIXES`.                                                                                                                                                                                                                                                                                                                                              |           |      |

### Implementation Phase 4 — Session Redaction & Review Path Safety

- GOAL-004: Redact free-text secrets in session events and validate untracked review file paths.

| Task     | Description                                                                                                                                                                                                                                                               | Completed | Date |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-018 | In `src/sessions.ts`, add `const SESSION_FREE_TEXT_SECRET_PATTERNS: readonly RegExp[] = [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, /\b(?:api[_-]?key\|authorization\|password\|secret\|token)\s*[:=]\s*[^\s,;]+/gi]`.                                                          |           |      |
| TASK-019 | Add helper `sanitizeSessionText(text: string \| undefined): string \| undefined` that returns `undefined` for undefined input else applies all patterns via `reduce((current, pattern) => current.replace(pattern, '[REDACTED]'), text)`.                                 |           |      |
| TASK-020 | In `cloneSessionEventEntry`, when copying `request`, run `sanitizeSessionText` over `message` (fallback to original if undefined) and over optional `sentMessage` and `toolProfile` (use conditional spread to preserve `exactOptionalPropertyTypes`).                    |           |      |
| TASK-021 | In `src/tools/review.ts`, change import to `import { isPathWithinRoot, type RootsFetcher } from '../lib/validation.js';`.                                                                                                                                                 |           |      |
| TASK-022 | At the top of `buildUntrackedPatch` after `const absolutePath = join(gitRoot, relativePath);`, add `if (!isPathWithinRoot(absolutePath, gitRoot)) return { path: relativePath, skipReason: 'sensitive' };` (placed before the existing `isSensitiveUntrackedPath` check). |           |      |

### Implementation Phase 5 — Tests, Lint, Type-check

- GOAL-005: Cover new behavior with tests and confirm clean tooling pass.

| Task     | Description                                                                                                                                                                                                                                          | Completed | Date |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-023 | Add tests in `__tests__/transport.test.ts` (or `transport-host-validation.test.ts`): broad bind without `ALLOWED_HOSTS` throws `AppError`; broad bind with `ALLOWED_HOSTS` starts; loopback bind unchanged.                                          |           |      |
| TASK-024 | Add web-standard handler test: stateless GET / DELETE / PUT return 405 with `Allow: POST, OPTIONS` header; POST and OPTIONS continue to work.                                                                                                        |           |      |
| TASK-025 | Add log-format test (or update existing) asserting `logSessionEvent` emits `sessionRef` and does NOT contain the raw session UUID.                                                                                                                   |           |      |
| TASK-026 | Add tests in `__tests__/lib/rate-limit.test.ts` (create if missing) for: bucket count never exceeds `maxBuckets`; idle buckets evicted after `idleTtlMs` using injected `now`.                                                                       |           |      |
| TASK-027 | Add `__tests__/config.test.ts` cases: `CORS_ORIGIN='*'` ok; `CORS_ORIGIN='https://example.com'` ok; `CORS_ORIGIN='https://example.com/path'` throws; `CORS_ORIGIN='https://user:pass@example.com'` throws; `CORS_ORIGIN='ftp://example.com'` throws. |           |      |
| TASK-028 | Extend `__tests__/lib/validation.test.ts` URL/IP cases to assert rejection of `0.0.0.0`, `100.64.0.1`, `198.18.0.1`, `198.51.100.1`, `203.0.113.1`, `224.0.0.1`, `1.5.2.3` (non-integer octet sanity), and `ff02::1` IPv6.                           |           |      |
| TASK-029 | Add `__tests__/sessions.test.ts` cases: `message` containing `Bearer abc.def-ghi=` and `api_key=xyz123` are replaced with `[REDACTED]` in cloned event entries.                                                                                      |           |      |
| TASK-030 | Add `__tests__/tools/pr.test.ts` (or new) case: `buildUntrackedPatch` returns `skipReason: 'sensitive'` when `relativePath` resolves outside `gitRoot` (e.g., `'../../etc/passwd'`).                                                                 |           |      |
| TASK-031 | Run `npm run format`, `npm run lint`, `npm run type-check`, `npm run test`; resolve any regressions.                                                                                                                                                 |           |      |

## 3. Alternatives

- **ALT-001**: Auto-generate `ALLOWED_HOSTS` for broad binds. Rejected — silently broadening trust violates SEC-001 intent.
- **ALT-002**: Drop bearer token requirement once Host validation is mandatory. Rejected — defense-in-depth; both controls are cheap.
- **ALT-003**: Replace bucket `Map` with an LRU library. Rejected — adds a dependency for a 30-line behavior; CON-002 forbids it.
- **ALT-004**: Resolve DNS for URL validation to block names pointing at private IPs. Rejected for this plan — adds latency and TOCTOU complexity; report classifies as future hardening.
- **ALT-005**: Encrypt logs to keep raw session IDs. Rejected — hashing solves the disclosure issue without log infra changes.

## 4. Dependencies

- **DEP-001**: `node:crypto` (already used for `randomUUID`/`timingSafeEqual`).
- **DEP-002**: Existing `AppError`, `isPathWithinRoot`, `validateHostHeader`, `responseError`, `withCors`, `logger`.
- **DEP-003**: Node.js `>=24` (per `AGENTS.md`).

## 5. Files

- **FILE-001**: `src/transport.ts` — host-validation guard, 405 helper, web-standard method check, hashed session log helpers.
- **FILE-002**: `src/lib/rate-limit.ts` — idle sweep + bucket cap.
- **FILE-003**: `src/config.ts` — strict `parseCorsOriginEnv` via `URL`.
- **FILE-004**: `src/lib/validation.ts` — expanded `isPrivateIpv4` + IPv6 multicast prefix.
- **FILE-005**: `src/sessions.ts` — free-text secret scrubbing in `cloneSessionEventEntry`.
- **FILE-006**: `src/tools/review.ts` — `isPathWithinRoot` guard in `buildUntrackedPatch`.
- **FILE-007**: `__tests__/transport.test.ts`, `__tests__/transport-host-validation.test.ts` — host/method/log tests.
- **FILE-008**: `__tests__/lib/rate-limit.test.ts` — bounding tests (new).
- **FILE-009**: `__tests__/config.test.ts` — CORS parse tests.
- **FILE-010**: `__tests__/lib/validation.test.ts` — IP literal tests.
- **FILE-011**: `__tests__/sessions.test.ts` — free-text redaction tests.
- **FILE-012**: `__tests__/tools/pr.test.ts` — path-escape test for `buildUntrackedPatch`.

## 6. Testing

- **TEST-001**: Broad bind without `ALLOWED_HOSTS` throws before listening; broad bind with it succeeds; loopback unchanged.
- **TEST-002**: Web-standard stateless: GET/DELETE/PUT → 405 + `Allow: POST, OPTIONS`; POST → handled; OPTIONS preflight unchanged.
- **TEST-003**: `logSessionEvent` output contains 12-hex `sessionRef`, never the raw UUID.
- **TEST-004**: Rate limiter never exceeds `maxBuckets`; idle entries evicted after `idleTtlMs`.
- **TEST-005**: `CORS_ORIGIN` accepts `"*"` and bare origin, rejects path/query/credentials/non-http schemes.
- **TEST-006**: `isPrivateIpv4` rejects `0.x`, `100.64–127.x`, TEST-NET, benchmark, `224+`; non-integer octets return false (not throw).
- **TEST-007**: IPv6 `ff02::1` classified as non-public.
- **TEST-008**: Session event `request.message` containing `Bearer xyz` / `api_key=xyz` returns `[REDACTED]` after `cloneSessionEventEntry`.
- **TEST-009**: `buildUntrackedPatch` returns `skipReason: 'sensitive'` when path escapes `gitRoot`.
- **TEST-010**: Full `npm run test` suite passes; `npm run lint` and `npm run type-check` clean.

## 7. Risks & Assumptions

- **RISK-001**: Existing operators with broad-bind HTTP and no `ALLOWED_HOSTS` will see startup failures. Mitigation: documented breaking change in PR description and README hardening checklist.
- **RISK-002**: Stricter `CORS_ORIGIN` parser may reject previously-tolerated values with paths. Mitigation: explicit error message guides config fix.
- **RISK-003**: Free-text redaction regex may over-redact unrelated text matching `token=...`. Acceptable — false positives in event resource only.
- **RISK-004**: Hashed session logs reduce debuggability when correlating with client logs. Mitigation: 12-char prefix is still unique enough for local correlation; raw IDs remain available to clients.
- **ASSUMPTION-001**: `ALLOWED_HOSTS` parsing already supports comma-separated entries (verified in `src/lib/validation.ts`).
- **ASSUMPTION-002**: `responseError(status, message)` returns a `Response` whose headers can be mutated (used for `Allow` header in 405).
- **ASSUMPTION-003**: No production deployment relies on `Number.isNaN`-based octet leniency.

## 8. Related Specifications / Further Reading

- `.github/report.md` — source security review.
- `AGENTS.md` — repo guidance, command list, safety boundaries.
- MCP transport guidance: Host validation, DNS rebinding, CORS, stateless POST-only requirements.
- OWASP SSRF Prevention Cheat Sheet — non-public IP literal blocking.
- IANA IPv4 Special-Purpose Address Registry — CGNAT (RFC 6598), TEST-NET (RFC 5737), benchmark (RFC 2544).
