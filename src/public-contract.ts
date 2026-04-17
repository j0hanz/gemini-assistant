export type PublicJobName = 'chat' | 'research' | 'analyze' | 'review' | 'memory' | 'discover';
export type PublicPromptName = 'discover' | 'research' | 'review' | 'memory';
export type PublicWorkflowName =
  | 'start-here'
  | 'chat'
  | 'research'
  | 'analyze'
  | 'review'
  | 'memory';
export type PublicResourceUri =
  | 'discover://catalog'
  | 'discover://workflows'
  | 'memory://sessions'
  | 'memory://sessions/{sessionId}'
  | 'memory://sessions/{sessionId}/transcript'
  | 'memory://sessions/{sessionId}/events'
  | 'memory://caches'
  | 'memory://caches/{cacheName}'
  | 'memory://workspace/context'
  | 'memory://workspace/cache';

export type DiscoveryKind = 'tool' | 'prompt' | 'resource';

export interface RelatedItemRef {
  kind: DiscoveryKind;
  name: string;
}

export interface DiscoveryEntry {
  name: string;
  kind: DiscoveryKind;
  title: string;
  bestFor: string;
  whenToUse: string;
  inputs: string[];
  returns: string;
  limitations?: string[];
  related: RelatedItemRef[];
}

export interface WorkflowEntry {
  name: PublicWorkflowName;
  goal: string;
  whenToUse: string;
  steps: string[];
  recommendedTools: PublicJobName[];
  recommendedPrompts: PublicPromptName[];
  relatedResources: PublicResourceUri[];
}

export interface JobMetadata {
  name: PublicJobName;
  title: string;
  summary: string;
  recommendedPrompt?: PublicPromptName;
}

export const PUBLIC_TOOL_NAMES = [
  'chat',
  'research',
  'analyze',
  'review',
  'memory',
  'discover',
] as const satisfies readonly PublicJobName[];

export const PUBLIC_PROMPT_NAMES = [
  'discover',
  'research',
  'review',
  'memory',
] as const satisfies readonly PublicPromptName[];

export const PUBLIC_RESOURCE_URIS = [
  'discover://catalog',
  'discover://workflows',
  'memory://sessions',
  'memory://sessions/{sessionId}',
  'memory://sessions/{sessionId}/transcript',
  'memory://sessions/{sessionId}/events',
  'memory://caches',
  'memory://caches/{cacheName}',
  'memory://workspace/context',
  'memory://workspace/cache',
] as const satisfies readonly PublicResourceUri[];

export const PUBLIC_WORKFLOW_NAMES = [
  'start-here',
  'chat',
  'research',
  'analyze',
  'review',
  'memory',
] as const satisfies readonly PublicWorkflowName[];

export const JOB_METADATA = [
  {
    name: 'chat',
    title: 'Chat',
    summary: 'Direct Gemini chat with optional in-memory server-managed sessions.',
  },
  {
    name: 'research',
    title: 'Research',
    summary: 'Quick grounded lookup or deeper multi-step research with explicit mode selection.',
    recommendedPrompt: 'research',
  },
  {
    name: 'analyze',
    title: 'Analyze',
    summary: 'Reason over local files, public URLs, or a small set of files with one focused goal.',
  },
  {
    name: 'review',
    title: 'Review',
    summary: 'Review local diffs, compare files, or diagnose failures under one job-first surface.',
    recommendedPrompt: 'review',
  },
  {
    name: 'memory',
    title: 'Memory',
    summary: 'Inspect and manage sessions, caches, and workspace memory resources.',
    recommendedPrompt: 'memory',
  },
  {
    name: 'discover',
    title: 'Discover',
    summary: 'Get guided entry points, workflows, limitations, and related prompts/resources.',
    recommendedPrompt: 'discover',
  },
] as const satisfies readonly JobMetadata[];

export const DISCOVERY_ENTRIES = [
  {
    name: 'chat',
    kind: 'tool',
    title: 'Chat',
    bestFor: 'Direct Gemini chat, structured output, and multi-turn server-managed sessions.',
    whenToUse:
      'Use when the job is conversational and you may want to continue it later by session ID.',
    inputs: [
      'goal',
      'session?',
      'memory?',
      'systemInstruction?',
      'thinkingLevel?',
      'responseSchema?',
      'temperature?',
      'seed?',
    ],
    returns:
      'A direct answer, optional structured data, usage metadata, and memory resource links for active sessions.',
    limitations: [
      'Sessions are stored in server memory only and expire or evict over time.',
      'Structured output is intended for single-turn calls and new sessions, not resumed sessions.',
    ],
    related: [
      { kind: 'tool', name: 'memory' },
      { kind: 'resource', name: 'memory://sessions' },
      { kind: 'resource', name: 'memory://sessions/{sessionId}/events' },
    ],
  },
  {
    name: 'research',
    kind: 'tool',
    title: 'Research',
    bestFor: 'Web-grounded lookup with an explicit quick or deep research mode.',
    whenToUse:
      'Use when the answer depends on current public information and the caller should choose speed versus depth.',
    inputs: [
      'mode',
      'goal',
      'urls?',
      'systemInstruction?',
      'thinkingLevel?',
      'deliverable?',
      'searchDepth?',
    ],
    returns:
      'A grounded summary with sources and, for deep mode, tool-usage details from the multi-step research path.',
    limitations: [
      'Mode is required; this contract does not accept legacy top-level query or topic fields.',
      'Grounding uses Google Search and optional URL Context, not persistent File Search indexes.',
    ],
    related: [
      { kind: 'prompt', name: 'research' },
      { kind: 'resource', name: 'discover://workflows' },
    ],
  },
  {
    name: 'analyze',
    kind: 'tool',
    title: 'Analyze',
    bestFor: 'Focused analysis of one local file, one or more public URLs, or a small file set.',
    whenToUse:
      'Use when you already know the target artifact and want a bounded grounded answer rather than broad research.',
    inputs: ['goal', 'targets', 'thinkingLevel?', 'mediaResolution?'],
    returns:
      'An analysis summary tied to the requested target kind with optional URL retrieval metadata.',
    limitations: [
      'Multi-target analysis is intentionally small and file-oriented to keep prompts bounded.',
      'URL targets require public http/https addresses.',
    ],
    related: [
      { kind: 'tool', name: 'research' },
      { kind: 'resource', name: 'memory://workspace/context' },
    ],
  },
  {
    name: 'review',
    kind: 'tool',
    title: 'Review',
    bestFor: 'Reviewing local diffs, comparing two files, or diagnosing a failing change.',
    whenToUse:
      'Use when the job is evaluative: find bugs, regressions, risky changes, or likely root causes.',
    inputs: ['subject', 'focus?', 'thinkingLevel?', 'cacheName?'],
    returns:
      'A review summary plus diff stats, comparison output, or failure guidance depending on the requested subject.',
    limitations: [
      'The diff mode inspects the local repository only; it does not fetch remote GitHub state.',
      'Failure review can use optional search/URL context, but only from explicit subject fields.',
    ],
    related: [
      { kind: 'prompt', name: 'review' },
      { kind: 'resource', name: 'discover://workflows' },
    ],
  },
  {
    name: 'memory',
    kind: 'tool',
    title: 'Memory',
    bestFor:
      'Inspecting or mutating server-managed sessions, Gemini caches, and workspace memory state.',
    whenToUse:
      'Use when you need to list, inspect, create, update, or delete the state behind chat sessions and reusable caches.',
    inputs: [
      'action',
      'sessionId?',
      'cacheName?',
      'filePaths?',
      'systemInstruction?',
      'ttl?',
      'displayName?',
      'confirm?',
    ],
    returns:
      'A memory operation result with summaries, inline data for the selected action, and related resource URIs.',
    limitations: [
      'Actions are explicit discriminated variants; generic target/input bags are not accepted.',
      'Workspace inspection actions are read-only mirrors of the corresponding memory resources.',
    ],
    related: [
      { kind: 'prompt', name: 'memory' },
      { kind: 'resource', name: 'memory://sessions' },
      { kind: 'resource', name: 'memory://caches' },
    ],
  },
  {
    name: 'discover',
    kind: 'tool',
    title: 'Discover',
    bestFor: 'Orienting a client to the six public jobs, workflows, prompts, and memory resources.',
    whenToUse:
      'Use when you need recommendations, a job-specific starting point, or contract-aware limitations before choosing another tool.',
    inputs: ['job?', 'goal?'],
    returns:
      'Guidance, related workflows, prompts, resources, and limitation notes derived from the shared public contract.',
    limitations: [
      'Discovery is guidance only; it does not execute research, review, or memory mutations directly.',
    ],
    related: [
      { kind: 'prompt', name: 'discover' },
      { kind: 'resource', name: 'discover://catalog' },
      { kind: 'resource', name: 'discover://workflows' },
    ],
  },
  {
    name: 'discover',
    kind: 'prompt',
    title: 'Discover Prompt',
    bestFor: 'Orienting a user to the six public jobs and the most relevant starting point.',
    whenToUse:
      'Use when a client wants a guided explanation of which public job to use before calling tools.',
    inputs: ['job?', 'goal?'],
    returns: 'A single prompt that frames the discover workflow and related public resources.',
    related: [
      { kind: 'tool', name: 'discover' },
      { kind: 'resource', name: 'discover://catalog' },
    ],
  },
  {
    name: 'research',
    kind: 'prompt',
    title: 'Research Prompt',
    bestFor: 'Packaging a research goal into the quick-versus-deep decision flow.',
    whenToUse:
      'Use when the client wants a guided way to explain the research task before calling the research job.',
    inputs: ['goal', 'mode?', 'deliverable?'],
    returns:
      'A workflow-oriented prompt that points to the research job and supporting discovery resources.',
    related: [
      { kind: 'tool', name: 'research' },
      { kind: 'resource', name: 'discover://workflows' },
    ],
  },
  {
    name: 'review',
    kind: 'prompt',
    title: 'Review Prompt',
    bestFor: 'Helping a client frame a diff review, file comparison, or failure triage request.',
    whenToUse: 'Use when the next step is clarifying what kind of review should happen and why.',
    inputs: ['subject?', 'focus?'],
    returns: 'A review-oriented prompt that points to the appropriate review subject variant.',
    related: [
      { kind: 'tool', name: 'review' },
      { kind: 'resource', name: 'discover://workflows' },
    ],
  },
  {
    name: 'memory',
    kind: 'prompt',
    title: 'Memory Prompt',
    bestFor:
      'Explaining when to use chat sessions, reusable caches, or workspace memory inspection.',
    whenToUse:
      'Use when a user needs guidance on whether the right memory primitive is a session, cache, or resource read.',
    inputs: ['action?', 'task?'],
    returns:
      'A memory-oriented prompt that points to the memory job and the related memory resources.',
    related: [
      { kind: 'tool', name: 'memory' },
      { kind: 'resource', name: 'memory://sessions' },
      { kind: 'resource', name: 'memory://caches' },
    ],
  },
  {
    name: 'discover://catalog',
    kind: 'resource',
    title: 'Discovery Catalog Resource',
    bestFor: 'Browsing the full public surface from one shared metadata source.',
    whenToUse:
      'Use when you need a concise machine-readable list of the public tools, prompts, and resources.',
    inputs: [],
    returns: 'JSON and Markdown discovery catalog content.',
    related: [{ kind: 'resource', name: 'discover://workflows' }],
  },
  {
    name: 'discover://workflows',
    kind: 'resource',
    title: 'Workflow Catalog Resource',
    bestFor: 'Browsing job-first starter workflows instead of a raw list of names.',
    whenToUse: 'Use when you want recommended entry points and related resources for common jobs.',
    inputs: [],
    returns: 'JSON and Markdown workflow catalog content.',
    related: [{ kind: 'resource', name: 'discover://catalog' }],
  },
  {
    name: 'memory://sessions',
    kind: 'resource',
    title: 'Session List Resource',
    bestFor: 'Browsing active in-memory chat sessions.',
    whenToUse: 'Use when you need to inspect or resume a server-managed chat session.',
    inputs: [],
    returns: 'JSON list of active session IDs and their last access timestamps.',
    related: [
      { kind: 'tool', name: 'chat' },
      { kind: 'tool', name: 'memory' },
    ],
  },
  {
    name: 'memory://sessions/{sessionId}',
    kind: 'resource',
    title: 'Session Detail Resource',
    bestFor: 'Inspecting a single active session entry.',
    whenToUse: 'Use when you need detail about one session before resuming or auditing it.',
    inputs: ['sessionId'],
    returns: 'JSON metadata for the selected session.',
    related: [
      { kind: 'resource', name: 'memory://sessions' },
      { kind: 'resource', name: 'memory://sessions/{sessionId}/transcript' },
    ],
  },
  {
    name: 'memory://sessions/{sessionId}/transcript',
    kind: 'resource',
    title: 'Session Transcript Resource',
    bestFor: 'Inspecting the text transcript for one active session.',
    whenToUse: 'Use when you need read-only visibility into recent user and assistant turns.',
    inputs: ['sessionId'],
    returns: 'JSON and Markdown transcript entries.',
    related: [{ kind: 'resource', name: 'memory://sessions/{sessionId}' }],
  },
  {
    name: 'memory://sessions/{sessionId}/events',
    kind: 'resource',
    title: 'Session Events Resource',
    bestFor: 'Inspecting normalized Gemini tool and function activity for one active session.',
    whenToUse:
      'Use when you need the server-managed inspection summary rather than the plain transcript.',
    inputs: ['sessionId'],
    returns: 'JSON and Markdown event summaries.',
    related: [{ kind: 'resource', name: 'memory://sessions/{sessionId}' }],
  },
  {
    name: 'memory://caches',
    kind: 'resource',
    title: 'Cache List Resource',
    bestFor: 'Browsing active Gemini caches available to the memory job.',
    whenToUse: 'Use when deciding whether to reuse, update, or delete cached context.',
    inputs: [],
    returns: 'JSON list of active caches and their summary metadata.',
    related: [{ kind: 'tool', name: 'memory' }],
  },
  {
    name: 'memory://caches/{cacheName}',
    kind: 'resource',
    title: 'Cache Detail Resource',
    bestFor: 'Inspecting one Gemini cache in full detail.',
    whenToUse: 'Use when you need the exact metadata for one cache before reuse or mutation.',
    inputs: ['cacheName'],
    returns: 'JSON cache metadata.',
    related: [{ kind: 'resource', name: 'memory://caches' }],
  },
  {
    name: 'memory://workspace/context',
    kind: 'resource',
    title: 'Workspace Context Resource',
    bestFor: 'Viewing the assembled workspace context used for Gemini calls.',
    whenToUse:
      'Use when you want to inspect which local project files are being summarized for the model.',
    inputs: [],
    returns: 'Markdown workspace context with sources and token estimate.',
    related: [{ kind: 'resource', name: 'memory://workspace/cache' }],
  },
  {
    name: 'memory://workspace/cache',
    kind: 'resource',
    title: 'Workspace Cache Resource',
    bestFor: 'Inspecting automatic workspace cache state.',
    whenToUse:
      'Use when you need to verify whether workspace caching is active and what it points at.',
    inputs: [],
    returns: 'JSON workspace cache status.',
    related: [{ kind: 'resource', name: 'memory://workspace/context' }],
  },
] as const satisfies readonly DiscoveryEntry[];

export const WORKFLOW_ENTRIES = [
  {
    name: 'start-here',
    goal: 'Orient a new client to the six public jobs and the recommended next step.',
    whenToUse: 'Use when the user asks what this server does or where to start.',
    steps: [
      'Read discover://catalog for the current public surface.',
      'Read discover://workflows for the guided entry points.',
      'Call discover with or without a preferred job to get a focused recommendation.',
      'Use chat for direct conversation once the starting point is clear.',
    ],
    recommendedTools: ['discover', 'chat'],
    recommendedPrompts: ['discover'],
    relatedResources: ['discover://catalog', 'discover://workflows', 'memory://sessions'],
  },
  {
    name: 'chat',
    goal: 'Start or continue a server-managed chat session with optional reusable memory.',
    whenToUse: 'Use when the task is conversational and may span multiple turns.',
    steps: [
      'Call chat with a goal and optional session.id.',
      'Inspect memory://sessions if you need to find an active session.',
      'Inspect memory://sessions/{sessionId}/transcript or /events when you need read-only inspection.',
      'Use memory cache actions when the same large context should be reused across calls.',
    ],
    recommendedTools: ['chat', 'memory'],
    recommendedPrompts: ['memory'],
    relatedResources: [
      'memory://sessions',
      'memory://sessions/{sessionId}/transcript',
      'memory://sessions/{sessionId}/events',
    ],
  },
  {
    name: 'research',
    goal: 'Choose between a quick grounded lookup and a deeper multi-step research path.',
    whenToUse: 'Use when the answer depends on current public information.',
    steps: [
      'Pick research.mode=quick for one grounded answer.',
      'Pick research.mode=deep when the task needs synthesis across multiple search steps.',
      'Use discover if you need a recommendation before committing to a mode.',
    ],
    recommendedTools: ['research', 'discover'],
    recommendedPrompts: ['research'],
    relatedResources: ['discover://catalog', 'discover://workflows'],
  },
  {
    name: 'analyze',
    goal: 'Analyze one known artifact or a small file set with a focused question.',
    whenToUse: 'Use when the target is known and bounded.',
    steps: [
      'Choose analyze.targets.kind=file for one file.',
      'Choose analyze.targets.kind=url for one or more public URLs.',
      'Choose analyze.targets.kind=multi for a small file set when the answer needs local cross-file context.',
    ],
    recommendedTools: ['analyze'],
    recommendedPrompts: ['discover'],
    relatedResources: ['memory://workspace/context', 'discover://catalog'],
  },
  {
    name: 'review',
    goal: 'Review a diff, compare two files, or diagnose a failing change from one job surface.',
    whenToUse: 'Use when the job is evaluative rather than open-ended exploration.',
    steps: [
      'Choose review.subject.kind=diff for the current local repository changes.',
      'Choose review.subject.kind=comparison for two specific files.',
      'Choose review.subject.kind=failure for stack traces or command failures.',
    ],
    recommendedTools: ['review'],
    recommendedPrompts: ['review'],
    relatedResources: ['discover://workflows', 'memory://sessions'],
  },
  {
    name: 'memory',
    goal: 'Inspect and manage sessions, caches, and workspace memory state from one job.',
    whenToUse:
      'Use when you need to understand or mutate the server-managed memory surface behind chat and cache workflows.',
    steps: [
      'Use session actions to list or inspect active chat sessions.',
      'Use cache actions to list, inspect, create, update, or delete Gemini caches.',
      'Use workspace actions to inspect workspace context and automatic workspace cache state.',
    ],
    recommendedTools: ['memory'],
    recommendedPrompts: ['memory'],
    relatedResources: [
      'memory://sessions',
      'memory://caches',
      'memory://workspace/context',
      'memory://workspace/cache',
    ],
  },
] as const satisfies readonly WorkflowEntry[];
