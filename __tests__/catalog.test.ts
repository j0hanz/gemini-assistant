import { test } from 'node:test';
import assert from 'node:assert';
import { listDiscoveryEntries, listWorkflowEntries } from '../src/catalog.js';

test('listDiscoveryEntries — returns discovery entries', () => {
  const entries = listDiscoveryEntries();
  assert(Array.isArray(entries));
  assert(entries.length > 0);
});

test('listDiscoveryEntries — contains chat tool', () => {
  const entries = listDiscoveryEntries();
  const chatEntry = entries.find((e) => e.name === 'chat');
  assert(chatEntry !== undefined);
});

test('listDiscoveryEntries — contains research tool', () => {
  const entries = listDiscoveryEntries();
  const researchEntry = entries.find((e) => e.name === 'research');
  assert(researchEntry !== undefined);
});

test('listDiscoveryEntries — contains analyze tool', () => {
  const entries = listDiscoveryEntries();
  const analyzeEntry = entries.find((e) => e.name === 'analyze');
  assert(analyzeEntry !== undefined);
});

test('listDiscoveryEntries — contains review tool', () => {
  const entries = listDiscoveryEntries();
  const reviewEntry = entries.find((e) => e.name === 'review');
  assert(reviewEntry !== undefined);
});

test('listWorkflowEntries — returns workflow entries', () => {
  const entries = listWorkflowEntries();
  assert(Array.isArray(entries));
});

test('listWorkflowEntries — all entries have names', () => {
  const entries = listWorkflowEntries();
  for (const entry of entries) {
    assert(typeof entry.name === 'string' && entry.name.length > 0);
  }
});
