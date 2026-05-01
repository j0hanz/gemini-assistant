// src/lib/interaction-stream.ts
import type { Interactions } from '@google/genai';

interface InteractionStreamResult {
  status: 'completed' | 'failed' | 'cancelled';
  text?: string | undefined;
  outputs?: Interactions.Interaction['outputs'] | undefined;
  error?: Error | undefined;
}

interface StreamEmitter {
  emit(type: string, data: unknown): void;
}

/**
 * Consume Interactions API SSE event stream.
 * Emits MCP notifications (progress, thoughts, function calls).
 * Returns result compatible with SessionEventEntry recording.
 * Validates event properties before accessing them and handles errors gracefully.
 */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function consumeInteractionStream(
  eventStream: AsyncIterable<unknown>,
  emitter: StreamEmitter,
): Promise<InteractionStreamResult> {
  if (typeof emitter.emit !== 'function') {
    return {
      status: 'failed',
      error: new Error('Invalid emitter: emitter must be an object with an emit method'),
    };
  }

  let fullText = '';
  let status: 'completed' | 'failed' | 'cancelled' = 'completed';
  let error: Error | undefined;

  try {
    for await (const event of eventStream) {
      const evt = asObject(event);
      if (!evt) continue;

      // Parse content deltas
      if (evt.type === 'content_part_delta') {
        const delta = asObject(evt.delta);
        if (delta && typeof delta.text === 'string') {
          fullText += delta.text;
          emitter.emit('progress', { delta: delta.text });
        }
      }

      // Parse thought summaries
      if (evt.type === 'thought_summary') {
        const summary = evt.summary;
        if (typeof summary === 'string') {
          emitter.emit('thought-delta', { summary });
        }
      }

      // Parse function calls
      if (evt.type === 'function_call') {
        emitter.emit('function-call', evt);
      }

      // End of message
      if (evt.type === 'message_stop') {
        emitter.emit('phase-transition', { phase: 'completed' });
      }
    }
  } catch (err) {
    status = 'failed';
    error = err instanceof Error ? err : new Error(String(err));
    // Emit phase transition on error to notify subscribers of failure
    emitter.emit('phase-transition', { phase: 'failed', error });
  }

  return {
    status,
    text: fullText || undefined,
    error,
  };
}
