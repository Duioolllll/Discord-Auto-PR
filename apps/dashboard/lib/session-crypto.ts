import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
function key(secret: string) {
  if (secret.length < 32) throw new Error('Dashboard session key is too short');
  return createHash('sha256').update(secret).digest();
}
export function sealToken(token: string, secret: string, now = Date.now()) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ token, expires: now + 3600000 })),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
export function openToken(value: string, secret: string, now = Date.now()): string | null {
  try {
    const buffer = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key(secret), buffer.subarray(0, 12));
    decipher.setAuthTag(buffer.subarray(12, 28));
    const payload = JSON.parse(
      Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8'),
    ) as { token: unknown; expires: number };
    return typeof payload.token === 'string' && payload.expires > now ? payload.token : null;
  } catch {
    return null;
  }
}
