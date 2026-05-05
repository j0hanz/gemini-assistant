import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isPublicHttpUrl, validateUrls } from '../../src/lib/url-guard.js';

describe('url-guard', () => {
  describe('isPublicHttpUrl', () => {
    it('returns true for a public HTTPS URL', () => {
      assert.equal(isPublicHttpUrl('https://example.com/path'), true);
    });

    it('returns false for localhost', () => {
      assert.equal(isPublicHttpUrl('http://localhost:3000'), false);
    });

    it('returns false for private IPv4', () => {
      assert.equal(isPublicHttpUrl('http://192.168.1.1'), false);
    });

    it('returns false for non-HTTP scheme', () => {
      assert.equal(isPublicHttpUrl('ftp://example.com'), false);
    });

    it('returns false for an invalid URL', () => {
      assert.equal(isPublicHttpUrl('not-a-url'), false);
    });
  });

  describe('validateUrls', () => {
    it('returns undefined when no URLs', () => {
      assert.equal(validateUrls(undefined), undefined);
    });

    it('returns undefined for valid public URLs', () => {
      assert.equal(validateUrls(['https://example.com']), undefined);
    });

    it('returns an error result for a private URL', () => {
      const result = validateUrls(['http://localhost']);
      assert.ok(result?.isError);
    });
  });
});
