import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { RunSpec } from '@hub/contracts';
import { CodexAdapter, RunnerFailure } from '@hub/agent-codex';
import { runSandbox } from '../../packages/agent-codex/src/container.js';
import { checkCodexSandbox } from '../../packages/agent-codex/src/probe.js';
import { supervise } from '../../apps/worker-supervisor/src/supervisor.js';

vi.mock('../../packages/agent-codex/src/container.js', async (original) => ({
  ...(await original<typeof import('../../packages/agent-codex/src/container.js')>()),
  runSandbox: vi.fn(),
}));
vi.mock('../../packages/agent-codex/src/probe.js', async (original) => ({
  ...(await original<typeof import('../../packages/agent-codex/src/probe.js')>()),
  checkCodexSandbox: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(runSandbox).mockReset();
  vi.mocked(checkCodexSandbox).mockReset();
});

const failure = () => new RunnerFailure('RUNNER_PROBE_FAILED', 'CONTAINER_CLEANUP_FAILED');
const success = () => ({
  status: 'success' as const,
  summary: 'fixture',
  changedPaths: [],
  artifacts: [],
});
const spec = (): RunSpec => ({
  jobId: randomUUID(),
  attemptId: randomUUID(),
  workspaceId: randomUUID(),
  kind: 'develop',
  engine: 'codex',
  repo: { owner: 'test', name: 'fixture', baseSha: 'a'.repeat(40) },
  instruction: 'fixture',
  limits: { timeoutSeconds: 30, maxOutputBytes: 4096 },
});
const adapter = (directory: string) =>
  new CodexAdapter({
    image: `sha256:${'a'.repeat(64)}`,
    workspaceRoot: '/tmp/fixture',
    auth: { directory },
    network: 'hub-egress-fixture',
  });

it('propagates unsafe container cleanup instead of reporting an ordinary failed CLI result', async () => {
  vi.mocked(runSandbox).mockRejectedValue(failure());
  await expect(
    adapter('/tmp/private-profile').run(spec(), new AbortController().signal),
  ).rejects.toMatchObject({ diagnostic: 'CONTAINER_CLEANUP_FAILED' });
  vi.mocked(runSandbox).mockRejectedValue(new RunnerFailure('RUNNER_PROBE_FAILED', 'TIMEOUT'));
  expect(
    (await adapter('/tmp/private-profile').run(spec(), new AbortController().signal)).status,
  ).toBe('failed');
});

it('propagates cleanup failure from readiness probes before registering a worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hub-review-profile-'));
  try {
    await writeFile(
      join(directory, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'fixture-access',
          refresh_token: 'fixture-refresh',
          id_token: 'fixture-id',
        },
      }),
      { mode: 0o600 },
    );
    vi.mocked(checkCodexSandbox).mockResolvedValue({
      ready: false,
      reason: 'RUNNER_PROBE_FAILED',
      diagnostic: { stage: 'probe', code: 'CONTAINER_CLEANUP_FAILED' },
    });
    await expect(adapter(directory).healthcheck()).rejects.toMatchObject({
      diagnostic: 'CONTAINER_CLEANUP_FAILED',
    });
    expect(runSandbox).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(slowOperations = false) {
  const root = await mkdtemp(join(tmpdir(), 'hub-review-supervisor-'));
  const attemptId = randomUUID();
  const workerId = randomUUID();
  const paths: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer(async (req, res) => {
    const path = req.url!;
    paths.push(path);
    await new Promise<void>((resolve) => {
      req.once('end', resolve);
      req.resume();
    });
    if (slowOperations && (path.endsWith('/snapshot') || path.endsWith('/publish')))
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          resolve();
        }, 10100);
        timers.add(timer);
      });
    res.setHeader('content-type', 'application/json');
    if (path === '/workers/register') res.end(JSON.stringify({ workerId, token: 'fixture' }));
    else if (path === '/workers/claim')
      res.end(
        JSON.stringify({
          attemptId,
          leaseToken: 'fixture',
          leaseVersion: 1,
          job: {
            id: randomUUID(),
            repository: 'test/fixture',
            instruction: 'fixture',
            engine: 'codex',
            kind: 'develop',
            timeoutSeconds: 30,
          },
        }),
      );
    else if (path.endsWith('/snapshot'))
      res.end(
        JSON.stringify({
          baseSha: 'a'.repeat(40),
          files: [{ path: 'README.md', contentBase64: Buffer.from('before').toString('base64') }],
        }),
      );
    else res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    root,
    paths,
    attemptId,
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

it.each(['engine', 'verification'] as const)(
  'stops and fences restart after %s container cleanup fails',
  async (stage) => {
    const f = await fixture();
    const healthcheck = vi.fn(async () => true);
    const options = {
      baseUrl: f.baseUrl,
      enrollmentToken: 'fixture',
      root: f.root,
      signal: AbortSignal.timeout(3000),
      verify: async () => {
        if (stage === 'verification') throw failure();
        return true;
      },
      adapter: {
        engine: 'codex' as const,
        healthcheck,
        supports: () => true,
        run: async () => {
          if (stage === 'engine') throw failure();
          return success();
        },
      },
    };
    try {
      await expect(supervise(options)).rejects.toMatchObject({
        diagnostic: 'CONTAINER_CLEANUP_FAILED',
      });
      expect(f.paths.filter((path) => path === '/workers/claim')).toHaveLength(1);
      expect(f.paths.some((path) => path.endsWith('/publish'))).toBe(false);
      expect(await readFile(join(f.root, '.unsafe-runner'), 'utf8')).toBe(
        'CONTAINER_CLEANUP_FAILED\n',
      );
      const retained = (await readdir(f.root)).find((name) => name.startsWith('.quarantine-'))!;
      expect(await readFile(join(f.root, retained, 'workspace', 'README.md'), 'utf8')).toBe(
        'before',
      );
      await expect(supervise(options)).rejects.toMatchObject({
        diagnostic: 'CONTAINER_CLEANUP_FAILED',
      });
      expect(healthcheck).toHaveBeenCalledTimes(1);
      expect(f.paths.filter((path) => path === '/workers/register')).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

it('keeps slow snapshot and publication requests alive within the task deadline while renewing its lease', async () => {
  const f = await fixture(true);
  try {
    await supervise({
      baseUrl: f.baseUrl,
      enrollmentToken: 'fixture',
      root: f.root,
      signal: AbortSignal.timeout(28000),
      once: true,
      verify: async () => true,
      adapter: {
        engine: 'codex',
        healthcheck: async () => true,
        supports: () => true,
        run: async () => {
          await writeFile(join(f.root, f.attemptId, 'README.md'), 'after');
          return success();
        },
      },
    });
    expect(f.paths.filter((path) => path.endsWith('/publish'))).toHaveLength(1);
    expect(f.paths.some((path) => path.endsWith('/complete'))).toBe(false);
    expect(f.paths.filter((path) => path.endsWith('/heartbeat')).length).toBeGreaterThanOrEqual(4);
  } finally {
    await f.close();
  }
}, 30000);
