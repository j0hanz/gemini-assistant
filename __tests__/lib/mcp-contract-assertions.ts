import assert from 'node:assert/strict';

import { Validator } from '@cfworker/json-schema';
import type { Schema } from '@cfworker/json-schema';

import {
  isJsonRpcFailure,
  type JsonRpcResponse,
  type JsonSchemaLike,
  type ToolCallResult,
  type ToolInfo,
} from './mcp-contract-client.js';

export function schemaRequiresField(schema: JsonSchemaLike | undefined, field: string): boolean {
  if (!schema) {
    return false;
  }

  if (schema.required?.includes(field)) {
    return true;
  }

  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const nested = schema[key];
    if (Array.isArray(nested) && nested.some((entry) => schemaRequiresField(entry, field))) {
      return true;
    }
  }

  return false;
}

export function assertProtocolError(
  response: JsonRpcResponse,
  expectedCode: number,
  expectedMessagePattern: RegExp,
): void {
  assert.ok(isJsonRpcFailure(response), 'Expected JSON-RPC failure response, got a success result');
  assert.equal(
    (response as unknown as { result?: unknown }).result,
    undefined,
    'JSON-RPC failure must not carry a result field',
  );
  assert.equal(response.error.code, expectedCode);
  assert.match(response.error.message, expectedMessagePattern);
}

export function assertToolExecutionError(
  result: ToolCallResult,
  expectedMessagePattern: RegExp,
): void {
  assert.equal(result.isError, true, 'Expected tool execution to fail');
  assert.ok(
    Array.isArray(result.content) && result.content.length >= 1,
    'Tool error result must include non-empty content[]',
  );
  const text = result.content.find((entry) => typeof entry.text === 'string')?.text ?? '';
  assert.match(text, expectedMessagePattern);
}

export function assertNoStructuredContentOnError(result: ToolCallResult): void {
  assert.equal(result.isError, true, 'Expected isError:true result');
  assert.ok(
    Array.isArray(result.content) && result.content.length >= 1,
    'Tool error result must include non-empty content[]',
  );
  assert.equal(
    (result as { structuredContent?: unknown }).structuredContent,
    undefined,
    'Tool error result must not carry structuredContent',
  );
}

export function assertAdvertisedOutputSchema(tool: ToolInfo, result: ToolCallResult): void {
  assert.notEqual(
    result.isError,
    true,
    `Expected ${tool.name} to succeed before schema validation`,
  );
  assert.ok(tool.outputSchema, `Expected ${tool.name} to advertise an outputSchema`);
  assert.ok(
    result.structuredContent && typeof result.structuredContent === 'object',
    `Expected ${tool.name} to return structuredContent`,
  );

  const validator = new Validator(
    (tool.outputSchema ?? { type: 'object' }) as Schema,
    '2020-12',
    false,
  );
  const validation = validator.validate(result.structuredContent);

  assert.equal(
    validation.valid,
    true,
    `${tool.name} structuredContent failed advertised outputSchema validation: ${validation.errors
      .map((error) => `${error.instanceLocation}: ${error.error}`)
      .join('; ')}`,
  );
}

export function assertStablePublicSurface(
  actualNames: readonly string[],
  expectedNames: readonly string[],
): void {
  assert.deepStrictEqual([...actualNames], [...expectedNames]);
}
