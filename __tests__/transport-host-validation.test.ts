import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  isAutoDerivedAllowedHosts,
  resolveAllowedHosts,
  validateHostHeader,
} from '../src/lib/validation.js';

afterEach(() => {
  delete process.env.MCP_ALLOWED_HOSTS;
});

describe('transport host validation helpers', () => {
  it('resolves identical default host policies for localhost, broad, and specific binds', () => {
    const cases = [
      {
        bindHost: '127.0.0.1',
        expectedAllowedHosts: ['localhost', '127.0.0.1', '[::1]'],
        acceptedHostHeader: '127.0.0.1:3000',
        rejectedHostHeader: 'evil.example.com:3000',
        autoDerived: false,
      },
      {
        bindHost: '0.0.0.0',
        expectedAllowedHosts: undefined,
        acceptedHostHeader: null,
        rejectedHostHeader: null,
        autoDerived: false,
      },
      {
        bindHost: '192.0.2.1',
        expectedAllowedHosts: ['192.0.2.1'],
        acceptedHostHeader: '192.0.2.1:3000',
        rejectedHostHeader: 'evil.example.com:3000',
        autoDerived: true,
      },
    ] as const;

    for (const testCase of cases) {
      const allowedHosts = resolveAllowedHosts(testCase.bindHost);
      assert.deepStrictEqual(allowedHosts, testCase.expectedAllowedHosts);
      assert.equal(isAutoDerivedAllowedHosts(testCase.bindHost), testCase.autoDerived);

      if (allowedHosts && testCase.acceptedHostHeader && testCase.rejectedHostHeader) {
        assert.equal(validateHostHeader(testCase.acceptedHostHeader, allowedHosts), true);
        assert.equal(validateHostHeader(testCase.rejectedHostHeader, allowedHosts), false);
      }
    }
  });

  it('lets explicit MCP_ALLOWED_HOSTS override auto-derived bind behavior', () => {
    process.env.MCP_ALLOWED_HOSTS = 'example.com,[::1]';

    const allowedHosts = resolveAllowedHosts('192.0.2.1');
    assert.deepStrictEqual(allowedHosts, ['example.com', '[::1]']);
    assert.equal(isAutoDerivedAllowedHosts('192.0.2.1'), false);
    assert.equal(validateHostHeader('example.com:3000', allowedHosts), true);
    assert.equal(validateHostHeader('[::1]:3000', allowedHosts), true);
    assert.equal(validateHostHeader('192.0.2.1:3000', allowedHosts), false);
  });
});
