type DiscoveryKind = 'tool' | 'prompt' | 'resource';

interface RelatedItemRef {
  kind: DiscoveryKind;
  name: string;
}

interface DiscoveryEntry {
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

interface WorkflowEntry {
  name: string;
  goal: string;
  whenToUse: string;
  steps: string[];
  recommendedTools: string[];
  recommendedPrompts: string[];
  relatedResources: string[];
}

const DISCOVERY_KIND_ORDER: Record<DiscoveryKind, number> = {
  tool: 0,
  prompt: 1,
  resource: 2,
};

const DISCOVERY_ENTRIES = [
  {
    name: 'agentic_search',
    kind: 'tool',
    title: 'Deep Research',
    bestFor: 'Multi-step research that needs web grounding and synthesized findings.',
    whenToUse: 'Use when a topic needs search, follow-up exploration, and cited synthesis.',
    inputs: ['topic', 'searchDepth?', 'thinkingLevel?'],
    returns: 'A structured research answer with sources and progress-aware task execution.',
    limitations: [
      'Grounds itself with Google Search and Gemini code execution only; it does not use File Search.',
      'Returns normalized tool metadata in structuredContent, not a replay-ready raw Gemini history.',
    ],
    related: [
      { kind: 'tool', name: 'search' },
      { kind: 'prompt', name: 'deep-research' },
      { kind: 'resource', name: 'workflows://list' },
    ],
  },
  {
    name: 'analyze_file',
    kind: 'tool',
    title: 'Analyze Local File',
    bestFor:
      'Inspecting a local file from approved workspace roots with a workspace-relative or absolute path.',
    whenToUse: 'Use when you need Gemini to reason about code, text, or media in one file.',
    inputs: ['filePath', 'question', 'thinkingLevel?', 'mediaResolution?'],
    returns: 'An answer grounded in the uploaded file content.',
    related: [
      { kind: 'prompt', name: 'analyze-file' },
      { kind: 'resource', name: 'tools://list' },
    ],
  },
  {
    name: 'analyze_pr',
    kind: 'tool',
    title: 'Review Local Diff',
    bestFor: 'Reviewing the current repository diff without remote GitHub access.',
    whenToUse: 'Use when you want a structured review of local changes or staged work.',
    inputs: ['dryRun?', 'cacheName?', 'thinkingLevel?', 'language?'],
    returns: 'A review summary with findings, omitted paths, and diff-aware context.',
    related: [
      { kind: 'prompt', name: 'diff-review' },
      { kind: 'tool', name: 'compare_files' },
      { kind: 'resource', name: 'workflows://list' },
    ],
  },
  {
    name: 'analyze_url',
    kind: 'tool',
    title: 'Analyze Public URL',
    bestFor: 'Reading public web pages directly through Gemini.',
    whenToUse: 'Use when a small set of specific URLs is more important than broad web search.',
    inputs: ['urls', 'question', 'systemInstruction?', 'thinkingLevel?'],
    returns: 'A URL-grounded answer plus per-URL retrieval status when available.',
    limitations: [
      'Only public http/https URLs are supported.',
      'Uses Gemini URL Context, not File Search or persistent document indexing.',
    ],
    related: [
      { kind: 'tool', name: 'search' },
      { kind: 'prompt', name: 'deep-research' },
    ],
  },
  {
    name: 'ask',
    kind: 'tool',
    title: 'Chat With Gemini',
    bestFor: 'General-purpose Gemini chat, including multi-turn sessions and structured output.',
    whenToUse: 'Use when you need a direct answer, a running session, or JSON output from Gemini.',
    inputs: [
      'message',
      'sessionId?',
      'systemInstruction?',
      'thinkingLevel?',
      'cacheName?',
      'responseSchema?',
      'temperature?',
      'seed?',
      'googleSearch?',
      'toolProfile?',
      'urls?',
    ],
    returns:
      'Answer text, optional structured data, usage metadata, and a session resource link for new chats.',
    limitations: [
      'responseSchema is supported for single-turn calls and new sessions only, not existing sessions.',
      'sessions://{sessionId}/events exposes a normalized inspection summary, not raw replay-ready Gemini history.',
      'Session and tool state are stored in memory only.',
    ],
    related: [
      { kind: 'resource', name: 'sessions://list' },
      { kind: 'resource', name: 'sessions://{sessionId}/events' },
      { kind: 'resource', name: 'sessions://{sessionId}/transcript' },
      { kind: 'prompt', name: 'getting-started' },
    ],
  },
  {
    name: 'compare_files',
    kind: 'tool',
    title: 'Compare Two Files',
    bestFor: 'Side-by-side analysis of two local files.',
    whenToUse: 'Use when you need a structured comparison instead of a repo-wide diff review.',
    inputs: [
      'filePathA',
      'filePathB',
      'question?',
      'thinkingLevel?',
      'googleSearch?',
      'cacheName?',
    ],
    returns: 'A structured explanation of differences, similarities, and notable changes.',
    related: [
      { kind: 'tool', name: 'analyze_pr' },
      { kind: 'prompt', name: 'diff-review' },
    ],
  },
  {
    name: 'create_cache',
    kind: 'tool',
    title: 'Create Cache',
    bestFor: 'Saving large reference context for repeated Gemini calls.',
    whenToUse:
      'Use when a project brief, code snapshot, or long document should be reused across asks.',
    inputs: ['filePaths?', 'systemInstruction?', 'ttl?', 'displayName?'],
    returns: 'Cache metadata including the active cache name and expiry details.',
    related: [
      { kind: 'tool', name: 'update_cache' },
      { kind: 'tool', name: 'delete_cache' },
      { kind: 'prompt', name: 'project-memory' },
      { kind: 'resource', name: 'caches://list' },
    ],
  },
  {
    name: 'delete_cache',
    kind: 'tool',
    title: 'Delete Cache',
    bestFor: 'Removing stale cached context.',
    whenToUse: 'Use when a cached project snapshot is outdated or no longer needed.',
    inputs: ['cacheName', 'confirm?'],
    returns: 'Deletion status for the selected cache.',
    related: [
      { kind: 'tool', name: 'list_caches' },
      { kind: 'tool', name: 'update_cache' },
      { kind: 'resource', name: 'caches://{cacheName}' },
    ],
  },
  {
    name: 'execute_code',
    kind: 'tool',
    title: 'Execute Generated Code',
    bestFor: 'Running Gemini-generated code in a sandbox and inspecting the output.',
    whenToUse:
      'Use when a task needs computation, parsing, or quick code-assisted experimentation.',
    inputs: ['task', 'language?', 'thinkingLevel?'],
    returns: 'Generated code, execution output, and a structured summary of the run.',
    limitations: [
      'Gemini code execution runs in Python.',
      'language is an advisory prompt hint, not a runtime switch.',
    ],
    related: [
      { kind: 'tool', name: 'agentic_search' },
      { kind: 'resource', name: 'tools://list' },
    ],
  },
  {
    name: 'explain_error',
    kind: 'tool',
    title: 'Explain Error',
    bestFor: 'Diagnosing stack traces and error output.',
    whenToUse: 'Use when you already have an error message and want root cause plus fix guidance.',
    inputs: [
      'error',
      'codeContext?',
      'language?',
      'thinkingLevel?',
      'googleSearch?',
      'urls?',
      'cacheName?',
    ],
    returns: 'An explanation of root cause, fixes, and prevention steps.',
    related: [
      { kind: 'prompt', name: 'explain-error' },
      { kind: 'prompt', name: 'diff-review' },
    ],
  },
  {
    name: 'generate_diagram',
    kind: 'tool',
    title: 'Generate Diagram',
    bestFor: 'Turning descriptions or code into Mermaid or PlantUML diagrams.',
    whenToUse: 'Use when a workflow, architecture, or process is easier to understand visually.',
    inputs: [
      'description',
      'diagramType?',
      'sourceFilePath?',
      'sourceFilePaths?',
      'thinkingLevel?',
      'googleSearch?',
      'cacheName?',
      'validateSyntax?',
    ],
    returns: 'Diagram text plus structured metadata about the generated output.',
    related: [
      { kind: 'tool', name: 'analyze_file' },
      { kind: 'resource', name: 'tools://list' },
    ],
  },
  {
    name: 'list_caches',
    kind: 'tool',
    title: 'List Caches',
    bestFor: 'Inspecting active Gemini caches and their expiry state.',
    whenToUse: 'Use when deciding whether to reuse, update, or delete cached context.',
    inputs: [],
    returns: 'A list of active caches and their basic metadata.',
    related: [
      { kind: 'tool', name: 'create_cache' },
      { kind: 'tool', name: 'update_cache' },
      { kind: 'resource', name: 'caches://list' },
    ],
  },
  {
    name: 'search',
    kind: 'tool',
    title: 'Web-Grounded Search',
    bestFor: 'Quick answers that need up-to-date web grounding.',
    whenToUse:
      'Use when a single grounded answer is enough and you do not need a full research workflow.',
    inputs: ['query', 'systemInstruction?', 'urls?', 'thinkingLevel?'],
    returns: 'A concise grounded answer with sources and optional source details.',
    limitations: [
      'Search grounding is limited to Google Search and optional URL Context over public URLs.',
      'This does not provide persistent File Search indexing or citations from uploaded corpora.',
    ],
    related: [
      { kind: 'tool', name: 'agentic_search' },
      { kind: 'prompt', name: 'deep-research' },
    ],
  },
  {
    name: 'update_cache',
    kind: 'tool',
    title: 'Update Cache',
    bestFor: 'Refreshing cached context without changing the calling pattern.',
    whenToUse: 'Use when a stored project brief or reference set needs new contents or TTL.',
    inputs: ['cacheName', 'ttl'],
    returns: 'Updated cache metadata with the new expiry state.',
    related: [
      { kind: 'tool', name: 'create_cache' },
      { kind: 'tool', name: 'list_caches' },
      { kind: 'prompt', name: 'project-memory' },
    ],
  },
  {
    name: 'analyze-file',
    kind: 'prompt',
    title: 'Analyze File Prompt',
    bestFor:
      'Packaging a workspace-relative or absolute file path and question into a ready-to-run prompt.',
    whenToUse:
      'Use when a client wants a guided starting point before calling file analysis tools.',
    inputs: ['filePath', 'question'],
    returns: 'A single user prompt that frames a focused file analysis request.',
    related: [
      { kind: 'tool', name: 'analyze_file' },
      { kind: 'resource', name: 'workflows://list' },
    ],
  },
  {
    name: 'code-review',
    kind: 'prompt',
    title: 'Code Review Prompt',
    bestFor: 'Prompting a structured review of a code snippet.',
    whenToUse: 'Use when you already have code text and want a review-focused prompt message.',
    inputs: ['code', 'language?'],
    returns: 'A review prompt that asks for bugs, best practices, and improvements.',
    related: [
      { kind: 'tool', name: 'ask' },
      { kind: 'tool', name: 'analyze_pr' },
    ],
  },
  {
    name: 'deep-research',
    kind: 'prompt',
    title: 'Deep Research Workflow',
    bestFor: 'Guiding a research job through the recommended search workflow.',
    whenToUse: 'Use when you want the client to explain the research path before running tools.',
    inputs: ['topic', 'deliverable?'],
    returns: 'A workflow-oriented prompt that points to research tools, prompts, and resources.',
    related: [
      { kind: 'tool', name: 'agentic_search' },
      { kind: 'tool', name: 'search' },
      { kind: 'resource', name: 'workflows://list' },
    ],
  },
  {
    name: 'diff-review',
    kind: 'prompt',
    title: 'Diff Review Workflow',
    bestFor: 'Guiding a local change review flow.',
    whenToUse:
      'Use when the next step is reviewing a local diff, comparing files, or diagnosing a failing change.',
    inputs: ['focus?'],
    returns: 'A workflow prompt that points to local review and error-analysis tools.',
    related: [
      { kind: 'tool', name: 'analyze_pr' },
      { kind: 'tool', name: 'compare_files' },
      { kind: 'resource', name: 'workflows://list' },
    ],
  },
  {
    name: 'explain-error',
    kind: 'prompt',
    title: 'Explain Error Prompt',
    bestFor: 'Packaging an error plus optional context into a diagnostic prompt.',
    whenToUse: 'Use when a client wants a guided diagnosis request before calling the tool.',
    inputs: ['error', 'context?'],
    returns: 'A single prompt message that asks for root cause, fixes, and prevention.',
    related: [
      { kind: 'tool', name: 'explain_error' },
      { kind: 'prompt', name: 'diff-review' },
    ],
  },
  {
    name: 'getting-started',
    kind: 'prompt',
    title: 'Getting Started Workflow',
    bestFor: 'Showing a first-time user what to try first.',
    whenToUse: 'Use when a new MCP client user asks what gemini-assistant is good at.',
    inputs: [],
    returns: 'A workflow prompt that points to the recommended onboarding path.',
    related: [
      { kind: 'tool', name: 'ask' },
      { kind: 'resource', name: 'tools://list' },
      { kind: 'resource', name: 'workflows://list' },
    ],
  },
  {
    name: 'project-memory',
    kind: 'prompt',
    title: 'Project Memory Workflow',
    bestFor: 'Explaining when to use sessions versus caches.',
    whenToUse: 'Use when a user is iterating on a project and wants consistent reusable context.',
    inputs: ['project?', 'currentTask?'],
    returns:
      'A workflow prompt that explains how sessions, caches, and transcript resources fit together.',
    related: [
      { kind: 'tool', name: 'create_cache' },
      { kind: 'tool', name: 'ask' },
      { kind: 'resource', name: 'sessions://{sessionId}/transcript' },
    ],
  },
  {
    name: 'summarize',
    kind: 'prompt',
    title: 'Summarize Text Prompt',
    bestFor: 'Condensing text into a chosen summary style.',
    whenToUse: 'Use when you want a reusable summary prompt instead of a full workflow prompt.',
    inputs: ['text', 'style?'],
    returns: 'A summary prompt with style-specific constraints.',
    related: [
      { kind: 'tool', name: 'ask' },
      { kind: 'prompt', name: 'deep-research' },
    ],
  },
  {
    name: 'caches://{cacheName}',
    kind: 'resource',
    title: 'Cache Detail Resource',
    bestFor: 'Inspecting one cache in full detail.',
    whenToUse: 'Use when a specific cache needs to be checked before reuse, update, or deletion.',
    inputs: ['cacheName'],
    returns: 'JSON metadata for one active Gemini cache.',
    related: [
      { kind: 'resource', name: 'caches://list' },
      { kind: 'tool', name: 'update_cache' },
      { kind: 'tool', name: 'delete_cache' },
    ],
  },
  {
    name: 'caches://list',
    kind: 'resource',
    title: 'Cache List Resource',
    bestFor: 'Browsing active Gemini caches.',
    whenToUse: 'Use when you need to see which caches exist and when they expire.',
    inputs: [],
    returns: 'JSON list of active Gemini caches and their summary metadata.',
    related: [
      { kind: 'tool', name: 'list_caches' },
      { kind: 'resource', name: 'caches://{cacheName}' },
      { kind: 'prompt', name: 'project-memory' },
    ],
  },
  {
    name: 'sessions://{sessionId}',
    kind: 'resource',
    title: 'Session Detail Resource',
    bestFor: 'Inspecting one active chat session.',
    whenToUse: 'Use when you need the session ID and last access metadata for a specific chat.',
    inputs: ['sessionId'],
    returns: 'JSON metadata for one active chat session.',
    related: [
      { kind: 'resource', name: 'sessions://list' },
      { kind: 'resource', name: 'sessions://{sessionId}/transcript' },
      { kind: 'tool', name: 'ask' },
    ],
  },
  {
    name: 'sessions://{sessionId}/transcript',
    kind: 'resource',
    title: 'Session Transcript Resource',
    bestFor: 'Inspecting the in-memory transcript for one active session.',
    whenToUse: 'Use when you want to see recent user and assistant turns for a live session.',
    inputs: ['sessionId'],
    returns: 'JSON transcript entries with role, text, timestamp, and optional taskId.',
    related: [
      { kind: 'resource', name: 'sessions://{sessionId}' },
      { kind: 'resource', name: 'sessions://list' },
      { kind: 'prompt', name: 'project-memory' },
    ],
  },
  {
    name: 'sessions://{sessionId}/events',
    kind: 'resource',
    title: 'Session Events Resource',
    bestFor: 'Inspecting tool/function activity for one active chat session.',
    whenToUse:
      'Use when you want to inspect Gemini tool usage, function calls, and related event metadata for a live session.',
    inputs: ['sessionId'],
    returns:
      'JSON event entries containing request metadata and normalized Gemini tool/function events.',
    related: [
      { kind: 'resource', name: 'sessions://{sessionId}' },
      { kind: 'resource', name: 'sessions://{sessionId}/transcript' },
      { kind: 'tool', name: 'ask' },
    ],
  },
  {
    name: 'sessions://list',
    kind: 'resource',
    title: 'Session List Resource',
    bestFor: 'Browsing active multi-turn chat sessions.',
    whenToUse:
      'Use when you want to see available chat sessions before resuming or inspecting one.',
    inputs: [],
    returns: 'JSON list of active session IDs and their last access timestamps.',
    related: [
      { kind: 'tool', name: 'ask' },
      { kind: 'resource', name: 'sessions://{sessionId}' },
      { kind: 'resource', name: 'sessions://{sessionId}/transcript' },
    ],
  },
  {
    name: 'tools://list',
    kind: 'resource',
    title: 'Discovery Catalog Resource',
    bestFor: 'Browsing the server surface in one concise machine-readable list.',
    whenToUse: 'Use when you want an overview of available tools, prompts, and resources.',
    inputs: [],
    returns: 'JSON catalog of public tools, prompts, and resources.',
    related: [
      { kind: 'resource', name: 'workflows://list' },
      { kind: 'prompt', name: 'getting-started' },
    ],
  },
  {
    name: 'workflows://list',
    kind: 'resource',
    title: 'Workflow Catalog Resource',
    bestFor: 'Browsing guided starter workflows.',
    whenToUse: 'Use when you want opinionated entry points instead of a raw capability list.',
    inputs: [],
    returns:
      'JSON list of supported workflows and their recommended tools, prompts, and resources.',
    related: [
      { kind: 'resource', name: 'tools://list' },
      { kind: 'prompt', name: 'getting-started' },
    ],
  },
  {
    name: 'workspace://context',
    kind: 'resource',
    title: 'Workspace Context',
    bestFor: 'Viewing assembled workspace context for Gemini API calls.',
    whenToUse: 'Read to inspect which project files and context are being sent to Gemini.',
    inputs: [],
    returns: 'Markdown content, sources list, estimated token count.',
    related: [{ kind: 'resource', name: 'workspace://cache' }],
  },
  {
    name: 'workspace://cache',
    kind: 'resource',
    title: 'Workspace Cache Status',
    bestFor: 'Checking the status of the workspace context cache.',
    whenToUse: 'Read to check if a Gemini context cache is active, its TTL, and content hash.',
    inputs: [],
    returns: 'Cache status: enabled, cacheName, contentHash, estimatedTokens, sources, ttl.',
    related: [{ kind: 'resource', name: 'workspace://context' }],
  },
] as const satisfies readonly DiscoveryEntry[];

const WORKFLOWS = [
  {
    name: 'getting-started',
    goal: 'Show a first-time MCP user what this server is best at and what to try first.',
    whenToUse: 'Use when the user just installed the server or asks for a quick orientation.',
    steps: [
      'Read tools://list for the full discovery catalog.',
      'Review workflows://list and start with the highest-fit workflow.',
      'Use ask for a quick capability tour or a first direct question.',
      'Check each tool entry for limitations before relying on advanced tool profiles or structured output.',
      'Inspect sessions://list if a multi-turn chat is created.',
    ],
    recommendedTools: ['ask', 'search', 'analyze_file'],
    recommendedPrompts: ['getting-started', 'deep-research', 'project-memory'],
    relatedResources: ['tools://list', 'workflows://list', 'sessions://list'],
  },
  {
    name: 'project-memory',
    goal: 'Explain when to keep context in a live session versus a reusable cache.',
    whenToUse:
      'Use when work spans multiple turns, long project briefs, or repeated Gemini calls over the same context.',
    steps: [
      'Create or inspect caches when the same large context should be reused.',
      'Use ask with a sessionId for the active conversation thread.',
      'Inspect sessions://{sessionId}/transcript when you need to verify live session history.',
      'Inspect sessions://{sessionId}/events when you need the normalized Gemini tool/function activity summary for the session.',
      'Use ask.responseSchema only for single-turn calls or a brand-new session.',
      'Use caches://list to manage reusable project context over time.',
    ],
    recommendedTools: ['create_cache', 'list_caches', 'update_cache', 'ask'],
    recommendedPrompts: ['project-memory', 'getting-started'],
    relatedResources: [
      'caches://list',
      'sessions://list',
      'sessions://{sessionId}/transcript',
      'sessions://{sessionId}/events',
    ],
  },
  {
    name: 'deep-research',
    goal: 'Run a grounded research flow with clear expectations around sources and follow-up.',
    whenToUse:
      'Use when a question needs current web information, synthesis, and traceable sources.',
    steps: [
      'Start with agentic_search for the main research pass.',
      'Use search for narrower follow-up questions or quick verification.',
      'Use summarize to condense long findings into a requested format.',
      'Review tools://list if the user wants adjacent capabilities such as URL or file analysis, keeping in mind that File Search and Live API are not part of this server.',
    ],
    recommendedTools: ['agentic_search', 'search', 'analyze_url'],
    recommendedPrompts: ['deep-research', 'summarize'],
    relatedResources: ['tools://list', 'workflows://list'],
  },
  {
    name: 'diff-review',
    goal: 'Review a local change set and follow up on specific failing files or errors.',
    whenToUse:
      'Use when the job is understanding a local diff, comparing revisions, or triaging failures.',
    steps: [
      'Run analyze_pr for the repo-wide change review.',
      'Use compare_files for focused side-by-side comparison when needed.',
      'Use explain_error if the change introduced a failing stack trace or command error.',
      'Use sessions://list if the review is being continued across multiple ask turns.',
    ],
    recommendedTools: ['analyze_pr', 'compare_files', 'explain_error'],
    recommendedPrompts: ['diff-review', 'code-review', 'explain-error'],
    relatedResources: ['workflows://list', 'sessions://list'],
  },
  {
    name: 'analyze-file',
    goal: 'Inspect one local file with a focused question.',
    whenToUse:
      'Use when the user already knows which file matters and wants a grounded answer about it.',
    steps: [
      'Use the analyze-file prompt to package the file path and question.',
      'Run analyze_file against a workspace-relative or absolute path inside allowed roots.',
      'Escalate to ask or generate_diagram if the answer needs broader synthesis or visualization.',
    ],
    recommendedTools: ['analyze_file', 'ask', 'generate_diagram'],
    recommendedPrompts: ['analyze-file'],
    relatedResources: ['tools://list', 'workflows://list'],
  },
] as const satisfies readonly WorkflowEntry[];

function compareDiscoveryEntries(left: DiscoveryEntry, right: DiscoveryEntry): number {
  const kindOrder = DISCOVERY_KIND_ORDER[left.kind] - DISCOVERY_KIND_ORDER[right.kind];
  if (kindOrder !== 0) return kindOrder;
  return left.name.localeCompare(right.name);
}

export function listDiscoveryEntries(): DiscoveryEntry[] {
  return [...DISCOVERY_ENTRIES].sort(compareDiscoveryEntries);
}

export function listWorkflowEntries(): WorkflowEntry[] {
  return WORKFLOWS.map((workflow) => ({
    ...workflow,
    steps: [...workflow.steps],
    recommendedTools: [...workflow.recommendedTools],
    recommendedPrompts: [...workflow.recommendedPrompts],
    relatedResources: [...workflow.relatedResources],
  }));
}

export function findDiscoveryEntry(kind: DiscoveryKind, name: string): DiscoveryEntry | undefined {
  return DISCOVERY_ENTRIES.find((entry) => entry.kind === kind && entry.name === name);
}

export function findWorkflowEntry(name: string): WorkflowEntry | undefined {
  return WORKFLOWS.find((workflow) => workflow.name === name);
}
