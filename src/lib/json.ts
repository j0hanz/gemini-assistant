interface ParseJsonOptions<T> {
  candidates?: readonly string[];
  fallback?: T;
}

export function parseJson<T = unknown>(
  text: string,
  options: ParseJsonOptions<T> = {},
): T | undefined {
  const candidates = options.candidates ?? [text];

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }

    try {
      return JSON.parse(trimmed) as T;
    } catch {
      continue;
    }
  }

  return options.fallback;
}
