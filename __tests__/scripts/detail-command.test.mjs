import assert from 'node:assert/strict';
import { test } from 'node:test';

// Inline copy of the detail validation logic from parseCliConfig
function validateDetailArg(raw) {
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

test('validateDetailArg returns null for undefined', () => {
  assert.equal(validateDetailArg(undefined), null);
});
test('validateDetailArg returns 1 for "1"', () => {
  assert.equal(validateDetailArg('1'), 1);
});
test('validateDetailArg returns 3 for "3"', () => {
  assert.equal(validateDetailArg('3'), 3);
});
test('validateDetailArg returns null for "0"', () => {
  assert.equal(validateDetailArg('0'), null);
});
test('validateDetailArg returns null for "-1"', () => {
  assert.equal(validateDetailArg('-1'), null);
});
test('validateDetailArg returns null for "foo"', () => {
  assert.equal(validateDetailArg('foo'), null);
});
test('validateDetailArg returns null for "1.5"', () => {
  assert.equal(validateDetailArg('1.5'), null);
});

// Inline copies of parseFrame and buildSourceWindow (no ANSI codes for testability)
function parseFrame(frame) {
  const m3 = /^(.+):(\d+):(\d+)$/.exec(frame);
  if (m3) return { file: m3[1], line: Number(m3[2]), col: Number(m3[3]) };
  const m2 = /^(.+):(\d+)$/.exec(frame);
  if (m2) return { file: m2[1], line: Number(m2[2]), col: 1 };
  return null;
}

function buildSourceWindow(src, line, col) {
  const BEFORE = 4;
  const AFTER = 5;
  const startLine = Math.max(1, line - BEFORE);
  const endLine = Math.min(src.length || line, line + AFTER);
  const gutterW = String(endLine).length;
  const pad = ' '.repeat(gutterW);
  const output = [];
  output.push(`${pad} |`);
  for (let n = startLine; n <= endLine; n++) {
    const srcLine = src[n - 1] || '';
    const gutter = String(n).padStart(gutterW);
    if (n === line) {
      output.push(`${gutter} │ ${srcLine}`);
      output.push(`${pad} │ ${' '.repeat(Math.max(0, col - 1))}^^^`);
    } else {
      output.push(`${gutter} │ ${srcLine}`);
    }
  }
  output.push(`${pad} |`);
  return output.join('\n');
}

test('parseFrame parses "file:line:col"', () => {
  assert.deepEqual(parseFrame('__tests__/foo.test.ts:18:5'), {
    file: '__tests__/foo.test.ts',
    line: 18,
    col: 5,
  });
});
test('parseFrame parses "file:line" with col defaulting to 1', () => {
  assert.deepEqual(parseFrame('src/foo.ts:42'), { file: 'src/foo.ts', line: 42, col: 1 });
});
test('parseFrame returns null for plain string', () => {
  assert.equal(parseFrame('no numbers here'), null);
});
test('parseFrame returns null for empty string', () => {
  assert.equal(parseFrame(''), null);
});

test('buildSourceWindow highlights the target line', () => {
  const src = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const out = buildSourceWindow(src, 10, 1);
  assert.ok(out.includes('10 │ line 10'), 'target line in output');
  assert.ok(out.includes('^^^'), 'caret present');
});
test('buildSourceWindow places caret at col offset', () => {
  const src = ['  foo bar'];
  const out = buildSourceWindow(src, 1, 3);
  assert.ok(out.includes('  ^^^'), 'caret at col 3 (2 spaces before)');
});
test('buildSourceWindow shows at most 4 lines before target', () => {
  const src = Array.from({ length: 20 }, (_, i) => `L${i + 1}`);
  const out = buildSourceWindow(src, 10, 1);
  assert.ok(out.includes('│ L6'), 'line 6 (10-4) visible');
  assert.ok(!out.includes('│ L5'), 'line 5 (10-5) not visible');
});
test('buildSourceWindow shows at most 5 lines after target', () => {
  const src = Array.from({ length: 20 }, (_, i) => `L${i + 1}`);
  const out = buildSourceWindow(src, 10, 1);
  assert.ok(out.includes('│ L15'), 'line 15 (10+5) visible');
  assert.ok(!out.includes('│ L16'), 'line 16 (10+6) not visible');
});
test('buildSourceWindow handles empty src gracefully', () => {
  const out = buildSourceWindow([], 1, 1);
  assert.equal(typeof out, 'string');
  assert.ok(out.includes('|'), 'fence lines present');
});
test('buildSourceWindow clamps to start of file', () => {
  const src = ['a', 'b', 'c'];
  const out = buildSourceWindow(src, 1, 1);
  assert.ok(out.includes('│ a'), 'first line visible');
});

// Inline copy of the detail view header composition logic (no ANSI)
function buildDetailHeader(failure, index) {
  const { name, frame, errorMessage, expected, actual } = failure;
  let errorLabel;
  if (expected !== undefined && actual !== undefined) {
    errorLabel = 'AssertionError';
  } else if (errorMessage) {
    errorLabel = errorMessage;
  } else {
    errorLabel = 'unknown error';
  }
  const lines = [`Failure ${index} — ${name}`];
  if (frame) {
    lines.push(`error  ${errorLabel}`);
    lines.push(`  --> ${frame}`);
  } else {
    lines.push(`error  ${errorLabel}`);
    lines.push('(no source location available)');
  }
  return lines.join('\n');
}

test('buildDetailHeader shows failure index and name', () => {
  const f = { name: 'test passes', frame: null, errorMessage: null };
  const out = buildDetailHeader(f, 2);
  assert.ok(out.includes('Failure 2'), 'index in header');
  assert.ok(out.includes('test passes'), 'name in header');
});
test('buildDetailHeader uses "AssertionError" when expected and actual are present', () => {
  const f = { name: 't', frame: 'f.ts:1:1', errorMessage: null, expected: '1', actual: '2' };
  assert.ok(buildDetailHeader(f, 1).includes('AssertionError'));
});
test('buildDetailHeader uses errorMessage when no expected/actual', () => {
  const f = {
    name: 't',
    frame: 'f.ts:1:1',
    errorMessage: 'Cannot read property x',
    expected: undefined,
    actual: undefined,
  };
  assert.ok(buildDetailHeader(f, 1).includes('Cannot read property x'));
});
test('buildDetailHeader uses "unknown error" when no errorMessage and no assertion', () => {
  const f = { name: 't', frame: null, errorMessage: null, expected: undefined, actual: undefined };
  assert.ok(buildDetailHeader(f, 1).includes('unknown error'));
});
test('buildDetailHeader shows frame arrow when frame present', () => {
  const f = { name: 't', frame: '__tests__/foo.ts:5:3', errorMessage: 'oops' };
  assert.ok(buildDetailHeader(f, 1).includes('--> __tests__/foo.ts:5:3'));
});
test('buildDetailHeader shows no-location note when frame is null', () => {
  const f = { name: 't', frame: null, errorMessage: 'oops' };
  assert.ok(buildDetailHeader(f, 1).includes('no source location available'));
});

// Inline copy of triage list formatting
function buildTriageList(failures) {
  const maxIdx = String(failures.length).length;
  const lines = [];
  for (let i = 0; i < failures.length; i++) {
    const f = failures[i];
    const idx = String(i + 1).padStart(maxIdx);
    const fileRef = f.frame ? f.frame.replace(/:(\d+):(\d+)$/, ':$1') : f.file || '';
    const nameStr = f.name.length > 60 ? f.name.slice(0, 60) : f.name;
    lines.push(`${idx}  ${nameStr.padEnd(62)}  ${fileRef}`);
  }
  return lines.join('\n');
}

test('buildTriageList numbers failures from 1', () => {
  const failures = [{ name: 'foo', frame: 'a.ts:1:1', file: '' }];
  assert.ok(buildTriageList(failures).startsWith('1  '));
});
test('buildTriageList extracts file:line (strips col) from frame', () => {
  const failures = [{ name: 'foo', frame: '__tests__/a.ts:42:7', file: '' }];
  const out = buildTriageList(failures);
  assert.ok(out.includes('__tests__/a.ts:42'), 'file:line present');
  assert.ok(!out.includes(':7'), 'col stripped');
});
test('buildTriageList falls back to file when frame absent', () => {
  const failures = [{ name: 'bar', frame: null, file: '__tests__/b.ts' }];
  assert.ok(buildTriageList(failures).includes('__tests__/b.ts'));
});
test('buildTriageList pads index for double-digit count', () => {
  const failures = Array.from({ length: 10 }, (_, i) => ({ name: `t${i}`, frame: null, file: '' }));
  const lines = buildTriageList(failures).split('\n');
  assert.ok(lines[0].startsWith(' 1  '), 'single-digit padded');
  assert.ok(lines[9].startsWith('10  '), 'double-digit not padded');
});
test('buildTriageList truncates names longer than 60 chars', () => {
  const failures = [{ name: 'x'.repeat(70), frame: null, file: '' }];
  assert.ok(!buildTriageList(failures).includes('x'.repeat(61)));
});
test('buildTriageList handles empty failures array', () => {
  assert.equal(buildTriageList([]), '');
});

// Inline copy of index validation logic from renderDetailCommand
function validateFailureIndex(failures, index) {
  if (!failures || failures.length === 0) return { error: 'no-failures' };
  if (index < 1 || index > failures.length) {
    return { error: 'out-of-range', count: failures.length };
  }
  return { failure: failures[index - 1] };
}

// Inline copy of LLM JSON payload builder
function buildLlmPayload(failure, index, src) {
  const parsed = failure.frame
    ? (() => {
        const m3 = /^(.+):(\d+):(\d+)$/.exec(String(failure.frame));
        if (m3) return { file: m3[1], line: Number(m3[2]), col: Number(m3[3]) };
        const m2 = /^(.+):(\d+)$/.exec(String(failure.frame));
        if (m2) return { file: m2[1], line: Number(m2[2]), col: 1 };
        return null;
      })()
    : null;

  const BEFORE = 4;
  const AFTER = 5;
  const windowLines =
    parsed && src.length > 0
      ? src.slice(Math.max(0, parsed.line - 1 - BEFORE), parsed.line + AFTER)
      : [];

  return {
    index,
    name: failure.name,
    file: failure.file || '',
    frame: failure.frame || null,
    errorMessage: failure.errorMessage ?? null,
    expected: failure.expected ?? null,
    actual: failure.actual ?? null,
    sourceWindow: parsed
      ? {
          startLine: Math.max(1, parsed.line - BEFORE),
          highlightLine: parsed.line,
          col: parsed.col,
          lines: windowLines,
        }
      : null,
  };
}

test('validateFailureIndex returns no-failures for empty array', () => {
  assert.deepEqual(validateFailureIndex([], 1), { error: 'no-failures' });
});
test('validateFailureIndex returns no-failures for null', () => {
  assert.deepEqual(validateFailureIndex(null, 1), { error: 'no-failures' });
});
test('validateFailureIndex returns out-of-range for index 0', () => {
  assert.equal(validateFailureIndex([{ name: 'x' }], 0).error, 'out-of-range');
});
test('validateFailureIndex returns out-of-range for index > length', () => {
  const r = validateFailureIndex([{ name: 'x' }], 2);
  assert.equal(r.error, 'out-of-range');
  assert.equal(r.count, 1);
});
test('validateFailureIndex returns the correct failure at index', () => {
  const f = [{ name: 'a' }, { name: 'b' }];
  assert.deepEqual(validateFailureIndex(f, 2), { failure: { name: 'b' } });
});

test('buildLlmPayload includes index and name', () => {
  const f = { name: 'my test', frame: null, file: '', errorMessage: null };
  const p = buildLlmPayload(f, 3, []);
  assert.equal(p.index, 3);
  assert.equal(p.name, 'my test');
});
test('buildLlmPayload sets sourceWindow to null when frame absent', () => {
  const f = { name: 't', frame: null, file: '', errorMessage: null };
  assert.equal(buildLlmPayload(f, 1, []).sourceWindow, null);
});
test('buildLlmPayload populates sourceWindow with highlightLine when frame present', () => {
  const src = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const f = { name: 't', frame: 'foo.ts:10:3', file: '', errorMessage: null };
  const p = buildLlmPayload(f, 1, src);
  assert.equal(p.sourceWindow.highlightLine, 10);
  assert.equal(p.sourceWindow.col, 3);
});

// Inline copy of the detail JSON-routing predicate (TASK-002)
function shouldEmitJsonDetail(llm, json) {
  return Boolean(llm) || Boolean(json);
}

test('shouldEmitJsonDetail returns false when neither flag is set', () => {
  assert.equal(shouldEmitJsonDetail(false, false), false);
});
test('shouldEmitJsonDetail returns true when --llm is set', () => {
  assert.equal(shouldEmitJsonDetail(true, false), true);
});
test('shouldEmitJsonDetail returns true when --json is set', () => {
  assert.equal(shouldEmitJsonDetail(false, true), true);
});
test('shouldEmitJsonDetail returns true when both flags are set', () => {
  assert.equal(shouldEmitJsonDetail(true, true), true);
});
