#!/usr/bin/env node
// Usage: node scripts/tasks.mjs [--fix] [--fast]
//   --fix   run lint:fix instead of lint
//   --fast  skip the test suite (static checks only)
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

// --- CONSTANTS ---

const HISTORY_FILE = '.tasks-history.json';
const MAX_DURATIONS = 5;
const MIN_SILENCE_MS = 30_000;
const STARTUP_MIN_MS = 30_000;
const MAX_STDERR_BYTES = 256 * 1024;
const RAW_OUTPUT_PREVIEW_LIMIT = 500;
const RAW_OUTPUT_MAX_LINES = 40;
const IS_WINDOWS = process.platform === 'win32';

const R = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

const PASS = `${GREEN}✓${R}`;
const FAIL = `${RED}✗${R}`;
const RUN = `${CYAN}◆${R}`;
const SKIP = `${YELLOW}–${R}`;
const HANG = `${YELLOW}⏱${R}`;
const FIX = `${CYAN}⟳${R}`;

// --- HISTORY (cold-path sync FS is acceptable) ---

/** @returns {{ test_durations: Record<string, number[]> }} */
function loadHistory(file = HISTORY_FILE) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { test_durations: Object.create(null) };
  }
  try {
    const parsed = JSON.parse(raw);
    // Defensive copy into a null-prototype dict (avoid prototype pollution).
    const test_durations = Object.create(null);
    const src = parsed?.test_durations;
    if (src && typeof src === 'object') {
      for (const key of Object.keys(src)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const value = src[key];
        if (Array.isArray(value)) {
          test_durations[key] = value.filter((n) => typeof n === 'number' && Number.isFinite(n));
        }
      }
    }
    return { test_durations };
  } catch {
    return { test_durations: Object.create(null) };
  }
}

function saveHistory(history, newDurations, file = HISTORY_FILE) {
  for (const [name, ms] of newDurations) {
    const arr = history.test_durations[name] ?? [];
    arr.push(ms);
    history.test_durations[name] = arr.slice(-MAX_DURATIONS);
  }
  writeFileSync(file, JSON.stringify(history, null, 2) + '\n', 'utf8');
}

function getSilenceTimeout(history) {
  const all = Object.values(history.test_durations).flat();
  if (!all.length) return MIN_SILENCE_MS;
  return Math.max(MIN_SILENCE_MS, 10 * Math.max(...all));
}

// --- COMMAND EXECUTION (no shell on POSIX; Windows needs shell for npm.cmd) ---

/**
 * Run a command and capture stdout/stderr.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {{ ok: boolean, stdout: string, stderr: string, status: number | null }}
 */
function runCommand(cmd, args) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // npm/npx are .cmd shims on Windows — require shell for resolution.
    // Node and other binaries do not. We never interpolate user input into
    // these arguments, so shell-on-Windows is not a security concern here.
    shell: IS_WINDOWS && (cmd === 'npm' || cmd === 'npx'),
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

// --- PARSERS ---

function parseEslintJson(jsonStr, cwd) {
  const results = JSON.parse(jsonStr);
  const errors = [];
  for (const file of results) {
    if (!file.messages?.length) continue;
    const rel = file.filePath?.startsWith(cwd)
      ? file.filePath.slice(cwd.length + 1).replaceAll('\\', '/')
      : (file.filePath ?? '').replaceAll('\\', '/');
    for (const msg of file.messages) {
      errors.push({
        file: rel,
        line: msg.line ?? 1,
        col: msg.column ?? 1,
        endCol: msg.endColumn ?? (msg.column ?? 1) + 3,
        rule: msg.ruleId ?? 'unknown',
        severity: msg.severity === 1 ? 'warning' : 'error',
        message: msg.message,
      });
    }
  }
  return errors;
}

const TSC_RE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/;

function parseTscOutput(text) {
  const errors = [];
  for (const line of text.split('\n')) {
    const m = TSC_RE.exec(line);
    if (!m) continue;
    errors.push({
      file: m[1].replaceAll('\\', '/'),
      line: Number(m[2]),
      col: Number(m[3]),
      endCol: Number(m[3]) + 3,
      rule: m[5],
      severity: m[4],
      message: m[6],
    });
  }
  return errors;
}

// --- KNIP PARSER ---

const KNIP_RULES = {
  files: { rule: 'unused-file', label: 'unused file' },
  dependencies: { rule: 'unused-dep', label: 'unused dependency' },
  devDependencies: { rule: 'unused-dev-dep', label: 'unused devDependency' },
  optionalPeerDependencies: {
    rule: 'unused-peer-dep',
    label: 'unused optional peer dependency',
  },
  unlisted: { rule: 'unlisted-dep', label: 'unlisted dependency' },
  binaries: { rule: 'unlisted-binary', label: 'unlisted binary' },
  unresolved: { rule: 'unresolved-import', label: 'unresolved import' },
  exports: { rule: 'unused-export', label: 'unused export' },
  types: { rule: 'unused-type', label: 'unused exported type' },
  nsExports: { rule: 'unused-ns-export', label: 'unused export in namespace' },
  nsTypes: { rule: 'unused-ns-type', label: 'unused type in namespace' },
  duplicates: { rule: 'duplicate-export', label: 'duplicate export' },
  enumMembers: { rule: 'unused-enum-member', label: 'unused enum member' },
  namespaceMembers: {
    rule: 'unused-ns-member',
    label: 'unused namespace member',
  },
  catalog: { rule: 'catalog-issue', label: 'catalog issue' },
};

const KNIP_FIXABLE_RULES = new Set([
  'unused-dep',
  'unused-dev-dep',
  'unused-peer-dep',
  'unused-export',
  'unused-ns-export',
  'unused-enum-member',
  'unused-ns-member',
  'unused-type',
  'unused-ns-type',
]);

function isKnipFixable(errors) {
  return errors.some((e) => KNIP_FIXABLE_RULES.has(e.rule));
}

function pushKnipError(errors, file, category, entry) {
  const meta = KNIP_RULES[category];
  if (!meta) return;
  const line = typeof entry?.line === 'number' && entry.line > 0 ? entry.line : 1;
  const col = typeof entry?.col === 'number' && entry.col > 0 ? entry.col : 1;
  const name = entry?.name ?? '';
  const namespace = entry?.namespace ? `${entry.namespace}.` : '';
  const message =
    category === 'files'
      ? 'Unused file (no references found)'
      : `${meta.label}: ${namespace}${name}`;
  errors.push({
    file: file.replaceAll('\\', '/'),
    line,
    col,
    endCol: col + Math.max(3, String(name).length || 3),
    rule: meta.rule,
    severity: 'error',
    message,
  });
}

function parseKnipJson(jsonStr) {
  const errors = [];
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return errors;
  }
  const rows = Array.isArray(parsed?.issues) ? parsed.issues : [];
  for (const row of rows) {
    const file = row?.file ?? '';
    if (!file) continue;
    for (const category of Object.keys(KNIP_RULES)) {
      const list = row[category];
      if (!Array.isArray(list) || list.length === 0) continue;
      if (category === 'duplicates') {
        // duplicates is an array-of-arrays of IssueSymbol
        for (const group of list) {
          if (!Array.isArray(group) || group.length === 0) continue;
          const names = group
            .map((s) => s?.name)
            .filter(Boolean)
            .join(', ');
          const first = group[0] ?? {};
          pushKnipError(errors, file, category, {
            name: names || 'duplicate',
            line: first.line,
            col: first.col,
          });
        }
        continue;
      }
      for (const entry of list) {
        pushKnipError(errors, file, category, entry);
      }
    }
  }
  return errors;
}

const TAP_OK_RE = /^\s*ok \d+ - (.+?)(?:\s+#\s+time=(\S+))?$/;
const TAP_NOT_OK_RE = /^\s*not ok \d+ - (.+)$/;
const YAML_KV_RE = /^(\w+):\s*(.*)$/;
const YAML_BLOCK_FRAME_RE = /at .+? \(([^)]+:\d+:\d+)\)/;

function parseTapLine(line) {
  const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
  const ok = TAP_OK_RE.exec(line);
  if (ok) {
    return {
      type: 'ok',
      depth: indent,
      name: ok[1].trim(),
      duration: ok[2] ? parseFloat(ok[2]) : 0,
    };
  }
  const notOk = TAP_NOT_OK_RE.exec(line);
  if (notOk) return { type: 'not_ok', depth: indent, name: notOk[1].trim() };
  if (/^\s+---\s*$/.test(line)) return { type: 'yaml_start' };
  if (/^\s+\.\.\.\s*$/.test(line)) return { type: 'yaml_end' };
  return { type: 'raw', line };
}

function parseYamlBlock(lines) {
  /** @type {Record<string, string>} */
  const result = Object.create(null);
  let multiKey = null;
  const multiLines = [];

  const flushMulti = () => {
    if (multiKey !== null) {
      result[multiKey] = multiLines.join('\n').trim();
      multiKey = null;
      multiLines.length = 0;
    }
  };

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (multiKey !== null) {
      if (/^\w+:/.test(trimmed)) {
        flushMulti();
      } else {
        multiLines.push(trimmed);
        continue;
      }
    }
    const kv = YAML_KV_RE.exec(trimmed);
    if (!kv) continue;
    const [, key, val] = kv;
    if (val === '|-' || val === '|') {
      multiKey = key;
      multiLines.length = 0;
    } else {
      result[key] = val.replace(/^'|'$/g, '');
    }
  }
  flushMulti();

  if (!result.at && result.stack) {
    const m = YAML_BLOCK_FRAME_RE.exec(result.stack);
    if (m && !m[1].startsWith('node:')) result.at = m[1];
  }
  return result;
}

// --- RENDERING ---

const sourceCache = new Map();

function clearSourceCache() {
  sourceCache.clear();
}

function getLines(filePath) {
  let cached = sourceCache.get(filePath);
  if (cached !== undefined) return cached;
  try {
    cached = readFileSync(filePath, 'utf8').split('\n');
  } catch {
    cached = [];
  }
  sourceCache.set(filePath, cached);
  return cached;
}

function renderRustError(error, cwd = process.cwd()) {
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
  const underline = '^'.repeat(underlineLen);
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

function renderTestFailureCard(failure) {
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

function emitLlmBlock(data) {
  const HR = '─'.repeat(53);
  process.stdout.write(
    `\n${HR}\n## LLM CONTEXT\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n${HR}\n\n`,
  );
}

// --- TASK RUNNERS ---

const args = new Set(process.argv.slice(2));
const fix = args.has('--fix');
const fast = args.has('--fast');

function runLint() {
  if (fix) {
    const r = runCommand('npm', ['run', 'lint:fix']);
    return r.ok ? { ok: true } : { ok: false, rawOutput: `${r.stdout}\n${r.stderr}`.trim() };
  }
  const r = runCommand('npx', ['eslint', '.', '--max-warnings=0', '--format=json']);
  if (r.ok) return { ok: true };
  try {
    const errors = parseEslintJson(r.stdout || '[]', process.cwd());
    if (!errors.length) {
      return { ok: false, rawOutput: `${r.stdout}\n${r.stderr}`.trim() };
    }
    const errCount = errors.filter((x) => x.severity === 'error').length;
    const warnCount = errors.filter((x) => x.severity === 'warning').length;
    return { ok: false, errors, counts: { errors: errCount, warnings: warnCount } };
  } catch {
    return { ok: false, rawOutput: `${r.stdout}\n${r.stderr}`.trim() };
  }
}

function runTypeCheck() {
  const r = runCommand('npx', ['tsc', '-p', 'tsconfig.json', '--noEmit', '--pretty', 'false']);
  if (r.ok) return { ok: true };
  const text = `${r.stdout}\n${r.stderr}`.trim();
  const errors = parseTscOutput(text);
  if (!errors.length) return { ok: false, rawOutput: text };
  const errCount = errors.filter((x) => x.severity === 'error').length;
  const warnCount = errors.filter((x) => x.severity === 'warning').length;
  return { ok: false, errors, counts: { errors: errCount, warnings: warnCount } };
}

function runKnip() {
  const r = runCommand('npx', ['knip', '--reporter', 'json', '--no-progress']);
  if (r.ok) return { ok: true };
  // knip prints JSON to stdout even on non-zero exit. Extract the JSON line.
  const stdout = r.stdout ?? '';
  const jsonLine = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('{'));
  if (!jsonLine) {
    return { ok: false, rawOutput: `${r.stdout}\n${r.stderr}`.trim() };
  }
  const errors = parseKnipJson(jsonLine);
  if (!errors.length) {
    return { ok: false, rawOutput: `${r.stdout}\n${r.stderr}`.trim() };
  }
  return {
    ok: false,
    errors,
    counts: { errors: errors.length, warnings: 0 },
  };
}

function runTest() {
  const history = loadHistory();
  const silenceMs = getSilenceTimeout(history);
  // Cold start (tsx/esm + .env load + discovery) needs a generous budget
  // until the first TAP line; then enforce the adaptive silence window.
  const startupMs = Math.max(silenceMs, STARTUP_MIN_MS);

  // Pass an AbortSignal to spawn so kill is automatic on timeout.
  // (Replaces the legacy try/catch around child.kill('SIGTERM').)
  const ac = new AbortController();
  const child = spawn(
    process.execPath,
    ['--import', 'tsx/esm', '--env-file=.env', '--test', '--no-warnings', '--test-reporter=tap'],
    { stdio: ['ignore', 'pipe', 'pipe'], signal: ac.signal },
  );

  /** @type {{ name: string; duration: number } | null} */
  let lastCompleted = null;
  /** @type {Map<string, number>} */
  const testDurations = new Map();
  /** @type {Array<{ name: string; file: string; expected?: string; actual?: string; errorMessage?: string; frame?: string | null }>} */
  const failures = [];
  let currentFailName = null;
  let inYaml = false;
  /** @type {string[]} */
  const yamlLines = [];
  let seenFirstOk = false;
  let stderrBuf = '';

  // Required: bind error listeners on the streams themselves to prevent
  // an unhandled 'error' event from crashing the process.
  child.stdout.on('error', (_err) => {
    /* suppress stream errors */
  });
  child.stderr.on('error', (_err) => {
    /* suppress stream errors */
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (stderrBuf.length < MAX_STDERR_BYTES) {
      stderrBuf += chunk;
      if (stderrBuf.length > MAX_STDERR_BYTES) {
        stderrBuf = stderrBuf.slice(0, MAX_STDERR_BYTES);
      }
    }
  });

  // readline gives correct line semantics with no manual buffer juggling.
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  const { promise, resolve } = Promise.withResolvers();
  let resolved = false;
  let silenceTimer = null;

  const settle = (value) => {
    if (resolved) return;
    resolved = true;
    if (silenceTimer) clearTimeout(silenceTimer);
    lines.close();
    resolve(value);
  };

  const armTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    const ms = seenFirstOk ? silenceMs : startupMs;
    silenceTimer = setTimeout(() => {
      const maxHistorical = Math.max(0, ...Object.values(history.test_durations).flat());
      ac.abort(); // triggers child kill via signal option
      settle({
        ok: false,
        timeout: true,
        silenceMs: ms,
        phase: seenFirstOk ? 'between-tests' : 'startup',
        lastCompletedTest: lastCompleted,
        suiteMaxHistoricalMs: maxHistorical,
      });
    }, ms);
  };

  armTimer();

  lines.on('line', (line) => {
    armTimer();
    const ev = parseTapLine(line);
    if (ev.type === 'ok') {
      seenFirstOk = true;
      lastCompleted = { name: ev.name, duration: ev.duration };
      testDurations.set(ev.name, ev.duration);
      inYaml = false;
      yamlLines.length = 0;
      currentFailName = null;
    } else if (ev.type === 'not_ok') {
      seenFirstOk = true;
      currentFailName = ev.name;
      inYaml = false;
      yamlLines.length = 0;
    } else if (ev.type === 'yaml_start') {
      inYaml = true;
      yamlLines.length = 0;
    } else if (ev.type === 'yaml_end' && inYaml) {
      inYaml = false;
      const yaml = parseYamlBlock([...yamlLines]);
      if (currentFailName) {
        failures.push({
          name: currentFailName,
          file: yaml.at ? yaml.at.replace(/:\d+:\d+$/, '') : '',
          expected: yaml.expected,
          actual: yaml.actual,
          errorMessage: yaml.error,
          frame: yaml.at ?? null,
        });
      }
      yamlLines.length = 0;
      currentFailName = null;
    } else if (inYaml) {
      yamlLines.push(line);
    }
  });

  child.on('error', (err) => {
    // Suppress the synthetic AbortError that spawn emits when ac.abort()
    // fires — we already settled with the timeout payload.
    if (err && err.name === 'AbortError') return;
    settle({ ok: false, rawOutput: String(err?.message ?? err) });
  });

  child.on('close', (code) => {
    if (failures.length) {
      settle({ ok: false, failures, testDurations });
      return;
    }
    if (code !== 0) {
      settle({ ok: false, rawOutput: stderrBuf || `test runner exited with code ${code}` });
      return;
    }
    saveHistory(history, testDurations);
    settle({ ok: true, testDurations });
  });

  return promise;
}

// --- TASK TABLE ---

/** @type {Array<{ label: string; cmd?: [string, string[]]; runner?: () => any | Promise<any>; skip?: boolean }>} */
const tasks = [
  { label: 'format', cmd: ['npm', ['run', 'format']] },
  { label: 'lint', runner: runLint },
  { label: 'type-check', runner: runTypeCheck },
  { label: 'build', cmd: ['npm', ['run', 'build']] },
  { label: 'knip', runner: runKnip },
  { label: 'test', runner: runTest, skip: fast },
];

const COL = Math.max(...tasks.map((t) => t.label.length)) + 2;

function elapsed(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function printHeader() {
  const mode = fix ? `${YELLOW}--fix${R}` : fast ? `${YELLOW}--fast${R}` : '';
  const suffix = mode ? `  ${mode}` : '';
  process.stdout.write(`\n  ${BOLD}gemini-assistant${R}  ${DIM}checks${R}${suffix}\n\n`);
}

function printTask(icon, label, time, skipped, counts) {
  const col = label.padEnd(COL);
  let right = skipped ? `${DIM}skipped${R}` : `${DIM}${time}${R}`;
  if (counts) {
    const parts = [];
    if (counts.errors)
      parts.push(`${RED}${counts.errors} error${counts.errors !== 1 ? 's' : ''}${R}`);
    if (counts.warnings)
      parts.push(`${YELLOW}${counts.warnings} warning${counts.warnings !== 1 ? 's' : ''}${R}`);
    if (parts.length) right = `${DIM}${time}${R}  ${parts.join(' · ')}`;
  }
  process.stdout.write(`\r  ${icon}  ${BOLD}${col}${R}  ${right}\n`);
}

function printOutput(raw) {
  if (!raw) return;
  const split = raw.trim().split('\n');
  const shown = split.slice(0, RAW_OUTPUT_MAX_LINES);
  process.stdout.write('\n');
  for (const line of shown) process.stdout.write(`      ${DIM}${line}${R}\n`);
  if (split.length > RAW_OUTPUT_MAX_LINES) {
    process.stdout.write(`      ${DIM}… ${split.length - RAW_OUTPUT_MAX_LINES} more lines${R}\n`);
  }
  process.stdout.write('\n');
}

// --- MAIN ---

async function main() {
  printHeader();

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const wallStart = Date.now();
  let llmPayload = null;

  for (const task of tasks) {
    if (task.skip) {
      printTask(SKIP, task.label, '', true, null);
      skipped++;
      continue;
    }

    process.stdout.write(`  ${RUN}  ${BOLD}${task.label.padEnd(COL)}${R}`);
    clearSourceCache();

    const start = Date.now();
    let result;

    if (task.runner) {
      result = await task.runner();
    } else if (task.cmd) {
      const [cmd, cmdArgs] = task.cmd;
      const r = runCommand(cmd, cmdArgs);
      result = r.ok ? { ok: true } : { ok: false, rawOutput: `${r.stdout}\n${r.stderr}`.trim() };
    } else {
      result = { ok: false, rawOutput: 'task has no runner or cmd' };
    }

    const ms = Date.now() - start;

    if (!result.ok) {
      const counts = result.counts ?? null;
      printTask(result.timeout ? HANG : FAIL, task.label, elapsed(ms), false, counts);
      failed++;

      if (result.timeout) {
        const startupPhase = result.phase === 'startup';
        process.stdout.write('\n');
        process.stdout.write(
          `  ${HANG}  ${BOLD}TIMED OUT${R} — ${
            startupPhase
              ? `no TAP output during startup window (${elapsed(result.silenceMs)})`
              : `no TAP output for ${elapsed(result.silenceMs)} between tests`
          }\n\n`,
        );
        if (result.lastCompletedTest) {
          process.stdout.write(`  ${DIM}Last completed test:${R}\n`);
          process.stdout.write(`  ${GREEN}✔${R}  ${result.lastCompletedTest.name}\n\n`);
          process.stdout.write(
            `  ${DIM}→ The hang likely occurred in the next test after this one.\n` +
              `    Check for: unclosed handles, unresolved promises, missing mock teardown.${R}\n\n`,
          );
        } else if (startupPhase) {
          process.stdout.write(
            `  ${DIM}→ Test process produced no TAP lines before the startup window expired.\n` +
              `    Check for: top-level await deadlocks, missing .env / config, slow cold start.${R}\n\n`,
          );
        }
        llmPayload = {
          failed_task: task.label,
          status: 'timeout',
          phase: result.phase ?? 'between-tests',
          silence_duration_ms: result.silenceMs,
          last_completed_test: result.lastCompletedTest ?? null,
          suite_max_historical_ms: result.suiteMaxHistoricalMs ?? 0,
          hint: startupPhase
            ? 'Test process produced no TAP output before the startup window expired. Likely causes: top-level await that never resolves, missing config/env, or a cold start slower than the startup budget.'
            : 'Process produced no TAP output for the silence threshold. The next test after last_completed_test is the likely culprit. Check for unclosed handles, unresolved promises, or missing mock teardown.',
        };
      } else if (result.failures?.length) {
        process.stdout.write('\n');
        for (const f of result.failures) {
          process.stdout.write(renderTestFailureCard(f) + '\n\n');
        }
        llmPayload = {
          failed_task: task.label,
          status: 'failed',
          total_failures: result.failures.length,
          failures: result.failures.map(
            ({ name, file, expected, actual, errorMessage, frame }) => ({
              name,
              file,
              ...(expected !== undefined ? { expected, received: actual } : {}),
              ...(errorMessage ? { error: errorMessage } : {}),
              ...(frame ? { at: frame } : {}),
            }),
          ),
        };
      } else if (result.errors?.length) {
        process.stdout.write('\n');
        for (const err of result.errors) {
          process.stdout.write(renderRustError(err) + '\n\n');
        }
        llmPayload = {
          failed_task: task.label,
          status: 'failed',
          total_errors: counts?.errors ?? 0,
          total_warnings: counts?.warnings ?? 0,
          errors: result.errors.map(({ file, line, col, rule, severity, message }) => ({
            file,
            line,
            col,
            rule,
            severity,
            message,
          })),
        };
      } else if (result.rawOutput) {
        printOutput(result.rawOutput);
        llmPayload = {
          failed_task: task.label,
          status: 'failed',
          raw_output_preview: result.rawOutput.slice(0, RAW_OUTPUT_PREVIEW_LIMIT),
        };
      }
      break;
    }

    printTask(PASS, task.label, elapsed(ms), false, null);
    passed++;
  }

  if (llmPayload) emitLlmBlock(llmPayload);

  const total = tasks.length - skipped;
  const wall = elapsed(Date.now() - wallStart);

  process.stdout.write('\n');

  if (failed === 0) {
    const label = fast
      ? `${passed}/${total} passed  ${DIM}(test skipped)${R}`
      : `${passed}/${total} passed`;
    process.stdout.write(`  ${GREEN}${BOLD}✓${R}  ${label}  ${DIM}${wall}${R}\n\n`);
    return 0;
  }

  process.stdout.write(
    `  ${RED}${BOLD}✗${R}  ${passed}/${total} passed  ${RED}${failed} failed${R}  ${DIM}${wall}${R}\n\n`,
  );
  return 1;
}

// CLI entry — only ever invoked via `node scripts/tasks.mjs`, never imported.
// Use exitCode (not process.exit) so stdout has a chance to flush.
process.exitCode = await main();
