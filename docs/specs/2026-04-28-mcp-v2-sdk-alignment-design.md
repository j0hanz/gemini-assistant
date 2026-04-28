# MCP v2 SDK Alignment — Design Spec

**Date:** 2026-04-28
**Status:** Approved
**Scope:** `src/prompts.ts`, `src/lib/task-utils.ts`, `src/lib/tool-context.ts`, `src/lib/tool-executor.ts`, `src/tools/*.ts`

---

## Background

`gemini-assistant` is correctly on the MCP v2 SDK split packages. A targeted audit against the v2
contract identified four gaps where either an available SDK feature is unused or a custom abstraction
layer adds indirection without payoff. This spec describes what changes, why, and what the exact
before/after looks like for each gap. The public contract (`src/public-contract.ts`), schemas, transports,
sessions, and streaming pipeline are out of scope and unchanged.

---

## Gap 1 — `completable()` missing on prompt enum args

### Problem

The three public prompts (`discover`, `research`, `review`) expose enum-typed optional args:

| Prompt | Arg | Type |
|--------|-----|------|
| `discover` | `job` | `PublicJobNameSchema` (enum) |
| `research` | `mode` | `z.enum(RESEARCH_MODE_OPTIONS)` |
| `review` | `subject` | `z.enum(REVIEW_SUBJECT_OPTIONS)` |

These are registered without `completable()` wrappers. Clients that support argument completion
(e.g. Claude Code) cannot offer tab-completion for these fields; users must know the valid values
in advance.

### Decision

Wrap each enum arg in `completable()` from `@modelcontextprotocol/server`. The completion callback
filters the enum values against the partial input prefix.

### Design

Add a shared helper at the top of `src/prompts.ts`:

```ts
function enumComplete<T extends string>(options: readonly T[]) {
  return (value: string | undefined): T[] =>
    options.filter((o) => o.startsWith(value ?? ''));
}
```

Apply to each schema field:

```ts
// DiscoverPromptSchema
job: completable(PublicJobNameSchema.optional(), enumComplete(PublicJobNameSchema.options))

// ResearchPromptSchema
mode: completable(enumField(RESEARCH_MODE_OPTIONS, '...').optional(), enumComplete(RESEARCH_MODE_OPTIONS))

// ReviewPromptSchema
subject: completable(enumField(REVIEW_SUBJECT_OPTIONS, '...').optional(), enumComplete(REVIEW_SUBJECT_OPTIONS))
```

`completable` is imported from `@modelcontextprotocol/server` (already a dependency).

### Verification

- `npm run type-check` passes — `completable()` wraps a `ZodType`, producing a type still accepted by `argsSchema`.
- Manual: register prompt in inspector, confirm completion list returned for partial prefix.

---

## Gap 2 — Schema passthrough bypass in task tool registration

### Problem

`task-utils.ts` wraps tool input schemas with `createSdkPassthroughInputSchema` before passing them
to `registerToolTask`. The passthrough replaces the schema's `validate` method with one that always
returns `{ value }`, bypassing SDK-level input validation entirely. Real schema validation happens
later inside `parseTaskInput` (called from `wrapTaskSafeWork`).

Intent (per the code comment): schema-invalid args should record a `failed` task rather than being
rejected at the `tools/call` boundary.

Side effect: this creates a divergent error surface:

| Mode | Invalid input result |
|------|----------------------|
| Stateless (`registerTool`) | Protocol error at `tools/call` |
| Stateful (`registerToolTask`) | Task created, then immediately fails |

The divergence is surprising for clients and creates dead state (failed tasks from malformed calls).

### Decision

Remove the bypass. Both modes now reject invalid input at the `tools/call` boundary as a protocol
error. No task record is created for structurally invalid input. `parseTaskInput` is retained to
handle Zod coercions/transforms on already-validated input.

### Design

**Delete:**
- `createSdkPassthroughInputSchema()` function
- `hasSafeParse()`, `hasParse()`, `hasStandardSchema()` helpers (exist only to support the bypass)
- `SafeParseSchema`, `ParseSchema`, `JsonSchemaProvider`, `StandardSchemaLike` interfaces

**Simplify `createTaskRegistrationConfig`:**

```ts
// Before
function createTaskRegistrationConfig(config: TaskToolConfig): TaskRegistrationConfig {
  return {
    ...config,
    inputSchema: createSdkPassthroughInputSchema(config.inputSchema),
    execution: TASK_EXECUTION,
  };
}

// After
function createTaskRegistrationConfig(config: TaskToolConfig): TaskRegistrationConfig {
  return { ...config, execution: TASK_EXECUTION };
}
```

`parseTaskInput` inside `wrapTaskSafeWork` is kept as-is. It now handles Zod transforms on input
that has already passed SDK validation, which is correct and non-redundant.

### Verification

- `npm run type-check` and `npm run lint` pass.
- Existing task e2e tests pass (valid input still works).
- New or updated test: calling a task tool with invalid input returns a JSON-RPC error (not a task ID).

---

## Gap 3 — `definePrompt()` custom builder duplicates SDK type system

### Problem

`src/prompts.ts` defines a custom `definePrompt()` helper with two TypeScript overloads, a
`PromptDefinition` interface, and a `createPromptDefinitions()` factory. These exist so the prompt
array can be iterated in `registerPrompts()` to call `server.registerPrompt()`.

The only functional contribution of `definePrompt()` is typed inference of `buildMessage(args)`.
The SDK's `server.registerPrompt()` overloads already infer handler argument types directly from
`argsSchema`, making the custom builder a redundant layer.

### Decision

Delete the `definePrompt()` builder, `PromptDefinition`, and `createPromptDefinitions()`. Replace
`registerPrompts()` with three direct `server.registerPrompt()` calls. The build functions
(`buildDiscoverPrompt`, `buildResearchPrompt`, `buildReviewPrompt`) are retained unchanged.

### Design

```ts
// Before
export function registerPrompts(server: McpServer): void {
  for (const definition of createPromptDefinitions()) {
    server.registerPrompt(
      definition.name,
      { title: ..., description: ..., argsSchema: ... },
      async (args) => ({ description: ..., ...definition.buildMessage(args) }),
    );
  }
}

// After
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'discover',
    { title: 'Discover', description: '...', argsSchema: DiscoverPromptSchema },
    async (args) => ({ description: '...', ...buildDiscoverPrompt(args) }),
  );

  server.registerPrompt(
    'research',
    { title: 'Research', description: '...', argsSchema: ResearchPromptSchema },
    async (args) => ({ description: '...', ...buildResearchPrompt(args) }),
  );

  server.registerPrompt(
    'review',
    { title: 'Review', description: '...', argsSchema: ReviewPromptSchema },
    async (args) => ({ description: '...', ...buildReviewPrompt(args) }),
  );
}
```

Prompt name strings are `PublicPromptName` — the `satisfies` keyword or an explicit cast enforces
this without the `definePrompt()` overload machinery.

**Deleted from `src/prompts.ts`:**
- `PromptDefinition` interface
- `definePrompt()` function (both overloads and implementation)
- `createPromptDefinitions()` function
- `BuildMessageResult`, `PromptMessageResult` type aliases

**Retained:**
- `DiscoverPromptSchema`, `ResearchPromptSchema`, `ReviewPromptSchema`
- `buildDiscoverPrompt`, `buildResearchPrompt`, `buildReviewPrompt`
- `renderWorkflowSection`, `PUBLIC_JOB_OPTIONS`
- `userPromptMessage` helper (used by build functions)

### Verification

- `npm run type-check` passes — SDK infers handler arg types from `argsSchema`.
- All three prompts appear in MCP inspector with correct descriptions and arg schemas.

---

## Gap 4 — Symbol-key service injection

### Problem

`tool-context.ts` defines a private `TOOL_SERVICES_KEY` Symbol and three functions
(`bindToolServices`, `getToolServices`, `findToolServices`) that attach a `ToolServices` bag to
a `ServerContext` object via property mutation. The pattern exists because `tool-executor.ts`
(a shared singleton) needs access to `workspace.resolveCacheName()` without `ToolServices` being
threaded through `registerWorkTool` → `createToolTaskHandlers`.

The Symbol approach is a hidden dependency: function signatures do not reveal that a `ctx` object
must have been `bind`-ed before use. Two work functions also call `findToolServices(ctx)` directly
rather than using closed-over services.

**Affected call sites:**

| File | Usage |
|------|-------|
| `tool-executor.ts:466` | `findToolServices(ctx)?.workspace.resolveCacheName(ctx)` |
| `research.ts:696` | `findToolServices(ctx)?.workspace.resolveCacheName(ctx)` |
| `review.ts:1288` | `findToolServices(ctx)?.workspace.scanFileNames()` |

All three can trivially use closed-over `resolvedServices` instead.

### Decision

Option A: pre-resolve dependencies in work functions, pass them into the pipeline/executor
explicitly. Remove the Symbol pattern in its entirety.

### Design

**Delete from `src/lib/tool-context.ts`:**
- `TOOL_SERVICES_KEY` symbol
- `BoundToolContext` type
- `bindToolServices()` export
- `getToolServices()` export
- `findToolServices()` export

**Update `src/lib/tool-executor.ts` — `executeGeminiPipeline`:**

```ts
// Before
const toolServices = findToolServices(ctx);
const cacheName = toolServices ? await toolServices.workspace.resolveCacheName(ctx) : undefined;
// ...
config: { ...request.config, cacheName }

// After
// (lines removed — cacheName comes from request.config set by the caller)
config: request.config
```

`GeminiPipelineRequest.config.cacheName` is already an optional field. Callers that need it
pre-resolve it before building the request.

**Update each tool's registration function:**

```ts
// chat.ts — before
work: (args, ctx) => chatWork(askWork, args, bindToolServices(ctx, services))

// chat.ts — after
work: (args, ctx) => chatWork(askWork, args, ctx, services)
```

```ts
// research.ts — before
work: (args, ctx) => researchWork(args, bindToolServices(ctx, resolvedServices))
// inside researchWork at line 696:
const cacheName = await findToolServices(ctx)?.workspace.resolveCacheName(ctx);

// research.ts — after
work: (args, ctx) => researchWork(args, ctx, resolvedServices)
// inside researchWork:
const cacheName = await resolvedServices.workspace.resolveCacheName(ctx);
```

```ts
// analyze.ts — before
analyzeWork(rootsFetcher, fileWork, args, bindToolServices(ctx, resolvedServices))

// analyze.ts — after
analyzeWork(rootsFetcher, fileWork, args, ctx, resolvedServices)
```

```ts
// review.ts — before
call site uses bindToolServices(ctx, resolvedServices)
// inside review work at line 1288:
const toolServices = findToolServices(ctx);
const docPathsToCheck = envDocs ?? [...(toolServices?.workspace.scanFileNames() ?? [])];

// review.ts — after
// work function threads resolvedServices explicitly
const docPathsToCheck = envDocs ?? [...(resolvedServices.workspace.scanFileNames() ?? [])];
```

Each tool's internal work functions (`chatWork`, `researchWork`, `analyzeWork`, and the internal
review function) gain a `services: ToolServices` parameter at the appropriate call depth.

### Verification

- `npm run type-check` — function signature changes are fully reflected.
- `npm run test` — existing unit and e2e tests pass (services still reach the same code paths).
- `tool-context.ts` exports no Symbol-related identifiers.
- `findToolServices` and `bindToolServices` do not appear in any `src/` file after the change.

---

## Rollup: files changed

| File | Change type | Notes |
|------|-------------|-------|
| `src/prompts.ts` | Modify | Gap 1 (completable) + Gap 3 (collapse builder) |
| `src/lib/task-utils.ts` | Modify | Gap 2 (remove bypass) |
| `src/lib/tool-context.ts` | Modify | Gap 4 (remove Symbol DI exports) |
| `src/lib/tool-executor.ts` | Modify | Gap 4 (remove findToolServices call) |
| `src/tools/chat.ts` | Modify | Gap 4 (thread services explicitly) |
| `src/tools/research.ts` | Modify | Gap 4 (thread services explicitly) |
| `src/tools/analyze.ts` | Modify | Gap 4 (thread services explicitly) |
| `src/tools/review.ts` | Modify | Gap 4 (thread services explicitly) |

No new files. No changes to `src/public-contract.ts`, `src/schemas/`, `src/transport.ts`,
`src/sessions.ts`, `src/lib/streaming.ts`, `src/lib/response.ts`, or `src/lib/orchestration.ts`.

---

## Required checks after implementation

```bash
npm run lint
npm run type-check
npm run test
npm run build
```

All must pass with no new warnings before the branch is mergeable.
