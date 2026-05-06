import { ProtocolError, ProtocolErrorCode, ResourceTemplate } from '@modelcontextprotocol/server';
import type { McpServer, ReadResourceResult } from '@modelcontextprotocol/server';

import { logger } from '../lib/logger.js';
import type { RootsFetcher } from '../lib/path-guard.js';
import type { StoreRegistry } from '../lib/store-registry.js';
import type { ToolServices } from '../lib/tool-executor.js';
import type { ResourceLink, ResourceMetadata } from '../schemas/outputs.js';

import type { SessionStore } from '../sessions.js';
import { registerDiscoverResources } from './discover.js';
import { registerSessionResources } from './sessions.js';
import { registerStoreResources } from './stores.js';
import { fileResourceUri } from './uris.js';
import { registerWorkspaceResources } from './workspace.js';

// ── Resource registry ─────────────────────────────────────────────────────

interface ResourceServices {
  sessionStore: SessionStore;
  toolServices: ToolServices;
  rootsFetcher: RootsFetcher;
  storeRegistry?: StoreRegistry;
}

/**
 * Register all resource modules with the MCP server.
 * Discovers, sessions/turns, workspace, and store resources.
 */
export function registerAllResources(server: McpServer, services: ResourceServices): void {
  registerDiscoverResources(server);
  registerSessionResources(server, services);
  registerWorkspaceResources(server, services.toolServices);
  if (services.storeRegistry) {
    registerStoreResources(server, services.storeRegistry);
  }
}

export * from './links.js';

// ── Resource registration helpers ────────────────────────────────────────

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

// ── Resource metadata builder ────────────────────────────────────────────

/**
 * Build a ResourceMetadata object with all required and optional fields.
 * Auto-sets generatedAt to current ISO timestamp if not provided.
 * Validates source is a known enum value.
 */
export function buildResourceMeta(options: {
  generatedAt?: string;
  source?: string;
  cached?: boolean;
  ttlMs?: number;
  size?: number;
  selfUri?: string;
  links?: ResourceLink[];
}): ResourceMetadata {
  if (options.source && options.source !== 'gemini-assistant') {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Invalid source: ${options.source}. Must be 'gemini-assistant'`,
    );
  }

  const meta: ResourceMetadata = {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    source: 'gemini-assistant',
    cached: options.cached ?? false,
    ...(options.ttlMs !== undefined && { ttlMs: options.ttlMs }),
    ...(options.size !== undefined && { size: options.size }),
  };

  if (options.selfUri) {
    meta.links = { self: { uri: options.selfUri } };
  } else if (options.links) {
    meta.links = { self: options.links[0] };
  }

  return meta;
}

// ── ResourceMemo ─────────────────────────────────────────────────────────

interface MemoEntry<V> {
  value: V;
  expiresAt: number;
}

export class ResourceMemo<K, V> {
  private readonly cache = new Map<K, MemoEntry<V>>();
  private readonly inflight = new Map<K, Promise<V>>();

  async get(key: K, ttlMs: number, build: () => V | Promise<V>): Promise<V> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }

    const promise = (async (): Promise<V> => {
      try {
        const value = await build();
        const expiresAt =
          ttlMs === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Date.now() + ttlMs;
        this.cache.set(key, { value, expiresAt });
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  invalidate(key?: K): void {
    if (key === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(key);
  }
}

// ── ResourceNotifier ─────────────────────────────────────────────────────

interface NotifierServer {
  sendResourceListChanged(): void;
  sendResourceUpdated(params: { uri: string }): Promise<void>;
}

interface ResourceNotifierOptions {
  /**
   * Optional predicate to filter `notifications/resources/updated` emissions
   * to only URIs the client has subscribed to via `resources/subscribe`.
   * If omitted, all updates are broadcast unconditionally.
   */
  isSubscribed?: (uri: string) => boolean;
}

const FILE_STORM_CAP = 50;

export class ResourceNotifier {
  private disposed = false;
  private readonly log = logger.child('resource-notifier');
  private readonly isSubscribed: (uri: string) => boolean;

  constructor(
    private readonly server: NotifierServer,
    options: ResourceNotifierOptions = {},
  ) {
    this.isSubscribed = options.isSubscribed ?? ((): boolean => true);
  }

  async notifyUpdated(uri: string): Promise<void> {
    if (this.disposed) return;
    if (!this.isSubscribed(uri)) return;
    try {
      await this.server.sendResourceUpdated({ uri });
    } catch (err) {
      this.log.warn('sendResourceUpdated failed', { uri, err: String(err) });
    }
  }

  notifyListChanged(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    try {
      // Fire-and-forget: sendResourceListChanged is synchronous and queues the
      // notification without waiting.
      this.server.sendResourceListChanged();
      return Promise.resolve();
    } catch (err) {
      this.log.warn('sendResourceListChanged failed', { err: String(err) });
      return Promise.resolve();
    }
  }

  async notifyFilesChanged(paths: readonly string[]): Promise<void> {
    if (this.disposed) return;
    if (paths.length > FILE_STORM_CAP) {
      await this.notifyListChanged();
      return;
    }
    await Promise.all(paths.map((p) => this.notifyUpdated(fileResourceUri(p))));
  }

  dispose(): void {
    this.disposed = true;
  }
}
