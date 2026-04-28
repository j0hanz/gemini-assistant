#!/usr/bin/env node
// Usage: node scripts/tasks.mjs [--fix] [--fast]
//   --fix   run lint:fix instead of lint
//   --fast  skip the test suite (static checks only)
import { execSync } from 'node:child_process';
import process from 'node:process';

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

const args = new Set(process.argv.slice(2));
const fix = args.has('--fix');
const fast = args.has('--fast');

/** @type {Array<{ label: string; cmd: string; skip?: boolean }>} */
const tasks = [
  { label: 'format', cmd: 'npm run format' },
  { label: 'lint', cmd: fix ? 'npm run lint:fix' : 'npm run lint' },
  { label: 'type-check', cmd: 'npm run type-check' },
  { label: 'build', cmd: 'npm run build' },
  { label: 'knip', cmd: 'npm run knip' },
  { label: 'test', cmd: 'npm run test', skip: fast },
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

function printTask(icon, label, time, skipped) {
  const col = label.padEnd(COL);
  const right = skipped ? `${DIM}skipped${R}` : `${DIM}${time}${R}`;
  process.stdout.write(`\r  ${icon}  ${BOLD}${col}${R}  ${right}\n`);
}

function printOutput(raw) {
  if (!raw) return;
  const lines = raw.trim().split('\n');
  const shown = lines.slice(0, 40);
  process.stdout.write('\n');
  for (const line of shown) process.stdout.write(`      ${DIM}${line}${R}\n`);
  if (lines.length > 40) {
    process.stdout.write(`      ${DIM}… ${lines.length - 40} more lines${R}\n`);
  }
  process.stdout.write('\n');
}

printHeader();

let passed = 0;
let failed = 0;
let skipped = 0;
const wallStart = Date.now();

for (const task of tasks) {
  if (task.skip) {
    printTask(SKIP, task.label, '', true);
    skipped++;
    continue;
  }

  process.stdout.write(`  ${RUN}  ${BOLD}${task.label.padEnd(COL)}${R}`);

  const start = Date.now();
  let output = '';
  let ok = true;

  try {
    execSync(task.cmd, { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    ok = false;
    const e = /** @type {any} */ (err);
    output = [e.stdout, e.stderr].filter(Boolean).join('\n');
    failed++;
  }

  const ms = Date.now() - start;
  printTask(ok ? PASS : FAIL, task.label, elapsed(ms), false);

  if (!ok) {
    printOutput(output);
    break;
  }

  passed++;
}

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
