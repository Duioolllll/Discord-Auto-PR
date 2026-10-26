import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer as createTcpServer, type Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createDatabase, type Database } from '@hub/db';
import { createQueue } from '@hub/queue';
import { Orchestrator, Workflow, hash } from '@hub/orchestrator';
import type { GitHubGateway } from '@hub/github';
import { buildApp } from '../../apps/control-api/src/app.js';
import { synchronizePullRequests } from '../../apps/orchestrator/src/reconcile.js';
import { dispatchOutbox } from '../../apps/orchestrator/src/outbox.js';
import { supervise } from '../../apps/worker-supervisor/src/supervisor.js';
import { createControlClient } from '../../apps/discord-bot/src/control-client.js';
import { handleCommand } from '../../apps/discord-bot/src/commands.js';
import { prepareTestDatabase } from '../helpers/test-db.js';
import { FakeGitHub } from '../fixtures/github.js';

process.loadEnvFile('.env');
const connection = process.env.TEST_DATABASE_URL!;
const url = new URL(connection);
if (url.pathname !== '/hub_test' || !['localhost', '127.0.0.1'].includes(url.hostname))
  throw new Error('Use the dedicated loopback hub_test database');
const config = {
  DATABASE_URL: connection,
  REDIS_URL: process.env.REDIS_URL!,
  ADMIN_API_TOKEN: 'admin-fixture-'.padEnd(64, 'a'),
  BOT_API_TOKEN: 'bot-fixture-'.padEnd(64, 'b'),
  WORKER_ENROLLMENT_TOKEN: 'enroll-fixture-'.padEnd(64, 'c'),
  GITHUB_WEBHOOK_SECRET: 'webhook-fixture-'.padEnd(64, 'd'),
  HOST: '127.0.0.1',
  PORT: 3001,
};
const admin = { id: 'local-admin', admin: true };
const headers = { authorization: `Bearer ${config.ADMIN_API_TOKEN}` };
let db: Database;
let service: Orchestrator;
let repository: Awaited<ReturnType<Database['repository']['create']>>;
let github: FakeGitHub;
let workflow: Workflow;
const job = () =>
  service
    .createJob(admin, {
      externalRequestId: randomUUID(),
      repository: repository.fullName,
      instruction: 'regression fixture',
      engine: 'codex',
      kind: 'develop',
      maxCostCents: 1,
      timeoutSeconds: 30,
    })
    .then((r) => r.job);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function plan() {
  const current = await job();
  const changes = [{ path: 'README.md', contentBase64: Buffer.from('changed').toString('base64') }];
  await db.job.update({
    where: { id: current.id },
    data: { status: 'NEEDS_HUMAN_ACTION', baseSha: 'a'.repeat(40) },
  });
  await db.jobStep.create({
    data: {
      jobId: current.id,
      key: 'publish-pr',
      status: 'STARTED',
      inputHash: hash(JSON.stringify(changes)),
      result: { baseSha: 'a'.repeat(40), changes },
    },
  });
  return current;
}
beforeAll(async () => {
  await prepareTestDatabase(connection);
  db = createDatabase(connection);
});
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "Repository", "Worker", "Identity", "TransactionOutbox", "WebhookInbox", "AuditEvent", "DeadLetter" CASCADE',
  );
  repository = await db.repository.create({
    data: {
      fullName: 'test/reliability',
      installationId: '42',
      budget: { create: { limitCents: 100000 } },
    },
  });
  github = new FakeGitHub();
  service = new Orchestrator(db);
  workflow = new Workflow(db, service, github);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => db.$disconnect());

it('does not recover a disabled repository or a job whose cancellation already committed', async () => {
  const disabled = await plan();
  await db.repository.update({ where: { id: repository.id }, data: { enabled: false } });
  await expect(workflow.reconcilePublish(admin, disabled.id)).rejects.toMatchObject({
    code: 'REPOSITORY_DISABLED',
  });
  expect(github.writes).toBe(0);
  expect((await db.job.findUniqueOrThrow({ where: { id: disabled.id } })).status).toBe(
    'NEEDS_HUMAN_ACTION',
  );
  await db.repository.update({ where: { id: repository.id }, data: { enabled: true } });
  const cancelled = await plan();
  await service.cancel(admin, cancelled.id);
  await expect(workflow.reconcilePublish(admin, cancelled.id)).rejects.toMatchObject({
    code: 'RECONCILIATION_NOT_REQUIRED',
  });
  expect(github.writes).toBe(0);
});
it('fences recovery against cancellation and another concurrent recovery', async () => {
  const current = await plan();
  const entered = deferred();
  const release = deferred();
  const original = github.publish.bind(github);
  vi.spyOn(github, 'publish').mockImplementation(async (...args) => {
    entered.resolve();
    await release.promise;
    return original(...args);
  });
  const pending = workflow.reconcilePublish(admin, current.id);
  try {
    await entered.promise;
    await expect(service.cancel(admin, current.id)).rejects.toMatchObject({
      code: 'JOB_NOT_CANCELLABLE',
    });
    await expect(workflow.reconcilePublish(admin, current.id)).rejects.toMatchObject({
      code: 'RECONCILIATION_NOT_REQUIRED',
    });
  } finally {
    release.resolve();
  }
  await pending;
  expect(github.publish).toHaveBeenCalledTimes(1);
  expect((await db.job.findUniqueOrThrow({ where: { id: current.id } })).status).toBe('PR_OPEN');
  expect(await db.jobEvent.count({ where: { jobId: current.id, kind: 'PR_OPEN' } })).toBe(1);
});
it('does not overwrite a newer recovery context after external work completes', async () => {
  const current = await plan();
  const original = github.publish.bind(github);
  vi.spyOn(github, 'publish').mockImplementation(async (...args) => {
    await db.job.update({
      where: { id: current.id },
      data: { status: 'NEEDS_HUMAN_ACTION', version: { increment: 1 } },
    });
    return original(...args);
  });
  await expect(workflow.reconcilePublish(admin, current.id)).rejects.toMatchObject({
    code: 'CONCURRENT_MODIFICATION',
  });
  expect((await db.job.findUniqueOrThrow({ where: { id: current.id } })).status).toBe(
    'NEEDS_HUMAN_ACTION',
  );
  expect(await db.pRLink.count()).toBe(0);
  expect((await db.jobStep.findFirstOrThrow()).status).toBe('STARTED');
});
it('visits all 51 pending PRs on every synchronization pass', async () => {
  await db.repository.update({ where: { id: repository.id }, data: { requiredChecks: ['ci'] } });
  const jobs = Array.from({ length: 51 }, () => randomUUID());
  await db.job.createMany({
    data: jobs.map((id) => ({
      id,
      externalRequestId: id,
      fingerprint: 'fixture',
      repositoryId: repository.id,
      actorId: admin.id,
      instruction: 'fixture',
      engine: 'codex',
      kind: 'develop',
      status: 'CI_WAIT',
    })),
  });
  await db.pRLink.createMany({
    data: jobs.map((jobId, i) => ({
      jobId,
      number: i + 1,
      branch: `hub/job-${jobId}`,
      url: `https://github.com/test/reliability/pull/${i + 1}`,
      headSha: github.headSha,
      baseSha: 'a'.repeat(40),
    })),
  });
  github.checkConclusion = 'pending';
  const remote: GitHubGateway = github;
  const original = remote.evidence.bind(remote);
  const spy = vi
    .spyOn(remote, 'evidence')
    .mockImplementation((repo, number) => original(repo, number));
  for (let pass = 0; pass < 2; pass++) {
    spy.mockClear();
    await synchronizePullRequests(db, remote);
    expect(new Set(spy.mock.calls.map(([, number]) => number)).size).toBe(51);
  }
});
it('returns the PR relation and newest logs while preserving forward event pagination', async () => {
  const current = await job();
  await db.pRLink.create({
    data: {
      jobId: current.id,
      number: 1,
      branch: `hub/job-${current.id}`,
      url: 'https://github.com/test/reliability/pull/1',
      headSha: github.headSha,
      baseSha: 'a'.repeat(40),
    },
  });
  await db.jobEvent.createMany({
    data: Array.from({ length: 105 }, (_, i) => ({
      jobId: current.id,
      eventId: randomUUID(),
      kind: 'FIXTURE',
      message: `event-${i + 1}`,
    })),
  });
  const userId = '123456789012345678';
  await db.roleBinding.create({
    data: { actorId: `discord:${userId}`, repositoryId: repository.id, role: 'developer' },
  });
  const app = buildApp({ db, config, pingRedis: async () => true, github });
  try {
    const detail = await app.inject({ url: `/jobs/${current.id}`, headers });
    expect(detail.json().pullRequest.number).toBe(1);
    const first = (await app.inject({ url: `/jobs/${current.id}/events`, headers })).json();
    expect(first.events).toHaveLength(100);
    const next = (
      await app.inject({ url: `/jobs/${current.id}/events?after=${first.cursor}`, headers })
    ).json();
    expect(next.events.at(-1).message).toBe('event-105');
    const latest = (
      await app.inject({ url: `/jobs/${current.id}/events?latest=true&limit=10`, headers })
    ).json();
    expect(latest.events.map((event: { message: string }) => event.message)).toEqual(
      Array.from({ length: 10 }, (_, i) => `event-${96 + i}`),
    );
    expect(
      (await app.inject({ url: `/jobs/${current.id}/events?latest=true&after=1`, headers }))
        .statusCode,
    ).toBe(400);
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const editReply = vi.fn(async (_payload: unknown) => undefined);
    await handleCommand(
      {
        commandName: 'logs',
        id: randomUUID(),
        user: { id: userId },
        options: { getString: () => current.id },
        deferReply: async () => undefined,
        editReply,
      } as unknown as Parameters<typeof handleCommand>[0],
      createControlClient(base, config.BOT_API_TOKEN),
    );
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('event-105') }),
    );
  } finally {
    await app.close();
  }
});
it('rejects token counter overflow at the API and stores the maximum valid count', async () => {
  await job();
  const worker = await service.register({ name: 'fixture', engines: ['codex'], maxConcurrent: 1 });
  const lease = (await service.claim(worker.workerId))!;
  const proof = { leaseToken: lease.leaseToken, leaseVersion: lease.leaseVersion };
  await service.heartbeat(worker.workerId, [{ ...proof, attemptId: lease.attemptId }]);
  const app = buildApp({ db, config, pingRedis: async () => true, github });
  const result = {
    status: 'success',
    summary: 'fixture',
    changedPaths: [],
    artifacts: [],
    usage: [{ source: 'token_estimate', inputTokens: 2147483648 }],
  };
  try {
    const call = (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: `/attempts/${lease.attemptId}/complete`,
        headers: { authorization: `Bearer ${worker.token}` },
        payload: payload as Record<string, unknown>,
      });
    expect((await call({ ...proof, eventId: 'overflow', result })).statusCode).toBe(400);
    expect((await db.job.findUniqueOrThrow({ where: { id: lease.job.id } })).status).toBe(
      'RUNNING',
    );
    result.usage[0]!.inputTokens = 2147483647;
    expect((await call({ ...proof, eventId: 'valid', result })).statusCode).toBe(200);
    expect((await db.usageSample.findFirstOrThrow()).inputTokens).toBe(2147483647);
  } finally {
    await app.close();
  }
});
it('does not publish when shutdown arrives during recursive collection', async () => {
  const current = await job();
  const stop = new AbortController();
  vi.spyOn(github, 'snapshot').mockResolvedValue({
    baseSha: 'a'.repeat(40),
    files: Array.from({ length: 600 }, (_, i) => ({
      path: `f-${i}.txt`,
      contentBase64: Buffer.from('before').toString('base64'),
    })),
  });
  const app = buildApp({ db, config, pingRedis: async () => true, github });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const root = await mkdtemp(join(tmpdir(), 'hub-abort-collect-'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await supervise({
      baseUrl: base,
      enrollmentToken: config.WORKER_ENROLLMENT_TOKEN,
      root,
      once: true,
      signal: stop.signal,
      verify: async () => {
        timer = setTimeout(() => stop.abort(), 5);
        return true;
      },
      adapter: {
        engine: 'codex',
        healthcheck: async () => true,
        supports: () => true,
        run: async (spec) => {
          await writeFile(join(root, spec.workspaceId, 'f-0.txt'), 'after');
          return {
            status: 'success',
            summary: 'fixture',
            changedPaths: [],
            artifacts: [],
            usage: [],
          };
        },
      },
    });
    expect(github.writes).toBe(0);
    expect((await db.job.findUniqueOrThrow({ where: { id: current.id } })).status).toBe(
      'CANCELLED',
    );
  } finally {
    clearTimeout(timer);
    stop.abort();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('quarantines an inaccessible tree and proceeds to the next job', async () => {
  await job();
  await job();
  const stop = new AbortController();
  let runs = 0;
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const app = buildApp({ db, config, pingRedis: async () => true, github });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const root = await mkdtemp(join(tmpdir(), 'hub-quarantine-'));
  try {
    await supervise({
      baseUrl: base,
      enrollmentToken: config.WORKER_ENROLLMENT_TOKEN,
      root,
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(5000)]),
      verify: async () => true,
      adapter: {
        engine: 'codex',
        healthcheck: async () => true,
        supports: () => true,
        run: async (spec) => {
          if (++runs === 1) {
            const locked = join(root, spec.workspaceId, 'locked');
            await mkdir(locked);
            await writeFile(join(locked, 'fixture'), 'fixture');
            await chmod(locked, 0);
          } else stop.abort();
          return {
            status: 'failed',
            summary: 'fixture',
            changedPaths: [],
            artifacts: [],
            usage: [],
          };
        },
      },
    });
    expect(runs).toBe(2);
    expect(errors).toHaveBeenCalledWith(
      'Workspace cleanup failed; isolated job files require operator cleanup.',
    );
    expect((await readdir(root)).filter((name) => name.startsWith('.quarantine-'))).toHaveLength(1);
  } finally {
    stop.abort();
    await app.close();
    for (const name of await readdir(root))
      if (name.startsWith('.quarantine-'))
        await chmod(join(root, name, 'workspace', 'locked'), 0o700);
    await rm(root, { recursive: true, force: true });
  }
});
it('records an initial Redis outage and publishes the same outbox entry after reconnecting', async () => {
  const proxy = createTcpServer();
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as { port: number }).port;
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  const offline = createQueue(`redis://127.0.0.1:${port}`);
  offline.queue.on('error', () => undefined);
  offline.connection.on('error', () => undefined);
  const entry = await db.transactionOutbox.create({ data: { topic: 'fixture', payload: {} } });
  const sockets = new Set<Socket>();
  const redis = new URL(config.REDIS_URL);
  proxy.on('connection', (incoming) => {
    const upstream = createConnection({ host: redis.hostname, port: Number(redis.port) || 6379 });
    for (const socket of [incoming, upstream]) {
      sockets.add(socket);
      socket.on('error', () => {
        incoming.destroy();
        upstream.destroy();
      });
      socket.on('close', () => sockets.delete(socket));
    }
    incoming.pipe(upstream);
    upstream.pipe(incoming);
  });
  try {
    await dispatchOutbox(db, offline.queue);
    expect(
      (await db.transactionOutbox.findUniqueOrThrow({ where: { id: entry.id } })).attempts,
    ).toBe(1);
    await new Promise<void>((resolve) => proxy.listen(port, '127.0.0.1', resolve));
    await vi.waitFor(() => expect(offline.connection.status).toBe('ready'), { timeout: 5000 });
    await offline.queue.waitUntilReady();
    await db.transactionOutbox.update({
      where: { id: entry.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await dispatchOutbox(db, offline.queue);
    expect(
      (await db.transactionOutbox.findUniqueOrThrow({ where: { id: entry.id } })).publishedAt,
    ).not.toBeNull();
    expect((await offline.queue.getJob(entry.id))?.name).toBe('fixture');
    await (await offline.queue.getJob(entry.id))?.remove();
  } finally {
    offline.connection.disconnect();
    await offline.queue.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});
