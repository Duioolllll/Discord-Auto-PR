import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createGitHubApp, timedGitHubFetch } from '@hub/github';
import { RunResult } from '@hub/contracts';
import { runPeriodicTasks } from '../../apps/orchestrator/src/scheduler.js';
import { supervise } from '../../apps/worker-supervisor/src/supervisor.js';

afterEach(() => vi.restoreAllMocks());
it('keeps lease maintenance running while another periodic task is blocked', async () => {
  const stop = new AbortController();
  let release!: () => void;
  let leases = 0;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = runPeriodicTasks(
    [
      { name: 'blocked', intervalMs: 5, run: () => blocked },
      {
        name: 'leases',
        intervalMs: 5,
        run: async () => {
          if (++leases === 3) {
            stop.abort();
            release();
          }
        },
      },
    ],
    stop.signal,
    () => undefined,
  );
  await running;
  expect(leases).toBe(3);
});
it('retries a transient idle heartbeat failure without registering another worker', async () => {
  let registrations = 0,
    heartbeats = 0;
  const id = randomUUID();
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/workers/register') {
      registrations++;
      res.statusCode = 201;
      res.end(JSON.stringify({ workerId: id, token: 'fixture' }));
    } else if (req.url?.endsWith('/heartbeat')) {
      heartbeats++;
      res.statusCode = heartbeats === 1 ? 503 : 200;
      res.end('{}');
    } else {
      res.statusCode = 204;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'hub-idle-retry-'));
  try {
    await supervise({
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      enrollmentToken: 'fixture',
      root,
      signal: AbortSignal.timeout(3000),
      once: true,
      retryDelayMs: 5,
      verify: async () => true,
      adapter: {
        engine: 'codex',
        healthcheck: async () => true,
        supports: () => true,
        run: async () => {
          throw new Error('No job should be claimed');
        },
      },
    });
    expect(registrations).toBe(1);
    expect(heartbeats).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
it('bounds both stalled GitHub headers and response bodies', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/body') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = timedGitHubFetch(fetch, 30);
  try {
    await expect(request(`${base}/headers`)).rejects.toThrow();
    await expect(request(`${base}/body`).then((response) => response.json())).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it('applies the GitHub deadline to installation authentication subrequests', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return new Response(
      JSON.stringify({
        token: 'fixture-token',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: {},
        repository_selection: 'all',
        id: 1,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const app = createGitHubApp({ appId: '1', privateKey });
  const client = await app.getInstallationOctokit(42);
  await client.request('GET /repos/{owner}/{repo}', { owner: 'fixture', repo: 'fixture' });
  expect(
    fetcher.mock.calls.some(([url]) => String(url).endsWith('/app/installations/42/access_tokens')),
  ).toBe(true);
});
it('rejects observations outside the database integer range before any publishing', () => {
  const result = {
    status: 'success',
    summary: 'fixture',
    changedPaths: [],
    artifacts: [],
    usage: [{ source: 'token_estimate', inputTokens: 2147483647, outputTokens: 1, amountUsd: 1 }],
  };
  expect(RunResult.safeParse(result).success).toBe(true);
  expect(
    RunResult.safeParse({ ...result, usage: [{ ...result.usage[0], inputTokens: 2147483648 }] })
      .success,
  ).toBe(false);
  expect(
    RunResult.safeParse({ ...result, usage: [{ ...result.usage[0], amountUsd: 3000 }] }).success,
  ).toBe(false);
});
