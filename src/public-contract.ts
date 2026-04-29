type PublicJobName = 'chat' | 'research' | 'analyze' | 'review';
export const THINKING_LEVELS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] as const;
export type AskThinkingLevel = (typeof THINKING_LEVELS)[number];

export type PublicPromptName = 'discover' | 'research' | 'review';
export type PublicWorkflowName = 'start-here' | 'chat' | 'research' | 'analyze' | 'review';
type PublicResourceUri =
  | 'discover://catalog'
  | 'discover://context'
  | 'discover://workflows'
  | 'gemini://profiles'
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

export const PUBLIC_STATIC_RESOURCE_URIS = [
  'discover://catalog',
  'discover://context',
  'discover://workflows',
  'gemini://profiles',
  'session://',
  'workspace://context',
  'workspace://cache',
] as const satisfies readonly PublicResourceUri[];

const PUBLIC_RESOURCE_TEMPLATES = [
  'session://{sessionId}',
  'session://{sessionId}/transcript',
  'session://{sessionId}/events',
  'gemini://sessions/{sessionId}/turns/{turnIndex}/parts',
] as const satisfies readonly PublicResourceUri[];

export const PUBLIC_RESOURCE_URIS = [
  ...PUBLIC_STATIC_RESOURCE_URIS,
  ...PUBLIC_RESOURCE_TEMPLATES,
] as const satisfies readonly PublicResourceUri[];

export const PUBLIC_WORKFLOW_NAMES = [
  'start-here',
  'chat',
  'research',
  'analyze',
  'review',
] as const satisfies readonly PublicWorkflowName[];

type DiscoveryEntryMetadata = Omit<DiscoveryEntry, 'kind' | 'name'>;

const TOOL_DISCOVERY_DETAILS = {
  chat: {
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
      'seed?',
      'tools?',
      'functionResponses?',
    ],
    returns:
      'A direct answer, optional structured data, usage/safety/citation metadata, and session resource links. When sessions are active, raw Gemini `Part[]` are persisted for replay-safe orchestration via the session-turn-parts resource (available only when sessions persist `Part[]`).',
    limitations: [
      'Sessions, task state, and task message queues are process-local memory state; restarts or stateless deployments lose continuity.',
      'Sessions require a stateful server connection path. Stateless transport rejects chat calls that include sessionId.',
      'Stateless transport (STATELESS=true) does not advertise the tasks capability — task-aware tools/call requests are unavailable; clients must rely on the synchronous return path.',
      'Input caps: goal max 100000 chars.',
      'Progress notifications truncate streamed text to ~80 characters per update; full text is delivered in the final response only.',
      'Sessions started before raw `Part[]` capture cannot serve `gemini://sessions/.../parts`.',
      'Transcript, events, and raw turn-parts resources require MCP_EXPOSE_SESSION_RESOURCES=true.',
      'Structured output is allowed for single-turn calls and new sessions; resumed sessions reject responseSchemaJson.',
      'Declared functions are executed by the MCP client, not by this server; return results through functionResponses on the same sessionId.',
      'Workspace cache reuse is skipped when a chat call sets systemInstruction or seed; the response may include warnings when cache reuse is skipped.',
    ],
    related: [
      { kind: 'resource', name: 'session://' },
      { kind: 'resource', name: 'session://{sessionId}/events' },
      { kind: 'resource', name: 'gemini://sessions/{sessionId}/turns/{turnIndex}/parts' },
    ],
  },
  research: {
    title: 'Research',
    bestFor: 'Web-grounded lookup with an explicit quick or deep research mode.',
    whenToUse: 'Use for tasks requiring current public information.',
    inputs: [
      'mode?',
      'goal',
      'thinkingLevel?',
      'thinkingBudget?',
      'maxOutputTokens?',
      'safetySettings?',
      'tools?',
      'systemInstruction?',
      'deliverable?',
      'searchDepth?',
    ],
    returns:
      'A summary with grounding status, grounding signals, claim-linked source attributions, Google Search sources, URL Context provenance, warnings, and tool-usage details from the multi-step research path.',
    limitations: [
      'Mode defaults to quick; this contract does not accept legacy top-level query or topic fields.',
      'Input caps: goal max 100000 chars.',
      '`searchDepth` and `deliverable` are rejected when `mode=quick`; `systemInstruction` is rejected when `mode=deep`.',
      'Grounding uses Google Search, optional URL Context, and optional Gemini File Search stores.',
      'Response `status` and `urlMetadata[].status` are forward-compatible open enums; clients must accept unknown string values.',
      'Claim-level findings and citations reflect source attribution from retrieved metadata, not independent verification of truth.',
    ],
    related: [
      { kind: 'prompt', name: 'research' },
      { kind: 'resource', name: 'discover://workflows' },
    ],
  },
  analyze: {
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
      'mediaResolution?',
      'tools?',
    ],
    returns:
      'An analysis summary or diagram tied to the requested target kind with optional URL retrieval metadata.',
    limitations: [
      'Multi-target analysis is intentionally small and file-oriented to keep prompts bounded.',
      'URL targets require public http/https addresses.',
      'Response `status` and `urlMetadata[].status` are forward-compatible open enums; clients must accept unknown string values.',
    ],
    related: [
      { kind: 'tool', name: 'research' },
      { kind: 'resource', name: 'workspace://context' },
    ],
  },
  review: {
    title: 'Review',
    bestFor: 'Reviewing local diffs, comparing two files, or diagnosing a failing change.',
    whenToUse: 'Use for evaluative tasks (bugs, regressions, root causes).',
    inputs: [
      'subjectKind?',
      'dryRun?',
      'language?',
      'filePathA?',
      'filePathB?',
      'question?',
      'error?',
      'codeContext?',
      'focus?',
      'thinkingLevel?',
      'thinkingBudget?',
      'maxOutputTokens?',
      'safetySettings?',
      'tools?',
    ],
    returns:
      'A review summary plus diff stats, comparison output, or failure guidance depending on the selected subjectKind.',
    limitations: [
      'The diff mode inspects the local repository only; it does not fetch remote GitHub state.',
      'Input caps: goal max 100000 chars via focus-bearing review prompts, error max 32000 chars, codeContext max 16000 chars.',
      'Subject-specific fields (`dryRun`, `filePathA`, `filePathB`, `question`, `error`, `codeContext`) are rejected outside the matching `subjectKind` variant.',
      'Search and URL context for failure and comparison review are configured via the `tools` field using a grounded profile (e.g., `web-research`, `urls-only`).',
    ],
    related: [
      { kind: 'prompt', name: 'review' },
      { kind: 'resource', name: 'discover://workflows' },
    ],
  },
} as const satisfies Record<PublicJobName, DiscoveryEntryMetadata>;

const PROMPT_DISCOVERY_DETAILS = {
  discover: {
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
  research: {
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
  review: {
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
} as const satisfies Record<PublicPromptName, DiscoveryEntryMetadata>;

const RESOURCE_DISCOVERY_DETAILS = {
  'discover://catalog': {
    title: 'Discovery Catalog Resource',
    bestFor: 'Browsing the full public surface from one shared metadata source.',
    whenToUse: 'Use for a machine-readable list of public tools, prompts, and resources.',
    inputs: [],
    returns: 'JSON and Markdown discovery catalog content.',
    related: [{ kind: 'resource', name: 'discover://workflows' }],
  },
  'discover://context': {
    title: 'Server Context Dashboard',
    bestFor: 'Inspecting the server knowledge state: workspace files, sessions, and config.',
    whenToUse: 'Use to understand available server context.',
    inputs: [],
    returns: 'JSON snapshot of the server context state.',
    related: [
      { kind: 'resource', name: 'discover://catalog' },
      { kind: 'resource', name: 'workspace://context' },
    ],
  },
  'discover://workflows': {
    title: 'Workflow Catalog Resource',
    bestFor: 'Browsing job-first starter workflows instead of a raw list of names.',
    whenToUse: 'Use to find recommended entry points for common jobs.',
    inputs: [],
    returns: 'JSON and Markdown workflow catalog content.',
    related: [{ kind: 'resource', name: 'discover://catalog' }],
  },
  'gemini://profiles': {
    title: 'Tool Profiles Resource',
    bestFor:
      'Discovering available tool profiles, their built-in capabilities, and valid combinations.',
    whenToUse:
      'Use to understand which profile to pass in the `tools.profile` field for chat, research, analyze, or review.',
    inputs: [],
    returns:
      'JSON catalog of all 11 tool profiles with builtIns, defaultThinkingLevel, notes, and a comboMatrix of valid capability combinations.',
    related: [{ kind: 'resource', name: 'discover://catalog' }],
  },
  'session://': {
    title: 'Session List Resource',
    bestFor: 'Browsing active in-memory chat sessions.',
    whenToUse: 'Use to inspect or resume a chat session.',
    inputs: [],
    returns: 'JSON list of active session summaries (id, lastAccess, and related metadata).',
    related: [{ kind: 'tool', name: 'chat' }],
  },
  'session://{sessionId}': {
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
  'session://{sessionId}/transcript': {
    title: 'Session Transcript Resource',
    bestFor: 'Inspecting the text transcript for one active session.',
    whenToUse: 'Use for read-only visibility into recent turns.',
    inputs: ['sessionId'],
    returns: 'JSON and Markdown transcript entries.',
    limitations: ['Transcript access requires MCP_EXPOSE_SESSION_RESOURCES=true.'],
    related: [{ kind: 'resource', name: 'session://{sessionId}' }],
  },
  'session://{sessionId}/events': {
    title: 'Session Events Resource',
    bestFor: 'Inspecting normalized Gemini tool and function activity for one active session.',
    whenToUse: 'Use to get the server-managed inspection summary.',
    inputs: ['sessionId'],
    returns: 'JSON and Markdown event summaries.',
    limitations: ['Events access requires MCP_EXPOSE_SESSION_RESOURCES=true.'],
    related: [{ kind: 'resource', name: 'session://{sessionId}' }],
  },
  'gemini://sessions/{sessionId}/turns/{turnIndex}/parts': {
    title: 'Session Turn Parts Resource',
    bestFor: 'Retrieving SDK-faithful Gemini `Part[]` for one persisted model turn.',
    whenToUse: 'Use for replay-safe multi-turn orchestration that needs SDK-faithful parts.',
    inputs: ['sessionId', 'turnIndex'],
    returns:
      'JSON array of Gemini `Part` objects for the selected persisted turn. Oversized `inlineData` payloads are elided but all other parts — including `thought` and `thoughtSignature` — are served verbatim.',
    limitations: ['Raw turn-parts access requires MCP_EXPOSE_SESSION_RESOURCES=true.'],
    related: [{ kind: 'resource', name: 'session://{sessionId}' }],
  },
  'workspace://context': {
    title: 'Workspace Context Resource',
    bestFor: 'Viewing the assembled workspace context used for Gemini calls.',
    whenToUse: 'Use to inspect which local files are summarized for the model.',
    inputs: [],
    returns: 'Markdown workspace context with sources and token estimate.',
    related: [{ kind: 'resource', name: 'workspace://cache' }],
  },
  'workspace://cache': {
    title: 'Workspace Cache Resource',
    bestFor: 'Inspecting automatic workspace cache state.',
    whenToUse: 'Use to verify workspace caching status.',
    inputs: [],
    returns: 'JSON workspace cache status.',
    related: [{ kind: 'resource', name: 'workspace://context' }],
  },
} as const satisfies Record<PublicResourceUri, DiscoveryEntryMetadata>;

function buildDiscoveryEntriesForKind<Name extends string>(
  kind: DiscoveryKind,
  names: readonly Name[],
  metadata: Record<Name, DiscoveryEntryMetadata>,
): DiscoveryEntry[] {
  return names.map((name) => ({
    name,
    kind,
    ...metadata[name],
  }));
}

export const DISCOVERY_ENTRIES = [
  ...buildDiscoveryEntriesForKind('tool', PUBLIC_TOOL_NAMES, TOOL_DISCOVERY_DETAILS),
  ...buildDiscoveryEntriesForKind('prompt', PUBLIC_PROMPT_NAMES, PROMPT_DISCOVERY_DETAILS),
  ...buildDiscoveryEntriesForKind('resource', PUBLIC_RESOURCE_URIS, RESOURCE_DISCOVERY_DETAILS),
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
      'When MCP_EXPOSE_SESSION_RESOURCES=true, inspect session://{sessionId}/transcript or /events when you need read-only inspection.',
      'When MCP_EXPOSE_SESSION_RESOURCES=true, use gemini://sessions/{sessionId}/turns/{turnIndex}/parts when an orchestrator needs replay-safe raw turn parts.',
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

export const TOOL_LABELS = {
  chat: 'Chat',
  research: 'Research',
  search: 'Web Search',
  analyzeUrl: 'Analyze URL',
  agenticSearch: 'Agentic Search',
  analyze: 'Analyze',
  analyzeFile: 'Analyze File',
  analyzeDiagram: 'Analyze Diagram',
  review: 'Review Diff',
  compareFiles: 'Compare Files',
  reviewFailure: 'Review Failure',
} as const;
