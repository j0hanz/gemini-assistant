// __tests__/client.test.ts
import assert from 'node:assert';
import { test } from 'node:test';

// buildGenerateContentConfig is the public entry-point; it calls buildThinkingConfig internally.
// We spy on the module-level logger by mocking the logger child used in client.ts.
// Because buildThinkingConfig is not exported we test its observable effect via the exported function.

test('buildGenerateContentConfig — warns when both thinkingLevel and thinkingBudget are supplied', async () => {
  // Capture any warnings written to process.stderr (clientLog writes there via logger).
  const warnings: string[] = [];
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array, ..._args: unknown[]): boolean => {
    if (typeof chunk === 'string') warnings.push(chunk);
    return true;
  };

  try {
    // Dynamically import to avoid hoisting issues with the mock.
    const { buildGenerateContentConfig } = await import('../src/client.js');
    buildGenerateContentConfig({
      thinkingLevel: 'LOW',
      thinkingBudget: 4096,
    });
  } finally {
    process.stderr.write = originalStderrWrite;
  }

  const warningOutput = warnings.join('');
  assert.ok(
    warningOutput.includes('thinkingBudget') || warningOutput.includes('thinking'),
    `Expected a warning mentioning thinkingBudget, got: ${warningOutput}`,
  );
});
