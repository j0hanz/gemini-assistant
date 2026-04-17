import type { McpServer } from '@modelcontextprotocol/server';

import { withErrorLogging } from '../lib/errors.js';
import { buildBaseStructuredOutput } from '../lib/response.js';
import { READONLY_ANNOTATIONS } from '../lib/task-utils.js';
import { type DiscoverInput, DiscoverInputSchema } from '../schemas/inputs.js';
import { DiscoverOutputSchema } from '../schemas/outputs.js';

import { findDiscoveryEntry, listDiscoveryEntries, listWorkflowEntries } from '../catalog.js';
import { JOB_METADATA } from '../public-contract.js';

function discoverSummary(args: DiscoverInput): string {
  if (!args.job) {
    return 'Use discover://catalog and discover://workflows to choose the best next public job.';
  }

  const meta = JOB_METADATA.find((entry) => entry.name === args.job);
  return meta ? `${meta.title}: ${meta.summary}` : `Use ${args.job} for the requested goal.`;
}

export function registerDiscoverTool(server: McpServer): void {
  server.registerTool(
    'discover',
    {
      title: 'Discover',
      description: 'Get guided entry points, workflows, related resources, and limitation notes.',
      inputSchema: DiscoverInputSchema,
      outputSchema: DiscoverOutputSchema,
      annotations: READONLY_ANNOTATIONS,
    },
    withErrorLogging('discover', 'Discover', async (args: DiscoverInput, ctx) => {
      const entry = args.job ? findDiscoveryEntry('tool', args.job) : undefined;
      let workflows = listWorkflowEntries();
      let recommendedTools = ['discover', 'chat'];
      let recommendedPrompts = ['discover'];
      let relatedResources = ['discover://catalog', 'discover://workflows'];

      if (args.job) {
        const focusedJob = args.job;
        workflows = workflows.filter((workflow) => workflow.recommendedTools.includes(focusedJob));
        recommendedTools = [focusedJob];
        if (entry) {
          recommendedPrompts = entry.related
            .filter((related) => related.kind === 'prompt')
            .map((related) => related.name);
          relatedResources = entry.related
            .filter((related) => related.kind === 'resource')
            .map((related) => related.name);
        }
      }

      return await Promise.resolve({
        content: [{ type: 'text', text: discoverSummary(args) }],
        structuredContent: {
          ...buildBaseStructuredOutput(ctx.task?.id),
          summary: discoverSummary(args),
          ...(args.job ? { job: args.job } : {}),
          recommendedTools,
          recommendedPrompts,
          relatedResources,
          ...(entry?.limitations ? { limitations: entry.limitations } : {}),
          catalog: listDiscoveryEntries().map((item) => ({
            kind: item.kind,
            name: item.name,
            title: item.title,
          })),
          workflows: workflows.map((workflow) => ({
            goal: workflow.goal,
            name: workflow.name,
            whenToUse: workflow.whenToUse,
          })),
        },
      });
    }),
  );
}
