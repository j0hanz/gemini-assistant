const TOKENS_PER_CHAR = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKENS_PER_CHAR);
}
