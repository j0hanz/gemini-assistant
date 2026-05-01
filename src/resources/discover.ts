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

role: MCP server that provides a job-first interface over Google Gemini
primary-purpose: Expose structured tools, prompts, and resources for chat, research, analysis, review, discovery, and introspection

## Capabilities

tools:
  chat: Direct conversation with Gemini, with optional session management
  research: Grounded information lookup with web search and synthesis
  analyze: File and URL analysis, code review, and diagram generation
  review: Diff review, file comparison, and failure diagnosis

prompts:
  discover: Entry point for workflows and resource discovery
  research: Guide for multi-step research workflows
  review: Instructions for PR and code review workflows

resources:
  discovery:
    assistant://discover/catalog: Tool, prompt, and resource catalog
    assistant://discover/workflows: Guided workflow documentation
    assistant://discover/context: Server context and configuration snapshot
    assistant://profiles: Available tool profiles
    assistant://instructions: Server instruction document

  sessions:
    gemini://session/{sessionId}: Individual session details
    gemini://session/{sessionId}/transcript: Conversation transcript
    gemini://session/{sessionId}/events: Session events
    gemini://session/{sessionId}/turn/{turnIndex}/parts: Interaction outputs

  workspace:
    gemini://workspace/cache: Cache status and metadata
    gemini://workspace/files/{path}: Individual workspace files

## Constraints

session-resources: Memory-only
session-resources-enabled-by: MCP_EXPOSE_SESSION_RESOURCES=true
workspace-cache-minimum-context: 4000 tokens
tool-inputs: Must match registered input schemas
file-paths: Must be workspace-relative
disallowed-paths:

- absolute paths
- path traversal

## Data Model

tool-input:
  format: Structured JSON
  schema-source: Zod schemas

tool-output:
  formats:
    - text
    - structured JSON
  optional-meta-block: _meta

metadata:
  includes:
    - generation timestamp
    - caching information
    - TTL
    - resource links

profiles:
  plain: Pure generation
  grounded: Real-time web search with citations
  web-research: Search plus reading specific pages
  deep-research: Search, synthesis, and computation
  urls-only: Caller-supplied URLs only
  code-math: Code execution and visualization
  code-math-grounded: Computation over fresh facts
  visual-inspect: Image analysis with zoom and annotation
  rag: File search; mutually exclusive with other profiles
  agent: Custom function calling
  structured: Enforced JSON schema output

sessions:
  storage: Conversation history
  stored-parts:
    filtered: Replay-safe parts
    raw: Original Gemini parts
  turn-contents:
    - Gemini content
    - tool calls
    - optional thought outputs

thought-outputs:
  exposed-when: MCP_EXPOSE_THOUGHTS=true

## Workflows

workflows:
  start-here:
    purpose: Introduce the server and discover available tools and resources

  chat:
    purpose: Set up conversation with optional background context

  research:
    purpose: Perform multi-step fact-finding and synthesis

  analyze:
    purpose: Inspect code, documents, URLs, and comparisons deeply

  review:
    purpose: Assess PRs, diffs, code quality, and failures with actionable feedback
`;
}

/**
 * Build context content as markdown.
 * Returns markdown describing the context resources and how they're used.
 */
function buildContextContent(): string {
  return `# Assistant Context

overview: Real-time context resources for inspecting gemini-assistant server state

context-areas:
  workspace: Files, cache status, and configuration
  sessions: Active conversations and transcripts
  metadata: Generation timestamps, TTLs, and caching information

## Workspace Context

workspace-context:
  purpose: Provide project file context to Gemini through workspace scanning and context caching
  scanned-files:
    - readme.md
    - package.json
    - tsconfig.json
    - other project files
  cache-behavior: Makes workspace content available to the Gemini API via context caching
  benefit: Reduces token usage for repetitive queries against the same files
  status-resource: gemini://workspace/cache

## Sessions

sessions:
  purpose: Store conversation history for multi-turn interactions
  id-format: Auto-generated UUID
  stores:
    - user messages
    - assistant messages
    - tool calls
    - tool responses
    - optional internal model reasoning
  access-pattern: gemini://session/{sessionId}

## Metadata

metadata:
  block-name: _meta
  included-in: All resources
  fields:
    generatedAt: ISO timestamp of resource generation
    source: gemini-assistant
    cached: Whether the resource is cached
    ttlMs: Cache TTL in milliseconds
    size: Approximate byte size
    links: Resource URIs for navigation

example-meta:
  _meta:
    generatedAt: "2026-05-01T12:34:56.789Z"
    source: gemini-assistant
    cached: true
    ttlMs: 3600000
    size: 15234
    links:
      self:
        uri: assistant://discover/catalog
        name: Discovery Catalog
        mimeType: text/markdown

## Caching Strategy

cache-invalidation: Time-based

resource-cache-ttl:
  catalog:
    ttl: 1 hour
    reason: Tool and prompt metadata rarely changes

  workflows:
    ttl: 1 hour
    reason: Workflow documentation is stable

  context:
    ttl: 5 minutes
    reason: Workspace state changes frequently

  profiles:
    ttl: never
    reason: Profile definitions are static

  instructions:
    ttl: 30 minutes
    reason: Server documentation is semi-stable

## Resource Links

resource-links:
  location: _meta.links
  purpose: Make resources discoverable and navigable
  primary-link: links.self
  usage: Navigate between related resources
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
