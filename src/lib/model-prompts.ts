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

function resolveTextPrompt(policy: TextPromptPolicy, cacheName?: string): ResolvedTextPrompt {
  const useCacheText = Boolean(cacheName && policy.cacheText);
  return {
    promptText: useCacheText
      ? joinNonEmpty([policy.cacheText, policy.promptText])
      : policy.promptText,
    systemInstruction: useCacheText ? undefined : policy.systemInstruction,
  };
}

function resolvePartPrompt(policy: PartPromptPolicy, cacheName?: string): ResolvedPartPrompt {
  const useCacheText = Boolean(cacheName && policy.cacheText);

  if (useCacheText && policy.cacheText !== undefined) {
    return {
      promptParts: [{ text: policy.cacheText }, ...policy.promptParts],
      systemInstruction: undefined,
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
  functionsActive: boolean,
): string | undefined {
  if (!functionsActive) return systemInstruction;
  return joinNonEmpty([
    systemInstruction,
    'When you call a declared function, wait for the MCP client to provide the function response. Do not invent function results.',
  ]);
}

function buildOutputInstruction(title: string, sections: readonly string[]): string {
  return joinNonEmpty([title, ...sections]);
}

export function buildGroundedAnswerPrompt(
  query: string,
  urls?: readonly string[],
  cacheName?: string,
): ResolvedTextPrompt {
  const promptText =
    !urls || urls.length === 0 ? query : `${query}\n\nPrimary URLs:\n${urls.join('\n')}`;

  return resolveTextPrompt(
    {
      promptText,
      systemInstruction:
        'Answer using retrieved sources from this turn. Prefer referencing sources by their URL when directly supported by retrieved content. If no sources were retrieved, say so and label the answer as unverified. Output order: 1) ## Findings - one bullet per claim formatted `- claim - [URL1, URL2]`; 2) ## Synthesis - prose derived only from Findings; 3) ## Open Questions - unverified leads.',
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
          'Answer the goal using content retrieved from the listed URLs. Cite the URL each claim comes from. If a URL fails to retrieve, list it under "Unretrieved" and do not guess its contents. If no URL retrieved successfully, respond with exactly: "No URLs retrieved; cannot answer."',
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
        ['Output:', '## Findings', '## Fixes'],
      ),
    },
    args.cacheName,
  );
}

export function buildErrorDiagnosisPrompt(args: {
  cacheName?: string | undefined;
  codeContext?: string | undefined;
  error: string;
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
        'Diagnose the error. Base the cause and fix on the given context; if search is available, search the error message and key identifiers. Cite sources for retrieved claims; otherwise mark the answer as unverified.',
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
          ? 'If syntax validation is requested, run Code Execution as a best-effort check and state uncertainty.'
          : undefined,
      ]),
    },
    args.cacheName,
  );
}

export function buildAgenticResearchPrompt(args: {
  searchDepth: number;
  topic: string;
  deliverable?: string | undefined;
  urls?: readonly string[] | undefined;
  cacheName?: string | undefined;
}): ResolvedTextPrompt {
  const deepMode = args.searchDepth >= 3;

  return resolveTextPrompt(
    {
      promptText: joinNonEmpty([
        args.urls && args.urls.length > 0 ? `Primary URLs:\n${args.urls.join('\n')}` : undefined,
        `Topic: ${args.topic}`,
        'Research the topic and produce a grounded Markdown report.',
      ]),
      systemInstruction: joinNonEmpty([
        'Research with Google Search, then write a grounded Markdown report.',
        deepMode
          ? 'You MAY issue multiple searches and MAY use Code Execution when the deliverable requires arithmetic, ranking, or consistency checks. If you did not use a capability, do not imply that you did.'
          : undefined,
        args.deliverable
          ? `Preferred shape: ${args.deliverable}. If the evidence does not support it, use the best-supported structure and say why.`
          : undefined,
        'Cite source URLs inline for retrieved claims. Treat planning notes as leads, not evidence. Flag unverified claims explicitly. Include dates for time-sensitive facts. Output order: 1) ## Findings - one bullet per claim formatted `- claim - [URL1, URL2]`; 2) ## Synthesis - prose derived only from Findings; 3) ## Open Questions - unverified leads.',
      ]),
    },
    args.cacheName,
  );
}
