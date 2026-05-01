import type { ReadResourceResult } from '@modelcontextprotocol/server';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

import { PROFILES, TOOL_PROFILE_NAMES } from '../lib/tool-profiles.js';

import {
  listDiscoveryEntries,
  listWorkflowEntries,
  renderDiscoveryCatalogMarkdown,
  renderWorkflowCatalogMarkdown,
} from '../catalog.js';
import { ResourceMemo } from './index.js';
import { buildResourceMeta } from './metadata.js';
import {
  ASSISTANT_CATALOG_URI,
  ASSISTANT_CONTEXT_URI,
  ASSISTANT_INSTRUCTIONS_URI,
  ASSISTANT_PROFILES_URI,
  ASSISTANT_WORKFLOWS_URI,
} from './uris.js';

/**
 * Build profiles content as JSON.
 * Returns a JSON object describing all available tool profiles.
 */
function buildProfilesContent(): string {
  const profileMap: Record<string, object> = {};

  for (const profileName of TOOL_PROFILE_NAMES) {
    const profile = PROFILES[profileName];
    profileMap[profileName] = {
      name: profile.name,
      builtIns: profile.builtIns,
      defaultThinkingLevel: profile.defaultThinkingLevel,
      meta: profile.meta,
      notes: profile.notes,
    };
  }

  return JSON.stringify(profileMap, null, 2);
}

/**
 * Build server instructions content as markdown.
 * Returns markdown text describing the server's role, capabilities, and constraints.
 */
function buildInstructionsContent(): string {
  return `# Gemini Assistant Server Instructions

## Role

The gemini-assistant is an MCP server that provides a job-first interface over Google Gemini. It exposes four primary tools (chat, research, analyze, review), three prompts for guided workflows, and a set of resources for discovery and introspection.

## Capabilities

### Tools
- **chat**: Direct conversation with Gemini, with optional session management
- **research**: Grounded information lookup with web search and synthesis
- **analyze**: File and URL analysis, code review, and diagram generation
- **review**: Diff review, file comparison, and failure diagnosis

### Prompts
- **discover**: Entry point for workflows and resource discovery
- **research**: Guide for multi-step research workflows
- **review**: Instructions for PR and code review workflows

### Resources

#### Discovery (assistant://)
- **assistant://discover/catalog**: Tool, prompt, and resource catalog
- **assistant://discover/workflows**: Guided workflow documentation
- **assistant://discover/context**: Server context and configuration snapshot
- **assistant://profiles**: Available tool profiles (plain, grounded, web-research, etc.)
- **assistant://instructions**: This document

#### Sessions (gemini://)
- **gemini://session/{sessionId}**: Individual session details
- **gemini://session/{sessionId}/transcript**: Conversation transcript
- **gemini://session/{sessionId}/events**: Session events
- **gemini://session/{sessionId}/turn/{turnIndex}/parts**: Interaction outputs

#### Workspace (gemini://)
- **gemini://workspace/cache**: Cache status and metadata
- **gemini://workspace/files/{path}**: Individual workspace files

## Constraints

- Session resources are memory-only; enable via \`MCP_EXPOSE_SESSION_RESOURCES=true\`
- Workspace context cache requires ≥4000 tokens to activate
- Tool invocations must match registered input schemas
- All file paths must be workspace-relative (no absolute paths or traversal)

## Data Model

### Tool Input/Output
- Tools accept structured JSON input matching Zod schemas
- Output is either text or structured JSON with optional \`_meta\` blocks
- Metadata includes generation timestamp, caching info, TTL, and resource links

### Profiles
Tool profiles define which capabilities (search, URLs, code execution, etc.) are available:
- **plain**: Pure generation
- **grounded**: Real-time web search with citations
- **web-research**: Search + read specific pages
- **deep-research**: Search + synthesis + computation
- **urls-only**: Caller-supplied URLs only
- **code-math**: Code execution and visualization
- **code-math-grounded**: Computation over fresh facts
- **visual-inspect**: Image analysis with zoom/annotation
- **rag**: File search (mutually exclusive with others)
- **agent**: Custom function calling
- **structured**: Enforced JSON schema output

### Sessions
Sessions store conversation history with both filtered (replay-safe) and raw parts. Each turn includes Gemini content, tool calls, and optional thought outputs (when exposed).

## Workflows

1. **start-here**: Introduction to the server, discovery of tools and resources
2. **chat**: Conversation setup with optional background context
3. **research**: Multi-step fact-finding and synthesis
4. **analyze**: Deep code/document inspection with comparisons
5. **review**: PR and code quality assessment with actionable feedback

## Environment Configuration

Key environment variables:
- \`GEMINI_API_KEY\`: Required Gemini API key
- \`MCP_EXPOSE_THOUGHTS\`: Show internal model reasoning (default: false)
- \`MCP_EXPOSE_SESSION_RESOURCES\`: Enable session transcripts (default: false)
- \`WORKSPACE_CACHE_ENABLED\`: Enable smart workspace caching (default: false)
- \`TRANSPORT\`: Select transport: stdio, http, web-standard (default: stdio)

## Quick Start

1. Start the server with stdio transport: \`npm run inspector\`
2. Access the **discover://catalog** resource for available tools
3. Read **assistant://workflows** for guided job workflows
4. Use **chat** tool for general conversation
5. Use **research** for fact-finding with citations
`;
}

/**
 * Build context content as markdown.
 * Returns markdown describing the context resources and how they're used.
 */
function buildContextContent(): string {
  return `# Assistant Context

## Overview

The gemini-assistant context resources provide real-time insights into the server's state:

- **Workspace**: Files, cache status, and configuration
- **Sessions**: Active conversations and their transcripts
- **Metadata**: Generation timestamps, TTLs, and caching information

## Workspace Context

The workspace cache intelligently scans project files (readme.md, package.json, tsconfig.json, etc.) and makes their content available to the Gemini API via context caching. This reduces token usage for repetitive queries against the same files.

**Status available at**: \`gemini://workspace/cache\`

## Sessions

Sessions store conversation history for multi-turn interactions. Each session:
- Has a unique ID (auto-generated UUID)
- Stores both user and assistant messages
- Preserves tool calls and responses
- Optionally exposes internal model reasoning

**Access sessions at**: \`gemini://session/{sessionId}\`

## Metadata

All resources include \`_meta\` blocks with:
- \`generatedAt\`: ISO timestamp of resource generation
- \`source\`: 'gemini-assistant'
- \`cached\`: Whether the resource is cached
- \`ttlMs\`: Cache TTL in milliseconds
- \`size\`: Approximate byte size
- \`links\`: Resource URIs for navigation

Example meta block:
\`\`\`json
{
  "_meta": {
    "generatedAt": "2026-05-01T12:34:56.789Z",
    "source": "gemini-assistant",
    "cached": true,
    "ttlMs": 3600000,
    "size": 15234,
    "links": {
      "self": {
        "uri": "assistant://discover/catalog",
        "name": "Discovery Catalog",
        "mimeType": "text/markdown"
      }
    }
  }
}
\`\`\`

## Caching Strategy

Resources use time-based cache invalidation:
- **Catalog** (1 hour): Tool and prompt metadata rarely changes
- **Workflows** (1 hour): Workflow documentation is stable
- **Context** (5 minutes): Workspace state changes frequently
- **Profiles** (never): Profile definitions are static
- **Instructions** (30 minutes): Server documentation is semi-stable

## Resource Links

All resources are discoverable via resource links in their \`_meta\` blocks. Use the \`links.self\` entry to navigate between related resources.
`;
}

class DiscoverResourceHandler {
  private catalogMemo = new ResourceMemo<string, string>();
  private workflowsMemo = new ResourceMemo<string, string>();
  private contextMemo = new ResourceMemo<string, string>();
  private profilesMemo = new ResourceMemo<string, string>();
  private instructionsMemo = new ResourceMemo<string, string>();

  async readResource(uri: string): Promise<string> {
    switch (uri) {
      case ASSISTANT_CATALOG_URI:
        return await this.catalogMemo.get('catalog', 3_600_000, () => {
          const entries = listDiscoveryEntries();
          const markdown = renderDiscoveryCatalogMarkdown(entries);
          const meta = buildResourceMeta({
            source: 'gemini-assistant',
            cached: true,
            ttlMs: 3_600_000,
            size: markdown.length,
            selfUri: ASSISTANT_CATALOG_URI,
          });
          return `${markdown}\n\n_meta: ${JSON.stringify(meta)}`;
        });

      case ASSISTANT_WORKFLOWS_URI:
        return await this.workflowsMemo.get('workflows', 3_600_000, () => {
          const entries = listWorkflowEntries();
          const markdown = renderWorkflowCatalogMarkdown(entries);
          const meta = buildResourceMeta({
            source: 'gemini-assistant',
            cached: true,
            ttlMs: 3_600_000,
            size: markdown.length,
            selfUri: ASSISTANT_WORKFLOWS_URI,
          });
          return `${markdown}\n\n_meta: ${JSON.stringify(meta)}`;
        });

      case ASSISTANT_CONTEXT_URI:
        return await this.contextMemo.get('context', 300_000, () => {
          const markdown = buildContextContent();
          const meta = buildResourceMeta({
            source: 'gemini-assistant',
            cached: true,
            ttlMs: 300_000,
            size: markdown.length,
            selfUri: ASSISTANT_CONTEXT_URI,
          });
          return `${markdown}\n\n_meta: ${JSON.stringify(meta)}`;
        });

      case ASSISTANT_PROFILES_URI:
        return await this.profilesMemo.get('profiles', Number.POSITIVE_INFINITY, () => {
          const content = buildProfilesContent();
          const meta = buildResourceMeta({
            source: 'gemini-assistant',
            cached: true,
            ttlMs: Number.POSITIVE_INFINITY,
            size: content.length,
            selfUri: ASSISTANT_PROFILES_URI,
          });
          return `${content}\n\n_meta: ${JSON.stringify(meta)}`;
        });

      case ASSISTANT_INSTRUCTIONS_URI:
        return await this.instructionsMemo.get('instructions', 1_800_000, () => {
          const markdown = buildInstructionsContent();
          const meta = buildResourceMeta({
            source: 'gemini-assistant',
            cached: true,
            ttlMs: 1_800_000,
            size: markdown.length,
            selfUri: ASSISTANT_INSTRUCTIONS_URI,
          });
          return `${markdown}\n\n_meta: ${JSON.stringify(meta)}`;
        });

      default:
        throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, `Unknown resource: ${uri}`);
    }
  }

  invalidate(uri?: string): void {
    if (!uri) {
      this.catalogMemo.invalidate();
      this.workflowsMemo.invalidate();
      this.contextMemo.invalidate();
      this.profilesMemo.invalidate();
      this.instructionsMemo.invalidate();
      return;
    }

    switch (uri) {
      case ASSISTANT_CATALOG_URI:
        this.catalogMemo.invalidate('catalog');
        break;
      case ASSISTANT_WORKFLOWS_URI:
        this.workflowsMemo.invalidate('workflows');
        break;
      case ASSISTANT_CONTEXT_URI:
        this.contextMemo.invalidate('context');
        break;
      case ASSISTANT_PROFILES_URI:
        this.profilesMemo.invalidate('profiles');
        break;
      case ASSISTANT_INSTRUCTIONS_URI:
        this.instructionsMemo.invalidate('instructions');
        break;
    }
  }
}

let handlerInstance: DiscoverResourceHandler | undefined;

function getHandler(): DiscoverResourceHandler {
  handlerInstance ??= new DiscoverResourceHandler();
  return handlerInstance;
}

/**
 * Create a ReadResourceResult for the given URI and content.
 */
function readResourceContent(uri: string, content: string): ReadResourceResult {
  // Determine MIME type based on URI
  const mimeType = uri === ASSISTANT_PROFILES_URI ? 'application/json' : 'text/markdown';

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
 * Resource request object.
 */
interface ResourceRequest {
  uri: string;
}

/**
 * Register discover resources under the assistant:// scheme.
 * This provides read-only access to catalogs, workflows, context, profiles, and instructions.
 */
export function registerDiscoverResources(server: {
  setResourceContentsHandler(
    handler: (request: ResourceRequest) => Promise<ReadResourceResult>,
  ): void;
}): void {
  const handler = getHandler();

  server.setResourceContentsHandler(async (request): Promise<ReadResourceResult> => {
    const uri = request.uri;
    const validUris = [
      ASSISTANT_CATALOG_URI,
      ASSISTANT_WORKFLOWS_URI,
      ASSISTANT_CONTEXT_URI,
      ASSISTANT_PROFILES_URI,
      ASSISTANT_INSTRUCTIONS_URI,
    ];

    if (!validUris.includes(uri as typeof ASSISTANT_CATALOG_URI)) {
      throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, `Unknown resource: ${uri}`);
    }

    const content = await handler.readResource(uri);
    return readResourceContent(uri, content);
  });
}

export function invalidateDiscoverResourceCache(uri?: string): void {
  const handler = getHandler();
  handler.invalidate(uri);
}
