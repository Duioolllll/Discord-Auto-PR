import { prepareTestDatabase } from '../helpers/test-db.js';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type Database } from '@hub/db';
import { createQueue } from '@hub/queue';
import { Orchestrator } from '@hub/orchestrator';
import { buildApp } from '../../apps/control-api/src/app.js';
import { dispatchOutbox } from '../../apps/orchestrator/src/outbox.js';
import type { ApiEnvironment } from '../../apps/control-api/src/config.js';
import { WorkerClient } from '../../apps/worker-supervisor/src/client.js';
import { FakeGitHub } from '../fixtures/github.js';
import { supervise } from '../../apps/worker-supervisor/src/supervisor.js';
import { synchronizePullRequests } from '../../apps/orchestrator/src/reconcile.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const github = new FakeGitHub();

if (existsSync('.env')) process.loadEnvFile('.env');
const connection = process.env.TEST_DATABASE_URL;
if (!connection) throw new Error('TEST_DATABASE_URL required; run pnpm setup:local');
const testUrl = new URL(connection);
if (testUrl.pathname !== '/hub_test' || !['127.0.0.1', 'localhost'].includes(testUrl.hostname))
  throw new Error(
    'Integration tests require a dedicated loopback hub_test database; refusing destructive cleanup.',
  );
const config: ApiEnvironment = {
  DATABASE_URL: connection,
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  ADMIN_API_TOKEN: 'admin-test-'.padEnd(64, 'a'),
  BOT_API_TOKEN: 'bot-test-'.padEnd(64, 'b'),
  WORKER_ENROLLMENT_TOKEN: 'enroll-test-'.padEnd(64, 'c'),
  GITHUB_WEBHOOK_SECRET: 'webhook-test-'.padEnd(64, 'd'),
  HOST: '127.0.0.1',
  PORT: 3001,
};
let db: Database;
let app: ReturnType<typeof buildApp>;
let queue: ReturnType<typeof createQueue>;
let service: Orchestrator;
const admin = { authorization: `Bearer ${config.ADMIN_API_TOKEN}` };
const userId = '123456789012345678';
const bot = { authorization: `Bearer ${config.BOT_API_TOKEN}`, 'x-discord-user-id': userId };
const body = () => ({
  externalRequestId: randomUUID(),
  repository: 'test/installed',
  instruction: 'Fix an isolated fixture',
  kind: 'develop',
  engine: 'codex',
});
const post = (
  url: string,
  payload: string | Record<string, unknown>,
  headers: Record<string, string> = admin,
) => app.inject({ method: 'POST', url, headers, payload });
const create = async () => {
  const response = await post('/jobs', body());
  expect(response.statusCode).toBe(201);
  return response.json().job as { id: string };
};
const register = async (engines = ['codex'], maxConcurrent = 1) => {
  const response = await post(
    '/workers/register',
    { name: 'test', engines, maxConcurrent },
    { authorization: `Bearer ${config.WORKER_ENROLLMENT_TOKEN}` },
  );
  expect(response.statusCode).toBe(201);
  const worker = response.json() as { workerId: string; token: string };
  return { ...worker, headers: { authorization: `Bearer ${worker.token}` } };
};

beforeAll(async () => {
  await prepareTestDatabase(connection);
  db = createDatabase(connection);
  queue = createQueue(config.REDIS_URL);
  service = new Orchestrator(db);
  app = buildApp({ db, config, pingRedis: () => queue.connection.ping(), github });
  await app.ready();
});
beforeEach(async () => {
  github.reset();
  // Only the explicitly guarded hub_test database is ever truncated.
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "Repository", "RoleBinding", "Job", "Worker", "JobAttempt", "JobEvent", "WebhookInbox", "TransactionOutbox", "Approval", "AuditEvent", "Identity", "DeadLetter" CASCADE',
  );
  const repository = await db.repository.create({
    data: { fullName: 'test/installed', installationId: '42' },
  });
  await db.identity.create({
    data: { actorId: `discord:${userId}`, githubId: '456', githubLogin: 'requester' },
  });
  await db.budget.create({ data: { repositoryId: repository.id, limitCents: 100000 } });
  await db.roleBinding.create({
    data: { actorId: `discord:${userId}`, repositoryId: repository.id, role: 'developer' },
  });
});
afterAll(async () => {
  await app?.close();
  await queue?.queue.close();
  await queue?.connection.quit();
  await db?.$disconnect();
});

describe('control API with real PostgreSQL and Redis', () => {
  it('keeps an uncertain merge locked until explicit outcome reconciliation', async () => {
    const created = await post('/jobs', body(), bot);
    const jobId = created.json().job.id;
    await db.job.update({ where: { id: jobId }, data: { status: 'PR_OPEN' } });
    await db.pRLink.create({
      data: {
        jobId,
        number: 1,
        branch: `hub/job-${jobId}`,
        url: 'https://github.com/test/installed/pull/1',
        headSha: github.headSha,
        baseSha: 'a'.repeat(40),
      },
    });
    await post('/identity/github', { oauthToken: 'test-oauth-proof' });
    expect((await post(`/jobs/${jobId}/approve`, {})).statusCode).toBe(200);
    github.mergeFailure = true;
    expect((await post(`/jobs/${jobId}/merge`, {})).statusCode).toBe(500);
    await synchronizePullRequests(db, github);
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe(
      'NEEDS_HUMAN_ACTION',
    );
    expect((await post(`/jobs/${jobId}/reconcile-merge`, {})).statusCode).toBe(409);
    await db.job.update({
      where: { id: jobId },
      data: { updatedAt: new Date(Date.now() - 310000) },
    });
    expect((await post(`/jobs/${jobId}/reconcile-merge`, {})).statusCode).toBe(200);
    github.mergeFailure = false;
    expect((await post(`/jobs/${jobId}/merge`, {})).statusCode).toBe(200);
    expect(github.merges).toBe(1);
  });
  it('withholds PR publication when independent repository verification fails', async () => {
    const server = buildApp({ db, config, pingRedis: () => queue.connection.ping(), github });
    const base = await server.listen({ host: '127.0.0.1', port: 0 });
    const root = await mkdtemp(join(tmpdir(), 'hub-test-gate-'));
    try {
      const job = await create();
      await supervise({
        baseUrl: base,
        enrollmentToken: config.WORKER_ENROLLMENT_TOKEN,
        root,
        verify: async () => false,
        once: true,
        signal: new AbortController().signal,
        adapter: {
          engine: 'codex',
          supports: () => true,
          healthcheck: async () => true,
          async run(spec) {
            await writeFile(join(root, spec.workspaceId, 'README.md'), 'fixture');
            return {
              status: 'success',
              summary: 'agent success claim',
              changedPaths: [],
              artifacts: [],
              usage: [],
            };
          },
        },
      });
      expect(github.writes).toBe(0);
      expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('FAILED');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('retains uncertain PR plans for explicit operator recovery rather than automatic replay', async () => {
    const created = await post('/jobs', body(), bot);
    const jobId = created.json().job.id;
    const worker = await register();
    const lease = (await post('/workers/claim', {}, worker.headers)).json();
    const proof = { leaseToken: lease.leaseToken, leaseVersion: lease.leaseVersion };
    const snapshot = await post(`/attempts/${lease.attemptId}/snapshot`, proof, worker.headers);
    expect(snapshot.statusCode).toBe(200);
    await post(
      `/workers/${worker.workerId}/heartbeat`,
      { leases: [{ attemptId: lease.attemptId, ...proof }] },
      worker.headers,
    );
    const input = {
      ...proof,
      eventId: 'publish',
      baseSha: snapshot.json().baseSha,
      changes: [
        { path: 'README.md', contentBase64: Buffer.from('new content').toString('base64') },
      ],
      result: {
        status: 'success',
        summary: 'fixture',
        changedPaths: ['README.md'],
        artifacts: [],
        usage: [],
      },
    };
    github.failure = true;
    expect(
      (await post(`/attempts/${lease.attemptId}/publish`, input, worker.headers)).statusCode,
    ).toBe(500);
    github.failure = false;
    expect(
      (await post(`/attempts/${lease.attemptId}/publish`, input, worker.headers)).statusCode,
    ).toBe(409);
    expect(github.writes).toBe(1);
    expect((await post(`/jobs/${jobId}/reconcile-publish`, {})).statusCode).toBe(200);
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('PR_OPEN');
    expect(await db.pRLink.count({ where: { jobId } })).toBe(1);
  });
  it('backs off failed queue delivery and permits an audited dead-letter retry', async () => {
    await create();
    const entry = await db.transactionOutbox.findFirstOrThrow();
    const spy = vi.spyOn(queue.queue, 'add').mockRejectedValue(new Error('simulated queue outage'));
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        await db.transactionOutbox.update({
          where: { id: entry.id },
          data: { nextAttemptAt: new Date(0) },
        });
        expect(await dispatchOutbox(db, queue.queue)).toBe(0);
      }
    } finally {
      spy.mockRestore();
    }
    const letter = await db.deadLetter.findUniqueOrThrow({ where: { eventId: entry.id } });
    expect(
      (await db.transactionOutbox.findUniqueOrThrow({ where: { id: entry.id } })).attempts,
    ).toBe(5);
    expect((await post(`/dead-letters/${letter.id}/retry`, {})).statusCode).toBe(200);
    expect(await dispatchOutbox(db, queue.queue)).toBe(1);
    await (await queue.queue.getJob(entry.id))?.remove();
  });
  it('runs a complete supervisor → PR → linked human approval → SHA-checked merge flow', async () => {
    const server = buildApp({ db, config, pingRedis: () => queue.connection.ping(), github });
    const base = await server.listen({ host: '127.0.0.1', port: 0 });
    const root = await mkdtemp(join(tmpdir(), 'hub-supervisor-'));
    try {
      const created = await post('/jobs', body(), bot);
      expect(created.statusCode).toBe(201);
      const jobId = created.json().job.id;
      await supervise({
        baseUrl: base,
        enrollmentToken: config.WORKER_ENROLLMENT_TOKEN,
        verify: async () => true,
        root,
        signal: new AbortController().signal,
        once: true,
        adapter: {
          engine: 'codex',
          supports: () => true,
          healthcheck: async () => true,
          async run(spec) {
            await writeFile(join(root, spec.workspaceId, 'README.md'), 'implemented fixture\n');
            return {
              status: 'success',
              summary: 'fixture tested',
              changedPaths: [],
              artifacts: [],
              usage: [{ source: 'token_estimate', inputTokens: 10, outputTokens: 20 }],
            };
          },
        },
      });
      expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('PR_OPEN');
      expect(github.writes).toBe(1);
      expect((await post('/identity/github', { oauthToken: 'test-oauth-proof' })).statusCode).toBe(
        200,
      );
      expect((await post(`/jobs/${jobId}/approve`, {})).statusCode).toBe(200);
      const merges = await Promise.all([
        post(`/jobs/${jobId}/merge`, {}),
        post(`/jobs/${jobId}/merge`, {}),
      ]);
      expect(merges.some((response) => response.statusCode === 200)).toBe(true);
      expect(github.merges).toBe(1);
      expect(await db.mergeRecord.count()).toBe(1);
      expect(
        (
          await post(`/jobs/${jobId}/cost/reconcile`, {
            actualCents: 42,
            evidenceReference: 'fixture-invoice',
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await post(`/jobs/${jobId}/cost/reconcile`, {
            actualCents: 42,
            evidenceReference: 'fixture-invoice',
          })
        ).statusCode,
      ).toBe(409);
      expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('MERGED');
      const costs = (await app.inject({ url: '/cost', headers: admin })).json();
      expect(
        costs.bySource.some((row: { source: string }) => row.source === 'token_estimate'),
      ).toBe(true);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('atomically reserves budget and releases a queued cancellation', async () => {
    const repo = await db.repository.findUniqueOrThrow({ where: { fullName: 'test/installed' } });
    await db.budget.update({ where: { repositoryId: repo.id }, data: { limitCents: 500 } });
    const responses = await Promise.all([post('/jobs', body()), post('/jobs', body())]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 402]);
    expect(
      (await db.budget.findUniqueOrThrow({ where: { repositoryId: repo.id } })).reservedCents,
    ).toBe(500);
    const job = await db.job.findFirstOrThrow();
    await post(`/jobs/${job.id}/cancel`, {});
    expect(
      (await db.budget.findUniqueOrThrow({ where: { repositoryId: repo.id } })).reservedCents,
    ).toBe(0);
  });
  it('blocks old approval or old green CI after a new head commit', async () => {
    const created = await post('/jobs', body(), bot);
    const jobId = created.json().job.id;
    await db.job.update({ where: { id: jobId }, data: { status: 'PR_OPEN' } });
    await db.repository.updateMany({ data: { requiredChecks: ['ci'] } });
    await db.pRLink.create({
      data: {
        jobId,
        number: 1,
        branch: `hub/job-${jobId}`,
        url: 'https://github.com/test/installed/pull/1',
        headSha: github.headSha,
        baseSha: 'a'.repeat(40),
      },
    });
    await post('/identity/github', { oauthToken: 'test-oauth-proof' });
    expect((await post(`/jobs/${jobId}/approve`, {})).statusCode).toBe(200);
    github.headSha = 'c'.repeat(40);
    expect((await post(`/jobs/${jobId}/merge`, {})).statusCode).toBe(409);
    expect(github.merges).toBe(0);
    await synchronizePullRequests(db, github);
    expect(await db.approval.count({ where: { jobId } })).toBe(0);
    expect((await db.pRLink.findUniqueOrThrow({ where: { jobId } })).headSha).toBe(github.headSha);
    await db.pRLink.update({ where: { jobId }, data: { headSha: github.headSha } });
    expect((await post(`/jobs/${jobId}/approve`, {})).statusCode).toBe(200);
    expect((await post(`/jobs/${jobId}/merge`, {})).statusCode).toBe(409);
    github.checksHead = github.headSha;
    github.checkConclusion = 'failure';
    expect((await post(`/jobs/${jobId}/merge`, {})).statusCode).toBe(409);
    expect(github.merges).toBe(0);
  });
  it('blocks self approval and unverified GitHub identity proofs', async () => {
    const job = await create();
    await db.job.update({ where: { id: job.id }, data: { status: 'PR_OPEN' } });
    await db.pRLink.create({
      data: {
        jobId: job.id,
        number: 1,
        branch: `hub/job-${job.id}`,
        url: 'https://github.com/test/installed/pull/1',
        headSha: github.headSha,
        baseSha: 'a'.repeat(40),
      },
    });
    expect((await post('/identity/github', { oauthToken: 'invalid-proof-token' })).statusCode).toBe(
      403,
    );
    await post('/identity/github', { oauthToken: 'test-oauth-proof' });
    expect((await post(`/jobs/${job.id}/approve`, {})).statusCode).toBe(403);
  });
  it('does not claim work for a disabled repository or draining worker', async () => {
    await create();
    const worker = await register();
    await db.repository.updateMany({ data: { enabled: false } });
    expect((await post('/workers/claim', {}, worker.headers)).statusCode).toBe(204);
    expect((await post(`/workers/${worker.workerId}/drain`, { draining: true })).statusCode).toBe(
      200,
    );
    expect((await post('/workers/claim', {}, worker.headers)).statusCode).toBe(409);
  });
  it('runs the outbound worker protocol over real loopback HTTP', async () => {
    const server = buildApp({ db, config, pingRedis: () => queue.connection.ping() });
    const base = await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      const response = await fetch(`${base}/jobs`, {
        method: 'POST',
        headers: { ...bot, 'content-type': 'application/json' },
        body: JSON.stringify(body()),
      });
      expect(response.status).toBe(201);
      const enrollment = new WorkerClient(base, config.WORKER_ENROLLMENT_TOKEN);
      const registration = await enrollment.request('/workers/register', {
        name: 'http-worker',
        engines: ['codex'],
        maxConcurrent: 1,
      });
      const client = new WorkerClient(base, String(registration?.token));
      const lease = await client.request('/workers/claim', {});
      expect(lease?.attemptId).toBeTypeOf('string');
      const proof = {
        attemptId: lease?.attemptId,
        leaseToken: lease?.leaseToken,
        leaseVersion: lease?.leaseVersion,
      };
      expect(
        await client.request(`/workers/${registration?.workerId}/heartbeat`, { leases: [proof] }),
      ).toEqual({ ok: true });
      expect(await client.request('/workers/claim', {})).toBeNull();
    } finally {
      await server.close();
    }
  });
  it('reports readiness only with working dependencies', async () => {
    expect((await app.inject('/readyz')).statusCode).toBe(200);
    const broken = buildApp({
      db,
      config,
      pingRedis: async () => {
        throw new Error('offline');
      },
    });
    expect((await broken.inject('/readyz')).statusCode).toBe(503);
    await broken.close();
  });
  it('deduplicates ten concurrent Discord retries into one job, audit and outbox', async () => {
    const payload = body();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => post('/jobs', payload, bot)),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 200, 200, 200, 200, 200, 200, 200, 200, 201,
    ]);
    expect(new Set(responses.map((r) => r.json().job.id)).size).toBe(1);
    expect(await db.job.count()).toBe(1);
    expect(await db.auditEvent.count()).toBe(1);
    expect(await db.transactionOutbox.count()).toBe(1);
    expect(
      (await post('/jobs', { ...payload, instruction: 'different instruction' }, bot)).statusCode,
    ).toBe(409);
  });
  it('denies unauthenticated, unauthorized, and uninstalled-repository requests', async () => {
    expect((await post('/jobs', body(), {})).statusCode).toBe(401);
    expect(
      (await post('/jobs', body(), { ...bot, 'x-discord-user-id': '999999999999999999' }))
        .statusCode,
    ).toBe(403);
    expect((await post('/jobs', { ...body(), repository: 'unknown/repo' })).statusCode).toBe(403);
    expect(await db.job.count()).toBe(0);
    const job = await create();
    expect(
      (
        await app.inject({
          url: `/jobs/${job.id}`,
          headers: { ...bot, 'x-discord-user-id': '999999999999999999' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('rejects unexpected authority fields, SSRF repository URLs and unsupported review engines', async () => {
    expect((await post('/jobs', { ...body(), admin: true })).statusCode).toBe(400);
    expect(
      (await post('/jobs', { ...body(), repository: 'http://169.254.169.254/a' })).statusCode,
    ).toBe(400);
    expect((await post('/jobs', { ...body(), engine: 'pr-agent' })).statusCode).toBe(400);
  });
  it('deduplicates ten signed webhook deliveries and rejects altered raw bytes', async () => {
    const raw = JSON.stringify({
      repository: { id: 1, full_name: 'test/installed' },
      installation: { id: 42 },
    });
    const signature = `sha256=${createHmac('sha256', config.GITHUB_WEBHOOK_SECRET).update(raw).digest('hex')}`;
    const headers = {
      'content-type': 'application/json',
      'x-hub-signature-256': signature,
      'x-github-delivery': 'delivery-1',
      'x-github-event': 'push',
    };
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => post('/webhooks/github', raw, headers)),
    );
    expect(responses.every((r) => [200, 202].includes(r.statusCode))).toBe(true);
    expect(await db.webhookInbox.count()).toBe(1);
    expect(await db.transactionOutbox.count()).toBe(1);
    expect((await post('/webhooks/github', `${raw} `, headers)).statusCode).toBe(401);
    expect(
      (await post('/webhooks/github', raw, { ...headers, 'x-hub-signature-256': 'sha256=0' }))
        .statusCode,
    ).toBe(401);
  });
  it('rejects signed webhooks for the wrong installation', async () => {
    const raw = JSON.stringify({
      repository: { id: 1, full_name: 'test/installed' },
      installation: { id: 99 },
    });
    const signature = `sha256=${createHmac('sha256', config.GITHUB_WEBHOOK_SECRET).update(raw).digest('hex')}`;
    expect(
      (
        await post('/webhooks/github', raw, {
          'content-type': 'application/json',
          'x-hub-signature-256': signature,
          'x-github-delivery': 'wrong-app',
          'x-github-event': 'push',
        })
      ).statusCode,
    ).toBe(403);
    expect(await db.webhookInbox.count()).toBe(0);
  });
  it('assigns one queued job once under concurrent claims', async () => {
    await create();
    const workers = await Promise.all([register(), register()]);
    const responses = await Promise.all(workers.map((w) => post('/workers/claim', {}, w.headers)));
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 204]);
    expect(await db.jobAttempt.count()).toBe(1);
  });
  it('enforces per-worker capacity and engine eligibility', async () => {
    await create();
    await create();
    const incompatible = await register(['pr-agent']);
    expect((await post('/workers/claim', {}, incompatible.headers)).statusCode).toBe(204);
    const worker = await register();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => post('/workers/claim', {}, worker.headers)),
    );
    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 204)).toHaveLength(3);
  });
  it('checks worker identity and fencing sequence on every heartbeat', async () => {
    await create();
    const worker = await register();
    const lease = (await post('/workers/claim', {}, worker.headers)).json();
    expect(
      (
        await post(
          `/workers/${worker.workerId}/heartbeat`,
          {
            leases: [
              {
                attemptId: lease.attemptId,
                leaseToken: lease.leaseToken,
                leaseVersion: lease.leaseVersion + 1,
              },
            ],
          },
          worker.headers,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await post(`/workers/${randomUUID()}/heartbeat`, { leases: [] }, worker.headers)).statusCode,
    ).toBe(403);
    expect(
      (
        await post(
          `/workers/${worker.workerId}/heartbeat`,
          {
            leases: [
              {
                attemptId: lease.attemptId,
                leaseToken: lease.leaseToken,
                leaseVersion: lease.leaseVersion,
              },
            ],
          },
          worker.headers,
        )
      ).statusCode,
    ).toBe(200);
  });
  it('rejects late completion and requires reconciliation rather than blind requeue', async () => {
    const job = await create();
    const worker = await register();
    const lease = (await post('/workers/claim', {}, worker.headers)).json();
    await db.jobAttempt.update({
      where: { id: lease.attemptId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const response = await post(
      `/attempts/${lease.attemptId}/complete`,
      {
        leaseToken: lease.leaseToken,
        leaseVersion: lease.leaseVersion,
        eventId: 'late',
        result: { status: 'success', summary: 'done', changedPaths: [], artifacts: [], usage: [] },
      },
      worker.headers,
    );
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('LOST_LEASE');
    expect(await service.expireLeases()).toBe(1);
    const updated = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe('FAILED');
    expect(updated.errorCode).toBe('LOST_LEASE_REQUIRES_RECONCILIATION');
    expect((await post('/workers/claim', {}, worker.headers)).statusCode).toBe(204);
  });
  it('revokes a cancelled job lease before accepting worker output', async () => {
    const job = await create();
    const worker = await register();
    const lease = (await post('/workers/claim', {}, worker.headers)).json();
    expect((await post(`/jobs/${job.id}/cancel`, {})).statusCode).toBe(200);
    const response = await post(
      `/attempts/${lease.attemptId}/complete`,
      {
        leaseToken: lease.leaseToken,
        leaseVersion: lease.leaseVersion,
        eventId: 'cancelled',
        result: { status: 'success', summary: '', changedPaths: [], artifacts: [], usage: [] },
      },
      worker.headers,
    );
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('JOB_CANCELLED');
    expect((await post(`/jobs/${job.id}/cancel`, {})).statusCode).toBe(200);
  });
  it('accepts result once without claiming an unverified PR exists', async () => {
    await create();
    const worker = await register();
    const lease = (await post('/workers/claim', {}, worker.headers)).json();
    const proof = { leaseToken: lease.leaseToken, leaseVersion: lease.leaseVersion };
    await post(
      `/workers/${worker.workerId}/heartbeat`,
      { leases: [{ attemptId: lease.attemptId, ...proof }] },
      worker.headers,
    );
    const payload = {
      ...proof,
      eventId: 'complete1',
      result: {
        status: 'success',
        summary: 'fixture result',
        changedPaths: [],
        artifacts: [],
        usage: [],
      },
    };
    const responses = await Promise.all([
      post(`/attempts/${lease.attemptId}/complete`, payload, worker.headers),
      post(`/attempts/${lease.attemptId}/complete`, payload, worker.headers),
    ]);
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(responses.map((r) => r.json().duplicate).sort()).toEqual([false, true]);
    expect((await db.job.findUniqueOrThrow({ where: { id: lease.job.id } })).status).toBe(
      'NEEDS_HUMAN_ACTION',
    );
  });
  it('uses a stable outbox ID when retrying Redis publication', async () => {
    await create();
    const entry = await db.transactionOutbox.findFirstOrThrow();
    await dispatchOutbox(db, queue.queue);
    expect((await queue.queue.getJob(entry.id))?.name).toBe('job.created');
    await db.transactionOutbox.update({ where: { id: entry.id }, data: { publishedAt: null } });
    await dispatchOutbox(db, queue.queue);
    expect(await queue.queue.getJob(entry.id)).toBeDefined();
    expect(
      (await db.transactionOutbox.findUniqueOrThrow({ where: { id: entry.id } })).publishedAt,
    ).not.toBeNull();
    await (await queue.queue.getJob(entry.id))?.remove();
  });
});
