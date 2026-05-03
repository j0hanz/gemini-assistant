import { ResourceTemplate } from '@modelcontextprotocol/server';
import type { McpServer, ReadResourceResult } from '@modelcontextprotocol/server';

/**
 * A resource definition reduced to its essentials.
 *
 * `read` returns the textual body for the given URI. The helpers below own the
 * `ReadResourceResult` envelope (mime type, contents array, URL coercion) so
 * that handlers don't have to repeat that shape per registration.
 */
interface ResourceDefinition {
  /** Unique resource identifier passed to `server.registerResource`. */
  id: string;
  description?: string;
  mimeType?: string;
  /** Produce the resource body for the given URI. */
  read: (uri: string) => Promise<string> | string;
}

function buildOptions(def: ResourceDefinition): { description?: string; mimeType?: string } {
  return {
    ...(def.description !== undefined ? { description: def.description } : {}),
    ...(def.mimeType !== undefined ? { mimeType: def.mimeType } : {}),
  };
}

function buildContents(uri: string, mimeType: string | undefined, text: string) {
  return [
    {
      uri,
      ...(mimeType !== undefined ? { mimeType } : {}),
      text,
    },
  ];
}

/**
 * Register a resource bound to a fixed URI.
 * The handler's `read` callback receives the static URI as-is.
 */
export function registerStaticResource(
  server: McpServer,
  uri: string,
  def: ResourceDefinition,
): void {
  server.registerResource(def.id, uri, buildOptions(def), async (): Promise<ReadResourceResult> => {
    const text = await def.read(uri);
    return { contents: buildContents(uri, def.mimeType, text) };
  });
}

/**
 * Register a resource backed by a URI template.
 * The handler's `read` callback receives the incoming concrete URI string.
 */
export function registerTemplateResource(
  server: McpServer,
  template: string,
  def: ResourceDefinition,
): void {
  server.registerResource(
    def.id,
    new ResourceTemplate(template, { list: undefined }),
    buildOptions(def),
    async (uri): Promise<ReadResourceResult> => {
      const uriStr = typeof uri === 'string' ? uri : uri.href;
      const text = await def.read(uriStr);
      return { contents: buildContents(uriStr, def.mimeType, text) };
    },
  );
}
