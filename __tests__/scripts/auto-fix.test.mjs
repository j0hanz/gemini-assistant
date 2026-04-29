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
