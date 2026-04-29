#!/usr/bin/env node
// Usage: node scripts/tasks.mjs [--fix] [--quick] [--all] [--json] [--llm] [--help]
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { parseArgs } from 'node:util';

const runController = new AbortController();

const Config = Object.freeze({
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
});

const Theme = Object.freeze({
  R: '\x1b[0m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  CYAN: '\x1b[36m',
  BLUE: '\x1b[34m',
  CLEAR_EOL: '\x1b[K',
});

const Icons = Object.freeze({
  PASS: `${Theme.GREEN}✔${Theme.R}`,
  FAIL: `${Theme.RED}✖${Theme.R}`,
  RUN: `${Theme.BLUE}❯${Theme.R}`,
  SKIP: `${Theme.YELLOW}⊘${Theme.R}`,
  HANG: `${Theme.YELLOW}⧖${Theme.R}`,
  FIX: `${Theme.CYAN}↻${Theme.R}`,
});

const SignalExitCodes = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

function signalExitCode(signalName) {
  return SignalExitCodes[signalName] ?? 128;
}

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

const Text = {
  normalizePath(value) {
    return String(value || '').replaceAll('\\', '/');
  },

  joinOutput(stdout = '', stderr = '') {
    return `${stdout || ''}\n${stderr || ''}`.trim();
  },

  cap(value, maxChars) {
    const text = String(value || '');
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  },

  appendCapped(current, chunk, maxChars) {
    if (current.length >= maxChars) return { value: current, truncated: true };
    const remaining = maxChars - current.length;
    if (chunk.length > remaining) {
      return { value: current + chunk.slice(0, remaining), truncated: true };
    }
    return { value: current + chunk, truncated: false };
  },

  elapsed(ms) {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  },

  plural(count, singular) {
    return `${count} ${singular}${count === 1 ? '' : 's'}`;
  },
};

const Json = {
  parse(value, fallback = null) {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  },
};

const FileStore = {
  async readJson(file, fallback) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return fallback;
    }
  },

  async writeJsonAtomic(file, payload) {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    await rename(tmp, file);
  },

  writeJsonAtomicSync(file, payload) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    renameSync(tmp, file);
  },

  removeSync(file) {
    try {
      rmSync(file, { force: true });
    } catch {
      // best-effort cleanup only
    }
  },
};

const Results = {
  pass(extra = {}) {
    return { ok: true, ...extra };
  },

  fail(extra = {}) {
    return { ok: false, ...extra };
  },

  skip(reason = 'skipped') {
    return { ok: null, skipped: true, skipReason: reason };
  },

  raw(stdout = '', stderr = '', prefix = '') {
    const output = Text.joinOutput(stdout, stderr);
    return this.fail({ rawOutput: prefix ? `${prefix}\n${output}`.trim() : output });
  },

  diagnostics(errors) {
    const counts = countDiagnostics(errors);
    return this.fail({ errors, counts });
  },
};

function countDiagnostics(errors) {
  let errorCount = 0;
  let warningCount = 0;
  for (const diagnostic of errors || []) {
    if (diagnostic.severity === 'warning') warningCount++;
    else errorCount++;
  }
  return { errors: errorCount, warnings: warningCount };
}

function parseCliConfig(args) {
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
    process.stderr.write(`${err?.message || String(err)}\n\n${HELP_TEXT}`);
    process.exitCode = 2;
    return null;
  }

  if (values.help) {
    process.stdout.write(HELP_TEXT);
    process.exitCode = 0;
    return null;
  }

  return Object.freeze({
    fix: !!values.fix,
    quick: !!values.quick,
    all: !!values.all,
    json: !!values.json,
    llm: !!values.llm,
  });
}

const ProcessRunner = {
  command(cmd, args) {
    if (Config.IS_WINDOWS && (cmd === 'npm' || cmd === 'npx')) {
      return {
        cmd: 'cmd.exe',
        args: ['/d', '/c', cmd, ...args],
        windowsVerbatimArguments: true,
      };
    }
    return { cmd, args, windowsVerbatimArguments: false };
  },

  spawnOptions(command, { signal, stdio = ['ignore', 'pipe', 'pipe'], encoding } = {}) {
    return {
      ...(stdio ? { stdio } : {}),
      ...(encoding ? { encoding } : {}),
      ...(signal ? { signal } : {}),
      ...(Config.IS_WINDOWS ? { windowsHide: true } : {}),
      ...(command.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    };
  },

  exec(cmd, args) {
    const command = this.command(cmd, args);
    const result = spawnSync(
      command.cmd,
      command.args,
      this.spawnOptions(command, { encoding: 'utf8' }),
    );

    return {
      ok: result.status === 0 && !result.error,
      stdout: result.stdout || '',
      stderr: result.stderr || (result.error ? result.error.message : ''),
      status: result.status,
      signal: result.signal,
    };
  },

  async execAsync(cmd, args, options = {}) {
    const {
      signal = runController.signal,
      maxStdout = Config.MAX_STDOUT_CHARS,
      maxStderr = Config.MAX_STDERR_CHARS_EXEC,
    } = options;
    const command = this.command(cmd, args);

    return new Promise((resolve) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      let truncatedStdout = false;
      let truncatedStderr = false;

      const settle = (payload) => {
        if (settled) return;
        settled = true;
        resolve(payload);
      };

      let child;
      try {
        child = spawn(command.cmd, command.args, this.spawnOptions(command, { signal }));
      } catch (err) {
        settle({
          ok: false,
          stdout: '',
          stderr: err?.message || String(err),
          status: null,
          signal: null,
          truncatedStdout: false,
          truncatedStderr: false,
        });
        return;
      }

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        const next = Text.appendCapped(stdout, chunk, maxStdout);
        stdout = next.value;
        truncatedStdout ||= next.truncated;
      });
      child.stderr?.on('data', (chunk) => {
        const next = Text.appendCapped(stderr, chunk, maxStderr);
        stderr = next.value;
        truncatedStderr ||= next.truncated;
      });
      child.on('close', (code, signalName) => {
        settle({
          ok: code === 0,
          stdout,
          stderr,
          status: code,
          signal: signalName,
          truncatedStdout,
          truncatedStderr,
        });
      });
      child.on('error', (err) => {
        if (err?.name === 'AbortError') return;
        settle({
          ok: false,
          stdout,
          stderr: err?.message || String(err),
          status: null,
          signal: null,
          truncatedStdout,
          truncatedStderr,
        });
      });
    });
  },
};

const HistoryManager = {
  async load(file = Config.HISTORY_FILE) {
    const parsed = await FileStore.readJson(file, null);
    return this.sanitize(parsed);
  },

  sanitize(parsed) {
    const test_durations = Object.create(null);
    const src = parsed && typeof parsed === 'object' ? parsed.test_durations : null;
    if (!src || typeof src !== 'object') return { test_durations };

    for (const key of Object.keys(src)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const value = src[key];
      if (!Array.isArray(value)) continue;
      test_durations[key] = value.filter((n) => typeof n === 'number' && Number.isFinite(n));
    }
    return { test_durations };
  },

  async save(history, newDurations, file = Config.HISTORY_FILE) {
    for (const [name, ms] of newDurations || []) {
      const arr = history.test_durations[name] || [];
      arr.push(ms);
      history.test_durations[name] = arr.slice(-Config.MAX_DURATIONS);
    }
    await FileStore.writeJsonAtomic(file, history);
  },

  getSilenceTimeout(history) {
    const all = Object.values(history.test_durations).flat();
    if (all.length === 0) return Config.MIN_SILENCE_MS;
    return Math.max(Config.MIN_SILENCE_MS, 10 * Math.max(...all));
  },
};

const EslintParser = {
  parse(jsonText, cwd) {
    const results = Json.parse(jsonText, []);
    if (!Array.isArray(results)) return [];

    const errors = [];
    for (const file of results) {
      const messages = Array.isArray(file?.messages) ? file.messages : [];
      if (messages.length === 0) continue;
      const rel = Text.normalizePath(path.relative(cwd, file.filePath || ''));
      for (const msg of messages) errors.push(this.toDiagnostic(msg, rel));
    }
    return errors;
  },

  toDiagnostic(msg, file) {
    const col = msg.column || 1;
    return {
      file,
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
    for (const line of String(text || '').split('\n')) {
      const match = this.RE.exec(line);
      if (!match) continue;
      errors.push({
        file: Text.normalizePath(match[1]),
        line: Number(match[2]),
        col: Number(match[3]),
        endCol: Number(match[3]) + 3,
        rule: match[5],
        severity: match[4],
        message: match[6],
      });
    }
    return errors;
  },
};

const KnipParser = {
  RULES: Object.freeze({
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
  }),

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
    return Array.isArray(errors) && errors.some((error) => this.FIXABLE_RULES.has(error.rule));
  },

  parse(jsonText) {
    const parsed = Json.parse(jsonText, {});
    const rows = Array.isArray(parsed?.issues) ? parsed.issues : [];
    const errors = [];
    for (const row of rows) this.parseRow(row, errors);
    return errors;
  },

  extractJson(stdout) {
    const text = String(stdout || '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    return start >= 0 && end > start ? text.slice(start, end + 1) : '';
  },

  parseRow(row, errors) {
    const file = row?.file ? Text.normalizePath(row.file) : '';
    if (!file) return;

    for (const [category, meta] of Object.entries(this.RULES)) {
      const list = row[category];
      if (!Array.isArray(list) || list.length === 0) continue;
      if (category === 'duplicates') this.pushDuplicateErrors(errors, file, list);
      else for (const entry of list) this.pushError(errors, file, category, meta, entry);
    }
  },

  pushDuplicateErrors(errors, file, groups) {
    for (const group of groups) {
      if (!Array.isArray(group) || group.length === 0) continue;
      const names = group
        .map((item) => item?.name)
        .filter(Boolean)
        .join(', ');
      const first = group[0] || {};
      this.pushError(errors, file, 'duplicates', this.RULES.duplicates, {
        name: names || 'duplicate',
        line: first.line,
        col: first.col,
      });
    }
  },

  parsePos(val) {
    return Number.isInteger(val) && val > 0 ? val : 1;
  },

  normalizeEntry(entry) {
    const line = this.parsePos(entry?.line);
    const col = this.parsePos(entry?.col);
    const name = entry?.name || '';
    const namespace = entry?.namespace ? `${entry.namespace}.` : '';
    return { line, col, name, namespace };
  },

  pushError(errors, file, category, meta, entry) {
    const { line, col, name, namespace } = this.normalizeEntry(entry);
    const message =
      category === 'files'
        ? 'Unused file (no references found)'
        : `${meta.label}: ${namespace}${name}`;

    errors.push({
      file,
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
    const indent = line.match(/^(\s*)/)?.[1]?.length || 0;
    const ok = this.OK_RE.exec(line);
    if (ok) {
      return {
        type: 'ok',
        depth: indent,
        name: ok[1].trim(),
        duration: ok[2] ? parseFloat(ok[2]) : 0,
      };
    }

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
      if (multiKey === null) return;
      result[multiKey] = multiLines.join('\n').trim();
      multiKey = null;
      multiLines.length = 0;
    };

    for (const raw of lines) {
      const trimmed = raw.trim();
      const kv = this.YAML_KV_RE.exec(trimmed);

      if (kv) {
        flushMulti();
        this.writeYamlKv(result, kv, (key) => {
          multiKey = key;
        });
      } else if (multiKey !== null) {
        multiLines.push(trimmed);
      }
    }
    flushMulti();

    if (!result.at && result.stack) {
      const match = this.YAML_BLOCK_FRAME_RE.exec(result.stack);
      if (match && !match[1].startsWith('node:')) result.at = match[1];
    }
    return result;
  },

  writeYamlKv(result, kv, setMultiKey) {
    const [, key, value] = kv;
    if (value === '|-' || value === '|') {
      setMultiKey(key);
      return;
    }
    result[key] = value.replace(/^'|'$/g, '');
  },
};

class TestTapState {
  constructor() {
    this.seenFirstOk = false;
    this.lastCompleted = null;
    this.testDurations = new Map();
    this.failures = [];
    this.currentFailName = null;
    this.currentFailIndex = -1;
    this.currentOkName = null;
    this.inYaml = false;
    this.yamlLines = [];
    this.stderrBuf = '';
  }

  appendStderr(chunk) {
    const next = Text.appendCapped(this.stderrBuf, chunk, Config.MAX_STDERR_CHARS);
    this.stderrBuf = next.value;
  }

  handleLine(line) {
    const ev = TapParser.parseLine(line);
    if (ev.type === 'ok') return this.handleOk(ev);
    if (ev.type === 'not_ok') return this.handleNotOk(ev);
    if (ev.type === 'yaml_start') return this.startYaml();
    if (ev.type === 'yaml_end' && this.inYaml) return this.endYaml();
    if (this.inYaml) this.yamlLines.push(line);
  }

  handleOk(ev) {
    this.seenFirstOk = true;
    this.lastCompleted = { name: ev.name, duration: ev.duration };
    this.testDurations.set(ev.name, ev.duration);
    this.currentOkName = ev.name;
    this.currentFailName = null;
    this.inYaml = false;
    this.yamlLines.length = 0;
  }

  handleNotOk(ev) {
    this.seenFirstOk = true;
    this.currentFailName = ev.name;
    this.currentOkName = null;
    this.inYaml = false;
    this.yamlLines.length = 0;
    this.currentFailIndex = this.failures.length;
    this.failures.push({
      name: ev.name,
      file: '',
      expected: undefined,
      actual: undefined,
      errorMessage: undefined,
      frame: null,
    });
  }

  startYaml() {
    this.inYaml = true;
    this.yamlLines.length = 0;
  }

  endYaml() {
    this.inYaml = false;
    const yaml = TapParser.parseYaml([...this.yamlLines]);
    if (this.currentFailName) this.enrichCurrentFailure(yaml);
    else if (this.currentOkName && yaml.duration_ms !== undefined) this.updateCurrentDuration(yaml);
    this.yamlLines.length = 0;
    this.currentFailName = null;
    this.currentOkName = null;
  }

  enrichCurrentFailure(yaml) {
    const enriched = {
      name: this.currentFailName,
      file: yaml.at ? yaml.at.replace(/:\d+:\d+$/, '') : '',
      expected: yaml.expected,
      actual: yaml.actual,
      errorMessage: yaml.error,
      frame: yaml.at || null,
    };

    if (
      this.currentFailIndex >= 0 &&
      this.failures[this.currentFailIndex].name === this.currentFailName
    ) {
      this.failures[this.currentFailIndex] = enriched;
    } else {
      this.failures.push(enriched);
    }
  }

  updateCurrentDuration(yaml) {
    const ms = parseFloat(yaml.duration_ms);
    if (!Number.isFinite(ms)) return;
    this.testDurations.set(this.currentOkName, ms);
    this.lastCompleted = { name: this.currentOkName, duration: ms };
  }
}

class TestRunner {
  constructor({ historyManager = HistoryManager, signal = runController.signal } = {}) {
    this.historyManager = historyManager;
    this.signal = signal;
  }

  async run() {
    const history = await this.historyManager.load();
    const silenceMs = this.historyManager.getSilenceTimeout(history);
    const startupMs = Math.max(silenceMs, Config.STARTUP_MIN_MS);
    const abortController = new AbortController();
    const state = new TestTapState();

    const child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', '--env-file=.env', '--test', '--no-warnings', '--test-reporter=tap'],
      ProcessRunner.spawnOptions(
        {},
        { signal: AbortSignal.any([abortController.signal, this.signal]) },
      ),
    );

    child.stdout?.on('error', noop);
    child.stderr?.on('error', noop);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => state.appendStderr(chunk));

    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const { promise, resolve } = Promise.withResolvers();
    let resolved = false;
    let activeTimerMs = startupMs;
    let silenceTimer;

    const settle = (value) => {
      if (resolved) return;
      resolved = true;
      if (silenceTimer) clearTimeout(silenceTimer);
      lines.close();
      resolve(value);
    };

    const forceKillAfterGrace = () => {
      const timer = setTimeout(() => {
        try {
          if (Config.IS_WINDOWS) child.kill();
          else child.kill('SIGKILL');
        } catch {
          // ignore kill errors
        }
      }, Config.KILL_GRACE_MS).unref();
      return timer;
    };

    const handleTimeout = async () => {
      const maxHistorical = Math.max(0, ...Object.values(history.test_durations).flat());
      const phase = state.seenFirstOk ? 'between-tests' : 'startup';
      const ms = state.seenFirstOk ? silenceMs : startupMs;
      try {
        abortController.abort(new Error('test silence timeout'));
      } catch {
        // ignore abort errors
      }

      const killTimer = forceKillAfterGrace();
      try {
        await once(child, 'close');
      } catch {
        // ignore close errors
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

    silenceTimer = setTimeout(handleTimeout, activeTimerMs).unref();

    const armTimer = () => {
      if (state.seenFirstOk && activeTimerMs !== silenceMs) {
        clearTimeout(silenceTimer);
        activeTimerMs = silenceMs;
        silenceTimer = setTimeout(handleTimeout, activeTimerMs).unref();
        return;
      }
      silenceTimer.refresh();
    };

    lines.on('line', (line) => {
      armTimer();
      state.handleLine(line);
    });

    child.on('error', (err) => {
      if (err?.name === 'AbortError') return;
      settle(Results.fail({ rawOutput: err?.message || String(err) }));
    });

    child.on('close', async (code) => {
      if (state.failures.length > 0) {
        settle(Results.fail({ failures: state.failures, testDurations: state.testDurations }));
        return;
      }

      if (code !== 0) {
        settle(
          Results.fail({ rawOutput: state.stderrBuf || `test runner exited with code ${code}` }),
        );
        return;
      }

      try {
        await this.historyManager.save(history, state.testDurations);
      } catch {
        // best-effort: history write must never fail a green run
      }
      settle(Results.pass({ testDurations: state.testDurations }));
    });

    return promise;
  }
}

const TaskCommands = {
  format(config) {
    return ['npm', ['run', config.fix ? 'format' : 'format:check']];
  },

  lintCheck() {
    return ['npx', ['eslint', '.', '--max-warnings=0', '--format=json']];
  },

  lintFix() {
    return ['npm', ['run', 'lint:fix']];
  },

  typeCheck() {
    return ['npx', ['tsc', '-p', 'tsconfig.json', '--noEmit', '--pretty', 'false']];
  },

  knipCheck() {
    return ['npx', ['knip', '--reporter', 'json', '--no-progress']];
  },

  knipFix() {
    return ['npx', ['knip', '--fix', '--fix-type', 'exports,types,dependencies', '--format']];
  },

  build() {
    return ['npm', ['run', 'build']];
  },
};

const TaskRunners = {
  async command(cmd, args) {
    const result = await ProcessRunner.execAsync(cmd, args);
    return result.ok ? Results.pass() : Results.raw(result.stdout, result.stderr);
  },

  async diagnosticCommand({ command, parse, output = (result) => result.stdout }) {
    const [cmd, args] = command;
    const result = await ProcessRunner.execAsync(cmd, args);
    if (result.ok) return Results.pass();

    const text = output(result);
    const errors = parse(text);
    if (errors.length === 0) return Results.raw(result.stdout, result.stderr);
    return Results.diagnostics(errors);
  },

  async runFormat(config) {
    return this.command(...TaskCommands.format(config));
  },

  async runLint(fix) {
    if (fix) {
      const result = await this.command(...TaskCommands.lintFix());
      if (!result.ok) return result;
      // Validate after mutating so a green --fix cannot hide residual lint errors.
    }
    return this.diagnosticCommand({
      command: TaskCommands.lintCheck(),
      parse: (stdout) => EslintParser.parse(stdout || '[]', process.cwd()),
    });
  },

  async runTypeCheck() {
    return this.diagnosticCommand({
      command: TaskCommands.typeCheck(),
      parse: (text) => TscParser.parse(text),
      output: (result) => Text.joinOutput(result.stdout, result.stderr),
    });
  },

  async runKnip() {
    return this.diagnosticCommand({
      command: TaskCommands.knipCheck(),
      parse: (stdout) => KnipParser.parse(KnipParser.extractJson(stdout)),
      output: (result) => result.stdout,
    });
  },

  async runBuild() {
    try {
      rmSync('dist', { recursive: true, force: true });
    } catch (err) {
      return Results.fail({ rawOutput: `dist removal failed: ${err?.message || String(err)}` });
    }
    return this.command(...TaskCommands.build());
  },

  async runTest() {
    return new TestRunner().run();
  },
};

class SourceCache {
  constructor() {
    this.cache = new Map();
  }

  clear() {
    this.cache.clear();
  }

  lines(filePath) {
    if (this.cache.has(filePath)) return this.cache.get(filePath);
    let lines;
    try {
      lines = readFileSync(filePath, 'utf8').split('\n');
    } catch {
      lines = [];
    }
    this.cache.set(filePath, lines);
    return lines;
  }
}

const sourceCache = new SourceCache();

const OutputRenderer = {
  clearCache() {
    sourceCache.clear();
  },

  renderDiagnostic(error, cwd = process.cwd()) {
    const { file, line, col, endCol, rule, severity, message } = error;
    const color = severity === 'warning' ? Theme.YELLOW : Theme.RED;
    const output = [];

    output.push(`${color}${severity}[${rule}]${Theme.R}  ${message}`);
    output.push(`  ${Theme.DIM}-->${Theme.R} ${file}:${line}:${col}`);

    const src = sourceCache.lines(path.resolve(cwd, file));
    const gutterW = String(line + 1).length;
    const pad = ' '.repeat(gutterW);
    const underlineLen = Math.max(3, (endCol || col + 3) - col);
    const underline = '^'.repeat(underlineLen);

    output.push(`${Theme.DIM}${pad} |${Theme.R}`);
    this.renderSourceContext(output, src, line, col, pad, gutterW, color, underline);
    return output.join('\n');
  },

  renderSourceContext(output, src, line, col, pad, gutterW, color, underline) {
    if (line < 1 || line > src.length) {
      output.push(
        `${Theme.DIM}${pad} │${Theme.R} ${' '.repeat(col - 1)}${color}${underline}${Theme.R}`,
      );
      return;
    }

    for (const n of [line - 1, line, line + 1]) {
      if (n < 1 || n > src.length) continue;
      const srcLine = src[n - 1] || '';
      const gutter = String(n).padStart(gutterW);
      if (n === line) {
        output.push(`${Theme.BOLD}${gutter}${Theme.R} ${Theme.DIM}│${Theme.R} ${srcLine}`);
        output.push(
          `${Theme.DIM}${pad} │${Theme.R} ${' '.repeat(col - 1)}${color}${underline}${Theme.R}`,
        );
      } else {
        output.push(`${Theme.DIM}${gutter} │ ${srcLine}${Theme.R}`);
      }
    }
  },

  renderTestFailureCard(failure) {
    const { name, file, expected, actual, errorMessage, frame } = failure;
    const output = [];

    output.push(`${Theme.RED}FAIL${Theme.R}  ${Theme.DIM}${file}${Theme.R}`);
    output.push(`  ${Theme.RED}✗${Theme.R}  ${name}`);
    output.push('');

    if (expected !== undefined && actual !== undefined) {
      output.push(`     ${Theme.DIM}AssertionError:${Theme.R}`);
      output.push(`     ${Theme.RED}- Expected   ${expected}${Theme.R}`);
      output.push(`     ${Theme.GREEN}+ Received   ${actual}${Theme.R}`);
    } else if (errorMessage) {
      output.push(`     ${Theme.RED}${errorMessage}${Theme.R}`);
    }

    if (frame) {
      output.push('');
      output.push(`     ${Theme.DIM}at ${frame}${Theme.R}`);
    }
    return output.join('\n');
  },

  renderDiagnosticsGrouped(errors, cwd = process.cwd()) {
    const byFile = new Map();
    for (const err of errors) {
      const list = byFile.get(err.file) || [];
      list.push(err);
      byFile.set(err.file, list);
    }

    for (const [file, list] of byFile) {
      process.stdout.write(`  ${Theme.BOLD}${file}${Theme.R}\n\n`);
      for (const err of list) {
        const block = this.renderDiagnostic(err, cwd)
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n');
        process.stdout.write(`${block}\n\n`);
      }
    }
  },

  emitLlmBlock(data) {
    const HR = '─'.repeat(53);
    process.stdout.write(
      `\n${HR}\n## LLM CONTEXT\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n${HR}\n\n`,
    );
  },
};

class Aggregate {
  constructor(mode) {
    this.mode = mode;
    this.tasks = [];
    this.passed = 0;
    this.failed = 0;
    this.skipped = 0;
    this.slowestTests = [];
    this.wallStart = Date.now();
  }

  record(label, result, ms) {
    if (result.skipped) return this.recordSkip(label, result.skipReason);
    if (result.ok) return this.recordPass(label, ms, result.annotation);
    return this.recordFail(label, result, ms);
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
      ...(result.rawOutput ? { rawOutput: Text.cap(result.rawOutput, 4000) } : {}),
    });
    this.failed++;
  }

  recordSkip(label, reason) {
    this.tasks.push({ label, ok: null, ms: 0, skipped: true, skipReason: reason });
    this.skipped++;
  }

  setSlowestTests(testDurations) {
    if (!testDurations || testDurations.size === 0) return;
    this.slowestTests = [...testDurations.entries()]
      .map(([name, ms]) => ({ name, ms: typeof ms === 'number' ? ms : 0 }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 5);
  }

  wallMs() {
    return Date.now() - this.wallStart;
  }

  failures() {
    return this.tasks.filter((task) => task.ok === false);
  }

  failureSummary() {
    const failed = this.failures();
    if (failed.length === 0) return null;
    return failed
      .map((task) => {
        if (task.timeout) return `${task.label}: timeout`;
        if (task.counts?.errors)
          return `${task.label}: ${Text.plural(task.counts.errors, 'error')}`;
        if (task.failures) return `${task.label}: ${Text.plural(task.failures.length, 'failure')}`;
        return `${task.label}: failed`;
      })
      .join(', ');
  }
}

class BaseReporter {
  constructor(config, colWidth) {
    this.config = config;
    this.col = colWidth;
    this.tickerHandle = null;
  }

  header() {
    // no-op
  }
  taskStart() {
    // no-op
  }
  taskEnd() {
    // no-op
  }
  groupStart() {
    // no-op
  }
  groupTaskEnd() {
    // no-op
  }
  groupEnd() {
    // no-op
  }
  failureDetail() {
    // no-op
  }
  summary() {
    // no-op
  }
}

class TtyReporter extends BaseReporter {
  constructor(config, colWidth) {
    super(config, colWidth);
    this.useTicker = !!process.stdout.isTTY;
    this.tickerStart = 0;
    this.groupLabels = null;
    this.groupDone = null;
    this.groupStartMs = 0;
  }

  header() {
    const flags = ['fix', 'quick', 'all']
      .filter((flag) => this.config[flag])
      .map((flag) => `${Theme.YELLOW}--${flag}${Theme.R}`);
    const suffix = flags.length > 0 ? `  ${flags.join('  ')}` : '';
    process.stdout.write(
      `\n  ${Theme.BOLD}gemini-assistant${Theme.R}  ${Theme.DIM}checks${Theme.R}${suffix}\n\n`,
    );
  }

  taskStart(label) {
    this.tickerStart = Date.now();
    this.writeTaskLine(Icons.RUN, label, '');
    if (!this.useTicker) return;
    this.tickerHandle = setInterval(() => {
      this.writeTaskLine(
        Icons.RUN,
        label,
        `${Theme.DIM}${Text.elapsed(Date.now() - this.tickerStart)}${Theme.R}`,
      );
    }, 1000).unref();
  }

  taskEnd(label, result, ms) {
    this.stopTicker();
    const icon = this.resultIcon(result);
    const right = this.resultRight(result, ms);
    this.writeTaskLine(icon, label, right, true);
  }

  writeTaskLine(icon, label, right = '', newline = false) {
    process.stdout.write(
      `\r  ${icon}  ${Theme.BOLD}${label.padEnd(this.col)}${Theme.R}${right ? `  ${right}` : ''}${Theme.CLEAR_EOL}${newline ? '\n' : ''}`,
    );
  }

  resultIcon(result) {
    if (result.skipped) return Icons.SKIP;
    if (result.ok) return Icons.PASS;
    if (result.timeout) return Icons.HANG;
    return Icons.FAIL;
  }

  resultRight(result, ms) {
    if (result.skipped) return `${Theme.DIM}${result.skipReason || 'skipped'}${Theme.R}`;
    const time = `${Theme.DIM}${Text.elapsed(ms)}${Theme.R}`;
    const counts = this.formatCounts(result.counts);
    let right = counts ? `${time}  ${counts}` : time;
    if (result.annotation) right += `  ${Theme.DIM}(${result.annotation})${Theme.R}`;
    return right;
  }

  formatCounts(counts) {
    if (!counts) return null;
    const parts = [];
    if (counts.errors) parts.push(`${Theme.RED}${Text.plural(counts.errors, 'error')}${Theme.R}`);
    if (counts.warnings)
      parts.push(`${Theme.YELLOW}${Text.plural(counts.warnings, 'warning')}${Theme.R}`);
    return parts.join(' · ') || null;
  }

  stopTicker() {
    if (!this.tickerHandle) return;
    clearInterval(this.tickerHandle);
    this.tickerHandle = null;
  }

  groupStart(labels) {
    this.groupLabels = [...labels];
    this.groupDone = new Map();
    this.groupStartMs = Date.now();
    if (!this.useTicker) return;

    for (const label of labels) {
      process.stdout.write(
        `  ${Icons.RUN}  ${Theme.BOLD}${label.padEnd(this.col)}${Theme.R}${Theme.CLEAR_EOL}\n`,
      );
    }
    this.tickerHandle = setInterval(() => this.redrawGroup(), 1000).unref();
  }

  groupTaskEnd(label, result, ms) {
    const icon = this.resultIcon(result);
    const right = this.resultRight(result, ms);
    this.groupDone.set(label, { icon, right });
    if (this.useTicker) {
      this.redrawGroup();
      return;
    }
    process.stdout.write(
      `  ${icon}  ${Theme.BOLD}${label.padEnd(this.col)}${Theme.R}  ${right}${Theme.CLEAR_EOL}\n`,
    );
  }

  groupEnd() {
    this.stopTicker();
    if (this.useTicker && this.groupLabels) this.redrawGroup();
    this.groupLabels = null;
    this.groupDone = null;
  }

  redrawGroup() {
    if (!this.groupLabels || !this.groupDone) return;
    const elapsed = `${Theme.DIM}${Text.elapsed(Date.now() - this.groupStartMs)}${Theme.R}`;
    process.stdout.write(`\x1b[${this.groupLabels.length}A`);
    for (const label of this.groupLabels) {
      const done = this.groupDone.get(label);
      const icon = done?.icon || Icons.RUN;
      const right = done?.right || elapsed;
      process.stdout.write(
        `  ${icon}  ${Theme.BOLD}${label.padEnd(this.col)}${Theme.R}  ${right}${Theme.CLEAR_EOL}\n`,
      );
    }
  }

  failureDetail(failedTasks) {
    for (const task of failedTasks) {
      if (task.timeout) {
        this.renderTimeout(task);
        continue;
      }
      if (task.failures?.length > 0) {
        this.renderTestFailures(task.failures);
        continue;
      }
      if (task.errors?.length > 0) {
        process.stdout.write('\n');
        OutputRenderer.renderDiagnosticsGrouped(task.errors);
        continue;
      }
      if (task.rawOutput) this.renderRawOutput(task.rawOutput);
    }
  }

  renderTimeout(task) {
    const startupPhase = task.phase === 'startup';
    process.stdout.write('\n');
    process.stdout.write(
      `  ${Icons.HANG}  ${Theme.BOLD}TIMED OUT${Theme.R} — ${
        startupPhase
          ? `no TAP output during startup window (${Text.elapsed(task.silenceMs)})`
          : `no TAP output for ${Text.elapsed(task.silenceMs)} between tests`
      }\n\n`,
    );

    if (task.lastCompletedTest) {
      process.stdout.write(`  ${Theme.DIM}Last completed test:${Theme.R}\n`);
      process.stdout.write(`  ${Theme.GREEN}✔${Theme.R}  ${task.lastCompletedTest.name}\n\n`);
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
  }

  renderTestFailures(failures) {
    process.stdout.write('\n');
    const shown = failures.slice(0, Config.MAX_FAILURE_CARDS);
    for (const failure of shown)
      process.stdout.write(`${OutputRenderer.renderTestFailureCard(failure)}\n\n`);
    if (failures.length > shown.length) {
      process.stdout.write(
        `      ${Theme.DIM}… ${failures.length - shown.length} more failures, see ${Config.FAILURE_FILE}${Theme.R}\n\n`,
      );
    }
  }

  renderRawOutput(rawOutput) {
    process.stdout.write('\n');
    const lines = rawOutput.trim().split('\n');
    const shown = lines.slice(0, Config.RAW_OUTPUT_MAX_LINES);
    for (const line of shown) process.stdout.write(`      ${Theme.DIM}${line}${Theme.R}\n`);
    if (lines.length > shown.length) {
      process.stdout.write(
        `      ${Theme.DIM}… ${lines.length - shown.length} more lines${Theme.R}\n`,
      );
    }
    process.stdout.write('\n');
  }

  summary(aggregate) {
    process.stdout.write('\n');
    this.renderSlowestTests(aggregate.slowestTests);

    const total = aggregate.tasks.length - aggregate.skipped;
    const wall = Text.elapsed(aggregate.wallMs());
    if (aggregate.failed === 0) {
      const skippedNote =
        aggregate.skipped > 0 ? `  ${Theme.DIM}(${aggregate.skipped} skipped)${Theme.R}` : '';
      process.stdout.write(
        `  ${Theme.GREEN}${Theme.BOLD}✓${Theme.R}  ${aggregate.passed}/${total} passed${skippedNote}  ${Theme.DIM}${wall}${Theme.R}\n\n`,
      );
      return;
    }

    process.stdout.write(
      `  ${Theme.RED}${Theme.BOLD}✗${Theme.R}  ${aggregate.failed} failed: ${aggregate.failureSummary() || 'failed'}  ${Theme.DIM}·${Theme.R}  ${aggregate.passed}/${total} ran  ${Theme.DIM}${wall}${Theme.R}\n`,
    );
    process.stdout.write(`  ${Theme.DIM}✎  failure details → ${Config.FAILURE_FILE}${Theme.R}\n\n`);
  }

  renderSlowestTests(slowestTests) {
    if (!slowestTests || slowestTests.length === 0) return;
    process.stdout.write(`  ${Theme.DIM}Slowest tests:${Theme.R}\n`);
    for (const test of slowestTests) {
      process.stdout.write(
        `    ${Text.elapsed(test.ms).padStart(5)}  ${Theme.DIM}${test.name}${Theme.R}\n`,
      );
    }
    process.stdout.write('\n');
  }
}

class JsonReporter extends BaseReporter {
  summary(aggregate) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: aggregate.failed === 0,
          mode: aggregate.mode,
          wallMs: aggregate.wallMs(),
          tasks: aggregate.tasks,
          slowestTests: aggregate.slowestTests,
          failureSummary: aggregate.failureSummary(),
        },
        null,
        2,
      ) + '\n',
    );
  }
}

function noop() {
  // intentionally empty
}

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

  try {
    FileStore.writeJsonAtomicSync(file, payload);
  } catch {
    // best-effort: do not mask the actual task failure
  }
}

function clearFailureFile(file = Config.FAILURE_FILE) {
  FileStore.removeSync(file);
}

function installSigintHandler(reporter, config) {
  let interrupted = false;
  process.on('SIGINT', () => {
    runController.abort();
    const exitCode = signalExitCode('SIGINT');
    if (interrupted) process.exit(exitCode);
    interrupted = true;

    if (reporter?.tickerHandle) clearInterval(reporter.tickerHandle);
    if (config?.json) {
      process.stderr.write('\n  interrupted\n\n');
      process.stdout.write(JSON.stringify({ ok: false, interrupted: true }) + '\n');
    } else {
      process.stdout.write('\x1b[?25h');
      process.stdout.write(`\n  ${Theme.YELLOW}interrupted${Theme.R}\n\n`);
    }
    process.exit(exitCode);
  });
}

class TaskOrchestrator {
  constructor(config) {
    this.config = config;
    this.tasks = this.createTasks(config);
    this.col = Math.max(...this.tasks.map((task) => task.label.length)) + 2;
  }

  createTasks(config) {
    return [
      { label: 'format', runner: () => TaskRunners.runFormat(config) },
      { label: 'lint', runner: () => TaskRunners.runLint(config.fix) },
      { label: 'type-check', runner: () => TaskRunners.runTypeCheck() },
      { label: 'knip', runner: () => TaskRunners.runKnip() },
      { label: 'test', runner: () => TaskRunners.runTest(), skip: config.quick },
      { label: 'rebuild', runner: () => TaskRunners.runBuild(), skip: config.quick },
    ];
  }

  async run() {
    const reporter = this.config.json
      ? new JsonReporter(this.config, this.col)
      : new TtyReporter(this.config, this.col);
    installSigintHandler(reporter, this.config);
    reporter.header();

    const aggregate = new Aggregate(this.config.all ? 'run-all' : 'fail-fast');
    const testDurations = this.config.fix
      ? await this.runSequential(aggregate, reporter)
      : await this.runPhased(aggregate, reporter);

    return this.finish(aggregate, reporter, testDurations);
  }

  async runSequential(aggregate, reporter) {
    let testDurations = null;
    for (const task of this.tasks) {
      const result = await this.executeTask(task, aggregate, reporter, { allowAutoFix: true });
      if (result?.testDurations) testDurations = result.testDurations;
      if (!this.config.all && aggregate.failed > 0) break;
    }
    return testDurations;
  }

  async runPhased(aggregate, reporter) {
    let testDurations = null;
    const [formatTask, ...rest] = this.tasks;
    const staticTasks = rest.slice(0, 3);
    const deepTasks = rest.slice(3);

    await this.executeTask(formatTask, aggregate, reporter, { allowAutoFix: true });
    if (this.shouldStop(aggregate)) return null;

    await this.executeGroup(staticTasks, aggregate, reporter);
    if (this.shouldStop(aggregate)) return null;

    const results = await this.executeGroup(deepTasks, aggregate, reporter);
    for (const result of results) {
      if (result?.result?.testDurations) testDurations = result.result.testDurations;
    }
    return testDurations;
  }

  shouldStop(aggregate) {
    return aggregate.failed > 0 && !this.config.all;
  }

  shouldGate(task, aggregate) {
    return (
      !this.config.all &&
      aggregate.failed > 0 &&
      (task.label === 'test' || task.label === 'rebuild')
    );
  }

  async executeTask(task, aggregate, reporter, options = {}) {
    const result = await this.runTaskWithReporting(task, aggregate, reporter, options);
    aggregate.record(task.label, result, result.ms || 0);
    return result;
  }

  _checkSkip(task, aggregate) {
    if (task.skip) return Results.skip('skipped');
    if (this.shouldGate(task, aggregate)) return Results.skip('gated on prior failure');
    return null;
  }

  async runTaskWithReporting(task, aggregate, reporter, options = {}) {
    const skipResult = this._checkSkip(task, aggregate);
    if (skipResult) {
      reporter.taskStart(task.label);
      reporter.taskEnd(task.label, skipResult, 0);
      return { ...skipResult, ms: 0 };
    }

    OutputRenderer.clearCache();
    reporter.taskStart(task.label);
    const { result, ms } = await this.runMeasured(task, options);
    reporter.taskEnd(task.label, result, ms);
    return { ...result, ms };
  }

  async executeGroup(tasks, aggregate, reporter) {
    const activeTasks = [];
    const completed = [];

    for (const task of tasks) {
      const skipResult = this._checkSkip(task, aggregate);
      if (skipResult) {
        reporter.taskStart(task.label);
        reporter.taskEnd(task.label, skipResult, 0);
        aggregate.record(task.label, skipResult, 0);
        completed.push({ task, result: skipResult, ms: 0 });
      } else {
        activeTasks.push(task);
      }
    }

    if (activeTasks.length === 0) return completed;

    reporter.groupStart(activeTasks.map((task) => task.label));
    const results = await Promise.all(
      activeTasks.map(async (task) => {
        OutputRenderer.clearCache();
        const { result, ms } = await this.runMeasured(task);
        reporter.groupTaskEnd(task.label, result, ms);
        return { task, result, ms };
      }),
    );
    reporter.groupEnd();

    for (const { task, result, ms } of results) aggregate.record(task.label, result, ms);
    return [...completed, ...results];
  }

  async runMeasured(task, options = {}) {
    const start = Date.now();
    let result = await task.runner();
    if (!result.ok && options.allowAutoFix) {
      const fixed = await this.attemptAutoFix(task, result);
      if (fixed) result = fixed;
    }
    return { result, ms: Date.now() - start };
  }

  async _applyFixAndRerun(task, fixResult) {
    if (!fixResult.ok) {
      return Results.fail({
        rawOutput:
          `auto-fix failed:\n${Text.joinOutput(fixResult.stdout, fixResult.stderr)}`.trim(),
      });
    }
    const rerun = await task.runner();
    return rerun.ok ? Results.pass({ annotation: 'auto-fixed' }) : rerun;
  }

  async attemptAutoFix(task, result) {
    if (task.label === 'format') {
      const fixResult = ProcessRunner.exec('npm', ['run', 'format']);
      return this._applyFixAndRerun(task, fixResult);
    }

    if (!this.config.fix || !result.errors || result.errors.length === 0) return null;
    if (task.label !== 'lint' && task.label !== 'knip') return null;
    if (task.label === 'knip' && !KnipParser.isFixable(result.errors)) return null;

    const fixResult =
      task.label === 'lint'
        ? ProcessRunner.exec(...TaskCommands.lintFix())
        : ProcessRunner.exec(...TaskCommands.knipFix());

    return this._applyFixAndRerun(task, fixResult);
  }

  finish(aggregate, reporter, testDurations = null) {
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
}

const config = parseCliConfig(process.argv.slice(2));
if (config !== null) {
  process.exitCode = await new TaskOrchestrator(config).run();
}
