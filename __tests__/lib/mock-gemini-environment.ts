import { FinishReason } from '@google/genai';
import type { GenerateContentResponse, Part } from '@google/genai';
import type { Interactions } from '@google/genai';

import { getAI } from '../../src/client.js';

async function* fakeStream(
  chunks: readonly GenerateContentResponse[],
): AsyncGenerator<GenerateContentResponse> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function ttlToExpireTime(ttl?: string): string {
  if (!ttl) {
    return '2099-01-01T00:00:00.000Z';
  }

  const seconds = Number.parseInt(ttl.replace(/s$/, ''), 10);
  if (Number.isNaN(seconds)) {
    return '2099-01-01T00:00:00.000Z';
  }

  return new Date(Date.parse('2099-01-01T00:00:00.000Z') + seconds * 1000).toISOString();
}

export function makeChunk(
  parts: Part[],
  finishReason?: FinishReason,
  candidateExtras?: Record<string, unknown>,
): GenerateContentResponse {
  return {
    candidates: [
      {
        content: { parts },
        ...(finishReason ? { finishReason } : {}),
        ...(candidateExtras ?? {}),
      },
    ],
  } as GenerateContentResponse;
}

export function createDeferredStream(...chunks: GenerateContentResponse[]): {
  release: () => void;
  stream: AsyncGenerator<GenerateContentResponse>;
} {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    release,
    stream: (async function* () {
      await ready;
      for (const chunk of chunks) {
        yield chunk;
      }
    })(),
  };
}

export class MockGeminiEnvironment {
  private readonly client = getAI();
  private readonly originalCreateCache = this.client.caches.create.bind(this.client.caches);
  private readonly originalDeleteCache = this.client.caches.delete.bind(this.client.caches);
  private readonly originalDeleteFile = this.client.files.delete.bind(this.client.files);
  private readonly originalGenerateContentStream = this.client.models.generateContentStream.bind(
    this.client.models,
  );
  private readonly originalInteractionCancel = this.client.interactions.cancel.bind(
    this.client.interactions,
  );
  private readonly originalInteractionCreate = this.client.interactions.create.bind(
    this.client.interactions,
  );
  private readonly originalInteractionGet = this.client.interactions.get.bind(
    this.client.interactions,
  );
  private readonly originalGetCache = this.client.caches.get.bind(this.client.caches);
  private readonly originalListCaches = this.client.caches.list.bind(this.client.caches);
  private readonly originalUpdateCache = this.client.caches.update.bind(this.client.caches);
  private readonly originalUpload = this.client.files.upload.bind(this.client.files);
  private readonly cacheStore = new Map<
    string,
    { displayName?: string; expireTime: string; model: string; name: string }
  >();
  private readonly cancelledIds: string[] = [];
  private readonly interactionQueue: Interactions.Interaction[] = [];
  private readonly pollQueue = new Map<string, Interactions.Interaction[]>();
  private readonly streamQueue: AsyncGenerator<GenerateContentResponse>[] = [];
  private uploadCounter = 0;
  readonly deletedUploads: string[] = [];

  install(): void {
    const cacheStore = this.cacheStore;
    const deletedUploads = this.deletedUploads;

    this.client.models.generateContentStream = async () => {
      const next = this.streamQueue.shift();
      if (!next) {
        throw new Error('No mocked Gemini stream queued for generateContentStream');
      }

      return next;
    };

    this.client.interactions.create = async () => {
      const next = this.interactionQueue.shift();
      if (!next) {
        throw new Error('No mocked Interaction queued for interactions.create');
      }

      return next;
    };

    this.client.interactions.get = async (id: string) => {
      const responses = this.pollQueue.get(id) ?? [];
      const next = responses.shift();
      if (!next) {
        throw new Error(`No poll response queued for interaction id="${id}"`);
      }

      return next;
    };

    this.client.interactions.cancel = async (id: string) => {
      this.cancelledIds.push(id);
      return {
        id,
        created: '2099-01-01T00:00:00.000Z',
        status: 'cancelled',
        updated: '2099-01-01T00:00:00.000Z',
      };
    };

    this.client.files.upload = async (opts: { file: Blob | string }) => {
      this.uploadCounter += 1;
      const fileName =
        typeof opts.file === 'string'
          ? (opts.file.split(/[\\/]/).pop() ?? `upload-${String(this.uploadCounter)}`)
          : `upload-${String(this.uploadCounter)}`;
      return {
        mimeType: 'text/plain',
        name: `uploaded-${String(this.uploadCounter)}`,
        uri: `gs://mock/${fileName}`,
      };
    };

    this.client.files.delete = async (opts: { name: string }) => {
      deletedUploads.push(opts.name);
      return {};
    };

    this.client.caches.create = async (opts: {
      config?: { displayName?: string };
      model?: string;
    }) => {
      const name = `cachedContents/mock-${String(cacheStore.size + 1)}`;
      const cache = {
        expireTime: '2099-01-01T00:00:00.000Z',
        model: opts.model ?? 'models/mock-gemini',
        name,
        ...(opts.config?.displayName ? { displayName: opts.config.displayName } : {}),
      };
      cacheStore.set(name, cache);
      return cache;
    };

    this.client.caches.get = async (opts: { name: string }) => {
      const cache = cacheStore.get(opts.name);
      if (!cache) {
        throw new Error(`Missing cache ${opts.name}`);
      }
      return cache;
    };

    this.client.caches.list = (async () => ({
      async *[Symbol.asyncIterator]() {
        for (const cache of cacheStore.values()) {
          yield cache;
        }
      },
    })) as unknown as typeof this.client.caches.list;

    this.client.caches.update = async (opts: { config?: { ttl?: string }; name: string }) => {
      const existing = cacheStore.get(opts.name) ?? {
        expireTime: '2099-01-01T00:00:00.000Z',
        model: 'models/mock-gemini',
        name: opts.name,
      };
      const updated = {
        ...existing,
        expireTime: ttlToExpireTime(opts.config?.ttl),
      };
      cacheStore.set(opts.name, updated);
      return updated;
    };

    this.client.caches.delete = async (opts: { name: string }) => {
      cacheStore.delete(opts.name);
      return {};
    };
  }

  restore(): void {
    this.client.models.generateContentStream = this.originalGenerateContentStream;
    this.client.interactions.cancel = this.originalInteractionCancel;
    this.client.interactions.create = this.originalInteractionCreate;
    this.client.interactions.get = this.originalInteractionGet;
    this.client.files.upload = this.originalUpload;
    this.client.files.delete = this.originalDeleteFile;
    this.client.caches.create = this.originalCreateCache;
    this.client.caches.get = this.originalGetCache;
    this.client.caches.list = this.originalListCaches;
    this.client.caches.delete = this.originalDeleteCache;
    this.client.caches.update = this.originalUpdateCache;
    this.streamQueue.length = 0;
    this.interactionQueue.length = 0;
    this.pollQueue.clear();
    this.cancelledIds.length = 0;
    this.cacheStore.clear();
    this.deletedUploads.length = 0;
    this.uploadCounter = 0;
  }

  queueStream(...chunks: GenerateContentResponse[]): void {
    this.streamQueue.push(fakeStream(chunks));
  }

  queueGenerator(stream: AsyncGenerator<GenerateContentResponse>): void {
    this.streamQueue.push(stream);
  }

  queueInteraction(interaction: Interactions.Interaction): void {
    this.interactionQueue.push(interaction);
  }

  queuePollResponses(id: string, ...responses: Interactions.Interaction[]): void {
    this.pollQueue.set(id, [...(this.pollQueue.get(id) ?? []), ...responses]);
  }

  get cancelledInteractionIds(): readonly string[] {
    return this.cancelledIds;
  }
}
