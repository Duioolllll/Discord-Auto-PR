import 'server-only';
import { cookies } from 'next/headers';
import { sealToken, openToken } from './session-crypto';
import { controlApiUrl } from './control-url';

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
  const base = controlApiUrl();
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
  timeoutSeconds: number;
  repository: { fullName: string };
  pullRequest?: { url: string; number: number; headSha: string };
}
export interface Repository {
  id: string;
  fullName: string;
  enabled: boolean;
  verifiedAt?: string;
  baseBranch: string;
}
export interface Worker {
  id: string;
  name: string;
  engines: string[];
  heartbeatAt: string;
  draining: boolean;
  maxConcurrent: number;
}
