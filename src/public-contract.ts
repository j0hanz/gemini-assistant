export type PublicJobName = 'chat' | 'research' | 'analyze' | 'review';
export type PublicPromptName = 'discover' | 'research' | 'review';
export type PublicWorkflowName = 'start-here' | 'chat' | 'research' | 'analyze' | 'review';
export type PublicResourceUri =
  | 'discover://catalog'
  | 'discover://context'
  | 'discover://workflows'
  | 'session://'
  | 'session://{sessionId}'
  | 'session://{sessionId}/transcript'
  | 'session://{sessionId}/events'
  | 'gemini://sessions/{sessionId}/turns/{turnIndex}/parts'
  | 'workspace://context'
  | 'workspace://cache';

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

interface JobMetadata {
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
] as const satisfies readonly PublicJobName[];

export const PUBLIC_PROMPT_NAMES = [
  'discover',
  'research',
  'review',
] as const satisfies readonly PublicPromptName[];

export const PUBLIC_RESOURCE_URIS = [
  'discover://catalog',
  'discover://context',
  'discover://workflows',
  'session://',
  'session://{sessionId}',
  'session://{sessionId}/transcript',
  'session://{sessionId}/events',
  'gemini://sessions/{sessionId}/turns/{turnIndex}/parts',
  'workspace://context',
  'workspace://cache',
] as const satisfies readonly PublicResourceUri[];

export const PUBLIC_WORKFLOW_NAMES = [
  'start-here',
  'chat',
  'research',
  'analyze',
  'review',
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
] as const satisfies readonly JobMetadata[];

export const DISCOVERY_ENTRIES = [
  {
    name: 'chat',
    kind: 'tool',
    title: 'Chat',
    bestFor:
      'Direct Gemini chat, structured output, optional Search/URL grounding, and multi-turn server-managed sessions.',
    whenToUse: 'Use for conversational tasks that span multiple turns.',
    inputs: [
      'goal',
      'sessionId?',
      'systemInstruction?',
      'thinkingLevel?',
      'thinkingBudget?',
      'maxOutputTokens?',
      'safetySettings?',
      'responseSchemaJson?',
      'temperature?',
      'seed?',
      'codeExecution?',
      'googleSearch?',
      'urls?',
      'fileSearch?',
      'functions?',
      'functionResponses?',
      'serverSideToolInvocations?',
    ],
    returns:
      'A direct answer, optional structured data, usage/safety/citation metadata, and session resource links. When sessions are active, raw Gemini `Part[]` are persisted for replay-safe orchestration via the session-turn-parts resource.',
    limitations: [
      'Sessions, task state, and task message queues are process-local memory state; restarts or stateless deployments lose continuity.',
      'Sessions require a stateful server connection path; stateless transport mode does not preserve chat continuity across requests.',
      'Structured output is intended for single-turn calls and new sessions, not resumed sessions.',
      'Declared functions are executed by the MCP client, not by this server; return results through functionResponses on the same sessionId.',
    ],
    related: [
      { kind: 'resource', name: 'session://' },
      { kind: 'resource', name: 'session://{sessionId}/events' },
      { kind: 'resource', name: 'gemini://sessions/{sessionId}/turns/{turnIndex}/parts' },
    ],
  },
  {
    name: 'research',
    kind: 'tool',
    title: 'Research',
    bestFor: 'Web-grounded lookup with an explicit quick or deep research mode.',
    whenToUse: 'Use for tasks requiring current public information.',
    inputs: [
      'mode?',
      'goal',
      'urls?',
      'systemInstruction?',
      'deliverable?',
      'searchDepth?',
      'thinkingLevel?',
      'thinkingBudget?',
      'maxOutputTokens?',
      'safetySettings?',
      'fileSearch?',
    ],
    returns:
      'A summary with grounding status, grounding signals, claim-linked findings, Google Search sources, URL Context provenance, warnings, and tool-usage details from the multi-step research path.',
    limitations: [
      'Mode defaults to quick; this contract does not accept legacy top-level query or topic fields.',
      'Grounding uses Google Search, optional URL Context, and optional Gemini File Search stores.',
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
    bestFor:
      'Focused analysis of one local file, one or more public URLs, a small file set, or diagram generation from known artifacts.',
    whenToUse: 'Use for bounded artifact analysis or diagram generation.',
    inputs: [
      'goal',
      'targetKind?',
      'filePath?',
      'urls?',
      'filePaths?',
      'outputKind?',
      'diagramType?',
      'validateSyntax?',
      'thinkingLevel?',
      'thinkingBudget?',
      'maxOutputTokens?',
      'safetySettings?',
      'googleSearch?',
      'mediaResolution?',
    ],
    returns:
      'An analysis summary or diagram tied to the requested target kind with optional URL retrieval metadata.',
    limitations: [
      'Multi-target analysis is intentionally small and file-oriented to keep prompts bounded.',
      'URL targets require public http/https addresses.',
    ],
    related: [
      { kind: 'tool', name: 'research' },
      { kind: 'resource', name: 'workspace://context' },
    ],
  },
  {
    name: 'review',
    kind: 'tool',
    title: 'Review',
    bestFor: 'Reviewing local diffs, comparing two files, or diagnosing a failing change.',
    whenToUse: 'Use for evaluative tasks (bugs, regressions, root causes).',
    inputs: [
      'subjectKind?',
      'dryRun?',
      'language?',
      'focus?',
      'thinkingLevel?',
      'thinkingBudget?',
      'maxOutputTokens?',
      'safetySettings?',
      'filePathA?',
      'filePathB?',
      'question?',
      'googleSearch?',
      'urls?',
      'error?',
      'codeContext?',
    ],
    returns:
      'A review summary plus diff stats, comparison output, or failure guidance depending on the selected subjectKind.',
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
    name: 'discover',
    kind: 'prompt',
    title: 'Discover Prompt',
    bestFor: 'Orienting a user to the public jobs and the most relevant starting point.',
    whenToUse: 'Use to guide a client on which public job to use.',
    inputs: ['job?', 'goal?'],
    returns: 'A single prompt that frames the discover workflow and related public resources.',
    related: [
      { kind: 'resource', name: 'discover://catalog' },
      { kind: 'resource', name: 'discover://workflows' },
    ],
  },
  {
    name: 'research',
    kind: 'prompt',
    title: 'Research Prompt',
    bestFor: 'Packaging a research goal into the quick-versus-deep decision flow.',
    whenToUse: 'Use to guide a client on how to explain a research task.',
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
    whenToUse: 'Use to clarify the type of review needed.',
    inputs: ['subject?', 'focus?'],
    returns: 'A review-oriented prompt that points to the appropriate review subject variant.',
    related: [
      { kind: 'tool', name: 'review' },
      { kind: 'resource', name: 'discover://workflows' },
    ],
  },
  {
    name: 'discover://catalog',
    kind: 'resource',
    title: 'Discovery Catalog Resource',
    bestFor: 'Browsing the full public surface from one shared metadata source.',
    whenToUse: 'Use for a machine-readable list of public tools, prompts, and resources.',
    inputs: [],
    returns: 'JSON and Markdown discovery catalog content.',
    related: [{ kind: 'resource', name: 'discover://workflows' }],
  },
  {
    name: 'discover://workflows',
    kind: 'resource',
    title: 'Workflow Catalog Resource',
    bestFor: 'Browsing job-first starter workflows instead of a raw list of names.',
    whenToUse: 'Use to find recommended entry points for common jobs.',
    inputs: [],
    returns: 'JSON and Markdown workflow catalog content.',
    related: [{ kind: 'resource', name: 'discover://catalog' }],
  },
  {
    name: 'discover://context',
    kind: 'resource',
    title: 'Server Context Dashboard',
    bestFor: 'Inspecting the server knowledge state: workspace files, sessions, and config.',
    whenToUse: 'Use to understand available server context.',
    inputs: [],
    returns: 'JSON and Markdown snapshot of the server context state.',
    related: [
      { kind: 'resource', name: 'discover://catalog' },
      { kind: 'resource', name: 'workspace://context' },
    ],
  },
  {
    name: 'session://',
    kind: 'resource',
    title: 'Session List Resource',
    bestFor: 'Browsing active in-memory chat sessions.',
    whenToUse: 'Use to inspect or resume a chat session.',
    inputs: [],
    returns: 'JSON list of active session IDs and their last access timestamps.',
    related: [{ kind: 'tool', name: 'chat' }],
  },
  {
    name: 'session://{sessionId}',
    kind: 'resource',
    title: 'Session Detail Resource',
    bestFor: 'Inspecting a single active session entry.',
    whenToUse: 'Use to get details for one session.',
    inputs: ['sessionId'],
    returns: 'JSON metadata for the selected session.',
    related: [
      { kind: 'resource', name: 'session://' },
      { kind: 'resource', name: 'session://{sessionId}/transcript' },
    ],
  },
  {
    name: 'session://{sessionId}/transcript',
    kind: 'resource',
    title: 'Session Transcript Resource',
    bestFor: 'Inspecting the text transcript for one active session.',
    whenToUse: 'Use for read-only visibility into recent turns.',
    inputs: ['sessionId'],
    returns: 'JSON and Markdown transcript entries.',
    related: [{ kind: 'resource', name: 'session://{sessionId}' }],
  },
  {
    name: 'session://{sessionId}/events',
    kind: 'resource',
    title: 'Session Events Resource',
    bestFor: 'Inspecting normalized Gemini tool and function activity for one active session.',
    whenToUse: 'Use to get the server-managed inspection summary.',
    inputs: ['sessionId'],
    returns: 'JSON and Markdown event summaries.',
    related: [{ kind: 'resource', name: 'session://{sessionId}' }],
  },
  {
    name: 'gemini://sessions/{sessionId}/turns/{turnIndex}/parts',
    kind: 'resource',
    title: 'Session Turn Parts Resource',
    bestFor: 'Retrieving SDK-faithful Gemini `Part[]` for one persisted model turn.',
    whenToUse: 'Use for replay-safe multi-turn orchestration that needs SDK-faithful parts.',
    inputs: ['sessionId', 'turnIndex'],
    returns:
      'JSON array of Gemini `Part` objects for the selected persisted turn. Oversized `inlineData` payloads are elided but all other parts — including `thought` and `thoughtSignature` — are served verbatim.',
    related: [{ kind: 'resource', name: 'session://{sessionId}' }],
  },
  {
    name: 'workspace://context',
    kind: 'resource',
    title: 'Workspace Context Resource',
    bestFor: 'Viewing the assembled workspace context used for Gemini calls.',
    whenToUse: 'Use to inspect which local files are summarized for the model.',
    inputs: [],
    returns: 'Markdown workspace context with sources and token estimate.',
    related: [{ kind: 'resource', name: 'workspace://cache' }],
  },
  {
    name: 'workspace://cache',
    kind: 'resource',
    title: 'Workspace Cache Resource',
    bestFor: 'Inspecting automatic workspace cache state.',
    whenToUse: 'Use to verify workspace caching status.',
    inputs: [],
    returns: 'JSON workspace cache status.',
    related: [{ kind: 'resource', name: 'workspace://context' }],
  },
] as const satisfies readonly DiscoveryEntry[];

export const WORKFLOW_ENTRIES = [
  {
    name: 'start-here',
    goal: 'Orient a new client to the public jobs and the recommended next step.',
    whenToUse: 'Use when the user asks what this server does.',
    steps: [
      'Read discover://catalog for the current public surface.',
      'Read discover://workflows for the guided entry points.',
      'Treat HTTP deployments as local-first unless the operator supplies durable task/session infrastructure outside this server.',
      'Use chat for direct conversation once the starting point is clear.',
    ],
    recommendedTools: ['chat'],
    recommendedPrompts: ['discover'],
    relatedResources: ['discover://catalog', 'discover://workflows', 'session://'],
  },
  {
    name: 'chat',
    goal: 'Start or continue a server-managed chat session.',
    whenToUse: 'Use when the task is conversational and may span multiple turns.',
    steps: [
      'Call chat with a goal and optional sessionId.',
      'If Gemini returns functionCalls, execute them in the MCP client and call chat again with the same sessionId plus functionResponses.',
      'Inspect session:// if you need to find an active session.',
      'Inspect session://{sessionId}/transcript or /events when you need read-only inspection.',
      'Use gemini://sessions/{sessionId}/turns/{turnIndex}/parts when an orchestrator needs replay-safe raw turn parts.',
    ],
    recommendedTools: ['chat'],
    recommendedPrompts: ['discover'],
    relatedResources: [
      'session://',
      'session://{sessionId}/transcript',
      'session://{sessionId}/events',
      'gemini://sessions/{sessionId}/turns/{turnIndex}/parts',
    ],
  },
  {
    name: 'research',
    goal: 'Choose between a quick grounded lookup and a deeper multi-step research path.',
    whenToUse: 'Use when the answer depends on current public information.',
    steps: [
      'Pick research.mode=quick for one grounded answer.',
      'Pick research.mode=deep when the task needs synthesis across multiple search steps.',
      'Use discover://catalog if you need a recommendation before committing to a mode.',
    ],
    recommendedTools: ['research'],
    recommendedPrompts: ['research'],
    relatedResources: ['discover://catalog', 'discover://workflows'],
  },
  {
    name: 'analyze',
    goal: 'Analyze one known artifact or a small file set with a focused question.',
    whenToUse: 'Use when the target is known and bounded.',
    steps: [
      'Choose targetKind=file for one file.',
      'Choose targetKind=url for one or more public URLs.',
      'Choose targetKind=multi for a small file set when the answer needs local cross-file context.',
      'Choose outputKind=diagram when you want a diagram instead of a summary.',
    ],
    recommendedTools: ['analyze'],
    recommendedPrompts: ['discover'],
    relatedResources: ['workspace://context', 'discover://catalog'],
  },
  {
    name: 'review',
    goal: 'Review a diff, compare two files, or diagnose a failing change from one job surface.',
    whenToUse: 'Use for evaluative tasks instead of open exploration.',
    steps: [
      'Choose subjectKind=diff for the current local repository changes.',
      'Choose subjectKind=comparison for two specific files.',
      'Choose subjectKind=failure for stack traces or command failures.',
    ],
    recommendedTools: ['review'],
    recommendedPrompts: ['review'],
    relatedResources: ['discover://workflows', 'session://'],
  },
] as const satisfies readonly WorkflowEntry[];
