#!/usr/bin/env node
// Usage: node scripts/tasks.mjs [--fix] [--quick] [--all] [--json] [--llm] [--help]
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { convertProcessSignalToExitCode, parseArgs } from 'node:util';

const runController = new AbortController();

// --- CONFIGURATION ---
const Config = {
  HISTORY_FILE: '.tasks-history.json',
  FAILURE_FILE: '.tasks-last-failure.json',
  MAX_DURATIONS: 5,
  MIN_SILENCE_MS: 30_000,
  STARTUP_MIN_MS: 30_000,
  MAX_STDERR_CHARS: 256 * 1024,
  MAX_STDOUT_CHARS: 1024 * 1024,
  MAX_STDERR_CHARS_EXEC: 256 * 1024,
  KILL_GRACE_MS: 5_000,
  RAW_OUTPUT_MAX_LINES: 40,
  MAX_ERRORS_IN_FILE: 1000,
  MAX_FAILURE_CARDS: 50,
  IS_WINDOWS: process.platform === 'win32',
};

const Theme = {
  R: '\x1b[0m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  CYAN: '\x1b[36m',
  BLUE: '\x1b[34m',
  CLEAR_EOL: '\x1b[K',
};

const Icons = {
  PASS: `${Theme.GREEN}✔${Theme.R}`,
  FAIL: `${Theme.RED}✖${Theme.R}`,
  RUN: `${Theme.BLUE}❯${Theme.R}`,
  SKIP: `${Theme.YELLOW}⊘${Theme.R}`,
  HANG: `${Theme.YELLOW}⧖${Theme.R}`,
  FIX: `${Theme.CYAN}↻${Theme.R}`,
};

// --- HISTORY MANAGER ---
const HistoryManager = {
  async load(file = Config.HISTORY_FILE) {
    try {
      const raw = await readFile(file, 'utf8');
      return this._sanitize(JSON.parse(raw));
    } catch {
      return { test_durations: Object.create(null) };
    }
  },

  _sanitize(parsed) {
    const test_durations = Object.create(null);
    const src = parsed && typeof parsed === 'object' ? parsed.test_durations : null;
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
  },

  async save(history, newDurations, file = Config.HISTORY_FILE) {
    for (const [name, ms] of newDurations) {
      const arr = history.test_durations[name] || [];
      arr.push(ms);
      history.test_durations[name] = arr.slice(-Config.MAX_DURATIONS);
    }
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(history, null, 2) + '\n', 'utf8');
    await rename(tmp, file);
  },

  getSilenceTimeout(history) {
    const all = Object.values(history.test_durations).flat();
    if (all.length === 0) return Config.MIN_SILENCE_MS;
    return Math.max(Config.MIN_SILENCE_MS, 10 * Math.max(...all));
  },
};

// --- COMMAND EXECUTION ---
const CommandRunner = {
  exec(cmd, args) {
    const isNpm = Config.IS_WINDOWS && (cmd === 'npm' || cmd === 'npx');
    const result = isNpm
      ? spawnSync('cmd.exe', ['/d', '/c', cmd, ...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsVerbatimArguments: true,
        })
      : spawnSync(cmd, args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });

    return {
      ok: result.status === 0 && !result.error,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      status: result.status,
    };
  },

  async execAsync(cmd, args) {
    return new Promise((resolve) => {
      const isNpm = Config.IS_WINDOWS && (cmd === 'npm' || cmd === 'npx');
      const child = isNpm
        ? spawn('cmd.exe', ['/d', '/c', cmd, ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsVerbatimArguments: true,
            signal: runController.signal,
          })
        : spawn(cmd, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            signal: runController.signal,
          });
      let stdout = '';
      let stderr = '';
      let truncatedStdout = false;
      let truncatedStderr = false;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        if (stdout.length >= Config.MAX_STDOUT_CHARS) {
          truncatedStdout = true;
          return;
        }
        const remaining = Config.MAX_STDOUT_CHARS - stdout.length;
        if (d.length > remaining) {
          stdout += d.slice(0, remaining);
          truncatedStdout = true;
        } else {
          stdout += d;
        }
      });
      child.stderr.on('data', (d) => {
        if (stderr.length >= Config.MAX_STDERR_CHARS_EXEC) {
          truncatedStderr = true;
          return;
        }
        const remaining = Config.MAX_STDERR_CHARS_EXEC - stderr.length;
        if (d.length > remaining) {
          stderr += d.slice(0, remaining);
          truncatedStderr = true;
        } else {
          stderr += d;
        }
      });
      child.on('close', (code) => {
        resolve({
          ok: code === 0,
          stdout,
          stderr,
          status: code,
          truncatedStdout,
          truncatedStderr,
        });
      });
      child.on('error', (err) => {
        resolve({
          ok: false,
          stdout: '',
          stderr: String(err.message),
          status: null,
          truncatedStdout: false,
          truncatedStderr: false,
        });
      });
    });
  },
};

// --- PARSERS ---
const EslintParser = {
  parse(jsonStr, cwd) {
    const errors = [];
    let results;
    try {
      results = JSON.parse(jsonStr);
    } catch {
      return errors;
    }

    for (const file of results) {
      this._parseFileMessages(file, cwd, errors);
    }
    return errors;
  },

  _parseFileMessages(file, cwd, errors) {
    const msgs = file.messages;
    if (!msgs || msgs.length === 0) return;

    const filePath = file.filePath || '';
    const rel = path.relative(cwd, filePath).replaceAll('\\', '/');

    for (const msg of msgs) {
      errors.push(this._formatError(msg, rel));
    }
  },

  _formatError(msg, relPath) {
    const col = msg.column || 1;
    return {
      file: relPath,
      line: msg.line || 1,
      col,
      endCol: msg.endColumn || col + 3,
      rule: msg.ruleId || 'unknown',
      severity: msg.severity === 1 ? 'warning' : 'error',
      message: msg.message,
    };
  },
};

const TscParser = {
  RE: /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/,

  parse(text) {
    const errors = [];
    for (const line of text.split('\n')) {
      const m = this.RE.exec(line);
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
  },
};

const KnipParser = {
  RULES: {
    files: { rule: 'unused-file', label: 'unused file' },
    dependencies: { rule: 'unused-dep', label: 'unused dependency' },
    devDependencies: { rule: 'unused-dev-dep', label: 'unused devDependency' },
    optionalPeerDependencies: { rule: 'unused-peer-dep', label: 'unused optional peer dependency' },
    unlisted: { rule: 'unlisted-dep', label: 'unlisted dependency' },
    binaries: { rule: 'unlisted-binary', label: 'unlisted binary' },
    unresolved: { rule: 'unresolved-import', label: 'unresolved import' },
    exports: { rule: 'unused-export', label: 'unused export' },
    types: { rule: 'unused-type', label: 'unused exported type' },
    nsExports: { rule: 'unused-ns-export', label: 'unused export in namespace' },
    nsTypes: { rule: 'unused-ns-type', label: 'unused type in namespace' },
    duplicates: { rule: 'duplicate-export', label: 'duplicate export' },
    enumMembers: { rule: 'unused-enum-member', label: 'unused enum member' },
    namespaceMembers: { rule: 'unused-ns-member', label: 'unused namespace member' },
    catalog: { rule: 'catalog-issue', label: 'catalog issue' },
  },

  FIXABLE_RULES: new Set([
    'unused-dep',
    'unused-dev-dep',
    'unused-peer-dep',
    'unused-export',
    'unused-ns-export',
    'unused-enum-member',
    'unused-ns-member',
    'unused-type',
    'unused-ns-type',
  ]),

  isFixable(errors) {
    return errors.some((e) => this.FIXABLE_RULES.has(e.rule));
  },

  parse(jsonStr) {
    const errors = [];
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return errors;
    }
    const rows = Array.isArray(parsed && parsed.issues) ? parsed.issues : [];
    for (const row of rows) {
      this._parseRow(row, errors);
    }
    return errors;
  },

  _parseRow(row, errors) {
    const file = row && row.file ? row.file : '';
    if (!file) return;
    for (const category of Object.keys(this.RULES)) {
      const list = row[category];
      if (!Array.isArray(list) || list.length === 0) continue;

      if (category === 'duplicates') {
        this._handleDuplicates(file, list, errors);
      } else {
        for (const entry of list) {
          this._pushError(errors, file, category, entry);
        }
      }
    }
  },

  _handleDuplicates(file, list, errors) {
    for (const group of list) {
      if (!Array.isArray(group) || group.length === 0) continue;
      const names = group
        .map((s) => s && s.name)
        .filter(Boolean)
        .join(', ');
      const first = group[0] || {};
      this._pushError(errors, file, 'duplicates', {
        name: names || 'duplicate',
        line: first.line,
        col: first.col,
      });
    }
  },

  _normalizeEntry(entry) {
    let line = 1,
      col = 1,
      name = '',
      namespace = '';
    if (entry) {
      if (typeof entry.line === 'number' && entry.line > 0) line = entry.line;
      if (typeof entry.col === 'number' && entry.col > 0) col = entry.col;
      name = entry.name || '';
      namespace = entry.namespace ? `${entry.namespace}.` : '';
    }
    return { line, col, name, namespace };
  },

  _pushError(errors, file, category, entry) {
    const meta = this.RULES[category];
    if (!meta) return;

    const { line, col, name, namespace } = this._normalizeEntry(entry);

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
  },
};

const TapParser = {
  OK_RE: /^\s*ok \d+ - (.+?)(?:\s+#\s+time=(\S+))?$/,
  NOT_OK_RE: /^\s*not ok \d+ - (.+)$/,
  YAML_KV_RE: /^(\w+):\s*(.*)$/,
  YAML_BLOCK_FRAME_RE: /at .+? \(([^)]+:\d+:\d+)\)/,

  parseLine(line) {
    const match = line.match(/^(\s*)/);
    const indent = match ? match[1].length : 0;

    const ok = this.OK_RE.exec(line);
    if (ok)
      return {
        type: 'ok',
        depth: indent,
        name: ok[1].trim(),
        // Node's built-in TAP reporter emits `# time=<ms>` in milliseconds.
        duration: ok[2] ? parseFloat(ok[2]) : 0,
      };

    const notOk = this.NOT_OK_RE.exec(line);
    if (notOk) return { type: 'not_ok', depth: indent, name: notOk[1].trim() };

    if (/^\s+---\s*$/.test(line)) return { type: 'yaml_start' };
    if (/^\s+\.\.\.\s*$/.test(line)) return { type: 'yaml_end' };

    return { type: 'raw', line };
  },

  parseYaml(lines) {
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
      this._processYamlLine(raw, result, multiLines, flushMulti, (k) => {
        multiKey = k;
      });
    }
    flushMulti();

    if (!result.at && result.stack) {
      const m = this.YAML_BLOCK_FRAME_RE.exec(result.stack);
      if (m && !m[1].startsWith('node:')) result.at = m[1];
    }
    return result;
  },

  _processYamlLine(raw, result, multiLines, flushMulti, setMultiKey) {
    const trimmed = raw.trim();
    const kv = this.YAML_KV_RE.exec(trimmed);

    if (multiLines.length > 0 || (kv && (kv[2] === '|-' || kv[2] === '|'))) {
      if (kv && kv[2] !== '|-' && kv[2] !== '|') {
        flushMulti();
        result[kv[1]] = kv[2].replace(/^'|'$/g, '');
      } else if (kv) {
        setMultiKey(kv[1]);
        multiLines.length = 0;
      } else {
        multiLines.push(trimmed);
      }
      return;
    }

    if (!kv) return;
    const [, key, val] = kv;
    result[key] = val.replace(/^'|'$/g, '');
  },
};

// --- RENDERING ---
const OutputRenderer = {
  sourceCache: new Map(),

  clearCache() {
    this.sourceCache.clear();
  },

  _getLines(filePath) {
    let cached = this.sourceCache.get(filePath);
    if (cached !== undefined) return cached;
    try {
      cached = readFileSync(filePath, 'utf8').split('\n');
    } catch {
      cached = [];
    }
    this.sourceCache.set(filePath, cached);
    return cached;
  },

  renderRustError(error, cwd = process.cwd()) {
    const { file, line, col, endCol, rule, severity, message } = error;
    const color = severity === 'warning' ? Theme.YELLOW : Theme.RED;
    const out = [];

    out.push(`${color}${severity}[${rule}]${Theme.R}  ${message}`);
    out.push(`  ${Theme.DIM}-->${Theme.R} ${file}:${line}:${col}`);

    const absPath = path.resolve(cwd, file);
    const src = this._getLines(absPath);
    const gutterW = String(line + 1).length;
    const pad = ' '.repeat(gutterW);

    out.push(`${Theme.DIM}${pad} |${Theme.R}`);
    const underlineLen = Math.max(3, (endCol || col + 3) - col);
    const underline = '^'.repeat(underlineLen);

    this._renderSourceContext(out, src, line, col, pad, gutterW, color, underline);

    return out.join('\n');
  },

  _renderSourceContext(out, src, line, col, pad, gutterW, color, underline) {
    if (line >= 1 && line <= src.length) {
      for (const n of [line - 1, line, line + 1]) {
        if (n < 1 || n > src.length) continue;
        const srcLine = src[n - 1] || '';
        const g = String(n).padStart(gutterW);
        if (n === line) {
          out.push(`${Theme.BOLD}${g}${Theme.R} ${Theme.DIM}│${Theme.R} ${srcLine}`);
          out.push(
            `${Theme.DIM}${pad} │${Theme.R} ${' '.repeat(col - 1)}${color}${underline}${Theme.R}`,
          );
        } else {
          out.push(`${Theme.DIM}${g} │ ${srcLine}${Theme.R}`);
        }
      }
    } else {
      out.push(
        `${Theme.DIM}${pad} │${Theme.R} ${' '.repeat(col - 1)}${color}${underline}${Theme.R}`,
      );
    }
  },

  renderTestFailureCard(failure) {
    const { name, file, expected, actual, errorMessage, frame } = failure;
    const out = [];

    out.push(`${Theme.RED}FAIL${Theme.R}  ${Theme.DIM}${file}${Theme.R}`);
    out.push(`  ${Theme.RED}✗${Theme.R}  ${name}`);
    out.push('');

    if (expected !== undefined && actual !== undefined) {
      out.push(`     ${Theme.DIM}AssertionError:${Theme.R}`);
      out.push(`     ${Theme.RED}- Expected   ${expected}${Theme.R}`);
      out.push(`     ${Theme.GREEN}+ Received   ${actual}${Theme.R}`);
    } else if (errorMessage) {
      out.push(`     ${Theme.RED}${errorMessage}${Theme.R}`);
    }

    if (frame) {
      out.push('');
      out.push(`     ${Theme.DIM}at ${frame}${Theme.R}`);
    }
    return out.join('\n');
  },

  renderRustErrorsGrouped(errors, cwd = process.cwd()) {
    const byFile = new Map();
    for (const err of errors) {
      const list = byFile.get(err.file) || [];
      list.push(err);
      byFile.set(err.file, list);
    }
    for (const [file, list] of byFile) {
      process.stdout.write(`  ${Theme.BOLD}${file}${Theme.R}\n\n`);
      for (const err of list) {
        const block = this.renderRustError(err, cwd)
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n');
        process.stdout.write(block + '\n\n');
      }
    }
  },

  emitLlmBlock(data) {
    const HR = '─'.repeat(53);
    process.stdout.write(
      `\n${HR}\n## LLM CONTEXT\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n${HR}\n\n`,
    );
  },

  formatElapsed(ms) {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  },
};

// --- TASK RUNNERS ---
const TaskRunners = {
  async runLint(fix) {
    if (fix) {
      const r = await CommandRunner.execAsync('npm', ['run', 'lint:fix']);
      return r.ok ? { ok: true } : { ok: false, rawOutput: `${r.stdout}\n${r.stderr}`.trim() };
    }

    const r = await CommandRunner.execAsync('npx', [
      'eslint',
      '.',
      '--max-warnings=0',
      '--format=json',
    ]);
    if (r.ok) return { ok: true };

    try {
      const errors = EslintParser.parse(r.stdout || '[]', process.cwd());
      if (errors.length === 0) return { ok: false, rawOutput: `${r.stdout}\n${r.stderr}`.trim() };

      const errCount = errors.filter((x) => x.severity === 'error').length;
      const warnCount = errors.filter((x) => x.severity === 'warning').length;
      return { ok: false, errors, counts: { errors: errCount, warnings: warnCount } };
    } catch {
      return { ok: false, rawOutput: `${r.stdout}\n${r.stderr}`.trim() };
    }
  },

  async runTypeCheck() {
    const r = await CommandRunner.execAsync('npx', [
      'tsc',
      '-p',
      'tsconfig.json',
      '--noEmit',
      '--pretty',
      'false',
    ]);
    if (r.ok) return { ok: true };

    const text = `${r.stdout}\n${r.stderr}`.trim();
    const errors = TscParser.parse(text);
    if (errors.length === 0) return { ok: false, rawOutput: text };

    const errCount = errors.filter((x) => x.severity === 'error').length;
    const warnCount = errors.filter((x) => x.severity === 'warning').length;
    return { ok: false, errors, counts: { errors: errCount, warnings: warnCount } };
  },

  async runKnip() {
    const r = await CommandRunner.execAsync('npx', ['knip', '--reporter', 'json', '--no-progress']);
    if (r.ok) return { ok: true };

    const stdout = (r.stdout || '').trim();
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    const jsonText = start >= 0 && end > start ? stdout.slice(start, end + 1) : '';
    if (!jsonText) return { ok: false, rawOutput: `${r.stdout}\n${r.stderr}`.trim() };

    const errors = KnipParser.parse(jsonText);
    if (errors.length === 0) return { ok: false, rawOutput: `${r.stdout}\n${r.stderr}`.trim() };

    return { ok: false, errors, counts: { errors: errors.length, warnings: 0 } };
  },

  async runBuild() {
    try {
      rmSync('dist', { recursive: true, force: true });
    } catch (err) {
      return {
        ok: false,
        rawOutput: `dist removal failed: ${String(err && err.message ? err.message : err)}`,
      };
    }
    const r = await CommandRunner.execAsync('npm', ['run', 'build']);
    if (!r.ok) return { ok: false, rawOutput: `${r.stdout}\n${r.stderr}`.trim() };
    return { ok: true };
  },

  async runTest() {
    const history = await HistoryManager.load();
    const silenceMs = HistoryManager.getSilenceTimeout(history);
    const startupMs = Math.max(silenceMs, Config.STARTUP_MIN_MS);
    const ac = new AbortController();

    const child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', '--env-file=.env', '--test', '--no-warnings', '--test-reporter=tap'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.any([ac.signal, runController.signal]),
      },
    );

    const state = {
      seenFirstOk: false,
      lastCompleted: null,
      testDurations: new Map(),
      failures: [],
      currentFailName: null,
      currentOkName: null,
      inYaml: false,
      yamlLines: [],
      stderrBuf: '',
      silenceTimer: null,
      resolved: false,
    };

    // Keep streams from crashing process
    const noop = () => {
      /* ignore */
    };
    child.stdout.on('error', noop);
    child.stderr.on('error', noop);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (state.stderrBuf.length < Config.MAX_STDERR_CHARS) {
        state.stderrBuf += chunk;
        if (state.stderrBuf.length > Config.MAX_STDERR_CHARS) {
          state.stderrBuf = state.stderrBuf.slice(0, Config.MAX_STDERR_CHARS);
        }
      }
    });

    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const { promise, resolve } = Promise.withResolvers();

    const settle = (value) => {
      if (state.resolved) return;
      state.resolved = true;
      if (state.silenceTimer) clearTimeout(state.silenceTimer);
      lines.close();
      resolve(value);
    };

    const handleTimeout = async () => {
      const maxHistorical = Math.max(0, ...Object.values(history.test_durations).flat());
      const phase = state.seenFirstOk ? 'between-tests' : 'startup';
      const ms = state.seenFirstOk ? silenceMs : startupMs;
      try {
        ac.abort(new Error('test silence timeout'));
      } catch {
        /* ignore abort errors */
      }
      // Escalate to forced kill after grace period if child does not exit.
      const killTimer = setTimeout(() => {
        try {
          if (Config.IS_WINDOWS) child.kill();
          else child.kill('SIGKILL');
        } catch {
          /* ignore kill errors */
        }
      }, Config.KILL_GRACE_MS).unref();
      try {
        await once(child, 'close');
      } catch {
        /* ignore close errors */
      }
      clearTimeout(killTimer);
      settle({
        ok: false,
        timeout: true,
        silenceMs: ms,
        phase,
        lastCompletedTest: state.lastCompleted,
        suiteMaxHistoricalMs: maxHistorical,
        rawOutput: state.stderrBuf || undefined,
      });
    };

    let activeTimerMs = startupMs;
    state.silenceTimer = setTimeout(handleTimeout, activeTimerMs).unref();

    const armTimer = () => {
      if (state.seenFirstOk && activeTimerMs !== silenceMs) {
        clearTimeout(state.silenceTimer);
        activeTimerMs = silenceMs;
        state.silenceTimer = setTimeout(handleTimeout, activeTimerMs).unref();
      } else {
        state.silenceTimer.refresh();
      }
    };

    lines.on('line', (line) => {
      armTimer();
      const ev = TapParser.parseLine(line);
      this._handleTapEvent(ev, state, line);
    });

    child.on('error', (err) => {
      if (err && err.name === 'AbortError') return;
      settle({ ok: false, rawOutput: String(err && err.message ? err.message : err) });
    });

    child.on('close', async (code) => {
      if (state.failures.length > 0) {
        settle({ ok: false, failures: state.failures, testDurations: state.testDurations });
        return;
      }
      if (code !== 0) {
        settle({ ok: false, rawOutput: state.stderrBuf || `test runner exited with code ${code}` });
        return;
      }
      try {
        await HistoryManager.save(history, state.testDurations);
      } catch {
        /* best-effort: history write must never crash a green run */
      }
      settle({ ok: true, testDurations: state.testDurations });
    });

    return promise;
  },

  _handleTapEvent(ev, state, line) {
    if (ev.type === 'ok') {
      state.seenFirstOk = true;
      state.lastCompleted = { name: ev.name, duration: ev.duration };
      // Provisional: real duration comes from YAML `duration_ms` block when present.
      state.testDurations.set(ev.name, ev.duration);
      state.currentOkName = ev.name;
      state.inYaml = false;
      state.yamlLines.length = 0;
      state.currentFailName = null;
    } else if (ev.type === 'not_ok') {
      state.seenFirstOk = true;
      state.currentFailName = ev.name;
      state.currentOkName = null;
      state.inYaml = false;
      state.yamlLines.length = 0;
      // Record a minimal failure card immediately; if a YAML diagnostic
      // block follows it will replace this entry with an enriched one.
      state.failures.push({
        name: ev.name,
        file: '',
        expected: undefined,
        actual: undefined,
        errorMessage: undefined,
        frame: null,
      });
    } else if (ev.type === 'yaml_start') {
      state.inYaml = true;
      state.yamlLines.length = 0;
    } else if (ev.type === 'yaml_end' && state.inYaml) {
      state.inYaml = false;
      const yaml = TapParser.parseYaml([...state.yamlLines]);
      if (state.currentFailName) {
        const enriched = {
          name: state.currentFailName,
          file: yaml.at ? yaml.at.replace(/:\d+:\d+$/, '') : '',
          expected: yaml.expected,
          actual: yaml.actual,
          errorMessage: yaml.error,
          frame: yaml.at || null,
        };
        // Replace the most recent matching pending card (added on `not ok`)
        // instead of appending to avoid double-counting failures.
        let replaced = false;
        for (let i = state.failures.length - 1; i >= 0; i--) {
          if (state.failures[i].name === state.currentFailName && !state.failures[i].frame) {
            state.failures[i] = enriched;
            replaced = true;
            break;
          }
        }
        if (!replaced) state.failures.push(enriched);
      } else if (state.currentOkName && yaml.duration_ms !== undefined) {
        const ms = parseFloat(yaml.duration_ms);
        if (Number.isFinite(ms)) {
          state.testDurations.set(state.currentOkName, ms);
          state.lastCompleted = { name: state.currentOkName, duration: ms };
        }
      }
      state.yamlLines.length = 0;
      state.currentFailName = null;
      state.currentOkName = null;
    } else if (state.inYaml) {
      state.yamlLines.push(line);
    }
  },
};

// --- RUN CONFIG ---
const HELP_TEXT = [
  'Usage: node scripts/tasks.mjs [flags]',
  '',
  '  --fix     Run lint:fix / knip --fix instead of check',
  '  --quick   Skip test + rebuild',
  '  --all     Run-all mode: continue past failures across all tasks',
  '  --json    Emit single JSON object on stdout, suppress human output',
  '  --llm     Echo failure detail to stdout (always written to .tasks-last-failure.json)',
  '  --help    Show this help',
  '',
].join('\n');

function parseConfig(args) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        fix: { type: 'boolean' },
        quick: { type: 'boolean' },
        all: { type: 'boolean' },
        json: { type: 'boolean' },
        llm: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    process.stderr.write(`${String(err && err.message ? err.message : err)}\n\n`);
    process.stderr.write(HELP_TEXT);
    process.exitCode = 2;
    return null;
  }

  if (values.help) {
    process.stdout.write(HELP_TEXT);
    process.exitCode = 0;
    return null;
  }
  return {
    fix: !!values.fix,
    quick: !!values.quick,
    all: !!values.all,
    json: !!values.json,
    llm: !!values.llm,
  };
}

// --- AGGREGATE ---
class Aggregate {
  constructor(mode) {
    this.mode = mode; // 'fail-fast' | 'run-all'
    this.tasks = [];
    this.passed = 0;
    this.failed = 0;
    this.skipped = 0;
    this.slowestTests = [];
    this.wallStart = Date.now();
  }

  recordPass(label, ms, annotation) {
    this.tasks.push({
      label,
      ok: true,
      ms,
      skipped: false,
      ...(annotation ? { annotation } : {}),
    });
    this.passed++;
  }

  recordFail(label, result, ms) {
    this.tasks.push({
      label,
      ok: false,
      ms,
      skipped: false,
      ...(result.counts ? { counts: result.counts } : {}),
      ...(result.errors ? { errors: result.errors.slice(0, Config.MAX_ERRORS_IN_FILE) } : {}),
      ...(result.failures ? { failures: result.failures.slice(0, Config.MAX_ERRORS_IN_FILE) } : {}),
      ...(result.timeout
        ? {
            timeout: true,
            phase: result.phase,
            silenceMs: result.silenceMs,
            ...(result.lastCompletedTest ? { lastCompletedTest: result.lastCompletedTest } : {}),
            ...(result.suiteMaxHistoricalMs
              ? { suiteMaxHistoricalMs: result.suiteMaxHistoricalMs }
              : {}),
          }
        : {}),
      ...(result.rawOutput ? { rawOutput: result.rawOutput.slice(0, 4000) } : {}),
    });
    this.failed++;
  }

  recordSkip(label, reason) {
    this.tasks.push({ label, ok: null, ms: 0, skipped: true, skipReason: reason });
    this.skipped++;
  }

  setSlowestTests(testDurations) {
    if (!testDurations || testDurations.size === 0) return;
    // Durations are already in milliseconds (TapParser preserves Node's TAP `# time=` value).
    const sorted = [...testDurations.entries()]
      .map(([name, ms]) => ({ name, ms: typeof ms === 'number' ? ms : 0 }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 5);
    this.slowestTests = sorted;
  }

  wallMs() {
    return Date.now() - this.wallStart;
  }

  failures() {
    return this.tasks.filter((t) => t.ok === false);
  }

  failureSummary() {
    const failed = this.failures();
    if (failed.length === 0) return null;
    return failed
      .map((t) => {
        if (t.timeout) return `${t.label}: timeout`;
        if (t.counts && t.counts.errors) return `${t.label}: ${t.counts.errors} errors`;
        if (t.failures) return `${t.label}: ${t.failures.length} failures`;
        return `${t.label}: failed`;
      })
      .join(', ');
  }
}

// --- REPORTERS ---
class TtyReporter {
  constructor(config, colWidth) {
    this.config = config;
    this.col = colWidth;
    this.tickerHandle = null;
    this.tickerStart = 0;
    this.tickerLabel = null;
    this.useTicker = !!process.stdout.isTTY;
  }

  header() {
    const flags = [];
    if (this.config.fix) flags.push(`${Theme.YELLOW}--fix${Theme.R}`);
    if (this.config.quick) flags.push(`${Theme.YELLOW}--quick${Theme.R}`);
    if (this.config.all) flags.push(`${Theme.YELLOW}--all${Theme.R}`);
    const suffix = flags.length > 0 ? `  ${flags.join('  ')}` : '';
    process.stdout.write(
      `\n  ${Theme.BOLD}gemini-assistant${Theme.R}  ${Theme.DIM}checks${Theme.R}${suffix}\n\n`,
    );
  }

  taskStart(label) {
    this.tickerLabel = label;
    this.tickerStart = Date.now();
    process.stdout.write(
      `\r  ${Icons.RUN}  ${Theme.BOLD}${label.padEnd(this.col)}${Theme.R}${Theme.CLEAR_EOL}`,
    );
    if (!this.useTicker) return;
    this.tickerHandle = setInterval(() => {
      const elapsed = OutputRenderer.formatElapsed(Date.now() - this.tickerStart);
      process.stdout.write(
        `\r  ${Icons.RUN}  ${Theme.BOLD}${label.padEnd(this.col)}${Theme.R}  ${Theme.DIM}${elapsed}${Theme.R}${Theme.CLEAR_EOL}`,
      );
    }, 1000).unref();
  }

  taskEnd(label, result, ms) {
    if (this.tickerHandle) {
      clearInterval(this.tickerHandle);
      this.tickerHandle = null;
    }
    this.tickerLabel = null;

    const counts = result.counts || null;
    let icon;
    if (result.skipped) icon = Icons.SKIP;
    else if (result.ok) icon = Icons.PASS;
    else if (result.timeout) icon = Icons.HANG;
    else icon = Icons.FAIL;

    const time = result.skipped ? '' : OutputRenderer.formatElapsed(ms);
    const left = `\r  ${icon}  ${Theme.BOLD}${label.padEnd(this.col)}${Theme.R}`;

    let right;
    if (result.skipped) {
      right = `${Theme.DIM}${result.skipReason || 'skipped'}${Theme.R}`;
    } else if (counts) {
      const parts = [];
      if (counts.errors)
        parts.push(`${Theme.RED}${counts.errors} error${counts.errors !== 1 ? 's' : ''}${Theme.R}`);
      if (counts.warnings)
        parts.push(
          `${Theme.YELLOW}${counts.warnings} warning${counts.warnings !== 1 ? 's' : ''}${Theme.R}`,
        );
      right = `${Theme.DIM}${time}${Theme.R}${parts.length ? `  ${parts.join(' · ')}` : ''}`;
    } else {
      right = `${Theme.DIM}${time}${Theme.R}`;
      if (result.annotation) right += `  ${Theme.DIM}(${result.annotation})${Theme.R}`;
    }
    process.stdout.write(`${left}  ${right}${Theme.CLEAR_EOL}\n`);
  }

  groupStart(labels) {
    this._grpLabels = [...labels];
    this._grpDone = new Map();
    this._grpStartMs = Date.now();
    if (!this.useTicker) return;
    for (const label of labels) {
      process.stdout.write(
        `  ${Icons.RUN}  ${Theme.BOLD}${label.padEnd(this.col)}${Theme.R}${Theme.CLEAR_EOL}\n`,
      );
    }
    this.tickerHandle = setInterval(() => this._redrawGroup(), 1000).unref();
  }

  _buildGroupLine(label, done, elapsed) {
    if (done) {
      const right = done.counts
        ? `${Theme.DIM}${done.timeStr}${Theme.R}  ${done.counts}`
        : `${Theme.DIM}${done.timeStr}${Theme.R}`;
      return `  ${done.icon}  ${Theme.BOLD}${label.padEnd(this.col)}${Theme.R}  ${right}${Theme.CLEAR_EOL}\n`;
    }
    return `  ${Icons.RUN}  ${Theme.BOLD}${label.padEnd(this.col)}${Theme.R}  ${Theme.DIM}${elapsed}${Theme.R}${Theme.CLEAR_EOL}\n`;
  }

  _redrawGroup() {
    const elapsed = OutputRenderer.formatElapsed(Date.now() - this._grpStartMs);
    process.stdout.write(`\x1b[${this._grpLabels.length}A`);
    for (const label of this._grpLabels) {
      process.stdout.write(this._buildGroupLine(label, this._grpDone.get(label) ?? null, elapsed));
    }
  }

  groupTaskEnd(label, result, ms) {
    const icon = result.ok ? Icons.PASS : result.timeout ? Icons.HANG : Icons.FAIL;
    const timeStr = OutputRenderer.formatElapsed(ms);
    let counts = null;
    if (result.counts) {
      const parts = [];
      if (result.counts.errors)
        parts.push(
          `${Theme.RED}${result.counts.errors} error${result.counts.errors !== 1 ? 's' : ''}${Theme.R}`,
        );
      if (result.counts.warnings)
        parts.push(
          `${Theme.YELLOW}${result.counts.warnings} warning${result.counts.warnings !== 1 ? 's' : ''}${Theme.R}`,
        );
      counts = parts.join(' · ') || null;
    }
    this._grpDone.set(label, { icon, timeStr, counts });
    if (!this.useTicker) {
      const right = counts
        ? `${Theme.DIM}${timeStr}${Theme.R}  ${counts}`
        : `${Theme.DIM}${timeStr}${Theme.R}`;
      process.stdout.write(
        `  ${icon}  ${Theme.BOLD}${label.padEnd(this.col)}${Theme.R}  ${right}${Theme.CLEAR_EOL}\n`,
      );
      return;
    }
    this._redrawGroup();
  }

  groupEnd() {
    if (this.tickerHandle) {
      clearInterval(this.tickerHandle);
      this.tickerHandle = null;
    }
    if (this.useTicker && this._grpLabels) this._redrawGroup();
    this._grpLabels = null;
    this._grpDone = null;
  }

  failureDetail(failedTasks) {
    for (const t of failedTasks) {
      if (t.timeout) {
        const startupPhase = t.phase === 'startup';
        process.stdout.write('\n');
        process.stdout.write(
          `  ${Icons.HANG}  ${Theme.BOLD}TIMED OUT${Theme.R} — ${
            startupPhase
              ? `no TAP output during startup window (${OutputRenderer.formatElapsed(t.silenceMs)})`
              : `no TAP output for ${OutputRenderer.formatElapsed(t.silenceMs)} between tests`
          }\n\n`,
        );
        if (t.lastCompletedTest) {
          process.stdout.write(`  ${Theme.DIM}Last completed test:${Theme.R}\n`);
          process.stdout.write(`  ${Theme.GREEN}✔${Theme.R}  ${t.lastCompletedTest.name}\n\n`);
          process.stdout.write(
            `  ${Theme.DIM}→ The hang likely occurred in the next test after this one.\n` +
              `    Check for: unclosed handles, unresolved promises, missing mock teardown.${Theme.R}\n\n`,
          );
        } else if (startupPhase) {
          process.stdout.write(
            `  ${Theme.DIM}→ Test process produced no TAP lines before the startup window expired.\n` +
              `    Check for: top-level await deadlocks, missing .env / config, slow cold start.${Theme.R}\n\n`,
          );
        }
        continue;
      }
      if (t.failures && t.failures.length > 0) {
        process.stdout.write('\n');
        const cap = Config.MAX_FAILURE_CARDS;
        const shown = t.failures.slice(0, cap);
        for (const f of shown) {
          process.stdout.write(OutputRenderer.renderTestFailureCard(f) + '\n\n');
        }
        if (t.failures.length > cap) {
          process.stdout.write(
            `      ${Theme.DIM}… ${t.failures.length - cap} more failures, see ${Config.FAILURE_FILE}${Theme.R}\n\n`,
          );
        }
        continue;
      }
      if (t.errors && t.errors.length > 0) {
        process.stdout.write('\n');
        OutputRenderer.renderRustErrorsGrouped(t.errors);
        continue;
      }
      if (t.rawOutput) {
        process.stdout.write('\n');
        const split = t.rawOutput.trim().split('\n');
        const shown = split.slice(0, Config.RAW_OUTPUT_MAX_LINES);
        for (const line of shown) process.stdout.write(`      ${Theme.DIM}${line}${Theme.R}\n`);
        if (split.length > Config.RAW_OUTPUT_MAX_LINES) {
          process.stdout.write(
            `      ${Theme.DIM}… ${split.length - Config.RAW_OUTPUT_MAX_LINES} more lines${Theme.R}\n`,
          );
        }
        process.stdout.write('\n');
      }
    }
  }

  summary(aggregate) {
    process.stdout.write('\n');

    if (aggregate.slowestTests.length > 0) {
      process.stdout.write(`  ${Theme.DIM}Slowest tests:${Theme.R}\n`);
      for (const t of aggregate.slowestTests) {
        process.stdout.write(
          `    ${OutputRenderer.formatElapsed(t.ms).padStart(5)}  ${Theme.DIM}${t.name}${Theme.R}\n`,
        );
      }
      process.stdout.write('\n');
    }

    const total = aggregate.tasks.length - aggregate.skipped;
    const wall = OutputRenderer.formatElapsed(aggregate.wallMs());
    if (aggregate.failed === 0) {
      const skippedNote =
        aggregate.skipped > 0 ? `  ${Theme.DIM}(${aggregate.skipped} skipped)${Theme.R}` : '';
      process.stdout.write(
        `  ${Theme.GREEN}${Theme.BOLD}✓${Theme.R}  ${aggregate.passed}/${total} passed${skippedNote}  ${Theme.DIM}${wall}${Theme.R}\n\n`,
      );
      return;
    }

    const summary = aggregate.failureSummary() || 'failed';
    process.stdout.write(
      `  ${Theme.RED}${Theme.BOLD}✗${Theme.R}  ${aggregate.failed} failed: ${summary}  ${Theme.DIM}·${Theme.R}  ${aggregate.passed}/${total} ran  ${Theme.DIM}${wall}${Theme.R}\n`,
    );
    process.stdout.write(`  ${Theme.DIM}✎  failure details → ${Config.FAILURE_FILE}${Theme.R}\n\n`);
  }
}

class JsonReporter {
  constructor(config) {
    this.config = config;
    this.tickerHandle = null;
  }
  header() {
    /* json mode emits a single payload in summary() */
  }
  taskStart() {
    /* no-op */
  }
  taskEnd() {
    /* no-op */
  }
  failureDetail() {
    /* no-op */
  }
  groupStart() {
    /* no-op: json mode emits single payload in summary() */
  }
  groupTaskEnd() {
    /* no-op */
  }
  groupEnd() {
    /* no-op */
  }
  summary(aggregate) {
    const payload = {
      ok: aggregate.failed === 0,
      mode: aggregate.mode,
      wallMs: aggregate.wallMs(),
      tasks: aggregate.tasks,
      slowestTests: aggregate.slowestTests,
      failureSummary: aggregate.failureSummary(),
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  }
}

// --- FAILURE FILE ---
function writeFailureFile(aggregate, file = Config.FAILURE_FILE) {
  const payload = {
    ok: false,
    mode: aggregate.mode,
    wallMs: aggregate.wallMs(),
    tasks: aggregate.tasks,
    slowestTests: aggregate.slowestTests,
    failureSummary: aggregate.failureSummary(),
    timestamp: new Date().toISOString(),
  };
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    renameSync(tmp, file);
  } catch {
    // best-effort: don't crash the script for a failure-detail write error
  }
}

// --- SIGINT ---
function installSigintHandler(reporter, config) {
  let interrupted = false;
  process.on('SIGINT', () => {
    runController.abort();
    const exitCode = convertProcessSignalToExitCode('SIGINT');
    if (interrupted) {
      process.exit(exitCode);
    }
    interrupted = true;
    if (reporter && reporter.tickerHandle) {
      clearInterval(reporter.tickerHandle);
    }
    if (config && config.json) {
      // Keep stdout JSON-only on interrupt.
      process.stderr.write(`\n  interrupted\n\n`);
      process.stdout.write(JSON.stringify({ ok: false, interrupted: true }) + '\n');
    } else {
      process.stdout.write('\x1b[?25h'); // restore cursor
      process.stdout.write(`\n  ${Theme.YELLOW}interrupted${Theme.R}\n\n`);
    }
    process.exit(exitCode);
  });
}

function clearFailureFile(file = Config.FAILURE_FILE) {
  try {
    rmSync(file, { force: true });
  } catch {
    // best-effort: never crash on cleanup
  }
}

// --- ORCHESTRATION ---
class TaskOrchestrator {
  constructor(config) {
    this.config = config;
    this.fix = config.fix;
    this.quick = config.quick;
    this.all = config.all;

    this.tasks = [
      { label: 'format', cmd: ['npm', ['run', this.fix ? 'format' : 'format:check']] },
      { label: 'lint', runner: () => TaskRunners.runLint(this.fix) },
      { label: 'type-check', runner: () => TaskRunners.runTypeCheck() },
      { label: 'knip', runner: () => TaskRunners.runKnip() },
      { label: 'test', runner: () => TaskRunners.runTest(), skip: this.quick },
      { label: 'rebuild', runner: () => TaskRunners.runBuild(), skip: this.quick },
    ];

    this.COL = Math.max(...this.tasks.map((t) => t.label.length)) + 2;
  }

  attemptAutoFix(task, result, reporter) {
    if (!this.fix) return null;
    const errors = result.errors;
    if (!errors || errors.length === 0) return null;
    if (task.label !== 'lint' && task.label !== 'knip') return null;
    if (task.label === 'knip' && !KnipParser.isFixable(errors)) return null;

    if (reporter instanceof TtyReporter) {
      process.stdout.write(
        `\r  ${Icons.FIX}  ${Theme.BOLD}${task.label.padEnd(this.COL)}${Theme.R}  ${Theme.DIM}auto-fixing...${Theme.R}${Theme.CLEAR_EOL}`,
      );
    }

    const fixResult =
      task.label === 'lint'
        ? CommandRunner.exec('npm', ['run', 'lint:fix'])
        : CommandRunner.exec('npx', [
            'knip',
            '--fix',
            '--fix-type',
            'exports,types,dependencies',
            '--format',
          ]);
    if (!fixResult.ok) {
      return {
        ok: false,
        rawOutput: `auto-fix failed:\n${fixResult.stdout}\n${fixResult.stderr}`.trim(),
      };
    }
    return task.runner();
  }

  _gatedOnFailure(task, aggregate) {
    return !this.all && aggregate.failed > 0 && (task.label === 'test' || task.label === 'rebuild');
  }

  async _runTask(task) {
    if (task.runner) return await task.runner();
    if (task.cmd) {
      const [cmd, cmdArgs] = task.cmd;
      const r = await CommandRunner.execAsync(cmd, cmdArgs);
      return r.ok ? { ok: true } : { ok: false, rawOutput: `${r.stdout}\n${r.stderr}`.trim() };
    }
    return { ok: false, rawOutput: 'task has no runner' };
  }

  _finishRun(aggregate, reporter, testDurations = null) {
    if (testDurations) aggregate.setSlowestTests(testDurations);
    reporter.failureDetail(aggregate.failures());
    reporter.summary(aggregate);
    if (aggregate.failed > 0) {
      writeFailureFile(aggregate);
      if (this.config.llm && !this.config.json) {
        OutputRenderer.emitLlmBlock({
          ok: false,
          mode: aggregate.mode,
          tasks: aggregate.tasks,
          failureSummary: aggregate.failureSummary(),
        });
      }
    } else {
      clearFailureFile();
    }
    return aggregate.failed === 0 ? 0 : 1;
  }

  async run() {
    const reporter = this.config.json
      ? new JsonReporter(this.config)
      : new TtyReporter(this.config, this.COL);
    installSigintHandler(reporter, this.config);
    reporter.header();
    if (this.fix) return this._runFixed(reporter);
    return this._runParallel(reporter);
  }

  async _runFixed(reporter) {
    const aggregate = new Aggregate(this.all ? 'run-all' : 'fail-fast');
    let testDurations = null;

    for (const task of this.tasks) {
      if (task.skip) {
        const skipResult = { skipped: true, skipReason: 'skipped' };
        reporter.taskStart(task.label);
        reporter.taskEnd(task.label, skipResult, 0);
        aggregate.recordSkip(task.label, skipResult.skipReason);
        continue;
      }

      if (this._gatedOnFailure(task, aggregate)) {
        const reason = 'gated on prior failure';
        reporter.taskStart(task.label);
        reporter.taskEnd(task.label, { skipped: true, skipReason: reason }, 0);
        aggregate.recordSkip(task.label, reason);
        continue;
      }

      OutputRenderer.clearCache();
      reporter.taskStart(task.label);
      const start = Date.now();
      let result = await this._runTask(task);
      let ms = Date.now() - start;

      if (!result.ok) {
        const fixed = this.attemptAutoFix(task, result, reporter);
        if (fixed !== null) {
          ms = Date.now() - start;
          if (fixed.ok) {
            reporter.taskEnd(task.label, { ok: true, annotation: 'auto-fixed' }, ms);
            aggregate.recordPass(task.label, ms, 'auto-fixed');
            continue;
          }
          result = fixed;
        }
      }

      if (result.ok) {
        reporter.taskEnd(task.label, result, ms);
        aggregate.recordPass(task.label, ms);
        if (task.label === 'test' && result.testDurations) testDurations = result.testDurations;
        continue;
      }

      reporter.taskEnd(task.label, result, ms);
      aggregate.recordFail(task.label, result, ms);
      if (!this.all) break;
    }

    return this._finishRun(aggregate, reporter, testDurations);
  }

  async _runParallel(reporter) {
    const aggregate = new Aggregate(this.all ? 'run-all' : 'fail-fast');
    let testDurations = null;

    const formatTask = this.tasks[0];
    const parallelStaticTasks = this.tasks.slice(1, 4);
    const deepTasks = this.tasks.slice(4);

    // ── Phase 0: format ──────────────────────────────────────────────────
    if (formatTask.skip) {
      reporter.taskStart(formatTask.label);
      reporter.taskEnd(formatTask.label, { skipped: true, skipReason: 'skipped' }, 0);
      aggregate.recordSkip(formatTask.label, 'skipped');
    } else {
      reporter.taskStart(formatTask.label);
      const fStart = Date.now();
      const fResult = await this._runTask(formatTask);
      const fMs = Date.now() - fStart;
      reporter.taskEnd(formatTask.label, fResult, fMs);

      if (fResult.ok) aggregate.recordPass(formatTask.label, fMs);
      else aggregate.recordFail(formatTask.label, fResult, fMs);

      if (aggregate.failed > 0 && !this.all) {
        return this._finishRun(aggregate, reporter);
      }
    }

    // ── Phase 1: lint, type-check, knip in parallel ──────────────────────
    reporter.groupStart(parallelStaticTasks.map((t) => t.label));
    const g1Results = await Promise.all(
      parallelStaticTasks.map(async (task) => {
        OutputRenderer.clearCache();
        const start = Date.now();
        const result = await this._runTask(task);
        const ms = Date.now() - start;
        reporter.groupTaskEnd(task.label, result, ms);
        return { task, result, ms };
      }),
    );
    reporter.groupEnd();

    for (const { task, result, ms } of g1Results) {
      if (result.ok) aggregate.recordPass(task.label, ms);
      else aggregate.recordFail(task.label, result, ms);
    }

    // ── Gate: skip Phase 2 when Phase 1 failed and --all not set ─────────
    if (aggregate.failed > 0 && !this.all) {
      return this._finishRun(aggregate, reporter);
    }

    // ── Phase 2: test + rebuild in parallel ──────────────────────────────
    const activeTasks = deepTasks.filter((task) => {
      if (task.skip) {
        reporter.taskStart(task.label);
        reporter.taskEnd(task.label, { skipped: true, skipReason: 'skipped' }, 0);
        aggregate.recordSkip(task.label, 'skipped');
        return false;
      }
      return true;
    });

    if (activeTasks.length > 0) {
      reporter.groupStart(activeTasks.map((t) => t.label));
      const g2Results = await Promise.all(
        activeTasks.map(async (task) => {
          OutputRenderer.clearCache();
          const start = Date.now();
          const result = await this._runTask(task);
          const ms = Date.now() - start;
          reporter.groupTaskEnd(task.label, result, ms);
          return { task, result, ms };
        }),
      );
      reporter.groupEnd();

      for (const { task, result, ms } of g2Results) {
        if (result.ok) {
          aggregate.recordPass(task.label, ms);
          if (task.label === 'test' && result.testDurations) testDurations = result.testDurations;
        } else {
          aggregate.recordFail(task.label, result, ms);
        }
      }
    }

    return this._finishRun(aggregate, reporter, testDurations);
  }
}

// --- CLI ENTRY ---
const config = parseConfig(process.argv.slice(2));
if (config !== null) {
  process.exitCode = await new TaskOrchestrator(config).run();
}
