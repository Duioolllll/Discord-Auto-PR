import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhook } from '@hub/github';

describe('raw-body webhook authentication', () => {
  const raw = Buffer.from('{ "event": "push" }');
  const signature = `sha256=${createHmac('sha256', 'test-secret').update(raw).digest('hex')}`;
  it('validates exact signed bytes', () =>
    expect(verifyWebhook(raw, signature, 'test-secret')).toBe(true));
  it('rejects reserialization and wrong secrets', () => {
    expect(verifyWebhook(Buffer.from('{"event":"push"}'), signature, 'test-secret')).toBe(false);
    expect(verifyWebhook(raw, signature, 'wrong-secret')).toBe(false);
  });
  it.each([undefined, '', 'sha256=0', 'sha1=abc', `sha256=${'z'.repeat(64)}`])(
    'rejects malformed signatures %s',
    (signature) => expect(verifyWebhook(raw, signature, 'test-secret')).toBe(false),
  );
});
