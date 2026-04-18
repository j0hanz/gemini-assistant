const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'do',
  'for',
  'from',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'we',
  'what',
  'when',
  'which',
  'who',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

const STATIC_PRIORITY_FILES = new Map<string, number>([
  ['readme.md', 0.2],
  ['package.json', 0.2],
  ['agents.md', 0.15],
  ['tsconfig.json', 0.1],
  ['copilot-instructions.md', 0.15],
]);

export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s_./\\:;,!?'"()[\]{}-]+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

function filenameScore(fileName: string, keywords: readonly string[]): number {
  const nameLower = fileName.toLowerCase();
  const nameWithoutExt = nameLower.replace(/\.[^.]+$/, '');
  const nameParts = nameWithoutExt.split(/[-_.]/);

  let matches = 0;
  for (const keyword of keywords) {
    if (nameLower.includes(keyword) || nameParts.some((part) => part === keyword)) {
      matches += 1;
    }
  }

  return Math.min(0.4, matches * 0.2);
}

function contentKeywordScore(content: string, keywords: readonly string[]): number {
  const contentLower = content.toLowerCase();
  let matches = 0;

  for (const keyword of keywords) {
    if (contentLower.includes(keyword)) {
      matches += 1;
    }
  }

  return Math.min(0.4, (matches / Math.max(keywords.length, 1)) * 0.4);
}

function staticPriority(fileName: string): number {
  return STATIC_PRIORITY_FILES.get(fileName.toLowerCase()) ?? 0.05;
}

export function scoreFile(fileName: string, content: string, keywords: readonly string[]): number {
  return (
    filenameScore(fileName, keywords) +
    contentKeywordScore(content, keywords) +
    staticPriority(fileName)
  );
}
