import { readFileSync } from 'node:fs';
import path from 'node:path';

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const R = '\x1b[0m';

const sourceCache = new Map();

export function clearSourceCache() {
  sourceCache.clear();
}

function getLines(filePath) {
  if (!sourceCache.has(filePath)) {
    try {
      sourceCache.set(filePath, readFileSync(filePath, 'utf8').split('\n'));
    } catch {
      sourceCache.set(filePath, []);
    }
  }
  return sourceCache.get(filePath);
}

export function renderRustError(error, cwd = process.cwd()) {
  const { file, line, col, endCol, rule, severity, message } = error;
  const color = severity === 'warning' ? YELLOW : RED;
  const out = [];
  out.push(`${color}${severity}[${rule}]${R}  ${message}`);
  out.push(`  ${DIM}-->${R} ${file}:${line}:${col}`);
  const absPath = path.isAbsolute(file) ? file : path.join(cwd, file);
  const src = getLines(absPath);
  const gutterW = String(line + 1).length;
  const pad = ' '.repeat(gutterW);
  out.push(`${DIM}${pad} |${R}`);
  const underlineLen = Math.max(3, (endCol ?? col + 3) - col);
  const underline = '^^^^^^^^^^^'.slice(0, underlineLen);
  if (line >= 1 && line <= src.length) {
    for (const n of [line - 1, line, line + 1]) {
      if (n < 1 || n > src.length) continue;
      const srcLine = src[n - 1] ?? '';
      const g = String(n).padStart(gutterW);
      if (n === line) {
        out.push(`${BOLD}${g}${R} ${DIM}│${R} ${srcLine}`);
        out.push(`${DIM}${pad} │${R} ${' '.repeat(col - 1)}${color}${underline}${R}`);
      } else {
        out.push(`${DIM}${g} │ ${srcLine}${R}`);
      }
    }
  } else {
    out.push(`${DIM}${pad} │${R} ${' '.repeat(col - 1)}${color}${underline}${R}`);
  }
  return out.join('\n');
}

export function renderTestFailureCard(failure) {
  const { name, file, expected, actual, errorMessage, frame } = failure;
  const out = [];
  out.push(`${RED}FAIL${R}  ${DIM}${file}${R}`);
  out.push(`  ${RED}✗${R}  ${name}`);
  out.push('');
  if (expected !== undefined && actual !== undefined) {
    out.push(`     ${DIM}AssertionError:${R}`);
    out.push(`     ${RED}- Expected   ${expected}${R}`);
    out.push(`     ${GREEN}+ Received   ${actual}${R}`);
  } else if (errorMessage) {
    out.push(`     ${RED}${errorMessage}${R}`);
  }
  if (frame) {
    out.push('');
    out.push(`     ${DIM}at ${frame}${R}`);
  }
  return out.join('\n');
}

export function emitLlmBlock(data) {
  const HR = '─'.repeat(53);
  process.stdout.write(
    `\n${HR}\n## LLM CONTEXT\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n${HR}\n\n`,
  );
}
