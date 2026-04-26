import type { Part } from '@google/genai';

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
  mode?: 'AUTO' | 'ANY' | 'NONE' | 'VALIDATED';
  declaredNames?: readonly string[];
  serverSideToolInvocations?: boolean;
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
  const declaredNames = opts.declaredNames?.filter((name) => name.trim().length > 0) ?? [];
  if (opts.mode === undefined || opts.mode === 'NONE' || declaredNames.length === 0) {
    return systemInstruction;
  }

  const names = declaredNames.join(', ');
  const modeInstruction =
    opts.mode === 'ANY'
      ? `You must call one or more of these declared functions when needed to complete the request: ${names}. Parallel calls are allowed.`
      : opts.mode === 'VALIDATED'
        ? `Available functions: ${names}. Function calls are schema-constrained by Gemini; the MCP client must still validate arguments before executing side effects.`
        : `Available functions: ${names}. Call only when the user's request requires it.`;

  return joinNonEmpty([
    systemInstruction,
    modeInstruction,
    opts.serverSideToolInvocations === true
      ? 'The server may execute the call. Do not fabricate function results.'
      : 'After issuing a call, stop and wait for the client to return the function response. Do not invent results.',
  ]);
}

function buildOutputInstruction(title: string, sections: readonly string[]): string {
  return joinNonEmpty([title, ...sections]);
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

  return resolveTextPrompt(
    {
      promptText,
      systemInstruction: joinNonEmpty([
        retrievalUnavailable ? 'No retrieval tools are available this turn.' : undefined,
        "Answer using sources retrieved this turn. If no source supports a claim, mark it '(unverified)'. If retrieval returned nothing, reply with exactly: 'No sources retrieved.' Do not invent URLs.",
      ]),
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
          'Answer the goal from the attached file. Cite sections, lines, or symbols.',
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
          'Answer the goal using content retrieved from the listed URLs. Do not guess content for URLs that did not retrieve. If none retrieved, reply with exactly: "No URLs retrieved; cannot answer."',
      },
      args.cacheName,
    );
  }

  return resolvePartPrompt(
    {
      promptParts: [...(args.attachedParts ?? []), { text: `Goal: ${args.goal}` }],
      systemInstruction:
        'Analyze the attached files. Cite filenames and short excerpts. Do not invent content that is not in the files.',
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
        systemInstruction: buildOutputInstruction(
          'Compare the files. Cite symbols or short quotes. Do not invent line numbers.',
          ['Output:', '## Summary', '## Differences', '## Impact'],
        ),
      },
      args.cacheName,
    );
  }

  const hasDocs = args.docContexts && args.docContexts.length > 0;
  // The trailing documentationDrift JSON block is validated against Zod at runtime.
  const docInstruction = hasDocs
    ? ' Cross-reference the diff against the documentation context. If the diff makes the docs factually incorrect or misleading, emit a `documentationDrift` array inside a JSON block at the end of your response (```json\\n{ "documentationDrift": [...] }\\n```). CRITICAL: If docs are still accurate, omit the `documentationDrift` JSON completely. Do not emit an empty array.'
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
      systemInstruction: buildOutputInstruction(
        `Review the unified diff for bugs, regressions, and behavior risk. Ignore formatting-only changes. Cite file paths and hunk context. Do not invent line numbers. If the diff looks clean, say so briefly.${docInstruction}`,
        ['Output:', 'Findings', 'Fixes'],
      ),
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
      systemInstruction: buildOutputInstruction(
        args.googleSearchEnabled
          ? 'Diagnose the error. Base the cause and fix on the given context. Search the error message and key identifiers; cite retrieved sources.'
          : "Diagnose the error. Base the cause and fix on the given context. No web search is available. Mark anything not derivable from the given context as '(unverified)'.",
        ['Output:', '## Cause', '## Fix', '## Notes'],
      ),
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
      cacheText: `Return exactly one fenced \`\`\`${args.diagramType} block.`,
      promptParts: [...(args.attachedParts ?? []), { text: `Task: ${args.description}` }],
      systemInstruction: joinNonEmpty([
        `Generate a ${args.diagramType} diagram from the description and files.`,
        `Return exactly one fenced \`\`\`${args.diagramType} block with clear node and edge labels.`,
        args.validateSyntax
          ? 'You may run Code Execution once to parse the diagram. Do not narrate the result.'
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
  return resolveTextPrompt(
    {
      promptText: joinNonEmpty([
        args.urls && args.urls.length > 0 ? `Primary URLs:\n${args.urls.join('\n')}` : undefined,
        `Topic: ${args.topic}`,
        'Research the topic and produce a grounded Markdown report.',
      ]),
      systemInstruction: joinNonEmpty([
        args.capabilities.googleSearch
          ? 'Research with Google Search, then write a grounded Markdown report.'
          : 'Write a grounded Markdown report using retrieved evidence from this turn.',
        args.capabilities.multiTurnRetrieval === true
          ? 'You may issue multiple searches when needed.'
          : undefined,
        args.capabilities.codeExecution
          ? 'Use Code Execution only for arithmetic, ranking, or consistency checks.'
          : undefined,
        args.deliverable
          ? `Preferred shape: ${args.deliverable}. If the evidence does not support it, use the best-supported structure and say why.`
          : undefined,
        'Cite source URLs inline for retrieved claims. Treat planning notes as leads, not evidence. Flag unverified claims explicitly. Include dates for time-sensitive facts.',
      ]),
    },
    args.cacheName,
  );
}
