import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  isPathWithinRoot,
  parseAllowedHosts,
  resolveAllowedHosts,
  resolveAndValidatePath,
  validateHostHeader,
} from '../../src/lib/validation.js';

// ── Host Validation ───────────────────────────────────────────────────

const ENV_KEY = 'MCP_ALLOWED_HOSTS';
const savedEnv = process.env[ENV_KEY];

function clearEnv(): void {
  if (savedEnv === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = savedEnv;
  }
}

function setEnv(value: string | undefined): void {
  if (value === undefined) {
    clearEnv();
  } else {
    process.env[ENV_KEY] = value;
  }
}

describe('parseAllowedHosts', () => {
  afterEach(() => {
    clearEnv();
  });

  it('returns undefined when env is not set', () => {
    setEnv(undefined);
    assert.equal(parseAllowedHosts(), undefined);
  });

  it('returns undefined for empty string', () => {
    setEnv('');
    assert.equal(parseAllowedHosts(), undefined);
  });

  it('returns undefined for whitespace-only string', () => {
    setEnv('  ,  , ');
    assert.equal(parseAllowedHosts(), undefined);
  });

  it('parses comma-separated hostnames', () => {
    setEnv('localhost, myapp.local, [::1]');
    assert.deepEqual(parseAllowedHosts(), ['localhost', 'myapp.local', '[::1]']);
  });

  it('trims whitespace from entries', () => {
    setEnv('  host1 , host2  ');
    assert.deepEqual(parseAllowedHosts(), ['host1', 'host2']);
  });

  it('handles single hostname', () => {
    setEnv('myserver');
    assert.deepEqual(parseAllowedHosts(), ['myserver']);
  });
});

describe('resolveAllowedHosts', () => {
  afterEach(() => {
    clearEnv();
  });

  it('returns explicit env hosts for localhost bind', () => {
    setEnv('custom.local');
    assert.deepEqual(resolveAllowedHosts('127.0.0.1'), ['custom.local']);
  });

  it('returns explicit env hosts for broad bind', () => {
    setEnv('myapp.example.com');
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
  it('rejects relative paths', async () => {
    await assert.rejects(() => resolveAndValidatePath('relative/path.txt'), {
      message: /must be absolute/,
    });
  });

  it('rejects relative dot paths', async () => {
    await assert.rejects(() => resolveAndValidatePath('./file.txt'), {
      message: /must be absolute/,
    });
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
