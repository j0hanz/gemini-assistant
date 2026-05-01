import type { ReadResourceResult } from '@modelcontextprotocol/server';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

import type { SessionStore } from '../sessions.js';
import { ResourceMemo } from './index.js';
import { buildResourceMeta } from './metadata.js';
import { decodeTemplateParam, requireTemplateParam, SESSIONS_LIST_URI } from './uris.js';

/**
 * Parse a URI and extract template parameters.
 * Returns an object with the extracted parameters.
 */
function parseSessionUri(
  uri: string,
):
  | { type: 'list' }
  | { type: 'detail'; sessionId: string }
  | { type: 'transcript'; sessionId: string }
  | { type: 'events'; sessionId: string }
  | { type: 'parts'; sessionId: string; turnIndex: string }
  | { type: 'grounding'; sessionId: string; turnIndex: string } {
  // Handle sessions list
  if (uri === SESSIONS_LIST_URI) {
    return { type: 'list' };
  }

  // Parse session/{sessionId} URIs
  const sessionMatch = /^gemini:\/\/session\/([^/]+)(?:\/(.*))?$/.exec(uri);
  if (!sessionMatch?.[1]) {
    throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, `Unknown resource: ${uri}`);
  }

  const sessionId: string = sessionMatch[1];
  const rest = sessionMatch[2];

  // Handle detail (just session ID)
  if (!rest) {
    return { type: 'detail', sessionId };
  }

  // Handle transcript
  if (rest === 'transcript') {
    return { type: 'transcript', sessionId };
  }

  // Handle events
  if (rest === 'events') {
    return { type: 'events', sessionId };
  }

  // Handle turn/{turnIndex}/parts or turn/{turnIndex}/grounding
  const turnMatch = /^turn\/(\d+)\/(parts|grounding)$/.exec(rest);
  const turnIdx = turnMatch?.[1];
  const turnType = turnMatch?.[2];
  if (turnIdx && turnType) {
    if (turnType === 'parts') {
      return { type: 'parts', sessionId, turnIndex: turnIdx };
    }
    return { type: 'grounding', sessionId, turnIndex: turnIdx };
  }

  throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, `Unknown resource: ${uri}`);
}

class SessionResourceHandler {
  private sessionStore: SessionStore;
  private memos = new Map<string, ResourceMemo<string, string>>();

  constructor(sessionStore: SessionStore) {
    this.sessionStore = sessionStore;
  }

  private getMemo(key: string): ResourceMemo<string, string> {
    if (!this.memos.has(key)) {
      this.memos.set(key, new ResourceMemo());
    }
    const memo = this.memos.get(key);
    if (!memo) {
      throw new Error('Memo not found');
    }
    return memo;
  }

  async readResource(uri: string): Promise<string> {
    const parsed = parseSessionUri(uri);

    switch (parsed.type) {
      case 'list':
        return this.readSessionsList();

      case 'detail':
        return await this.readSessionDetail(uri, parsed.sessionId);

      case 'transcript':
        return await this.readSessionTranscript(uri, parsed.sessionId);

      case 'events':
        return await this.readSessionEvents(uri, parsed.sessionId);

      case 'parts':
        return await this.readTurnParts(uri, parsed.sessionId, parsed.turnIndex);

      case 'grounding':
        return await this.readTurnGrounding(uri, parsed.sessionId, parsed.turnIndex);
    }
  }

  private readSessionsList(): string {
    const entries = this.sessionStore.listSessionEntries();
    const sessionIds = entries.map((session) => session.id);
    const meta = buildResourceMeta({
      cached: false,
      ttlMs: 5_000,
      size: JSON.stringify(sessionIds).length,
      selfUri: SESSIONS_LIST_URI,
    });
    return `${JSON.stringify(sessionIds, null, 2)}\n\n_meta: ${JSON.stringify(meta)}`;
  }

  private async readSessionDetail(uri: string, sessionId: string): Promise<string> {
    const memoKey = `detail_${sessionId}`;
    const memo = this.getMemo(memoKey);

    const content = await memo.get(memoKey, Number.POSITIVE_INFINITY, () => {
      const decodedSessionId = decodeTemplateParam(sessionId);
      if (!decodedSessionId) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Session ID required');
      }

      const entry = this.sessionStore.getSessionEntry(decodedSessionId);
      if (!entry) {
        throw new ProtocolError(
          ProtocolErrorCode.ResourceNotFound,
          `Session '${decodedSessionId}' not found`,
        );
      }

      const interactionId = this.sessionStore.getSessionInteractionId(decodedSessionId);
      const responseContent = {
        sessionId: decodedSessionId,
        interactionId: interactionId ?? null,
        createdAt: new Date(entry.lastAccess).toISOString(),
        turnCount: this.sessionStore.listTurnIndices(decodedSessionId).length,
      };

      const meta = buildResourceMeta({
        cached: false,
        ttlMs: 10_000,
        size: JSON.stringify(responseContent).length,
        selfUri: uri,
      });

      return `${JSON.stringify(responseContent, null, 2)}\n\n_meta: ${JSON.stringify(meta)}`;
    });

    return content;
  }

  private async readSessionTranscript(uri: string, sessionId: string): Promise<string> {
    const memoKey = `transcript_${sessionId}`;
    const memo = this.getMemo(memoKey);

    const content = await memo.get(memoKey, 5_000, () => {
      const decodedSessionId = decodeTemplateParam(sessionId);
      if (!decodedSessionId) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Session ID required');
      }

      const transcript = this.sessionStore.listSessionTranscriptEntries(decodedSessionId);
      if (!transcript) {
        throw new ProtocolError(
          ProtocolErrorCode.ResourceNotFound,
          `Session '${decodedSessionId}' not found`,
        );
      }

      const markdown = this.buildTranscriptMarkdown(decodedSessionId, transcript);
      const meta = buildResourceMeta({
        cached: false,
        ttlMs: 5_000,
        size: markdown.length,
        selfUri: uri,
      });

      return `${markdown}\n\n_meta: ${JSON.stringify(meta)}`;
    });

    return content;
  }

  private buildTranscriptMarkdown(
    sessionId: string,
    transcript: {
      role: 'user' | 'assistant';
      text: string;
      timestamp: number;
      taskId?: string;
    }[],
  ): string {
    const lines: string[] = [`# Transcript: ${sessionId}`, ''];

    if (transcript.length === 0) {
      lines.push('_No transcript entries yet._');
      return lines.join('\n');
    }

    for (const entry of transcript) {
      const ts = new Date(entry.timestamp).toISOString();
      const taskSuffix = entry.taskId ? ` · task \`${entry.taskId}\`` : '';

      lines.push(`## Turn ${lines.length / 4}`);
      lines.push(`**${entry.role}** (\`${ts}\`${taskSuffix})`);
      lines.push('');
      lines.push(entry.text);
      lines.push('');
    }

    return lines.join('\n').trimEnd() + '\n';
  }

  private async readSessionEvents(uri: string, sessionId: string): Promise<string> {
    const memoKey = `events_${sessionId}`;
    const memo = this.getMemo(memoKey);

    const content = await memo.get(memoKey, 5_000, () => {
      const decodedSessionId = decodeTemplateParam(sessionId);
      if (!decodedSessionId) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Session ID required');
      }

      const events = this.sessionStore.listSessionEventEntries(decodedSessionId);
      if (!events) {
        throw new ProtocolError(
          ProtocolErrorCode.ResourceNotFound,
          `Session '${decodedSessionId}' not found`,
        );
      }

      const meta = buildResourceMeta({
        cached: false,
        ttlMs: 5_000,
        size: JSON.stringify(events).length,
        selfUri: uri,
      });

      return `${JSON.stringify(events, null, 2)}\n\n_meta: ${JSON.stringify(meta)}`;
    });

    return content;
  }

  private async readTurnParts(uri: string, sessionId: string, turnIndex: string): Promise<string> {
    const memoKey = `parts_${sessionId}_${turnIndex}`;
    const memo = this.getMemo(memoKey);

    const content = await memo.get(memoKey, Number.POSITIVE_INFINITY, () => {
      const decodedSessionId = decodeTemplateParam(sessionId);
      if (!decodedSessionId) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Session ID required');
      }

      const decodedTurnIndex = requireTemplateParam(turnIndex, 'Turn index');
      const turnIndexNum = Number.parseInt(decodedTurnIndex, 10);

      if (Number.isNaN(turnIndexNum) || turnIndexNum < 0) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid turn index');
      }

      // Verify session exists
      const session = this.sessionStore.getSessionEntry(decodedSessionId);
      if (!session) {
        throw new ProtocolError(
          ProtocolErrorCode.ResourceNotFound,
          `Session '${decodedSessionId}' not found`,
        );
      }

      const parts = this.sessionStore.getTurnRawParts(decodedSessionId, turnIndexNum);
      if (!parts) {
        throw new ProtocolError(
          ProtocolErrorCode.ResourceNotFound,
          `Turn ${turnIndexNum} not found in session '${decodedSessionId}'`,
        );
      }

      const meta = buildResourceMeta({
        cached: false,
        ttlMs: Number.POSITIVE_INFINITY,
        size: JSON.stringify(parts).length,
        selfUri: uri,
      });

      return `${JSON.stringify(parts, null, 2)}\n\n_meta: ${JSON.stringify(meta)}`;
    });

    return content;
  }

  private async readTurnGrounding(
    uri: string,
    sessionId: string,
    turnIndex: string,
  ): Promise<string> {
    const memoKey = `grounding_${sessionId}_${turnIndex}`;
    const memo = this.getMemo(memoKey);

    const content = await memo.get(memoKey, Number.POSITIVE_INFINITY, () => {
      const decodedSessionId = decodeTemplateParam(sessionId);
      if (!decodedSessionId) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Session ID required');
      }

      const decodedTurnIndex = requireTemplateParam(turnIndex, 'Turn index');
      const turnIndexNum = Number.parseInt(decodedTurnIndex, 10);

      if (Number.isNaN(turnIndexNum) || turnIndexNum < 0) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid turn index');
      }

      // Verify session exists
      const session = this.sessionStore.getSessionEntry(decodedSessionId);
      if (!session) {
        throw new ProtocolError(
          ProtocolErrorCode.ResourceNotFound,
          `Session '${decodedSessionId}' not found`,
        );
      }

      const grounding = this.sessionStore.getTurnGrounding(decodedSessionId, turnIndexNum);
      if (!grounding) {
        throw new ProtocolError(
          ProtocolErrorCode.ResourceNotFound,
          `Grounding not found for turn ${turnIndexNum} in session '${decodedSessionId}'`,
        );
      }

      const meta = buildResourceMeta({
        cached: false,
        ttlMs: Number.POSITIVE_INFINITY,
        size: JSON.stringify(grounding).length,
        selfUri: uri,
      });

      return `${JSON.stringify(grounding, null, 2)}\n\n_meta: ${JSON.stringify(meta)}`;
    });

    return content;
  }
}

/**
 * Create a ReadResourceResult for the given URI and content.
 */
function readResourceContent(uri: string, content: string): ReadResourceResult {
  // Determine MIME type based on resource type
  let mimeType = 'application/json';
  if (uri.endsWith('/transcript')) {
    mimeType = 'text/markdown';
  }

  return {
    contents: [
      {
        uri,
        mimeType,
        text: content,
      },
    ],
  };
}

/**
 * Register session resources under the gemini:// scheme.
 * This provides read-only access to session lists, details, transcripts, events, and turn data.
 */
export function registerSessionResources(
  server: {
    setResourceContentsHandler(
      handler: (request: { uri: string }) => Promise<ReadResourceResult>,
    ): void;
  },
  services: { sessionStore: SessionStore },
): void {
  const { sessionStore } = services;
  const handler = new SessionResourceHandler(sessionStore);

  server.setResourceContentsHandler(async (request): Promise<ReadResourceResult> => {
    const uri = request.uri;

    // Validate that the URI is a session resource
    const isSessionsList = uri === SESSIONS_LIST_URI;
    const isSessionDetail = /^gemini:\/\/session\/[^/]+$/.exec(uri);
    const isSessionTranscript = /^gemini:\/\/session\/[^/]+\/transcript$/.exec(uri);
    const isSessionEvents = /^gemini:\/\/session\/[^/]+\/events$/.exec(uri);
    const isTurnParts = /^gemini:\/\/session\/[^/]+\/turn\/\d+\/parts$/.exec(uri);
    const isTurnGrounding = /^gemini:\/\/session\/[^/]+\/turn\/\d+\/grounding$/.exec(uri);

    if (
      !isSessionsList &&
      !isSessionDetail &&
      !isSessionTranscript &&
      !isSessionEvents &&
      !isTurnParts &&
      !isTurnGrounding
    ) {
      throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, `Unknown resource: ${uri}`);
    }

    const content = await handler.readResource(uri);
    return readResourceContent(uri, content);
  });
}
