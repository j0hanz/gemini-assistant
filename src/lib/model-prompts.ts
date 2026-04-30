import type { FunctionCallingConfigMode, Part } from '@google/genai';

interface ResolvedTextPrompt {
  promptText: string;
  systemInstruction: string | undefined;
}

interface ResolvedPartPrompt {
  promptParts: Part[];
  systemInstruction: string | undefined;
}

interface TextPromptPolicy {
  cacheText?: string;
  promptText: string;
  systemInstruction: string;
}

interface PartPromptPolicy {
  cacheText?: string;
  promptParts: Part[];
  systemInstruction: string;
}

export interface Capabilities {
  googleSearch: boolean;
  urlContext: boolean;
  codeExecution: boolean;
  fileSearch: boolean;
  multiTurnRetrieval?: boolean;
}

interface FunctionCallingInstructionOptions {
  mode?: FunctionCallingConfigMode | 'AUTO' | 'ANY' | 'NONE' | 'VALIDATED';
  declaredNames?: readonly string[];
  serverSideToolInvocations?: boolean;
}

function escapeInstructionBlock(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

const CITE_CODE = 'Cite as `path:line`.';
const CITE_WEB = 'Cite as [title](url).';
const REPORT_SKELETON =
  '## Summary — 2–4 sentence overview.\n' +
  '## Findings — body using ### sub-sections or tables.\n' +
  '## Sources — cited URLs as a compact reference list.';

export function buildFunctionCallingInstructionText(
  opts: FunctionCallingInstructionOptions,
): string | undefined {
  const declaredNames = opts.declaredNames?.filter((name) => name.trim().length > 0) ?? [];
  const hasDeclaredFunctions = declaredNames.length > 0;
  const hasBuiltInTraces = opts.serverSideToolInvocations === true;

  if (opts.mode === undefined || opts.mode === 'NONE') {
    return hasBuiltInTraces
      ? 'Server-side tool traces may appear. Treat them as runtime events, not evidence.'
      : undefined;
  }

  if (!hasDeclaredFunctions) {
    return hasBuiltInTraces
      ? 'Server-side tool traces may appear. No declared client functions are available this turn.'
      : undefined;
  }

  const names = declaredNames.join(', ');
  const modeInstruction =
    opts.mode === 'ANY'
      ? `Call one or more of these functions as needed: ${names}. Parallel calls allowed.`
      : opts.mode === 'VALIDATED'
        ? `Available declared functions: ${names}. Arguments are schema-constrained; the MCP client validates before executing side effects.`
        : `Available declared functions: ${names}. Call them only when the request requires it.`;

  const executionInstruction = hasBuiltInTraces
    ? 'Server-side tool traces may also appear. Custom functions are executed by the MCP client. Do not fabricate results.'
    : 'After a function call, wait for the client response. Do not invent results.';

  return joinNonEmpty([modeInstruction, executionInstruction]);
}

function resolveTextPrompt(policy: TextPromptPolicy, cacheName?: string): ResolvedTextPrompt {
  const useCacheText = Boolean(cacheName && policy.cacheText);
  return {
    promptText: useCacheText
      ? joinNonEmpty([policy.cacheText, policy.promptText])
      : policy.promptText,
    systemInstruction: policy.systemInstruction,
  };
}

function resolvePartPrompt(policy: PartPromptPolicy, cacheName?: string): ResolvedPartPrompt {
  const useCacheText = Boolean(cacheName && policy.cacheText);

  if (useCacheText && policy.cacheText !== undefined) {
    return {
      promptParts: [{ text: policy.cacheText }, ...policy.promptParts],
      systemInstruction: policy.systemInstruction,
    };
  }

  return {
    promptParts: policy.promptParts,
    systemInstruction: policy.systemInstruction,
  };
}

function joinNonEmpty(sections: readonly (string | undefined)[]): string {
  return sections.filter((section): section is string => Boolean(section?.trim())).join('\n\n');
}

export function appendFunctionCallingInstruction(
  systemInstruction: string | undefined,
  opts: FunctionCallingInstructionOptions,
): string | undefined {
  const instruction = buildFunctionCallingInstructionText(opts);
  if (!instruction) {
    return systemInstruction;
  }

  return joinNonEmpty([systemInstruction, instruction]);
}

export function buildGroundedAnswerPrompt(
  query: string,
  urls?: readonly string[],
  cacheName?: string,
  capabilities?: Capabilities,
): ResolvedTextPrompt {
  const promptText =
    !urls || urls.length === 0 ? query : `${query}\n\nPrimary URLs:\n${urls.join('\n')}`;
  const retrievalUnavailable =
    capabilities !== undefined &&
    !capabilities.googleSearch &&
    !capabilities.urlContext &&
    !capabilities.fileSearch;

  const groundingInstruction = retrievalUnavailable
    ? 'No retrieval tools are available. Answer only from your training knowledge. Explicitly flag any claim that would benefit from live verification as (unverified). Do not invent URLs or citations.'
    : "Answer from sources retrieved this turn. If retrieved sources do not fully answer the question, say so explicitly rather than supplementing with unverified training knowledge. Mark any training-knowledge claims '(unverified)'. If retrieval returned nothing, say so. Do not invent URLs.";

  return resolveTextPrompt(
    {
      promptText,
      systemInstruction: groundingInstruction,
    },
    cacheName,
  );
}

type FileAnalysisPromptArgs =
  | {
      cacheName?: string | undefined;
      goal: string;
      kind: 'single';
    }
  | {
      cacheName?: string | undefined;
      goal: string;
      kind: 'url';
      urls: readonly string[];
    }
  | {
      attachedParts?: readonly Part[];
      cacheName?: string | undefined;
      goal: string;
      kind: 'multi';
    };

type FileAnalysisPromptResult<A extends FileAnalysisPromptArgs> = A extends { kind: 'multi' }
  ? ResolvedPartPrompt
  : ResolvedTextPrompt;

export function buildFileAnalysisPrompt<A extends FileAnalysisPromptArgs>(
  args: A,
): FileAnalysisPromptResult<A>;
export function buildFileAnalysisPrompt(
  args: FileAnalysisPromptArgs,
): ResolvedTextPrompt | ResolvedPartPrompt {
  if (args.kind === 'single') {
    return resolveTextPrompt(
      {
        promptText: args.goal,
        systemInstruction:
          'Answer the goal from the attached file.\n## Answer\n## References — excerpts as `path:line`.\nDo not invent.',
      },
      args.cacheName,
    );
  }

  if (args.kind === 'url') {
    return resolveTextPrompt(
      {
        promptText: joinNonEmpty([
          args.urls.length > 0 ? `URLs:\n${args.urls.join('\n')}` : undefined,
          `Task: ${args.goal}`,
        ]),
        systemInstruction:
          'Answer the goal from content at the listed URLs.\n## Answer\n## References — sources as [title](url); note any that failed to retrieve.\nIf no URLs retrieved, say so. Do not invent.',
      },
      args.cacheName,
    );
  }

  return resolvePartPrompt(
    {
      promptParts: [...(args.attachedParts ?? []), { text: `Goal: ${args.goal}` }],
      systemInstruction:
        'Analyze the attached files.\n## Answer\n## References — excerpts as `filename:line` or short quotes.\nDo not invent.',
    },
    args.cacheName,
  );
}

type DiffReviewPromptArgs =
  | {
      cacheName?: string | undefined;
      focus?: string | undefined;
      mode: 'compare';
      promptParts: readonly Part[];
    }
  | {
      cacheName?: string | undefined;
      mode: 'review';
      promptText: string;
      docContexts?: { filename: string; content: string }[];
    };

type DiffReviewPromptResult<A extends DiffReviewPromptArgs> = A extends { mode: 'compare' }
  ? ResolvedPartPrompt
  : ResolvedTextPrompt;

export function buildDiffReviewPrompt<A extends DiffReviewPromptArgs>(
  args: A,
): DiffReviewPromptResult<A>;
export function buildDiffReviewPrompt(
  args: DiffReviewPromptArgs,
): ResolvedTextPrompt | ResolvedPartPrompt {
  if (args.mode === 'compare') {
    return resolvePartPrompt(
      {
        promptParts: [
          ...args.promptParts,
          { text: args.focus ? `Focus: ${args.focus}` : 'Compare the two files.' },
        ],
        cacheText: 'Compare the files. Output: Summary, Differences, Impact. Cite short quotes.',
        systemInstruction: joinNonEmpty([
          'Compare the files.',
          '## Summary — 2–4 sentence overview of what differs and why it matters.',
          '## Differences — table (| Aspect | File A | File B |) for 2+ attributes; prose otherwise.',
          '## Impact — consequences of the differences.',
          `${CITE_CODE} Do not invent line numbers.`,
        ]),
      },
      args.cacheName,
    );
  }

  const hasDocs = args.docContexts && args.docContexts.length > 0;
  const docInstruction = hasDocs
    ? ' Cross-reference the diff with the documentation context. If the diff makes docs factually incorrect, emit a trailing ```json\n{ "documentationDrift": [...] }\n``` block. Omit it if docs are still accurate. No empty array; no unfenced JSON.'
    : '';

  const docContent = hasDocs
    ? '\n\n<documentation_context>\n' +
      (args.docContexts ?? [])
        .map((doc) => `File: ${doc.filename}\n\`\`\`\n${doc.content}\n\`\`\``)
        .join('\n\n') +
      '\n</documentation_context>'
    : '';

  return resolveTextPrompt(
    {
      cacheText: 'Review the diff for bugs and behavior risk. Ignore formatting-only changes.',
      promptText: args.promptText + docContent,
      systemInstruction: `Review the diff for bugs, regressions, and behavior risk. Ignore formatting-only changes.\nPresent findings as a table:\n| Severity | File | Finding | Fix |\nSeverity: Critical · High · Medium · Low · Info\n${CITE_CODE} Do not invent line numbers.\nIf clean, say so in one sentence — no table.${docInstruction}`,
    },
    args.cacheName,
  );
}

export function buildErrorDiagnosisPrompt(args: {
  cacheName?: string | undefined;
  codeContext?: string | undefined;
  error: string;
  googleSearchEnabled: boolean;
  language?: string | undefined;
  urls?: readonly string[] | undefined;
}): ResolvedTextPrompt {
  const sections: string[] = [`## Error\n\n\`\`\`\n${args.error}\n\`\`\``];

  if (args.codeContext) {
    sections.push(`## Code\n\n\`\`\`${args.language ?? ''}\n${args.codeContext}\n\`\`\``);
  }

  if (args.language) {
    sections.push(`## Language\n\n${args.language}`);
  }

  if (args.urls && args.urls.length > 0) {
    sections.push(`## URLs\n\n${args.urls.join('\n')}`);
  }

  sections.push('## Task\n\nDiagnose the error and propose the most likely fix.');

  return resolveTextPrompt(
    {
      cacheText: 'Diagnose the error. Output: Cause, Fix, Notes.',
      promptText: sections.join('\n\n'),
      systemInstruction: joinNonEmpty([
        'Diagnose the error from the given context.',
        `## Cause — most likely root cause. ${CITE_CODE}`,
        '## Fix — remediation steps. Number them if more than one.',
        '## Notes — edge cases or follow-ups. Omit if empty.',
        args.googleSearchEnabled
          ? `Search the error and key identifiers. ${CITE_WEB}`
          : "Mark claims not derivable from context as '(unverified)'.",
      ]),
    },
    args.cacheName,
  );
}

export function buildDiagramGenerationPrompt(args: {
  attachedParts?: readonly Part[];
  cacheName?: string | undefined;
  description: string;
  diagramType: string;
  validateSyntax?: boolean | undefined;
}): ResolvedPartPrompt {
  return resolvePartPrompt(
    {
      cacheText: `Return one fenced \`\`\`${args.diagramType} block.`,
      promptParts: [...(args.attachedParts ?? []), { text: `Task: ${args.description}` }],
      systemInstruction: joinNonEmpty([
        `Generate a ${args.diagramType} diagram from the description and files.`,
        `Return one fenced \`\`\`${args.diagramType} block with clear node and edge labels.`,
        'No prose.',
        args.validateSyntax
          ? 'Run Code Execution once to validate syntax. Do not narrate the result.'
          : undefined,
      ]),
    },
    args.cacheName,
  );
}

export function buildAgenticResearchPrompt(args: {
  topic: string;
  capabilities: Capabilities;
  deliverable?: string | undefined;
  urls?: readonly string[] | undefined;
  cacheName?: string | undefined;
}): ResolvedTextPrompt {
  const sanitizedTopic = escapeInstructionBlock(args.topic);

  return resolveTextPrompt(
    {
      promptText: joinNonEmpty([
        args.urls && args.urls.length > 0 ? `Primary URLs:\n${args.urls.join('\n')}` : undefined,
        `<research_topic>${sanitizedTopic}</research_topic>`,
        'Research the topic and produce a grounded report.',
      ]),
      systemInstruction: joinNonEmpty([
        args.capabilities.googleSearch
          ? `Research with Google Search, then write a grounded report:\n${REPORT_SKELETON}`
          : `Write a grounded report from provided context only. Do not retrieve or fabricate external sources:\n${REPORT_SKELETON}`,
        args.capabilities.multiTurnRetrieval === true
          ? 'Issue multiple searches as needed.'
          : undefined,
        args.capabilities.codeExecution
          ? 'Use Code Execution only for arithmetic, ranking, or consistency checks.'
          : undefined,
        args.deliverable
          ? `Preferred shape: ${args.deliverable}. If evidence does not support it, use the best-supported structure and say why.`
          : undefined,
        `${CITE_WEB} Flag unverified claims. Include dates for time-sensitive facts.`,
      ]),
    },
    args.cacheName,
  );
}
