import { createHmac, timingSafeEqual } from 'node:crypto';
export * from './client.js';
export * from './environment.js';
export * from './http.js';

export function verifyWebhook(raw: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}
