import type { McpServer } from '@modelcontextprotocol/server';

type Transport = Parameters<McpServer['connect']>[0];
type MessageHandler = NonNullable<Transport['onmessage']>;
type TransportMessage = Parameters<NonNullable<Transport['send']>>[0];
type TransportMessageExtra = Parameters<MessageHandler>[1];
type TransportSendOptions = Parameters<NonNullable<Transport['send']>>[1];

function defer(callback: () => void): void {
  queueMicrotask(callback);
}

export class InMemoryTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];

  private closed = false;
  private peer?: InMemoryTransport;
  private started = false;

  static createLinkedPair(): [InMemoryTransport, InMemoryTransport] {
    const left = new InMemoryTransport();
    const right = new InMemoryTransport();
    left.peer = right;
    right.peer = left;
    return [left, right];
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error('InMemoryTransport already started');
    }
    this.started = true;
  }

  async send(message: TransportMessage, options?: TransportSendOptions): Promise<void> {
    if (this.closed) {
      throw new Error('InMemoryTransport is closed');
    }
    if (!this.started) {
      throw new Error('InMemoryTransport has not been started');
    }

    const peer = this.peer;
    if (!peer || peer.closed) {
      throw new Error('InMemoryTransport peer is unavailable');
    }

    defer(() => {
      try {
        peer.onmessage?.(message, options as TransportMessageExtra);
      } catch (error) {
        this.onerror?.(error as Error);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}
