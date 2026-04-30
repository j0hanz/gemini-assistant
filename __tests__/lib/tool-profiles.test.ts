import assert from 'node:assert';
import { test } from 'node:test';

import { FunctionCallingConfigMode } from '@google/genai';

import {
  buildToolsArray,
  ProfileValidationError,
  resolveProfile,
  resolveProfileFunctionCallingMode,
  validateProfile,
} from '../../src/lib/tool-profiles.js';

test('resolveProfile — all named profiles resolve without throwing', () => {
  const profiles = [
    'plain',
    'grounded',
    'web-research',
    'deep-research',
    'urls-only',
    'code-math',
    'code-math-grounded',
    'visual-inspect',
    'rag',
    'agent',
    'structured',
  ];

  for (const profileName of profiles) {
    const resolved = resolveProfile({ profile: profileName }, { toolKey: 'chat' });
    assert.strictEqual(resolved.profile, profileName);
    assert(Array.isArray(resolved.builtIns) || resolved.builtIns === undefined);
  }
});

test('validateProfile — plain profile passes', () => {
  const resolved = resolveProfile({ profile: 'plain' }, { toolKey: 'chat' });
  assert.doesNotThrow(() => validateProfile(resolved));
});

test('validateProfile — grounded profile passes', () => {
  const resolved = resolveProfile({ profile: 'grounded' }, { toolKey: 'chat' });
  assert.doesNotThrow(() => validateProfile(resolved));
});

test('validateProfile — fileSearch + other built-ins throws', () => {
  const resolved = resolveProfile({ profile: 'rag' }, { toolKey: 'chat' });
  assert.throws(() => {
    // Try to manually mix fileSearch with other builtIns (normally prevented at profile def level)
    validateProfile({
      ...resolved,
      builtIns: [...resolved.builtIns, 'googleSearch'],
    });
  }, ProfileValidationError);
});

test('validateProfile — fileSearch + functions throws', () => {
  const resolved = resolveProfile(
    {
      profile: 'rag',
      overrides: {
        functions: [{ name: 'test', description: 'test' }],
        fileSearchStores: ['store1'],
      },
    },
    { toolKey: 'chat' },
  );
  assert.throws(() => validateProfile(resolved), ProfileValidationError);
});

test('validateProfile — agent requires functions', () => {
  const resolved = resolveProfile({ profile: 'agent' }, { toolKey: 'chat' });
  assert.throws(() => validateProfile(resolved), { message: /requires.*functions/i });
});

test('validateProfile — agent with functions passes', () => {
  const resolved = resolveProfile(
    { profile: 'agent', overrides: { functions: [{ name: 'test', description: 'test' }] } },
    { toolKey: 'chat' },
  );
  assert.doesNotThrow(() => validateProfile(resolved));
});

test('validateProfile — structured requires responseSchemaJson', () => {
  const resolved = resolveProfile({ profile: 'structured' }, { toolKey: 'chat' });
  assert.throws(() => validateProfile(resolved), { message: /requires.*responseSchema/i });
});

test('validateProfile — structured with schema passes', () => {
  const resolved = resolveProfile(
    { profile: 'structured', overrides: { responseSchemaJson: { type: 'object' } } },
    { toolKey: 'chat' },
  );
  assert.doesNotThrow(() => validateProfile(resolved));
});

test('validateProfile — visual-inspect requires thinkingLevel >= medium', () => {
  const resolved = resolveProfile(
    { profile: 'visual-inspect', thinkingLevel: 'minimal' },
    { toolKey: 'analyze', hasImageInput: true },
  );
  assert.throws(() => validateProfile(resolved), { message: /thinking.*medium/i });
});

test('validateProfile — visual-inspect with medium thinking passes', () => {
  const resolved = resolveProfile(
    { profile: 'visual-inspect', thinkingLevel: 'medium' },
    { toolKey: 'analyze', hasImageInput: true },
  );
  assert.doesNotThrow(() => validateProfile(resolved));
});

test('validateProfile — rag requires fileSearchStores', () => {
  const resolved = resolveProfile({ profile: 'rag' }, { toolKey: 'chat' });
  assert.throws(() => validateProfile(resolved), { message: /fileSearchStores/i });
});

test('validateProfile — rag with stores passes', () => {
  const resolved = resolveProfile(
    { profile: 'rag', overrides: { fileSearchStores: ['store1'] } },
    { toolKey: 'chat' },
  );
  assert.doesNotThrow(() => validateProfile(resolved));
});

test('resolveProfile — overrides applied to resolved profile', () => {
  const resolved = resolveProfile(
    { profile: 'plain', overrides: { urls: ['http://example.com'] } },
    { toolKey: 'chat' },
  );
  assert.deepStrictEqual(resolved.overrides.urls, ['http://example.com']);
});

test('resolveProfile — auto-promotion with URLs', () => {
  const resolved = resolveProfile(
    { overrides: { urls: ['http://example.com'] } },
    { toolKey: 'chat' },
  );
  // plain auto-promotes to web-research when URLs are provided
  assert.strictEqual(resolved.autoPromoted, true);
});

test('FunctionCallingConfigMode.VALIDATED resolves to the string VALIDATED', () => {
  // Pins that the SDK enum value used internally matches the string the API expects.
  assert.strictEqual(FunctionCallingConfigMode.VALIDATED, 'VALIDATED');
  // Bracket access must also resolve (used in resolveProfileFunctionCallingMode).
  assert.strictEqual(FunctionCallingConfigMode['VALIDATED'], 'VALIDATED');
});

test('resolveProfileFunctionCallingMode — returns VALIDATED when profile has functions + built-ins', () => {
  const resolved = resolveProfile(
    {
      profile: 'grounded',
      overrides: {
        functions: [{ name: 'myFn', description: 'a test function' }],
      },
    },
    { toolKey: 'chat' },
  );
  const mode = resolveProfileFunctionCallingMode(resolved);
  assert.strictEqual(mode, FunctionCallingConfigMode.VALIDATED);
});

test('resolveProfileFunctionCallingMode — returns undefined for plain profile with no functions', () => {
  const resolved = resolveProfile({ profile: 'plain' }, { toolKey: 'chat' });
  const mode = resolveProfileFunctionCallingMode(resolved);
  assert.strictEqual(mode, undefined);
});

test('buildToolsArray — function declaration emits parametersJsonSchema not parameters', () => {
  const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
  const resolved = resolveProfile(
    {
      profile: 'agent',
      overrides: {
        functions: [{ name: 'search', description: 'web search', parametersJsonSchema: schema }],
      },
    },
    { toolKey: 'chat' },
  );

  const tools = buildToolsArray(resolved);
  const decl = tools
    .flatMap((t) => ('functionDeclarations' in t ? (t.functionDeclarations ?? []) : []))
    .find((d) => d.name === 'search');

  assert.ok(decl, 'search declaration must exist');
  assert.ok(
    'parametersJsonSchema' in decl,
    `expected parametersJsonSchema key, got: ${JSON.stringify(Object.keys(decl))}`,
  );
  assert.ok(!('parameters' in decl), 'parameters key must not be present');
  assert.deepStrictEqual(decl.parametersJsonSchema, schema);
});

test('resolveProfile — accepts mcpServer in overrides', () => {
  const override = {
    profile: 'agent',
    overrides: {
      mcpServer: {
        transport: 'stdio',
        command: 'npx',
        args: ['@modelcontextprotocol/server-filesystem', '--root', '.'],
      },
    },
  };

  const resolved = resolveProfile(override, { toolKey: 'chat' });

  assert.strictEqual(resolved.profile, 'agent');
  assert.deepStrictEqual(resolved.overrides.mcpServer, override.overrides.mcpServer);
});
