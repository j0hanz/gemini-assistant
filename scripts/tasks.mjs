#!/usr/bin/env node
// Usage: node scripts/tasks.mjs [--fix] [--fast]
//   --fix   run lint:fix instead of lint
//   --fast  skip the test suite (static checks only)
import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// --- HISTORY AND TIMEOUT ---

const MAX_DURATIONS = 5;

function loadHistory(file = '.tasks-history.json') {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { test_durations: {} };
  }
}

function saveHistory(history, newDurations, file = '.tasks-history.json') {
  for (const [name, ms] of newDurations) {
    const arr = history.test_durations[name] ?? [];
    arr.push(ms);
    history.test_durations[name] = arr.slice(-MAX_DURATIONS);
  }
  writeFileSync(file, JSON.stringify(history, null, 2) + '\n', 'utf8');
}

const MIN_SILENCE_MS = 30_000;

function getSilenceTimeout(history) {
  const all = Object.values(history.test_durations).flat();
  if (!all.length) return MIN_SILENCE_MS;
  return Math.max(MIN_SILENCE_MS, 10 * Math.max(...all));
}

// --- PARSERS ---

function parseEslintJson(jsonStr, cwd) {
  const results = JSON.parse(jsonStr);
  const errors = [];
  for (const file of results) {
    if (!file.messages?.length) continue;
    const rel = file.filePath?.startsWith(cwd)
      ? file.filePath.slice(cwd.length + 1).replace(/\\/g, '/')
      : (file.filePath ?? '').replace(/\\/g, '/');
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
    const m = line.match(TSC_RE);
    if (!m) continue;
    errors.push({
      file: m[1].replace(/\\/g, '/'),
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

function parseTapLine(line) {
  const indent = (line.match(/^(\s*)/) ?? ['', ''])[1].length;
  const ok = /^\s*ok \d+ - (.+?)(?:\s+#\s+time=(\S+))?$/.exec(line);
  if (ok)
    return {
      type: 'ok',
      depth: indent,
      name: ok[1].trim(),
      duration: ok[2] ? parseFloat(ok[2]) : 0,
    };
  const notOk = /^\s*not ok \d+ - (.+)$/.exec(line);
  if (notOk) return { type: 'not_ok', depth: indent, name: notOk[1].trim() };
  if (/^\s+---\s*$/.test(line)) return { type: 'yaml_start' };
  if (/^\s+\.\.\.\s*$/.test(line)) return { type: 'yaml_end' };
  return { type: 'raw', line };
}

function parseYamlBlock(lines) {
  const result = {};
  let multiKey = null;
  const multiLines = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (multiKey) {
      if (/^\w+:/.test(trimmed)) {
        result[multiKey] = multiLines.join('\n').trim();
        multiKey = null;
        multiLines.length = 0;
      } else {
        multiLines.push(trimmed);
        continue;
      }
    }
    const kv = /^(\w+):\s*(.*)$/.exec(trimmed);
    if (!kv) continue;
    const [, key, val] = kv;
    if (val === '|-' || val === '|') {
      multiKey = key;
      multiLines.length = 0;
    } else {
      result[key] = val.replace(/^'|'$/g, '');
    }
  }
  if (multiKey) result[multiKey] = multiLines.join('\n').trim();
  if (!result.at && result.stack) {
    const m = result.stack.match(/at .+? \(([^)]+:\d+:\d+)\)/);
    if (m && !m[1].startsWith('node:')) result.at = m[1];
  }
  return result;
}

// --- RENDERING ---

const R = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

const sourceCache = new Map();

function clearSourceCache() {
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

// --- MAIN RUNNER ---

const PASS = `${GREEN}✓${R}`;
const FAIL = `${RED}✗${R}`;
const RUN = `${CYAN}◆${R}`;
const SKIP = `${YELLOW}–${R}`;
const HANG = `${YELLOW}⏱${R}`;

const args = new Set(process.argv.slice(2));
const fix = args.has('--fix');
const fast = args.has('--fast');

function runLint() {
  if (fix) {
    try {
      execSync('npm run lint:fix', { encoding: 'utf8', stdio: 'pipe' });
      return { ok: true };
    } catch (err) {
      const e = /** @type {any} */ (err);
      return { ok: false, rawOutput: [e.stdout, e.stderr].filter(Boolean).join('\n') };
    }
  }
  try {
    execSync('npx eslint . --max-warnings=0 --format=json', { encoding: 'utf8', stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    const e = /** @type {any} */ (err);
    try {
      const errors = parseEslintJson(e.stdout ?? '[]', process.cwd());
      if (!errors.length) {
        return { ok: false, rawOutput: [e.stdout, e.stderr].filter(Boolean).join('\n') };
      }
      const errCount = errors.filter((x) => x.severity === 'error').length;
      const warnCount = errors.filter((x) => x.severity === 'warning').length;
      return { ok: false, errors, counts: { errors: errCount, warnings: warnCount } };
    } catch {
      return { ok: false, rawOutput: [e.stdout, e.stderr].filter(Boolean).join('\n') };
    }
  }
}

function runTypeCheck() {
  try {
    execSync('npx tsc -p tsconfig.json --noEmit --pretty false', {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { ok: true };
  } catch (err) {
    const e = /** @type {any} */ (err);
    const text = [e.stdout, e.stderr].filter(Boolean).join('\n');
    const errors = parseTscOutput(text);
    if (!errors.length) return { ok: false, rawOutput: text };
    const errCount = errors.filter((x) => x.severity === 'error').length;
    const warnCount = errors.filter((x) => x.severity === 'warning').length;
    return { ok: false, errors, counts: { errors: errCount, warnings: warnCount } };
  }
}

function runTest() {
  return new Promise((resolve) => {
    const history = loadHistory();
    const silenceMs = getSilenceTimeout(history);
    // Startup budget: tsx/esm cold start + .env load + test discovery can take
    // several seconds before the first TAP line. Use a generous budget until
    // the first `ok` is observed; only then enforce the adaptive silence
    // window between TAP lines.
    const startupMs = Math.max(silenceMs, 30_000);

    const child = spawn(
      'node',
      ['--import', 'tsx/esm', '--env-file=.env', '--test', '--no-warnings', '--test-reporter=tap'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    /** @type {{ name: string; duration: number } | null} */
    let lastCompleted = null;
    /** @type {Map<string, number>} */
    const testDurations = new Map();
    /** @type {Array<{ name: string; file: string; expected?: string; actual?: string; errorMessage?: string; frame?: string | null }>} */
    const failures = [];
    let currentFailName = /** @type {string | null} */ (null);
    let inYaml = false;
    /** @type {string[]} */
    const yamlLines = [];
    let buf = '';
    /** @type {ReturnType<typeof setTimeout> | null} */
    let silenceTimer = null;
    let resolved = false;
    let seenFirstOk = false;
    let stderrBuf = '';

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
    });

    function done(value) {
      if (resolved) return;
      resolved = true;
      if (silenceTimer) clearTimeout(silenceTimer);
      resolve(value);
    }

    function resetTimer() {
      if (silenceTimer) clearTimeout(silenceTimer);
      const ms = seenFirstOk ? silenceMs : startupMs;
      silenceTimer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore: process may already have exited
        }
        const maxHistorical = Math.max(0, ...Object.values(history.test_durations).flat());
        done({
          ok: false,
          timeout: true,
          silenceMs: ms,
          phase: seenFirstOk ? 'between-tests' : 'startup',
          lastCompletedTest: lastCompleted,
          suiteMaxHistoricalMs: maxHistorical,
        });
      }, ms);
    }

    resetTimer();

    child.stdout.on('data', (chunk) => {
      resetTimer();
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
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
      }
    });

    child.on('error', (err) => {
      done({ ok: false, rawOutput: String(err?.message ?? err) });
    });

    child.on('close', (code) => {
      if (failures.length) {
        done({ ok: false, failures, testDurations });
        return;
      }
      if (code !== 0) {
        done({ ok: false, rawOutput: stderrBuf || `test runner exited with code ${code}` });
        return;
      }
      saveHistory(history, testDurations);
      done({ ok: true, testDurations });
    });
  });
}

/** @type {Array<{ label: string; cmd?: string; runner?: () => any | Promise<any>; skip?: boolean }>} */
const tasks = [
  { label: 'format', cmd: 'npm run format' },
  { label: 'lint', runner: runLint },
  { label: 'type-check', runner: runTypeCheck },
  { label: 'build', cmd: 'npm run build' },
  { label: 'knip', cmd: 'npm run knip' },
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
  const lines = raw.trim().split('\n');
  const shown = lines.slice(0, 40);
  process.stdout.write('\n');
  for (const line of shown) process.stdout.write(`      ${DIM}${line}${R}\n`);
  if (lines.length > 40)
    process.stdout.write(`      ${DIM}… ${lines.length - 40} more lines${R}\n`);
  process.stdout.write('\n');
}

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
  } else {
    try {
      execSync(task.cmd, { encoding: 'utf8', stdio: 'pipe' });
      result = { ok: true };
    } catch (err) {
      const e = /** @type {any} */ (err);
      result = { ok: false, rawOutput: [e.stdout, e.stderr].filter(Boolean).join('\n') };
    }
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
        failures: result.failures.map(({ name, file, expected, actual, errorMessage, frame }) => ({
          name,
          file,
          ...(expected !== undefined ? { expected, received: actual } : {}),
          ...(errorMessage ? { error: errorMessage } : {}),
          ...(frame ? { at: frame } : {}),
        })),
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
        raw_output_preview: result.rawOutput.slice(0, 500),
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
} else {
  process.stdout.write(
    `  ${RED}${BOLD}✗${R}  ${passed}/${total} passed  ${RED}${failed} failed${R}  ${DIM}${wall}${R}\n\n`,
  );
  process.exit(1);
}
