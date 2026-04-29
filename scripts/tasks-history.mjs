import { readFileSync, writeFileSync } from 'node:fs';

const MAX_DURATIONS = 5;

export function loadHistory(file = '.tasks-history.json') {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { test_durations: {} };
  }
}

export function saveHistory(history, newDurations, file = '.tasks-history.json') {
  for (const [name, ms] of newDurations) {
    const arr = history.test_durations[name] ?? [];
    arr.push(ms);
    history.test_durations[name] = arr.slice(-MAX_DURATIONS);
  }
  writeFileSync(file, JSON.stringify(history, null, 2) + '\n', 'utf8');
}

// Minimum silence window between TAP lines. Must accommodate inter-suite gaps
// (each test file pays a fresh tsx/esm transpile cost), so this is generous.
// A genuine hang produces no output indefinitely; a slow gap produces output
// within seconds.
const MIN_SILENCE_MS = 30_000;

export function getSilenceTimeout(history) {
  const all = Object.values(history.test_durations).flat();
  if (!all.length) return MIN_SILENCE_MS;
  return Math.max(MIN_SILENCE_MS, 10 * Math.max(...all));
}
