import 'server-only';
import { cookies } from 'next/headers';
import { sealToken, openToken } from './session-crypto';

export const seal = (token: string) => sealToken(token, process.env.DASHBOARD_SESSION_SECRET ?? '');
export async function sessionToken() {
  const value = (await cookies()).get('hub_session')?.value;
  return value ? openToken(value, process.env.DASHBOARD_SESSION_SECRET ?? '') : null;
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  suppliedToken?: string,
): Promise<T> {
  const token = suppliedToken ?? (await sessionToken());
  if (!token) throw new Error('AUTH_REQUIRED');
  const base = new URL(process.env.CONTROL_API_URL ?? 'http://127.0.0.1:3001');
  if (
    base.protocol !== 'https:' &&
    !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname))
  )
    throw new Error('HTTPS_REQUIRED');
  const response = await fetch(new URL(path, base), {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({ error: 'API_UNAVAILABLE' }))) as {
      error?: string;
    };
    throw new Error(error.error ?? 'API_UNAVAILABLE');
  }
  return response.json() as Promise<T>;
}
export interface Job {
  id: string;
  instruction: string;
  status: string;
  engine: string;
  kind: string;
  actorId: string;
  errorCode?: string;
  createdAt: string;
  maxCostCents: number;
  repository: { fullName: string };
  pullRequest?: { url: string; number: number; headSha: string };
}
export interface Repository {
  id: string;
  fullName: string;
  enabled: boolean;
  verifiedAt?: string;
  budget?: { limitCents: number; reservedCents: number; spentCents: number };
}
export interface Worker {
  id: string;
  name: string;
  engines: string[];
  heartbeatAt: string;
  draining: boolean;
  maxConcurrent: number;
}
