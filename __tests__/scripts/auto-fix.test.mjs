import assert from 'node:assert/strict';
import { test } from 'node:test';

// Inline copy — tasks.mjs is a CLI script, not a module; functions are not exported.
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

test('isKnipFixable — returns true when at least one error is fixable', () => {
  assert.equal(isKnipFixable([{ rule: 'unused-export' }, { rule: 'unlisted-dep' }]), true);
});

test('isKnipFixable — returns false when all errors are unfixable', () => {
  assert.equal(isKnipFixable([{ rule: 'unlisted-dep' }, { rule: 'unlisted-binary' }]), false);
});

test('isKnipFixable — returns false for empty array', () => {
  assert.equal(isKnipFixable([]), false);
});

test('isKnipFixable — covers all fixable rule names', () => {
  for (const rule of KNIP_FIXABLE_RULES) {
    assert.equal(isKnipFixable([{ rule }]), true, `Expected ${rule} to be fixable`);
  }
});

test('isKnipFixable — unused-file is not fixable', () => {
  assert.equal(isKnipFixable([{ rule: 'unused-file' }]), false);
});

test('isKnipFixable — duplicate-export is not fixable', () => {
  assert.equal(isKnipFixable([{ rule: 'duplicate-export' }]), false);
});

// Inline copy of the format auto-fix gating predicate (TASK-003)
function shouldAttemptAutoFix(taskLabel, configFix, errors) {
  if (!configFix) return false;
  if (taskLabel === 'format') return true;
  if (taskLabel !== 'lint' && taskLabel !== 'knip') return false;
  return Array.isArray(errors) && errors.length > 0;
}

test('shouldAttemptAutoFix returns false for format when --fix is absent', () => {
  assert.equal(shouldAttemptAutoFix('format', false, []), false);
});
test('shouldAttemptAutoFix returns true for format when --fix is set', () => {
  assert.equal(shouldAttemptAutoFix('format', true, []), true);
});
test('shouldAttemptAutoFix returns false for type-check regardless of --fix', () => {
  assert.equal(shouldAttemptAutoFix('type-check', true, [{}]), false);
});
test('shouldAttemptAutoFix returns true for lint with errors when --fix is set', () => {
  assert.equal(shouldAttemptAutoFix('lint', true, [{}]), true);
});
test('shouldAttemptAutoFix returns false for lint with no errors', () => {
  assert.equal(shouldAttemptAutoFix('lint', true, []), false);
});
test('shouldAttemptAutoFix returns false for knip when --fix is absent', () => {
  assert.equal(shouldAttemptAutoFix('knip', false, [{}]), false);
});
