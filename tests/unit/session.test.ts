import { expect, it } from 'vitest';
import { sealToken, openToken } from '../../apps/dashboard/lib/session-crypto.js';
it('rejects forged, expired and wrong-key dashboard sessions', () => {
  const secret = 'a'.repeat(64);
  const sealed = sealToken('test-token', secret, 1000);
  expect(sealed).not.toContain('test-token');
  expect(openToken(sealed, secret, 2000)).toBe('test-token');
  expect(openToken(sealed, secret, 3601001)).toBeNull();
  expect(openToken(sealed, 'b'.repeat(64), 2000)).toBeNull();
  const decoded = Buffer.from(sealed, 'base64url');
  decoded[30] = (decoded[30] ?? 0) ^ 1;
  expect(openToken(decoded.toString('base64url'), secret, 2000)).toBeNull();
});
