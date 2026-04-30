import { logger } from './logger.js';

interface NotifierServer {
  sendResourceListChanged(): void;
  sendResourceUpdated(params: { uri: string }): Promise<void>;
}

const FILE_STORM_CAP = 50;

/**
 * Convert a file path to a resource URI.
 * Local implementation to avoid cross-task blockers (TASK-104 creates the shared version).
 */
function fileResourceUri(path: string): string {
  return `gemini://workspace/files/${path}`;
}

export class ResourceNotifier {
  private disposed = false;
  private readonly log = logger.child('resource-notifier');

  constructor(private readonly server: NotifierServer) {}

  async notifyUpdated(uri: string): Promise<void> {
    if (this.disposed) return;
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
      // notification without waiting. The async method signature allows the
      // caller to optionally await if needed, but we don't block here.
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
