#!/usr/bin/env node
// Usage: node scripts/tasks.mjs [--fix] [--fast]
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

// --- CONFIGURATION ---
const Config = {
  HISTORY_FILE: '.tasks-history.json',
  MAX_DURATIONS: 5,
  MIN_SILENCE_MS: 30_000,
  STARTUP_MIN_MS: 30_000,
  MAX_STDERR_BYTES: 256 * 1024,
  RAW_OUTPUT_PREVIEW_LIMIT: 500,
  RAW_OUTPUT_MAX_LINES: 40,
  REBUILD_DELAY_MS: 3_000,
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
  CLEAR_EOL: '\x1b[K',
};

const Icons = {
  PASS: `${Theme.GREEN}✔${Theme.R}`,
  FAIL: `${Theme.RED}✖${Theme.R}`,
  RUN: `${Theme.CYAN}❯${Theme.R}`,
  SKIP: `${Theme.YELLOW}⊘${Theme.R}`,
  HANG: `${Theme.YELLOW}⧖${Theme.R}`,
  FIX: `${Theme.CYAN}↻${Theme.R}`,
};

// --- HISTORY MANAGER ---
const HistoryManager = {
  load(file = Config.HISTORY_FILE) {
    try {
      const raw = readFileSync(file, 'utf8');
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

  save(history, newDurations, file = Config.HISTORY_FILE) {
    for (const [name, ms] of newDurations) {
      const arr = history.test_durations[name] || [];
      arr.push(ms);
      history.test_durations[name] = arr.slice(-Config.MAX_DURATIONS);
    }
    writeFileSync(file, JSON.stringify(history, null, 2) + '\n', 'utf8');
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
      ? spawnSync(`${cmd} ${args.join(' ')}`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: true,
        })
      : spawnSync(cmd, args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        });

    return {
      ok: result.status === 0 && !result.error,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      status: result.status,
    };
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
    const rel = filePath.startsWith(cwd)
      ? filePath.slice(cwd.length + 1).replaceAll('\\', '/')
      : filePath.replaceAll('\\', '/');

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

    const absPath = path.isAbsolute(file) ? file : path.join(cwd, file);
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
  runLint(fix) {
    if (fix) {
      const r = CommandRunner.exec('npm', ['run', 'lint:fix']);
      return r.ok ? { ok: true } : { ok: false, rawOutput: `${r.stdout}\n${r.stderr}`.trim() };
    }

    const r = CommandRunner.exec('npx', ['eslint', '.', '--max-warnings=0', '--format=json']);
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

  runTypeCheck() {
    const r = CommandRunner.exec('npx', [
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

  runKnip() {
    const r = CommandRunner.exec('npx', ['knip', '--reporter', 'json', '--no-progress']);
    if (r.ok) return { ok: true };

    const jsonLine = (r.stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('{'));
    if (!jsonLine) return { ok: false, rawOutput: `${r.stdout}\n${r.stderr}`.trim() };

    const errors = KnipParser.parse(jsonLine);
    if (errors.length === 0) return { ok: false, rawOutput: `${r.stdout}\n${r.stderr}`.trim() };

    return { ok: false, errors, counts: { errors: errors.length, warnings: 0 } };
  },

  async runBuild(taskColWidth) {
    const lbl = 'rebuild'.padEnd(taskColWidth);

    process.stdout.write(
      `\r  ${Icons.RUN}  ${Theme.BOLD}${lbl}${Theme.R}  ${Theme.DIM}removing dist...${Theme.R}${Theme.CLEAR_EOL}`,
    );
    try {
      rmSync('dist', { recursive: true, force: true });
    } catch (err) {
      return {
        ok: false,
        rawOutput: `dist removal failed: ${String(err && err.message ? err.message : err)}`,
      };
    }

    process.stdout.write(
      `\r  ${Icons.RUN}  ${Theme.BOLD}${lbl}${Theme.R}  ${Theme.DIM}settling ${OutputRenderer.formatElapsed(Config.REBUILD_DELAY_MS)}...${Theme.R}${Theme.CLEAR_EOL}`,
    );
    await new Promise((resolve) => setTimeout(resolve, Config.REBUILD_DELAY_MS));

    process.stdout.write(
      `\r  ${Icons.RUN}  ${Theme.BOLD}${lbl}${Theme.R}  ${Theme.DIM}rebuilding...${Theme.R}${Theme.CLEAR_EOL}`,
    );
    const r = CommandRunner.exec('npm', ['run', 'build']);
    if (!r.ok) return { ok: false, rawOutput: `${r.stdout}\n${r.stderr}`.trim() };
    return { ok: true };
  },

  runTest() {
    const history = HistoryManager.load();
    const silenceMs = HistoryManager.getSilenceTimeout(history);
    const startupMs = Math.max(silenceMs, Config.STARTUP_MIN_MS);
    const ac = new AbortController();

    const child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', '--env-file=.env', '--test', '--no-warnings', '--test-reporter=tap'],
      { stdio: ['ignore', 'pipe', 'pipe'], signal: ac.signal },
    );

    const state = {
      seenFirstOk: false,
      lastCompleted: null,
      testDurations: new Map(),
      failures: [],
      currentFailName: null,
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
      if (state.stderrBuf.length < Config.MAX_STDERR_BYTES) {
        state.stderrBuf += chunk;
        if (state.stderrBuf.length > Config.MAX_STDERR_BYTES) {
          state.stderrBuf = state.stderrBuf.slice(0, Config.MAX_STDERR_BYTES);
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

    const armTimer = () => {
      if (state.silenceTimer) clearTimeout(state.silenceTimer);
      const ms = state.seenFirstOk ? silenceMs : startupMs;
      state.silenceTimer = setTimeout(() => {
        const maxHistorical = Math.max(0, ...Object.values(history.test_durations).flat());
        ac.abort();
        settle({
          ok: false,
          timeout: true,
          silenceMs: ms,
          phase: state.seenFirstOk ? 'between-tests' : 'startup',
          lastCompletedTest: state.lastCompleted,
          suiteMaxHistoricalMs: maxHistorical,
        });
      }, ms);
    };

    armTimer();

    lines.on('line', (line) => {
      armTimer();
      const ev = TapParser.parseLine(line);
      this._handleTapEvent(ev, state, line);
    });

    child.on('error', (err) => {
      if (err && err.name === 'AbortError') return;
      settle({ ok: false, rawOutput: String(err && err.message ? err.message : err) });
    });

    child.on('close', (code) => {
      if (state.failures.length > 0) {
        settle({ ok: false, failures: state.failures, testDurations: state.testDurations });
        return;
      }
      if (code !== 0) {
        settle({ ok: false, rawOutput: state.stderrBuf || `test runner exited with code ${code}` });
        return;
      }
      HistoryManager.save(history, state.testDurations);
      settle({ ok: true, testDurations: state.testDurations });
    });

    return promise;
  },

  _handleTapEvent(ev, state, line) {
    if (ev.type === 'ok') {
      state.seenFirstOk = true;
      state.lastCompleted = { name: ev.name, duration: ev.duration };
      state.testDurations.set(ev.name, ev.duration);
      state.inYaml = false;
      state.yamlLines.length = 0;
      state.currentFailName = null;
    } else if (ev.type === 'not_ok') {
      state.seenFirstOk = true;
      state.currentFailName = ev.name;
      state.inYaml = false;
      state.yamlLines.length = 0;
    } else if (ev.type === 'yaml_start') {
      state.inYaml = true;
      state.yamlLines.length = 0;
    } else if (ev.type === 'yaml_end' && state.inYaml) {
      state.inYaml = false;
      const yaml = TapParser.parseYaml([...state.yamlLines]);
      if (state.currentFailName) {
        state.failures.push({
          name: state.currentFailName,
          file: yaml.at ? yaml.at.replace(/:\d+:\d+$/, '') : '',
          expected: yaml.expected,
          actual: yaml.actual,
          errorMessage: yaml.error,
          frame: yaml.at || null,
        });
      }
      state.yamlLines.length = 0;
      state.currentFailName = null;
    } else if (state.inYaml) {
      state.yamlLines.push(line);
    }
  },
};

// --- ORCHESTRATION ---
class TaskOrchestrator {
  constructor(argsSet) {
    this.fix = argsSet.has('--fix');
    this.fast = argsSet.has('--fast');

    this.tasks = [
      { label: 'format', cmd: ['npm', ['run', 'format']] },
      { label: 'lint', runner: () => TaskRunners.runLint(this.fix) },
      { label: 'type-check', runner: () => TaskRunners.runTypeCheck() },
      { label: 'knip', runner: () => TaskRunners.runKnip() },
      { label: 'test', runner: () => TaskRunners.runTest(), skip: this.fast },
      { label: 'rebuild', runner: () => TaskRunners.runBuild(this.COL), skip: this.fast },
    ];

    this.COL = Math.max(...this.tasks.map((t) => t.label.length)) + 2;
  }

  printHeader() {
    const mode = this.fix
      ? `${Theme.YELLOW}--fix${Theme.R}`
      : this.fast
        ? `${Theme.YELLOW}--fast${Theme.R}`
        : '';
    const suffix = mode ? `  ${mode}` : '';
    process.stdout.write(
      `\n  ${Theme.BOLD}gemini-assistant${Theme.R}  ${Theme.DIM}checks${Theme.R}${suffix}\n\n`,
    );
  }

  printTask(icon, label, time, skipped, counts, annotation = null) {
    const col = label.padEnd(this.COL);
    let right = skipped ? `${Theme.DIM}skipped${Theme.R}` : `${Theme.DIM}${time}${Theme.R}`;
    if (annotation) right += `  ${Theme.DIM}(${annotation})${Theme.R}`;

    if (counts) {
      const parts = [];
      if (counts.errors)
        parts.push(`${Theme.RED}${counts.errors} error${counts.errors !== 1 ? 's' : ''}${Theme.R}`);
      if (counts.warnings)
        parts.push(
          `${Theme.YELLOW}${counts.warnings} warning${counts.warnings !== 1 ? 's' : ''}${Theme.R}`,
        );
      if (parts.length > 0) right = `${Theme.DIM}${time}${Theme.R}  ${parts.join(' · ')}`;
    }
    process.stdout.write(
      `\r  ${icon}  ${Theme.BOLD}${col}${Theme.R}  ${right}${Theme.CLEAR_EOL}\n`,
    );
  }

  printOutput(raw) {
    if (!raw) return;
    const split = raw.trim().split('\n');
    const shown = split.slice(0, Config.RAW_OUTPUT_MAX_LINES);
    process.stdout.write('\n');
    for (const line of shown) process.stdout.write(`      ${Theme.DIM}${line}${Theme.R}\n`);
    if (split.length > Config.RAW_OUTPUT_MAX_LINES) {
      process.stdout.write(
        `      ${Theme.DIM}… ${split.length - Config.RAW_OUTPUT_MAX_LINES} more lines${Theme.R}\n`,
      );
    }
    process.stdout.write('\n');
  }

  attemptAutoFix(task, result) {
    const errors = result.errors;
    if (!errors || errors.length === 0) return null;
    if (task.label !== 'lint' && task.label !== 'knip') return null;
    if (task.label === 'knip' && !KnipParser.isFixable(errors)) return null;

    process.stdout.write(
      `\r  ${Icons.FIX}  ${Theme.BOLD}${task.label.padEnd(this.COL)}${Theme.R}  ${Theme.DIM}auto-fixing...${Theme.R}${Theme.CLEAR_EOL}`,
    );

    if (task.label === 'lint') {
      CommandRunner.exec('npm', ['run', 'lint:fix']);
    } else {
      CommandRunner.exec('npx', [
        'knip',
        '--fix',
        '--fix-type',
        'exports,types,dependencies',
        '--format',
      ]);
    }
    return task.runner();
  }

  handleFailure(task, result, ms) {
    const counts = result.counts || null;
    this.printTask(
      result.timeout ? Icons.HANG : Icons.FAIL,
      task.label,
      OutputRenderer.formatElapsed(ms),
      false,
      counts,
    );

    if (result.timeout) {
      return this._handleTimeoutFailure(task, result);
    }
    if (result.failures && result.failures.length > 0) {
      return this._handleTestFailures(task, result);
    }
    if (result.errors && result.errors.length > 0) {
      return this._handleLinterErrors(task, result, counts);
    }
    if (result.rawOutput) {
      this.printOutput(result.rawOutput);
      return {
        failed_task: task.label,
        status: 'failed',
        raw_output_preview: result.rawOutput.slice(0, Config.RAW_OUTPUT_PREVIEW_LIMIT),
      };
    }
    return null;
  }

  _handleTimeoutFailure(task, result) {
    const startupPhase = result.phase === 'startup';
    process.stdout.write('\n');
    process.stdout.write(
      `  ${Icons.HANG}  ${Theme.BOLD}TIMED OUT${Theme.R} — ${
        startupPhase
          ? `no TAP output during startup window (${OutputRenderer.formatElapsed(result.silenceMs)})`
          : `no TAP output for ${OutputRenderer.formatElapsed(result.silenceMs)} between tests`
      }\n\n`,
    );

    if (result.lastCompletedTest) {
      process.stdout.write(`  ${Theme.DIM}Last completed test:${Theme.R}\n`);
      process.stdout.write(`  ${Theme.GREEN}✔${Theme.R}  ${result.lastCompletedTest.name}\n\n`);
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

    return {
      failed_task: task.label,
      status: 'timeout',
      phase: result.phase || 'between-tests',
      silence_duration_ms: result.silenceMs,
      last_completed_test: result.lastCompletedTest || null,
      suite_max_historical_ms: result.suiteMaxHistoricalMs || 0,
      hint: startupPhase
        ? 'Test process produced no TAP output before the startup window expired.'
        : 'Process produced no TAP output for the silence threshold.',
    };
  }

  _handleTestFailures(task, result) {
    process.stdout.write('\n');
    for (const f of result.failures) {
      process.stdout.write(OutputRenderer.renderTestFailureCard(f) + '\n\n');
    }
    return {
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
  }

  _handleLinterErrors(task, result, counts) {
    process.stdout.write('\n');
    for (const err of result.errors) {
      process.stdout.write(OutputRenderer.renderRustError(err) + '\n\n');
    }
    return {
      failed_task: task.label,
      status: 'failed',
      total_errors: counts && counts.errors ? counts.errors : 0,
      total_warnings: counts && counts.warnings ? counts.warnings : 0,
      errors: result.errors.map(({ file, line, col, rule, severity, message }) => ({
        file,
        line,
        col,
        rule,
        severity,
        message,
      })),
    };
  }

  async run() {
    this.printHeader();
    let passed = 0,
      failed = 0,
      skipped = 0;
    const wallStart = Date.now();
    let llmPayload = null;

    for (const task of this.tasks) {
      if (task.skip) {
        this.printTask(Icons.SKIP, task.label, '', true, null);
        skipped++;
        continue;
      }

      process.stdout.write(
        `\r  ${Icons.RUN}  ${Theme.BOLD}${task.label.padEnd(this.COL)}${Theme.R}${Theme.CLEAR_EOL}`,
      );
      OutputRenderer.clearCache();

      const { result, ms } = await this._executeTask(task);

      if (!result.ok) {
        let finalResult = result;
        let finalMs = ms;

        const fixed = this.attemptAutoFix(task, result);
        if (fixed !== null) {
          finalMs = Date.now() - (wallStart + ms);
          if (fixed.ok) {
            this.printTask(
              Icons.PASS,
              task.label,
              OutputRenderer.formatElapsed(finalMs),
              false,
              null,
              'auto-fixed',
            );
            passed++;
            continue;
          }
          finalResult = fixed;
        }

        llmPayload = this.handleFailure(task, finalResult, finalMs);
        failed++;
        break;
      }

      this.printTask(Icons.PASS, task.label, OutputRenderer.formatElapsed(ms), false, null);
      passed++;
    }

    if (llmPayload) OutputRenderer.emitLlmBlock(llmPayload);

    const total = this.tasks.length - skipped;
    const wall = OutputRenderer.formatElapsed(Date.now() - wallStart);

    process.stdout.write('\n');
    if (failed === 0) {
      const label = this.fast
        ? `${passed}/${total} passed  ${Theme.DIM}(test skipped)${Theme.R}`
        : `${passed}/${total} passed`;
      process.stdout.write(
        `  ${Theme.GREEN}${Theme.BOLD}✓${Theme.R}  ${label}  ${Theme.DIM}${wall}${Theme.R}\n\n`,
      );
      return 0;
    }

    process.stdout.write(
      `  ${Theme.RED}${Theme.BOLD}✗${Theme.R}  ${passed}/${total} passed  ${Theme.RED}${failed} failed${Theme.R}  ${Theme.DIM}${wall}${Theme.R}\n\n`,
    );
    return 1;
  }

  async _executeTask(task) {
    const start = Date.now();
    let result;

    if (task.runner) {
      result = await task.runner();
    } else if (task.cmd) {
      const [cmd, cmdArgs] = task.cmd;
      const r = CommandRunner.exec(cmd, cmdArgs);
      result = r.ok ? { ok: true } : { ok: false, rawOutput: `${r.stdout}\n${r.stderr}`.trim() };
    }

    return { result, ms: Date.now() - start };
  }
}

// --- CLI ENTRY ---
const argsSet = new Set(process.argv.slice(2));
process.exitCode = await new TaskOrchestrator(argsSet).run();
