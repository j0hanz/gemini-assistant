import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import { handleToolError } from '../lib/errors.js';
import { withRetry } from '../lib/retry.js';
import { READONLY_ANNOTATIONS, registerTaskTool } from '../lib/task-utils.js';
import { type EmbedContentInput, EmbedContentInputSchema } from '../schemas/inputs.js';
import { EmbedContentOutputSchema } from '../schemas/outputs.js';

import { ai } from '../client.js';

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-004';
const EMBED_TOOL_LABEL = 'Embed Content';

async function embedContentWork(
  { contents, model, outputDimensionality }: EmbedContentInput,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const embeddingModel = model ?? DEFAULT_EMBEDDING_MODEL;

  try {
    const result = await withRetry(
      () =>
        ai.models.embedContent({
          model: embeddingModel,
          contents,
          config: {
            ...(outputDimensionality !== undefined ? { outputDimensionality } : {}),
          },
        }),
      { signal: ctx.mcpReq.signal },
    );

    const embeddings = (result.embeddings ?? []).map((e) => ({
      values: e.values ?? [],
    }));

    return {
      content: [
        {
          type: 'text' as const,
          text: `Embedded ${contents.length} input(s) into ${embeddings.length} vector(s) using ${embeddingModel}.`,
        },
      ],
      structuredContent: { embeddings },
    };
  } catch (err) {
    return await handleToolError(ctx, 'embed_content', EMBED_TOOL_LABEL, err);
  }
}

export function registerEmbedContentTool(server: McpServer): void {
  registerTaskTool(
    server,
    'embed_content',
    {
      title: 'Embed Content',
      description:
        'Generate embedding vectors for text inputs. Returns float arrays for semantic similarity, clustering, or retrieval.',
      inputSchema: EmbedContentInputSchema,
      outputSchema: EmbedContentOutputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    embedContentWork,
  );
}
