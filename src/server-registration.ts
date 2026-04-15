import type { McpServer } from '@modelcontextprotocol/server';

import { registerPrompts, registerResources } from './server-content.js';
import { registerAskTool } from './tools/ask.js';
import { registerCacheTools } from './tools/cache.js';
import { registerCompareFilesTool } from './tools/compare.js';
import { registerGenerateDiagramTool } from './tools/diagram.js';
import { registerAnalyzeFileTool, registerExecuteCodeTool } from './tools/execution.js';
import { registerExplainErrorTool } from './tools/explain-error.js';
import { registerAnalyzePrTool } from './tools/pr.js';
import {
  registerAgenticSearchTool,
  registerAnalyzeUrlTool,
  registerSearchTool,
} from './tools/research.js';

export type ServerRegistrar = (server: McpServer) => void;

export const SERVER_REGISTRARS = [
  ['ask tool', registerAskTool],
  ['execute_code tool', registerExecuteCodeTool],
  ['search tool', registerSearchTool],
  ['agentic_search tool', registerAgenticSearchTool],
  ['analyze_file tool', registerAnalyzeFileTool],
  ['analyze_url tool', registerAnalyzeUrlTool],
  ['analyze_pr tool', registerAnalyzePrTool],
  ['explain_error tool', registerExplainErrorTool],
  ['compare_files tool', registerCompareFilesTool],
  ['generate_diagram tool', registerGenerateDiagramTool],
  ['cache tools', registerCacheTools],
  ['prompts', registerPrompts],
  ['resources', registerResources],
] as const satisfies readonly (readonly [string, ServerRegistrar])[];

export function registerServerFeatures(server: McpServer): void {
  for (const [, register] of SERVER_REGISTRARS) {
    register(server);
  }
}
