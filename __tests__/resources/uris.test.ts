import { ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert';
import { test } from 'node:test';

import {
  ASSISTANT_CATALOG_URI,
  ASSISTANT_CONTEXT_URI,
  ASSISTANT_INSTRUCTIONS_URI,
  ASSISTANT_PROFILES_URI,
  ASSISTANT_WORKFLOWS_URI,
  decodeTemplateParam,
  FILE_RESOURCE_TEMPLATE,
  fileResourceUri,
  normalizeTemplateParam,
  requireTemplateParam,
  SESSION_DETAIL_TEMPLATE,
  SESSION_EVENTS_TEMPLATE,
  SESSION_TRANSCRIPT_TEMPLATE,
  sessionEventsUri,
  sessionResourceUri,
  SESSIONS_LIST_URI,
  sessionTranscriptUri,
  TURN_GROUNDING_TEMPLATE,
  TURN_PARTS_TEMPLATE,
  turnGroundingUri,
  turnPartsUri,
  WORKSPACE_CACHE_CONTENTS_URI,
  WORKSPACE_CACHE_URI,
  WORKSPACE_FILES_URI,
} from '../../src/resources/uris.js';

test('URI constants — assistant:// URIs are defined', () => {
  assert.strictEqual(ASSISTANT_CATALOG_URI, 'assistant://discover/catalog');
  assert.strictEqual(ASSISTANT_WORKFLOWS_URI, 'assistant://discover/workflows');
  assert.strictEqual(ASSISTANT_CONTEXT_URI, 'assistant://discover/context');
  assert.strictEqual(ASSISTANT_PROFILES_URI, 'assistant://profiles');
  assert.strictEqual(ASSISTANT_INSTRUCTIONS_URI, 'assistant://instructions');
});

test('URI constants — gemini:// URIs are defined', () => {
  assert.strictEqual(SESSIONS_LIST_URI, 'gemini://sessions');
  assert.strictEqual(WORKSPACE_CACHE_URI, 'gemini://workspace/cache');
  assert.strictEqual(WORKSPACE_CACHE_CONTENTS_URI, 'gemini://workspace/cache/contents');
  assert.strictEqual(WORKSPACE_FILES_URI, 'gemini://workspace/files');
});

test('URI templates — session templates are defined', () => {
  assert.strictEqual(SESSION_DETAIL_TEMPLATE, 'gemini://session/{sessionId}');
  assert.strictEqual(SESSION_TRANSCRIPT_TEMPLATE, 'gemini://session/{sessionId}/transcript');
  assert.strictEqual(SESSION_EVENTS_TEMPLATE, 'gemini://session/{sessionId}/events');
  assert.strictEqual(TURN_PARTS_TEMPLATE, 'gemini://session/{sessionId}/turn/{turnIndex}/parts');
  assert.strictEqual(
    TURN_GROUNDING_TEMPLATE,
    'gemini://session/{sessionId}/turn/{turnIndex}/grounding',
  );
  assert.strictEqual(FILE_RESOURCE_TEMPLATE, 'gemini://workspace/files/{path}');
});

test('sessionResourceUri — encodes sessionId correctly', () => {
  const sessionId = 'test-session-123';
  const result = sessionResourceUri(sessionId);
  assert.strictEqual(result, 'gemini://session/test-session-123');
});

test('sessionResourceUri — encodes special characters in sessionId', () => {
  const sessionId = 'session/with/slashes';
  const result = sessionResourceUri(sessionId);
  // / should be encoded as %2F
  assert.strictEqual(result, 'gemini://session/session%2Fwith%2Fslashes');
});

test('sessionResourceUri — encodes spaces and special chars', () => {
  const sessionId = 'session with spaces & special?';
  const result = sessionResourceUri(sessionId);
  assert.ok(result.includes('%20')); // space encoded
  assert.ok(result.includes('%26')); // & encoded
  assert.ok(result.includes('%3F')); // ? encoded
});

test('sessionTranscriptUri — builds correctly from sessionId', () => {
  const sessionId = 'test-session';
  const result = sessionTranscriptUri(sessionId);
  assert.strictEqual(result, 'gemini://session/test-session/transcript');
});

test('sessionTranscriptUri — encodes sessionId', () => {
  const sessionId = 'session/with/slashes';
  const result = sessionTranscriptUri(sessionId);
  assert.strictEqual(result, 'gemini://session/session%2Fwith%2Fslashes/transcript');
});

test('sessionEventsUri — builds correctly from sessionId', () => {
  const sessionId = 'test-session';
  const result = sessionEventsUri(sessionId);
  assert.strictEqual(result, 'gemini://session/test-session/events');
});

test('sessionEventsUri — encodes sessionId', () => {
  const sessionId = 'session@example.com';
  const result = sessionEventsUri(sessionId);
  assert.strictEqual(result, 'gemini://session/session%40example.com/events');
});

test('turnPartsUri — builds correctly from sessionId and turnIndex', () => {
  const sessionId = 'test-session';
  const turnIndex = 0;
  const result = turnPartsUri(sessionId, turnIndex);
  assert.strictEqual(result, 'gemini://session/test-session/turn/0/parts');
});

test('turnPartsUri — handles multiple turns', () => {
  const sessionId = 'test-session';
  const result1 = turnPartsUri(sessionId, 0);
  const result2 = turnPartsUri(sessionId, 1);
  const result3 = turnPartsUri(sessionId, 42);
  assert.strictEqual(result1, 'gemini://session/test-session/turn/0/parts');
  assert.strictEqual(result2, 'gemini://session/test-session/turn/1/parts');
  assert.strictEqual(result3, 'gemini://session/test-session/turn/42/parts');
});

test('turnPartsUri — encodes sessionId', () => {
  const sessionId = 'session/with/slashes';
  const turnIndex = 5;
  const result = turnPartsUri(sessionId, turnIndex);
  assert.strictEqual(result, 'gemini://session/session%2Fwith%2Fslashes/turn/5/parts');
});

test('turnGroundingUri — builds correctly from sessionId and turnIndex', () => {
  const sessionId = 'test-session';
  const turnIndex = 0;
  const result = turnGroundingUri(sessionId, turnIndex);
  assert.strictEqual(result, 'gemini://session/test-session/turn/0/grounding');
});

test('turnGroundingUri — encodes sessionId', () => {
  const sessionId = 'session?with=params';
  const turnIndex = 3;
  const result = turnGroundingUri(sessionId, turnIndex);
  assert.strictEqual(result, 'gemini://session/session%3Fwith%3Dparams/turn/3/grounding');
});

test('fileResourceUri — builds correctly from path', () => {
  const path = 'src/index.ts';
  const result = fileResourceUri(path);
  assert.strictEqual(result, 'gemini://workspace/files/src/index.ts');
});

test('fileResourceUri — encodes path with special characters', () => {
  const path = 'src/my file.ts';
  const result = fileResourceUri(path);
  assert.strictEqual(result, 'gemini://workspace/files/src/my%20file.ts');
});

test('fileResourceUri — encodes slashes in filename', () => {
  const path = 'src/folder/file.ts';
  const result = fileResourceUri(path);
  // slashes are NOT encoded in paths (they're part of the structure)
  assert.strictEqual(result, 'gemini://workspace/files/src/folder/file.ts');
});

test('normalizeTemplateParam — returns undefined for falsy values', () => {
  assert.strictEqual(normalizeTemplateParam(undefined), undefined);
  assert.strictEqual(normalizeTemplateParam(''), undefined);
  assert.strictEqual(normalizeTemplateParam(null as unknown as string | undefined), undefined);
});

test('normalizeTemplateParam — returns string as-is', () => {
  assert.strictEqual(normalizeTemplateParam('test-value'), 'test-value');
  assert.strictEqual(normalizeTemplateParam('test%20value'), 'test%20value');
});

test('normalizeTemplateParam — takes first element of array', () => {
  assert.strictEqual(normalizeTemplateParam(['first', 'second']), 'first');
  assert.strictEqual(normalizeTemplateParam(['only']), 'only');
});

test('decodeTemplateParam — returns undefined for falsy values', () => {
  assert.strictEqual(decodeTemplateParam(undefined), undefined);
  assert.strictEqual(decodeTemplateParam(''), undefined);
});

test('decodeTemplateParam — decodes percent-encoded string', () => {
  assert.strictEqual(decodeTemplateParam('test%20value'), 'test value');
  assert.strictEqual(decodeTemplateParam('session%2Fwith%2Fslashes'), 'session/with/slashes');
  assert.strictEqual(decodeTemplateParam('test%40example.com'), 'test@example.com');
});

test('decodeTemplateParam — handles array by taking first element', () => {
  assert.strictEqual(decodeTemplateParam(['test%20value', 'ignored']), 'test value');
});

test('decodeTemplateParam — throws ProtocolError on invalid percent-encoding', () => {
  assert.throws(
    () => {
      decodeTemplateParam('invalid%ZZencoding');
    },
    (err: Error) => {
      return (
        'code' in err &&
        err.code === ProtocolErrorCode.InvalidParams &&
        err.message.includes('Invalid percent-encoding')
      );
    },
  );
});

test('decodeTemplateParam — throws on incomplete percent-encoding', () => {
  assert.throws(
    () => {
      decodeTemplateParam('incomplete%2');
    },
    (err: Error) => {
      return (
        'code' in err &&
        err.code === ProtocolErrorCode.InvalidParams &&
        err.message.includes('Invalid percent-encoding')
      );
    },
  );
});

test('requireTemplateParam — returns decoded value when present', () => {
  const result = requireTemplateParam('test%20value', 'Test Param');
  assert.strictEqual(result, 'test value');
});

test('requireTemplateParam — throws when value is undefined', () => {
  assert.throws(
    () => {
      requireTemplateParam(undefined, 'Test Param');
    },
    (err: Error) => {
      return (
        'code' in err &&
        err.code === ProtocolErrorCode.InvalidParams &&
        err.message === 'Test Param required'
      );
    },
  );
});

test('requireTemplateParam — throws when value is empty string', () => {
  assert.throws(
    () => {
      requireTemplateParam('', 'Session ID');
    },
    (err: Error) => {
      return (
        'code' in err &&
        err.code === ProtocolErrorCode.InvalidParams &&
        err.message === 'Session ID required'
      );
    },
  );
});

test('requireTemplateParam — throws on invalid encoding', () => {
  assert.throws(
    () => {
      requireTemplateParam('bad%ZZencoding', 'Test');
    },
    (err: Error) => {
      return (
        'code' in err &&
        err.code === ProtocolErrorCode.InvalidParams &&
        err.message.includes('Invalid percent-encoding')
      );
    },
  );
});

test('URI round-trip — sessionId with special chars round-trips', () => {
  const original = 'session/with/special@chars!';
  const uri = sessionResourceUri(original);
  // Now decode it back
  const decoded = decodeTemplateParam(uri.replace('gemini://session/', ''));
  assert.strictEqual(decoded, original);
});

test('URI round-trip — path with spaces round-trips', () => {
  const original = 'src/my test file.ts';
  const uri = fileResourceUri(original);
  const encoded = uri.replace('gemini://workspace/files/', '');
  const decoded = decodeTemplateParam(encoded);
  assert.strictEqual(decoded, original);
});
