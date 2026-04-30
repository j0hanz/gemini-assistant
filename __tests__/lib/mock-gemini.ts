import type { GenerateContentResponse } from '@google/genai';

export function mockStream(
  chunks: Partial<GenerateContentResponse>[],
): AsyncIterable<GenerateContentResponse> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index >= chunks.length) return { done: true, value: undefined as never };
          return { done: false, value: chunks[index++] as GenerateContentResponse };
        },
      };
    },
  };
}

export function mockTextResponse(text: string): AsyncIterable<GenerateContentResponse> {
  return mockStream([
    {
      candidates: [
        { content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' as never },
      ],
    },
  ]);
}

export function mockFunctionCallResponse(
  name: string,
  args: Record<string, unknown>,
): AsyncIterable<GenerateContentResponse> {
  return mockStream([
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { name, args } }],
          },
          finishReason: 'STOP' as never,
        },
      ],
    },
  ]);
}

export function mockUsageResponse(
  text: string,
  inputTokens: number,
  outputTokens: number,
): AsyncIterable<GenerateContentResponse> {
  return mockStream([
    {
      candidates: [
        { content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' as never },
      ],
      usageMetadata: {
        promptTokenCount: inputTokens,
        candidatesTokenCount: outputTokens,
        totalTokenCount: inputTokens + outputTokens,
      },
    },
  ]);
}

export function createMockAI(responses: AsyncIterable<GenerateContentResponse>[]) {
  let callIndex = 0;
  return {
    models: {
      generateContentStream: () => {
        const stream = responses[callIndex] ?? mockTextResponse('');
        callIndex++;
        return Promise.resolve(stream);
      },
    },
  };
}
