import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  isPathWithinRoot,
  parseAllowedHosts,
  resolveAllowedHosts,
  resolveAndValidatePath,
  resolveWorkspacePath,
  validateHostHeader,
  validateUrls,
} from '../../src/lib/validation.js';

// ── Host Validation ───────────────────────────────────────────────────

const ALLOWED_HOSTS_ENV_KEY = 'MCP_ALLOWED_HOSTS';
const ALLOWED_FILE_ROOTS_ENV_KEY = 'ALLOWED_FILE_ROOTS';
const savedAllowedHostsEnv = process.env[ALLOWED_HOSTS_ENV_KEY];
const savedAllowedFileRootsEnv = process.env[ALLOWED_FILE_ROOTS_ENV_KEY];

function restoreAllowedHostsEnv(): void {
  if (savedAllowedHostsEnv === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[ALLOWED_HOSTS_ENV_KEY];
  } else {
    process.env[ALLOWED_HOSTS_ENV_KEY] = savedAllowedHostsEnv;
  }
}

function setAllowedHostsEnv(value: string | undefined): void {
  if (value === undefined) {
    restoreAllowedHostsEnv();
  } else {
    process.env[ALLOWED_HOSTS_ENV_KEY] = value;
  }
}

function restoreAllowedFileRootsEnv(): void {
  if (savedAllowedFileRootsEnv === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[ALLOWED_FILE_ROOTS_ENV_KEY];
  } else {
    process.env[ALLOWED_FILE_ROOTS_ENV_KEY] = savedAllowedFileRootsEnv;
  }
}

function setAllowedFileRootsEnv(value: string | undefined): void {
  if (value === undefined) {
    restoreAllowedFileRootsEnv();
  } else {
    process.env[ALLOWED_FILE_ROOTS_ENV_KEY] = value;
  }
}

describe('parseAllowedHosts', () => {
  afterEach(() => {
    restoreAllowedHostsEnv();
  });

  it('returns undefined when env is not set', () => {
    setAllowedHostsEnv(undefined);
    assert.equal(parseAllowedHosts(), undefined);
  });

  it('returns undefined for empty string', () => {
    setAllowedHostsEnv('');
    assert.equal(parseAllowedHosts(), undefined);
  });

  it('returns undefined for whitespace-only string', () => {
    setAllowedHostsEnv('  ,  , ');
    assert.equal(parseAllowedHosts(), undefined);
  });

  it('parses comma-separated hostnames', () => {
    setAllowedHostsEnv('localhost, myapp.local, [::1]');
    assert.deepEqual(parseAllowedHosts(), ['localhost', 'myapp.local', '[::1]']);
  });

  it('trims whitespace from entries', () => {
    setAllowedHostsEnv('  host1 , host2  ');
    assert.deepEqual(parseAllowedHosts(), ['host1', 'host2']);
  });

  it('handles single hostname', () => {
    setAllowedHostsEnv('myserver');
    assert.deepEqual(parseAllowedHosts(), ['myserver']);
  });
});

describe('resolveAllowedHosts', () => {
  afterEach(() => {
    restoreAllowedHostsEnv();
  });

  it('returns explicit env hosts for localhost bind', () => {
    setAllowedHostsEnv('custom.local');
    assert.deepEqual(resolveAllowedHosts('127.0.0.1'), ['custom.local']);
  });

  it('returns explicit env hosts for broad bind', () => {
    setAllowedHostsEnv('myapp.example.com');
    assert.deepEqual(resolveAllowedHosts('0.0.0.0'), ['myapp.example.com']);
  });

  it('auto-resolves localhost hosts for 127.0.0.1 bind', () => {
    assert.deepEqual(resolveAllowedHosts('127.0.0.1'), ['localhost', '127.0.0.1', '[::1]']);
  });

  it('auto-resolves localhost hosts for localhost bind', () => {
    assert.deepEqual(resolveAllowedHosts('localhost'), ['localhost', '127.0.0.1', '[::1]']);
  });

  it('auto-resolves localhost hosts for ::1 bind', () => {
    assert.deepEqual(resolveAllowedHosts('::1'), ['localhost', '127.0.0.1', '[::1]']);
  });

  it('auto-resolves specific hostnames to the bind host', () => {
    assert.deepEqual(resolveAllowedHosts('Example.Internal'), ['example.internal']);
  });

  it('auto-resolves specific IPv4 binds to the bind host', () => {
    assert.deepEqual(resolveAllowedHosts('192.168.1.10'), ['192.168.1.10']);
  });

  it('auto-resolves specific IPv6 binds to bracketed bind hosts', () => {
    assert.deepEqual(resolveAllowedHosts('2001:db8::10'), ['[2001:db8::10]']);
  });

  it('returns undefined for 0.0.0.0 without env', () => {
    assert.equal(resolveAllowedHosts('0.0.0.0'), undefined);
  });

  it('returns undefined for :: without env', () => {
    assert.equal(resolveAllowedHosts('::'), undefined);
  });

  it('returns undefined for empty string without env', () => {
    assert.equal(resolveAllowedHosts(''), undefined);
  });
});

describe('validateHostHeader', () => {
  const ALLOWED = ['localhost', '127.0.0.1', '[::1]'];

  it('accepts matching hostname', () => {
    assert.equal(validateHostHeader('localhost', ALLOWED), true);
  });

  it('accepts hostname with port', () => {
    assert.equal(validateHostHeader('localhost:3000', ALLOWED), true);
  });

  it('rejects unknown hostname', () => {
    assert.equal(validateHostHeader('evil.example.com', ALLOWED), false);
  });

  it('rejects unknown hostname with port', () => {
    assert.equal(validateHostHeader('evil.example.com:3000', ALLOWED), false);
  });

  it('rejects null header', () => {
    assert.equal(validateHostHeader(null, ALLOWED), false);
  });

  it('rejects empty header', () => {
    assert.equal(validateHostHeader('', ALLOWED), false);
  });

  it('is case-insensitive', () => {
    assert.equal(validateHostHeader('LOCALHOST', ALLOWED), true);
    assert.equal(validateHostHeader('LocalHost:8080', ALLOWED), true);
  });

  it('handles IPv4 with port', () => {
    assert.equal(validateHostHeader('127.0.0.1:3000', ALLOWED), true);
  });

  it('handles IPv6 with brackets', () => {
    assert.equal(validateHostHeader('[::1]', ALLOWED), true);
  });

  it('handles IPv6 with brackets and port', () => {
    assert.equal(validateHostHeader('[::1]:3000', ALLOWED), true);
  });

  it('rejects IPv6 without brackets when allowlist uses brackets', () => {
    assert.equal(validateHostHeader('::1', ALLOWED), false);
  });

  it('works with custom allowlist', () => {
    const custom = ['myapp.local', 'api.internal'];
    assert.equal(validateHostHeader('myapp.local:8080', custom), true);
    assert.equal(validateHostHeader('api.internal', custom), true);
    assert.equal(validateHostHeader('other.host', custom), false);
  });
});

// ── Path Validation ───────────────────────────────────────────────────

describe('resolveAndValidatePath', () => {
  afterEach(() => {
    restoreAllowedFileRootsEnv();
  });

  it('accepts relative paths under cwd', async () => {
    const result = await resolveAndValidatePath('package.json');
    assert.ok(result.endsWith('package.json'));
  });

  it('accepts relative dot paths under cwd', async () => {
    const result = await resolveAndValidatePath('./package.json');
    assert.ok(result.endsWith('package.json'));
  });

  it('accepts absolute paths under cwd', async () => {
    const testPath = join(process.cwd(), 'package.json');
    const result = await resolveAndValidatePath(testPath);
    assert.ok(result.endsWith('package.json'));
  });

  it('rejects paths outside allowed roots', async () => {
    // Use a path that is definitely outside cwd
    const outsidePath =
      process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/etc/passwd';
    // Only test if this is actually outside cwd
    const cwd = process.cwd().toLowerCase();
    if (!outsidePath.toLowerCase().startsWith(cwd)) {
      await assert.rejects(() => resolveAndValidatePath(outsidePath), {
        message: /outside allowed directories/,
      });
    }
  });

  it('resolves normalized paths', async () => {
    const testPath = join(process.cwd(), 'src', '..', 'package.json');
    const result = await resolveAndValidatePath(testPath);
    // Should resolve to the actual path without ..
    assert.ok(!result.includes('..'));
    assert.ok(result.endsWith('package.json'));
  });

  it('handles non-existent files under allowed root gracefully', async () => {
    const testPath = join(process.cwd(), 'nonexistent-test-file-12345.txt');
    // Should not throw — just validate it's under allowed root
    const result = await resolveAndValidatePath(testPath);
    assert.ok(result.includes('nonexistent-test-file-12345.txt'));
  });

  it('uses rootsFetcher roots when provided', async () => {
    const testPath = join(process.cwd(), 'package.json');
    const fetcher = async () => [process.cwd()];
    const result = await resolveAndValidatePath(testPath, fetcher);
    assert.ok(result.endsWith('package.json'));
  });

  it('rejects path outside rootsFetcher roots', async () => {
    const outsidePath =
      process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/etc/passwd';
    const fetcher = async () => [process.cwd()];
    await assert.rejects(() => resolveAndValidatePath(outsidePath, fetcher), {
      message: /outside allowed directories/,
    });
  });

  it('rejects sibling paths that share the same string prefix as the allowed root', async () => {
    const fetcher = async () => [process.cwd()];
    const siblingPath = join(`${process.cwd()}-backup`, 'secret.txt');

    await assert.rejects(() => resolveAndValidatePath(siblingPath, fetcher), {
      message: /outside allowed directories/,
    });
  });

  it('falls back to env roots when rootsFetcher returns empty', async () => {
    const testPath = join(process.cwd(), 'package.json');
    const fetcher = async () => [] as string[];
    const result = await resolveAndValidatePath(testPath, fetcher);
    assert.ok(result.endsWith('package.json'));
  });

  it('falls back to env roots when rootsFetcher throws', async () => {
    const testPath = join(process.cwd(), 'package.json');
    const fetcher = async () => {
      throw new Error('client does not support roots');
    };
    const result = await resolveAndValidatePath(testPath, fetcher);
    assert.ok(result.endsWith('package.json'));
  });

  it('does not let client roots expand beyond ALLOWED_FILE_ROOTS', async () => {
    const outsidePath =
      process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/etc/passwd';

    if (outsidePath.toLowerCase().startsWith(process.cwd().toLowerCase())) {
      return;
    }

    setAllowedFileRootsEnv(process.cwd());
    const fetcher = async () => [process.platform === 'win32' ? 'C:\\' : '/'];

    await assert.rejects(() => resolveAndValidatePath(outsidePath, fetcher), {
      message: /outside allowed directories/,
    });
  });
});

describe('resolveWorkspacePath', () => {
  afterEach(() => {
    restoreAllowedFileRootsEnv();
  });

  it('returns a workspace-relative display path for cwd files', async () => {
    const result = await resolveWorkspacePath(join(process.cwd(), 'src', 'index.ts'));
    assert.strictEqual(result.displayPath, 'src/index.ts');
  });

  it('resolves relative paths using client roots', async () => {
    const fetcher = async () => [process.cwd()];
    const result = await resolveWorkspacePath('src/index.ts', fetcher);

    assert.ok(result.resolvedPath.endsWith(join('src', 'index.ts')));
    assert.strictEqual(result.displayPath, 'src/index.ts');
    assert.strictEqual(result.workspaceRoot, process.cwd());
  });

  it('rejects relative paths that escape the workspace root', async () => {
    await assert.rejects(() => resolveWorkspacePath('../package.json'), {
      message: /escapes the workspace root/,
    });
  });

  it('rejects ambiguous relative paths across multiple roots', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'gemini-assistant-roots-'));
    const rootA = join(tempRoot, 'root-a');
    const rootB = join(tempRoot, 'root-b');

    try {
      await mkdir(join(rootA, 'src'), { recursive: true });
      await mkdir(join(rootB, 'src'), { recursive: true });
      await writeFile(join(rootA, 'src', 'shared.ts'), 'export const a = 1;\n');
      await writeFile(join(rootB, 'src', 'shared.ts'), 'export const b = 2;\n');

      setAllowedFileRootsEnv(`${rootA},${rootB}`);
      const fetcher = async () => [rootA, rootB];

      await assert.rejects(() => resolveWorkspacePath('src/shared.ts', fetcher), {
        message: /ambiguous across workspace roots/,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('isPathWithinRoot', () => {
  it('accepts exact root matches', () => {
    assert.equal(isPathWithinRoot(process.cwd(), process.cwd()), true);
  });

  it('accepts descendants under the allowed root', () => {
    assert.equal(isPathWithinRoot(join(process.cwd(), 'src', 'index.ts'), process.cwd()), true);
  });

  it('rejects sibling paths with a matching string prefix', () => {
    assert.equal(
      isPathWithinRoot(join(`${process.cwd()}-backup`, 'index.ts'), process.cwd()),
      false,
    );
  });
});

describe('validateUrls', () => {
  it('accepts public http and https URLs', () => {
    assert.strictEqual(validateUrls(['https://example.com', 'http://example.org/path']), undefined);
  });

  it('rejects custom schemes', () => {
    const result = validateUrls(['ftp://example.com/file.txt']);
    assert.strictEqual(result?.isError, true);
    assert.match(result?.content[0]?.text ?? '', /Only http:\/\/ and https:\/\//);
  });

  it('rejects localhost and private-network targets', () => {
    const localhost = validateUrls(['https://localhost:3000']);
    const privateNet = validateUrls(['http://192.168.1.10/dashboard']);

    assert.strictEqual(localhost?.isError, true);
    assert.strictEqual(privateNet?.isError, true);
    assert.match(localhost?.content[0]?.text ?? '', /Private, loopback, and localhost URLs/);
    assert.match(privateNet?.content[0]?.text ?? '', /Private, loopback, and localhost URLs/);
  });
});
