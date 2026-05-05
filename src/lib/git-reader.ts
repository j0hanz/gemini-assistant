import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

interface DiffArgs {
  base: string;
  head?: string | undefined;
  paths?: readonly string[] | undefined;
  extraArgs?: readonly string[] | undefined;
}

interface DiffResult {
  raw: string;
}

interface StatusResult {
  raw: string;
}

export interface GitReader {
  diff(args: DiffArgs): Promise<DiffResult>;
  status(): Promise<StatusResult>;
  show(ref: string, path?: string): Promise<string>;
  isAvailable(): Promise<boolean>;
  exec(args: readonly string[]): Promise<string>;
}

// ── Real adapter (wraps execFile) ─────────────────────────────────────

export class ExecFileGitReader implements GitReader {
  constructor(private readonly cwd: string) {}

  async diff(args: DiffArgs): Promise<DiffResult> {
    const positional = args.head ? [args.base, args.head] : [args.base];
    const paths = args.paths ? ['--', ...args.paths] : [];
    const extra = args.extraArgs ? [...args.extraArgs] : [];
    const { stdout } = await execFileAsync('git', ['diff', ...extra, ...positional, ...paths], {
      cwd: this.cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return { raw: stdout };
  }

  async status(): Promise<StatusResult> {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1'], {
      cwd: this.cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return { raw: stdout };
  }

  async show(ref: string, path?: string): Promise<string> {
    const args = path ? ['show', `${ref}:${path}`] : ['show', ref];
    const { stdout } = await execFileAsync('git', args, {
      cwd: this.cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return stdout;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('git', ['--version'], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async exec(args: readonly string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args as string[], {
      cwd: this.cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return stdout;
  }
}

// ── Test adapter (returns pre-canned data) ────────────────────────────

interface FixtureConfig {
  diffRaw?: string;
  statusRaw?: string;
  showOutput?: string;
  available?: boolean;
  execOutput?: Record<string, string>;
}

export class FixtureGitReader implements GitReader {
  constructor(private readonly config: FixtureConfig) {}

  async diff(_args: DiffArgs): Promise<DiffResult> {
    return await Promise.resolve({ raw: this.config.diffRaw ?? '' });
  }

  async status(): Promise<StatusResult> {
    return await Promise.resolve({ raw: this.config.statusRaw ?? '' });
  }

  async show(_ref: string, _path?: string): Promise<string> {
    return await Promise.resolve(this.config.showOutput ?? '');
  }

  async isAvailable(): Promise<boolean> {
    return await Promise.resolve(this.config.available ?? false);
  }

  async exec(args: readonly string[]): Promise<string> {
    const key = args.join(' ');
    return await Promise.resolve(this.config.execOutput?.[key] ?? '');
  }
}
