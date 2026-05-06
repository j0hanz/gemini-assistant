import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveAllowedHosts, validateHostHeader } from '../../src/lib/url-guard.js';

describe('host-guard', () => {
  describe('validateHostHeader', () => {
    it('returns true for exact match', () => {
      assert.equal(validateHostHeader('example.com', ['example.com']), true);
    });

    it('returns false for null header', () => {
      assert.equal(validateHostHeader(null, ['example.com']), false);
    });

    it('strips port before comparison', () => {
      assert.equal(validateHostHeader('example.com:3000', ['example.com']), true);
    });

    it('returns false when host not in allowlist', () => {
      assert.equal(validateHostHeader('evil.com', ['example.com']), false);
    });
  });

  describe('resolveAllowedHosts', () => {
    it('returns localhost names for localhost bind', () => {
      const hosts = resolveAllowedHosts('localhost');
      assert.ok(Array.isArray(hosts));
      assert.ok(hosts !== undefined && hosts.length > 0);
    });

    it('returns undefined for broad bind (0.0.0.0)', () => {
      assert.equal(resolveAllowedHosts('0.0.0.0'), undefined);
    });
  });
});
