import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  getAllowedRoots,
  isPathWithinRoot,
  parseAllowedHosts,
  resolveAllowedHosts,
  resolveAndValidatePath,
  resolveWorkspacePath,
  validateHostHeader,
  validateUrls,
} from '../../src/lib/validation.js';

// ── Host Validation ───────────────────────────────────────────────────

const ROOTS_ENV_KEY = 'ROOTS';
const ALLOWED_HOSTS_ENV_KEY = 'ALLOWED_HOSTS';
const savedAllowedFileRootsEnv = process.env[ROOTS_ENV_KEY];
const savedAllowedHostsEnv = process.env[ALLOWED_HOSTS_ENV_KEY];

function restoreAllowedFileRootsEnv(): void {
  if (savedAllowedFileRootsEnv === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[ROOTS_ENV_KEY];
  } else {
    process.env[ROOTS_ENV_KEY] = savedAllowedFileRootsEnv;
  }
}

function setAllowedFileRootsEnv(value: string | undefined): void {
  if (value === undefined) {
    restoreAllowedFileRootsEnv();
  } else {
    process.env[ROOTS_ENV_KEY] = value;
  }
}

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

function firstTextContent(result: ReturnType<typeof validateUrls>): string {
  const entry = result?.content[0];
  return entry?.type === 'text' ? entry.text : '';
}

afterEach(() => {
  restoreAllowedHostsEnv();
});

describe('parseAllowedHosts', () => {
  it('returns undefined when ALLOWED_HOSTS is unset', () => {
    setAllowedHostsEnv(undefined);

    assert.equal(parseAllowedHosts(), undefined);
  });

  it('normalizes explicit allowed-host entries', () => {
    setAllowedHostsEnv('Example.com:3000, EXAMPLE.com, ::1, [2001:db8::10]:8080');

    assert.deepEqual(parseAllowedHosts(), ['example.com', '[::1]', '[2001:db8::10]']);
  });
});

describe('resolveAllowedHosts', () => {
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

  it('normalizes bare IPv6 when allowlist uses brackets', () => {
    assert.equal(validateHostHeader('::1', ALLOWED), true);
  });

  it('works with custom allowlist', () => {
    const custom = ['myapp.local', 'api.internal'];
    assert.equal(validateHostHeader('myapp.local:8080', custom), true);
    assert.equal(validateHostHeader('api.internal', custom), true);
    assert.equal(validateHostHeader('other.host', custom), false);
  });

  it('accepts normalized equivalent configured host forms', () => {
    assert.equal(validateHostHeader('example.com', ['example.com:3000']), true);
    assert.equal(validateHostHeader('example.com:8080', ['EXAMPLE.com']), true);
    assert.equal(validateHostHeader('[::1]:3000', ['::1']), true);
    assert.equal(validateHostHeader('[::1]', ['[::1]']), true);
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

  it('defaults allowed roots to client workspace roots when ROOTS is unset', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'gemini-assistant-client-roots-'));
    setAllowedFileRootsEnv('');

    try {
      const roots = await getAllowedRoots(async () => [tempRoot]);

      assert.deepStrictEqual(roots, [tempRoot]);
    } finally {
      restoreAllowedFileRootsEnv();
      await rm(tempRoot, { recursive: true, force: true });
    }
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

  it('does not let client roots expand beyond ROOTS', async () => {
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

  it('resolves duplicate relative paths against the allowed root intersection first', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'gemini-assistant-allowed-roots-'));
    const rootA = join(tempRoot, 'root-a');
    const rootB = join(tempRoot, 'root-b');

    try {
      await mkdir(join(rootA, 'src'), { recursive: true });
      await mkdir(join(rootB, 'src'), { recursive: true });
      await writeFile(join(rootA, 'src', 'shared.ts'), 'export const a = 1;\n');
      await writeFile(join(rootB, 'src', 'shared.ts'), 'export const b = 2;\n');

      setAllowedFileRootsEnv(rootA);
      const fetcher = async () => [rootA, rootB];

      const result = await resolveWorkspacePath('src/shared.ts', fetcher);

      assert.strictEqual(result.workspaceRoot, rootA);
      assert.strictEqual(result.displayPath, 'src/shared.ts');
      assert.strictEqual(result.resolvedPath, join(rootA, 'src', 'shared.ts'));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects relative paths outside the allowed roots after resolution', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'gemini-assistant-outside-roots-'));
    const rootA = join(tempRoot, 'root-a');
    const rootB = join(tempRoot, 'root-b');

    try {
      await mkdir(join(rootA, 'src'), { recursive: true });
      await mkdir(join(rootB, 'src'), { recursive: true });
      await writeFile(join(rootB, 'src', 'shared.ts'), 'export const b = 2;\n');

      setAllowedFileRootsEnv(rootA);
      const fetcher = async () => [rootB];

      await assert.rejects(() => resolveWorkspacePath('src/shared.ts', fetcher), {
        message: /outside allowed directories/,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects absolute paths outside the allowed roots', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'gemini-assistant-absolute-roots-'));
    const allowedRoot = join(tempRoot, 'allowed');
    const outsideRoot = join(tempRoot, 'outside');
    const outsidePath = join(outsideRoot, 'src', 'shared.ts');

    try {
      await mkdir(join(allowedRoot, 'src'), { recursive: true });
      await mkdir(join(outsideRoot, 'src'), { recursive: true });
      await writeFile(outsidePath, 'export const value = 1;\n');

      setAllowedFileRootsEnv(allowedRoot);

      await assert.rejects(() => resolveWorkspacePath(outsidePath), {
        message: /outside allowed directories/,
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
    assert.match(firstTextContent(result), /Only http:\/\/ and https:\/\//);
  });

  it('rejects localhost and private-network targets', () => {
    const localhost = validateUrls(['https://localhost:3000']);
    const privateNet = validateUrls(['http://192.168.1.10/dashboard']);

    assert.strictEqual(localhost?.isError, true);
    assert.strictEqual(privateNet?.isError, true);
    assert.match(firstTextContent(localhost), /Private, loopback, and localhost URLs/);
    assert.match(firstTextContent(privateNet), /Private, loopback, and localhost URLs/);
  });

  it('rejects expanded special-use IPv4 and IPv6 literal ranges', () => {
    const rejectedUrls = [
      'http://0.0.0.0',
      'http://100.64.0.1',
      'http://198.18.0.1',
      'http://198.51.100.1',
      'http://203.0.113.1',
      'http://224.0.0.1',
      'http://[ff02::1]',
    ];

    for (const url of rejectedUrls) {
      const result = validateUrls([url]);
      assert.strictEqual(result?.isError, true, url);
      assert.match(firstTextContent(result), /Private, loopback, and localhost URLs/);
    }
  });
});
