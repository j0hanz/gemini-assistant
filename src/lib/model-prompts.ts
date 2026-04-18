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
  return {
    promptText: cacheName ? joinNonEmpty([policy.cacheText, policy.promptText]) : policy.promptText,
    systemInstruction: cacheName ? undefined : policy.systemInstruction,
  };
}

function resolvePartPrompt(policy: PartPromptPolicy, cacheName?: string): ResolvedPartPrompt {
  return {
    promptParts:
      cacheName && policy.cacheText
        ? [{ text: policy.cacheText }, ...policy.promptParts]
        : policy.promptParts,
    systemInstruction: cacheName ? undefined : policy.systemInstruction,
  };
}

function joinNonEmpty(sections: readonly (string | undefined)[]): string {
  return sections.filter((section): section is string => Boolean(section?.trim())).join('\n\n');
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
    !urls || urls.length === 0 ? query : `${query}\n\nUse these URLs too:\n${urls.join('\n')}`;

  return resolveTextPrompt(
    {
      promptText,
      systemInstruction:
        'TASK: Answer from grounded search results only.\nCONSTRAINTS: Keep it concise and grounded in the retrieved sources.',
    },
    cacheName,
  );
}

export function buildFileAnalysisPrompt(
  args:
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
      },
): ResolvedTextPrompt;
export function buildFileAnalysisPrompt(args: {
  attachedParts?: readonly Part[];
  cacheName?: string | undefined;
  goal: string;
  kind: 'multi';
}): ResolvedPartPrompt;
export function buildFileAnalysisPrompt(args: {
  attachedParts?: readonly Part[];
  goal: string;
  kind: 'single' | 'multi' | 'url';
  urls?: readonly string[];
  cacheName?: string | undefined;
}): ResolvedTextPrompt | ResolvedPartPrompt {
  if (args.kind === 'single') {
    return resolveTextPrompt(
      {
        promptText: args.goal,
        systemInstruction:
          'TASK: Answer the user goal based on the provided file.\nCONSTRAINTS: Answer from the provided file only. Cite relevant sections, lines, or elements.',
      },
      args.cacheName,
    );
  }

  if (args.kind === 'url') {
    return resolveTextPrompt(
      {
        promptText: joinNonEmpty([
          args.urls && args.urls.length > 0 ? `URLs:\n${args.urls.join('\n')}` : undefined,
          `Task: ${args.goal}`,
        ]),
        systemInstruction:
          'TASK: Answer the user goal based on the retrieved URL content.\nCONSTRAINTS: Answer from the retrieved URL content only. Cite relevant sections, fields, or short quotes.',
      },
      args.cacheName,
    );
  }

  return resolvePartPrompt(
    {
      promptParts: [...(args.attachedParts ?? []), { text: `Goal: ${args.goal}` }],
      systemInstruction:
        'TASK: Analyze the provided local files.\nCONSTRAINTS: Analyze only the provided local files. Synthesize across them when needed. Cite filenames, symbols, or short excerpts. Do not invent missing context.',
    },
    args.cacheName,
  );
}

export function buildDiffReviewPrompt(args: {
  cacheName?: string | undefined;
  focus?: string | undefined;
  mode: 'compare';
  promptParts: readonly Part[];
}): ResolvedPartPrompt;
export function buildDiffReviewPrompt(args: {
  cacheName?: string | undefined;
  mode: 'review';
  promptText: string;
}): ResolvedTextPrompt;
export function buildDiffReviewPrompt(args: {
  cacheName?: string | undefined;
  mode: 'compare' | 'review';
  promptText?: string;
  promptParts?: readonly Part[];
  focus?: string | undefined;
}): ResolvedTextPrompt | ResolvedPartPrompt {
  if (args.mode === 'compare') {
    return resolvePartPrompt(
      {
        promptParts: [
          ...(args.promptParts ?? []),
          { text: args.focus ? `Focus: ${args.focus}` : 'Task: Compare the two files.' },
        ],
        cacheText:
          'TASK: Compare the provided files.\nOUTPUT: Summary, Differences, Impact.\nCONSTRAINTS: Cite symbols or short quotes.',
        systemInstruction: buildOutputInstruction(
          'TASK: Compare the provided files.\nCONSTRAINTS:\n- Base claims on the files.\n- Cite symbols, section names, or short quotes.\n- Do not invent line numbers.',
          ['OUTPUT:', '## Summary', '## Differences', '## Impact'],
        ),
      },
      args.cacheName,
    );
  }

  return resolveTextPrompt(
    {
      cacheText:
        'TASK: Review the diff for bugs, regressions, and behavior risk.\nOUTPUT: Findings, Fixes.\nCONSTRAINTS: Ignore formatting-only changes.',
      promptText: args.promptText ?? '',
      systemInstruction: buildOutputInstruction(
        'TASK: Review the unified diff for bugs, regressions, and behavior risk.\nCONSTRAINTS:\n- Ignore formatting-only changes.\n- Cite file paths and hunk context from the diff.\n- Do not invent content or line numbers.\n- If the diff looks clean, say so briefly.',
        [
          'OUTPUT:',
          '## Findings',
          'List issues by severity with file references.',
          '## Fixes',
          'Short next steps.',
        ],
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
      cacheText:
        'TASK: Diagnose the error.\nOUTPUT: Cause, Fix, Notes.\nCONSTRAINTS: Extract distinct error queries before searching.',
      promptText: sections.join('\n\n'),
      systemInstruction: buildOutputInstruction(
        'TASK: Diagnose the provided error.\nCONSTRAINTS:\n- If search is available, extract distinct error codes or key error messages into <search_queries> and search them individually.\n- Base conclusions on the provided context and grounded tool results.\n- Cite relevant symbols, files, lines, or snippets.\n- If a language is given, follow its norms.',
        ['OUTPUT:', '## Cause', '## Fix', '## Notes'],
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
        `TASK: Generate a ${args.diagramType} diagram from the description and files.`,
        'CONSTRAINTS:',
        `- Return exactly one fenced \`\`\`${args.diagramType} block.`,
        '- Keep it readable with clear node and edge labels.',
        '- If source code is provided, derive the diagram from it.',
        args.validateSyntax
          ? '- If syntax validation is requested, use code execution for a best-effort check and state uncertainty.'
          : undefined,
      ]),
    },
    args.cacheName,
  );
}

export function buildAgenticResearchPrompt(args: {
  searchDepth: number;
  topic: string;
  cacheName?: string | undefined;
}): ResolvedTextPrompt {
  const depthInstruction =
    args.searchDepth <= 2
      ? 'Focused: cover 2-3 key aspects.'
      : args.searchDepth <= 3
        ? 'Thorough: cover 4-5 key aspects.'
        : 'Exhaustive: cover as many relevant aspects as possible.';

  return resolveTextPrompt(
    {
      promptText: joinNonEmpty([
        `Topic: ${args.topic}`,
        depthInstruction,
        'Task: research the topic and produce a grounded report.',
      ]),
      systemInstruction: joinNonEmpty([
        'TASK: Research with Google Search and Code Execution, then write a grounded Markdown report.',
        'CONSTRAINTS:',
        '- Split the topic into sub-questions and search multiple angles.',
        '- Use Code Execution for calculations, comparisons, rankings, and tables when useful.',
        '- Include concrete numbers and dates when available.',
        '- Do not state unsupported claims.',
      ]),
    },
    args.cacheName,
  );
}
