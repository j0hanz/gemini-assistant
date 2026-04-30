# Schemas in MCP v2 (Standard Schema, Zod v4, JSON Schema interop)

Read this when defining `inputSchema`, `outputSchema`, `argsSchema`, or any MCP-facing validator.

## The rule

v2 requires Standard Schema for all schema fields. Plain object shapes are no longer accepted.

Accepted sources:

- **Zod v4** (`import { z } from 'zod/v4'`) — recommended default
- **ArkType** — for `type(...)`-style codebases
- **Valibot** — via `toStandardJsonSchema(...)`
- **Raw JSON Schema** — via `fromJsonSchema(...)` from `@modelcontextprotocol/server`

Use Zod v4 unless the codebase already uses something else.

## Zod v4 patterns for MCP

### Always import from `zod/v4`

```ts
import { z } from 'zod/v4';
```

`zod` (v3) and `zod/v4` are different packages with different runtime behavior. Mixing them produces confusing type errors.

### `z.strictObject` at boundaries — not `z.object`

```ts
// ✓ catches misspelled fields from clients
const InputSchema = z.strictObject({
  query: z.string(),
  limit: z.number().int().positive().optional(),
});

// ✗ silently strips unknown keys → masks caller bugs
const Loose = z.object({
  query: z.string(),
});
```

Use `z.strictObject(...)` for tool inputs, prompt args, structured outputs — anything that crosses the protocol boundary.

Internal helper schemas (not exposed externally) can use `z.object(...)`.

### `.describe()` on every model-facing field

```ts
const InputSchema = z.strictObject({
  query: z.string().describe('Natural-language search query'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum number of results to return (1-50)'),
});
```

Descriptions are sent to the model as part of the tool schema. They're how the model learns what each field means. Skipping them produces less reliable tool calls.

### Discriminated unions for modeful inputs

```ts
const SearchInputSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('query'),
    query: z.string().min(1).describe('Natural-language query'),
    includeSnippets: z.boolean().default(true),
  }),
  z.strictObject({
    mode: z.literal('url'),
    urls: z.array(z.httpUrl()).min(1).max(20).describe('URLs to inspect'),
    question: z.string().min(1).describe('Question about the URLs'),
  }),
]);
```

Beats one giant object full of unrelated optionals. The discriminator (`mode`) makes mode-specific field requirements enforceable.

### Defaults vs prefaults

```ts
limit: z.number().int().min(1).default(10),         // applies after parsing succeeds
timeout: z.string().prefault('30s'),                 // applies before transforms run
```

Use `.default(...)` for the common case. Use `.prefault(...)` when you need transforms or refinements to run on the default value.

### Refinements at the right layer

Schema-level (validate shape, fail fast):

```ts
const InputSchema = z
  .strictObject({
    startDate: z.iso.date(),
    endDate: z.iso.date(),
  })
  .refine((d) => d.startDate <= d.endDate, {
    message: 'startDate must be on or before endDate',
  });
```

Handler-level (depends on runtime state):

```ts
async (args, ctx) => {
  if (await isBlocked(args.userId)) {
    return { content: [{ type: 'text', text: 'User is blocked' }], isError: true };
  }
  // ...
};
```

Don't try to encode runtime-dependent rules in the schema.

## Output schemas — keep them aligned with results

```ts
const OutputSchema = z.strictObject({
  status: z.enum(['ok', 'error']),
  itemsProcessed: z.int().nonnegative(),
});

server.registerTool(
  'process',
  { inputSchema: InputSchema, outputSchema: OutputSchema },
  async (args): Promise<CallToolResult> => {
    const raw = await doWork(args);
    const structured = OutputSchema.parse(raw); // validate before returning
    return {
      content: [{ type: 'text', text: `Processed ${structured.itemsProcessed} items` }],
      structuredContent: structured,
    };
  },
);
```

Always parse `structuredContent` through the output schema if it comes from an external/upstream source. Drift between declared schema and actual payload is a contract violation.

## Sharing field builders

For projects with many tools, centralize reusable fields:

```ts
// schemas/fields.ts
import { z } from 'zod/v4';

export const sessionId = () =>
  z.string().uuid().describe('Session identifier');

export const limit = (max = 50) =>
  z.number().int().min(1).max(max).default(10).describe(`Max results (1-${max})`);

export const usage = () =>
  z.strictObject({
    promptTokenCount: z.int().nonnegative().optional(),
    totalTokenCount: z.int().nonnegative().optional(),
  });

// schemas/inputs.ts
import { sessionId, limit } from './fields.js';

export const SearchInputSchema = z.strictObject({
  query: z.string().min(1).describe('Search query'),
  sessionId: sessionId().optional(),
  limit: limit(20),
});
```

Reuse beats redefining primitives across files.

## Composing output schemas

```ts
const baseOutputShape = {
  usage: usage().optional().describe('Token usage'),
  requestId: z.string().optional().describe('Upstream correlation ID'),
};

export const SearchOutputSchema = z.strictObject({
  answer: z.string().describe('Grounded answer'),
  sources: z.array(z.httpUrl()).describe('Source URLs'),
  ...baseOutputShape,
});

export const AnalyzeOutputSchema = z.strictObject({
  summary: z.string(),
  keyPoints: z.array(z.string()),
  ...baseOutputShape,
});
```

Either spread shared shape into multiple `z.strictObject(...)` calls, or use `.safeExtend(...)`. Don't copy-paste large schema fragments by hand.

## Strict objects with `.passthrough` carve-outs

Sometimes you need strict + a known escape hatch. Compose:

```ts
const InputSchema = z.strictObject({
  query: z.string(),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Free-form metadata; not validated'),
});
```

Don't reach for `.passthrough()` on the top-level — it defeats the strictness you wanted. Use a typed escape-hatch field instead.

## JSON Schema interop

If the source of truth is JSON Schema (e.g., from an OpenAPI spec or external contract):

```ts
import { fromJsonSchema } from '@modelcontextprotocol/server';

const RawSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, description: 'Search query' },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
  },
  required: ['query'],
  additionalProperties: false,
} as const;

server.registerTool(
  'search',
  { inputSchema: fromJsonSchema(RawSchema) },
  async ({ query, limit = 10 }) => ({
    content: [{ type: 'text', text: `Searching: ${query} (${limit})` }],
  }),
);
```

`as const` preserves literal types — the SDK uses them for handler argument inference.

**`fromJsonSchema` optional second argument**: If you need to supply a custom JSON Schema validator (e.g., `AjvJsonSchemaValidator` or `CfWorkerJsonSchemaValidator`), pass it as the second argument. The SDK auto-selects the right validator for the runtime (Node.js → `AjvJsonSchemaValidator`, Cloudflare Workers → `CfWorkerJsonSchemaValidator`), so you only need this for custom validator configurations:

```ts
import { AjvJsonSchemaValidator, fromJsonSchema } from '@modelcontextprotocol/server';

const validator = new AjvJsonSchemaValidator();
const schema = fromJsonSchema(RawSchema, validator);
```

**Don't hand-translate JSON Schema to partial Zod.** Either convert fully (and lose the original as truth) or use `fromJsonSchema(...)`.

## Elicitation `requestedSchema` is JSON Schema (NOT Zod)

The MCP spec restricts elicitation forms to a small set of primitives, expressed as raw JSON Schema:

```ts
await ctx.mcpReq.elicitInput({
  mode: 'form',
  message: 'Provide your details',
  requestedSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Name' },
      age: { type: 'integer', minimum: 0, maximum: 120 },
      role: { type: 'string', enum: ['admin', 'user', 'guest'] },
    },
    required: ['name'],
  },
});
```

Supported primitives:

- string
- number / integer
- boolean
- enum (single-select)
- multi-select enum

Don't try to use Zod here — the spec intentionally restricts to client-renderable shapes.

## Validation that crosses the network is not optional

Any time you receive data from outside (tool args, structured outputs from upstream APIs, resource contents you didn't generate), parse through a schema. The SDK already validates `inputSchema` for you — that handles tool args. For everything else (upstream API responses, third-party data), validate manually:

```ts
const upstreamRaw = await fetch(...).then((r) => r.json());
const validated = UpstreamResponseSchema.parse(upstreamRaw);  // throws on shape mismatch
```

Catching schema violations at the boundary prevents subtle "looks-like-it-works" bugs deeper in the stack.

## Schema organization at scale

```text
src/schemas/
├── fields.ts       // reusable field builders (sessionId, limit, usage, ...)
├── shared.ts       // shared object schemas referenced by multiple tools
├── inputs.ts       // tool input schemas
├── outputs.ts      // structured-output schemas
├── validators.ts   // JSON Schema validators (e.g. @cfworker/json-schema)
└── prompts.ts      // prompt argsSchemas
```

Push reusable shapes into `fields.ts` and `shared.ts`. Inputs and outputs reference them.

## Common schema pitfalls

- Importing from `zod` (v3) instead of `zod/v4` in a v2 codebase.
- Using `z.object(...)` at external boundaries — silently strips typos.
- Skipping `.describe(...)` — model can't tell what fields mean.
- One huge object with unrelated optionals instead of a discriminated union.
- Hand-translating JSON Schema to partial Zod and losing fidelity.
- Putting Zod schemas into elicitation `requestedSchema` (must be JSON Schema).
- Forgetting to parse `structuredContent` from upstream sources before returning.
- Encoding runtime-dependent rules in schema refinements (belongs in handler).
- Inlining the same schema in multiple files — central it via `fields.ts`/`shared.ts`.
