import { LATEST_PROTOCOL_VERSION, type McpServer } from '@modelcontextprotocol/server';

import { pathToFileURL } from 'node:url';

import { InMemoryTransport } from './in-memory-transport.js';

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcRequest extends JsonRpcNotification {
  id: number;
}

export interface JsonRpcSuccess {
  id: number;
  jsonrpc: '2.0';
  result: Record<string, unknown>;
}

export interface JsonRpcFailure {
  error: { code: number; message: string; data?: unknown };
  id: number | null;
  jsonrpc: '2.0';
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export interface JsonSchemaLike {
  allOf?: JsonSchemaLike[];
  anyOf?: JsonSchemaLike[];
  oneOf?: JsonSchemaLike[];
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolAnnotations {
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  readOnlyHint?: boolean;
}

export interface ToolInfo {
  annotations?: ToolAnnotations;
  execution?: { taskSupport?: string };
  inputSchema?: JsonSchemaLike;
  name: string;
  outputSchema?: JsonSchemaLike;
  title?: string;
}

export interface ToolCallResult {
  content: { name?: string; text?: string; type: string; uri?: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

type HandlerResult =
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string; data?: unknown } };

type ServerRequestHandler = (request: JsonRpcRequest) => Promise<HandlerResult>;

export interface JsonRpcTestClientOptions {
  capabilities?: Record<string, unknown>;
  clientInfo?: { name: string; version: string };
  roots?: readonly { name: string; uri: string }[];
  serverRequestHandlers?: Record<string, ServerRequestHandler>;
}

export interface ServerHarness {
  client: JsonRpcTestClient;
  close: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isJsonRpcResponse(message: unknown): message is JsonRpcResponse {
  return (
    isRecord(message) && message.jsonrpc === '2.0' && 'id' in message && !('method' in message)
  );
}

export function isJsonRpcServerRequest(message: unknown): message is JsonRpcRequest {
  return isRecord(message) && message.jsonrpc === '2.0' && 'id' in message && 'method' in message;
}

export function isJsonRpcFailure(message: JsonRpcResponse): message is JsonRpcFailure {
  return 'error' in message;
}

function defaultRoots(): { name: string; uri: string }[] {
  return [{ uri: pathToFileURL(process.cwd()).href, name: 'workspace' }];
}

function defaultServerHandlers(
  options: JsonRpcTestClientOptions,
): Record<string, ServerRequestHandler> {
  const handlers: Record<string, ServerRequestHandler> = {
    'roots/list': async () => ({ result: { roots: [...(options.roots ?? defaultRoots())] } }),
  };

  return {
    ...handlers,
    ...(options.serverRequestHandlers ?? {}),
  };
}

export class JsonRpcTestClient {
  private nextId = 0;
  private readonly notifications: JsonRpcNotification[] = [];
  private readonly pending = new Map<number, (message: JsonRpcResponse) => void>();
  private readonly serverRequestHandlers: Record<string, ServerRequestHandler>;
  private readonly serverRequestMethods: string[] = [];
  private readonly unexpectedServerRequests: string[] = [];

  constructor(
    private readonly transport: InMemoryTransport,
    private readonly options: JsonRpcTestClientOptions = {},
  ) {
    this.serverRequestHandlers = defaultServerHandlers(options);
    this.transport.onmessage = (message) => {
      if (isJsonRpcServerRequest(message)) {
        void this.handleServerRequest(message);
        return;
      }

      if (isJsonRpcResponse(message)) {
        this.pending.get(message.id ?? -1)?.(message);
        if (typeof message.id === 'number') {
          this.pending.delete(message.id);
        }
        return;
      }

      this.notifications.push(message as JsonRpcNotification);
    };
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    this.serverRequestMethods.push(request.method);
    const handler = this.serverRequestHandlers[request.method];

    if (!handler) {
      this.unexpectedServerRequests.push(request.method);
      await this.transport.send({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32601,
          message: `Unhandled server request: ${request.method}`,
        },
      });
      return;
    }

    const response = await handler(request);
    await this.transport.send({
      jsonrpc: '2.0',
      id: request.id,
      ...response,
    });
  }

  async start(): Promise<void> {
    await this.transport.start();
  }

  async close(): Promise<void> {
    this.pending.clear();
    await this.transport.close();
  }

  async initialize(): Promise<JsonRpcSuccess> {
    const response = await this.request('initialize', {
      capabilities: this.options.capabilities ?? { roots: {} },
      clientInfo: this.options.clientInfo ?? { name: 'mcp-contract-test', version: '0.0.1' },
      protocolVersion: LATEST_PROTOCOL_VERSION,
    });
    await this.notify('notifications/initialized');
    return response;
  }

  async request(method: string, params?: Record<string, unknown>): Promise<JsonRpcSuccess> {
    const response = await this.requestRaw(method, params);

    if (isJsonRpcFailure(response)) {
      throw new Error(`JSON-RPC ${response.error.code}: ${response.error.message}`);
    }

    return response;
  }

  async requestRaw(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = ++this.nextId;
    const request: JsonRpcRequest = {
      id,
      jsonrpc: '2.0',
      method,
      ...(params ? { params } : {}),
    };

    return await new Promise<JsonRpcResponse>((resolve) => {
      this.pending.set(id, resolve);
      void this.transport.send(request);
    });
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    await this.transport.send({
      jsonrpc: '2.0',
      method,
      ...(params ? { params } : {}),
    });
  }

  getNotifications(): JsonRpcNotification[] {
    return [...this.notifications];
  }

  getServerRequestMethods(): string[] {
    return [...this.serverRequestMethods];
  }

  getUnexpectedServerRequests(): string[] {
    return [...this.unexpectedServerRequests];
  }
}

export async function flushEventLoop(turns = 2): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export async function createServerHarness(
  createInstance: () => { close: () => Promise<void>; server: McpServer },
  clientOptions: JsonRpcTestClientOptions = {},
  options: {
    autoInitialize?: boolean;
    closeOrder?: 'client-first' | 'server-first';
    flushAfterServerClose?: number;
    flushBeforeClose?: number;
  } = {},
): Promise<ServerHarness> {
  const instance = createInstance();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new JsonRpcTestClient(clientTransport, clientOptions);

  await client.start();
  await instance.server.connect(serverTransport as Parameters<McpServer['connect']>[0]);

  if (options.autoInitialize) {
    await client.initialize();
  }

  return {
    client,
    close: async () => {
      await flushEventLoop(options.flushBeforeClose ?? 0);

      if (options.closeOrder === 'client-first') {
        await client.close();
        await instance.close();
      } else {
        await instance.close();
        await flushEventLoop(options.flushAfterServerClose ?? 0);
        await client.close();
      }
    },
  };
}
