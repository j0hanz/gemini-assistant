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
 */
export async function consumeInteractionStream(
  eventStream: AsyncIterable<unknown>,
  emitter: StreamEmitter,
): Promise<InteractionStreamResult> {
  let fullText = '';
  const outputs: Interactions.Interaction['outputs'] = [];
  let status: 'completed' | 'failed' | 'cancelled' = 'completed';
  let error: Error | undefined;

  try {
    for await (const event of eventStream) {
      const evt = event as Record<string, unknown>;

      // Parse content deltas
      if (evt.type === 'content_part_delta') {
        const delta = evt.delta as Record<string, unknown>;
        if (typeof delta.text === 'string') {
          fullText += delta.text;
          emitter.emit('progress', { delta: delta.text });
        }
      }

      // Parse thought summaries
      if (evt.type === 'thought_summary') {
        const summary = evt.summary as string;
        emitter.emit('thought-delta', { summary });
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
    emitter.emit('phase-transition', { phase: 'failed', error });
  }

  return {
    status,
    text: fullText || undefined,
    outputs: outputs.length > 0 ? outputs : undefined,
    error,
  };
}
