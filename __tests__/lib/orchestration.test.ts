import assert from 'node:assert';
import { test } from 'node:test';

import {
  buildOrchestrationDiagnostics,
  buildOrchestrationRequestFromInputs,
} from '../../src/lib/tool-profiles.js';

test('buildOrchestrationDiagnostics — emits info for resolved profile', () => {
  const request = buildOrchestrationRequestFromInputs({ googleSearch: true });
  const diagnostics = buildOrchestrationDiagnostics(request, 'chat');
  const info = diagnostics.find((d) => d.level === 'info');
  assert.ok(info, 'must emit info diagnostic');
  assert.ok(info.message.includes('chat'), 'message must include toolKey');
});

test('buildOrchestrationDiagnostics — warns when URLs provided but urlContext not in profile', () => {
  // Create request directly without urlContext being auto-added
  const request = {
    builtInToolSpecs: [],
    urls: ['https://example.com'],
  };
  const diagnostics = buildOrchestrationDiagnostics(request, 'analyze');
  const warning = diagnostics.find((d) => d.level === 'warning' && d.message.includes('URL'));
  assert.ok(warning, 'must warn about URL without urlContext capability');
});

test('buildOrchestrationDiagnostics — no URL warning when urlContext is active', () => {
  const request = buildOrchestrationRequestFromInputs({
    urls: ['https://example.com'],
    googleSearch: true, // urlContext will be auto-added by buildOrchestrationRequestFromInputs
  });
  const diagnostics = buildOrchestrationDiagnostics(request, 'analyze');
  const warning = diagnostics.find((d) => d.level === 'warning' && d.message.includes('URL'));
  assert.strictEqual(warning, undefined, 'must not warn when urlContext is active');
});

test('buildOrchestrationDiagnostics — warns on empty fileSearch stores', () => {
  const request = buildOrchestrationRequestFromInputs({
    fileSearch: { fileSearchStoreNames: [] },
  });
  const diagnostics = buildOrchestrationDiagnostics(request, 'analyze');
  const warning = diagnostics.find(
    (d) => d.level === 'warning' && d.message.includes('File Search'),
  );
  assert.ok(warning, 'must warn when fileSearch has no store names');
});
