import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createDatabase, type Database } from '@hub/db';
import { Orchestrator, Workflow } from '@hub/orchestrator';
import { prepareTestDatabase } from '../helpers/test-db.js';
import { FakeGitHub } from '../fixtures/github.js';

process.loadEnvFile('.env');
const connection = process.env.TEST_DATABASE_URL!;
const url = new URL(connection);
if (url.pathname !== '/hub_cli_test' || !['localhost', '127.0.0.1'].includes(url.hostname))
  throw new Error('Workflow review tests require the dedicated loopback hub_cli_test database');

const admin = { id: 'local-admin', admin: true };
const requester = { id: 'discord:123456789012345678', admin: false };
const reviewer = { id: 'discord:987654321098765432', admin: false };
let db: Database;
let service: Orchestrator;
let workflow: Workflow;
let github: FakeGitHub;
let repository: Awaited<ReturnType<Database['repository']['create']>>;

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
      fullName: 'test/workflow-review',
      installationId: '42',
      mergeInstallationId: '43',
      requiredChecks: ['ci'],
      roles: {
        create: [
          { actorId: requester.id, role: 'developer' },
          { actorId: reviewer.id, role: 'reviewer' },
        ],
      },
    },
  });
  await db.identity.createMany({
    data: [
      { actorId: requester.id, githubId: '456', githubLogin: 'requester' },
      { actorId: reviewer.id, githubId: '123', githubLogin: 'reviewer' },
    ],
  });
  service = new Orchestrator(db);
  github = new FakeGitHub();
  workflow = new Workflow(db, service, github);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => db.$disconnect());

async function createJob() {
  return (
    await service.createJob(requester, {
      externalRequestId: randomUUID(),
      repository: repository.fullName,
      instruction: 'fixture',
      engine: 'codex',
      kind: 'develop',
      timeoutSeconds: 30,
    })
  ).job;
}
async function pullRequestJob() {
  const job = await createJob();
  await db.job.update({ where: { id: job.id }, data: { status: 'PR_OPEN' } });
  await db.pRLink.create({
    data: {
      jobId: job.id,
      number: 1,
      branch: `hub/job-${job.id}`,
      url: 'https://github.com/test/workflow-review/pull/1',
      headSha: github.headSha,
      baseSha: 'a'.repeat(40),
    },
  });
  return job;
}
async function approvedJob() {
  const job = await pullRequestJob();
  await workflow.approve(reviewer, job.id);
  return job;
}
async function runningJob() {
  const job = await createJob();
  const worker = await service.register({ name: 'fixture', engines: ['codex'], maxConcurrent: 1 });
  const lease = (await service.claim(worker.workerId))!;
  const proof = { leaseToken: lease.leaseToken, leaseVersion: lease.leaseVersion };
  await service.heartbeat(worker.workerId, [{ attemptId: lease.attemptId, ...proof }]);
  return { job, worker, lease, proof };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([
  ['disabled repository', 'REPOSITORY_DISABLED'],
  ['revoked reviewer role', 'REVIEWER_ROLE_REQUIRED'],
] as const)(
  'does not record approval after %s changes during GitHub verification',
  async (change, code) => {
    const job = await pullRequestJob();
    const original = github.evidence.bind(github);
    vi.spyOn(github, 'evidence').mockImplementation(async () => {
      const evidence = await original();
      if (change === 'disabled repository')
        await db.repository.update({ where: { id: repository.id }, data: { enabled: false } });
      else
        await db.roleBinding.update({
          where: { actorId_repositoryId: { actorId: reviewer.id, repositoryId: repository.id } },
          data: { role: 'developer' },
        });
      return evidence;
    });
    await expect(workflow.approve(reviewer, job.id)).rejects.toMatchObject({ code });
    expect(await db.approval.count({ where: { jobId: job.id } })).toBe(0);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('PR_OPEN');
  },
);

it.each([
  ['disabled repository', 'REPOSITORY_DISABLED'],
  ['revoked reviewer role', 'REVIEWER_ROLE_REQUIRED'],
  ['changed required checks', 'MERGE_CONTEXT_CHANGED'],
] as const)(
  'stops a merge when %s changes during GitHub evidence collection',
  async (change, code) => {
    const job = await approvedJob();
    const original = github.evidence.bind(github);
    vi.spyOn(github, 'evidence').mockImplementation(async () => {
      const evidence = await original();
      if (change === 'disabled repository')
        await db.repository.update({ where: { id: repository.id }, data: { enabled: false } });
      else if (change === 'revoked reviewer role')
        await db.roleBinding.update({
          where: { actorId_repositoryId: { actorId: reviewer.id, repositoryId: repository.id } },
          data: { role: 'developer' },
        });
      else
        await db.repository.update({
          where: { id: repository.id },
          data: { requiredChecks: ['ci', 'new-check'] },
        });
      return evidence;
    });
    await expect(workflow.merge(reviewer, job.id)).rejects.toMatchObject({ code });
    expect(github.merges).toBe(0);
    expect(await db.jobStep.count({ where: { jobId: job.id, key: 'merge-pr' } })).toBe(0);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(
      'APPROVAL_WAIT',
    );
  },
);

it.each([false, true])(
  'preserves a newer merge context after a stale remote outcome; failure=%s',
  async (fail) => {
    const job = await approvedJob();
    const original = github.merge.bind(github);
    let newerVersion = -1;
    vi.spyOn(github, 'merge').mockImplementation(async (...args) => {
      const newer = await db.job.update({
        where: { id: job.id },
        data: {
          version: { increment: 1 },
          errorCode: 'NEWER_CONTEXT',
        },
      });
      newerVersion = newer.version;
      if (fail) throw new Error('Uncertain old remote response');
      return original(...args);
    });
    await expect(workflow.merge(reviewer, job.id)).rejects.toThrow(
      fail ? 'Uncertain old remote response' : 'MERGE_CONTEXT_CHANGED',
    );
    const current = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(current).toMatchObject({
      status: 'MERGING',
      version: newerVersion,
      errorCode: 'NEWER_CONTEXT',
    });
    expect(await db.mergeRecord.count({ where: { jobId: job.id } })).toBe(0);
    expect((await db.jobStep.findFirstOrThrow({ where: { jobId: job.id } })).status).toBe(
      'STARTED',
    );
  },
);

it('does not let an expired original publish failure overwrite a newer recovery claim', async () => {
  const { job, worker, lease, proof } = await runningJob();
  const snapshot = await workflow.snapshot(worker.workerId, lease.attemptId, proof);
  const firstEntered = deferred(),
    secondEntered = deferred(),
    failFirst = deferred(),
    finishRecovery = deferred();
  const original = github.publish.bind(github);
  let calls = 0;
  vi.spyOn(github, 'publish').mockImplementation(async (...args) => {
    if (++calls === 1) {
      firstEntered.resolve();
      await failFirst.promise;
      throw new Error('Original request failed late');
    }
    secondEntered.resolve();
    await finishRecovery.promise;
    return original(...args);
  });
  const first = workflow
    .publish(worker.workerId, lease.attemptId, {
      ...proof,
      eventId: 'publish',
      baseSha: snapshot.baseSha,
      changes: [{ path: 'README.md', contentBase64: Buffer.from('changed').toString('base64') }],
      result: { status: 'success', summary: 'fixture', changedPaths: [], artifacts: [] },
    })
    .then(
      () => null,
      (error: Error) => error,
    );
  await firstEntered.promise;
  await db.jobAttempt.update({ where: { id: lease.attemptId }, data: { expiresAt: new Date(0) } });
  await service.expireLeases();
  const recovery = workflow.reconcilePublish(admin, job.id).then(
    () => true,
    () => false,
  );
  try {
    await secondEntered.promise;
    const claimed = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    failFirst.resolve();
    expect(await first).toMatchObject({ message: 'Original request failed late' });
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: 'PUBLISHING',
      version: claimed.version,
    });
  } finally {
    failFirst.resolve();
    finishRecovery.resolve();
  }
  expect(await recovery).toBe(true);
  expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('PR_OPEN');
});

it('rejects snapshot reads from a completed attempt before its lease timestamp expires', async () => {
  const { worker, lease, proof } = await runningJob();
  await service.complete(worker.workerId, lease.attemptId, {
    ...proof,
    eventId: 'complete',
    result: { status: 'failed', summary: 'fixture', changedPaths: [], artifacts: [] },
  });
  const remote = vi.spyOn(github, 'snapshot');
  await expect(workflow.snapshot(worker.workerId, lease.attemptId, proof)).rejects.toMatchObject({
    code: 'ATTEMPT_FINISHED',
  });
  expect(remote).not.toHaveBeenCalled();
});
