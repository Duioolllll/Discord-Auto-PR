import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type Database, type Transaction } from '@hub/db';
import type { CreateJob, RunResult } from '@hub/contracts';
import { DomainError, requireCondition, redactLog } from '@hub/policy';
export { Workflow } from './workflow.js';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const randomToken = () => randomBytes(32).toString('hex');
const active = ['LEASED', 'RUNNING'];
export interface Actor {
  id: string;
  admin: boolean;
}
type Lease = { leaseToken: string; leaseVersion: number };

async function record(
  tx: Transaction,
  jobId: string,
  actorId: string,
  action: string,
  details: Prisma.InputJsonValue = {},
) {
  await tx.auditEvent.create({ data: { actorId, action, resourceId: jobId, details } });
  await tx.transactionOutbox.create({
    data: { topic: action, payload: { jobId, actorId, details } },
  });
}

export class Orchestrator {
  constructor(
    public db: Database,
    private ttlMs = 60000,
    private globalConcurrency = 8,
  ) {}

  async authorize(actor: Actor, repositoryId: string, write = false) {
    if (actor.admin) return;
    const binding = await this.db.roleBinding.findUnique({
      where: { actorId_repositoryId: { actorId: actor.id, repositoryId } },
    });
    requireCondition(
      binding && (!write || ['developer', 'admin'].includes(binding.role)),
      'FORBIDDEN',
      403,
    );
  }

  async createJob(actor: Actor, input: CreateJob) {
    const repository = await this.db.repository.findUnique({
      where: { fullName: input.repository },
    });
    requireCondition(
      repository?.enabled && repository.installationId,
      'REPOSITORY_NOT_INSTALLED',
      403,
    );
    await this.authorize(actor, repository.id, true);
    requireCondition(repository.allowedEngines.includes(input.engine), 'ENGINE_NOT_ALLOWED', 400);
    const fingerprint = hash(JSON.stringify({ ...input, actorId: actor.id }));
    try {
      return await this.db.$transaction(async (tx) => {
        const job = await tx.job.create({
          data: {
            externalRequestId: input.externalRequestId,
            fingerprint,
            repositoryId: repository.id,
            actorId: actor.id,
            instruction: input.instruction,
            engine: input.engine,
            kind: input.kind,
            timeoutSeconds: input.timeoutSeconds,
          },
        });
        await tx.jobEvent.create({
          data: {
            jobId: job.id,
            eventId: `created:${job.id}`,
            kind: 'QUEUED',
            message: 'Job queued; awaiting an eligible worker.',
          },
        });
        await record(tx, job.id, actor.id, 'job.created');
        return { job, created: true };
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
        throw error;
      const job = await this.db.job.findUniqueOrThrow({
        where: { externalRequestId: input.externalRequestId },
      });
      requireCondition(job.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT');
      return { job, created: false };
    }
  }

  async getJob(actor: Actor, id: string) {
    const job = await this.db.job.findUnique({
      where: { id },
      include: {
        events: { orderBy: { createdAt: 'asc' }, take: 100 },
        repository: true,
        pullRequest: true,
      },
    });
    requireCondition(job, 'JOB_NOT_FOUND', 404);
    await this.authorize(actor, job.repositoryId);
    return job;
  }

  async cancel(actor: Actor, id: string) {
    const job = await this.getJob(actor, id);
    requireCondition(actor.admin || job.actorId === actor.id, 'FORBIDDEN', 403);
    if (job.status === 'CANCELLED') return job;
    requireCondition(
      !['MERGED', 'FAILED', 'MERGING', 'PUBLISHING'].includes(job.status),
      'JOB_NOT_CANCELLABLE',
    );
    return this.db.$transaction(async (tx) => {
      const changed = await tx.job.updateMany({
        where: { id, version: job.version },
        data: { status: 'CANCELLED', version: { increment: 1 } },
      });
      requireCondition(changed.count === 1, 'CONCURRENT_MODIFICATION');
      await tx.jobAttempt.updateMany({
        where: { jobId: id, status: { in: active } },
        data: { status: 'CANCELLED' },
      });
      await tx.jobEvent.create({
        data: {
          jobId: id,
          eventId: `cancel:${id}`,
          kind: 'CANCELLED',
          message: 'Cancellation requested; all active leases revoked.',
        },
      });
      await record(tx, id, actor.id, 'job.cancelled');
      return tx.job.findUniqueOrThrow({ where: { id } });
    });
  }

  async register(input: { name: string; engines: string[]; maxConcurrent: number }) {
    const token = randomToken();
    const worker = await this.db.worker.create({ data: { ...input, tokenHash: hash(token) } });
    return { workerId: worker.id, token };
  }

  async workerForToken(token: string) {
    const worker = await this.db.worker.findUnique({ where: { tokenHash: hash(token) } });
    requireCondition(worker, 'UNAUTHORIZED', 401);
    return worker;
  }

  async claim(workerId: string) {
    return this.db.$transaction(async (tx) => {
      // A global transaction lock enforces both per-worker and total capacity across API replicas.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(724001)`;
      const worker = await tx.worker.findUniqueOrThrow({ where: { id: workerId } });
      requireCondition(!worker.draining, 'WORKER_DRAINING');
      const now = new Date();
      const total = await tx.jobAttempt.count({
        where: { status: { in: active }, expiresAt: { gt: now } },
      });
      const count = await tx.jobAttempt.count({
        where: { workerId, status: { in: active }, expiresAt: { gt: now } },
      });
      if (count >= worker.maxConcurrent || total >= this.globalConcurrency) return null;
      // Never requeue expired attempts here: remote side effects need reconciliation first.
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT j."id" FROM "Job" j JOIN "Repository" r ON r."id" = j."repositoryId"
        WHERE j."status" = 'QUEUED' AND r."enabled" AND j."engine" = ANY(${worker.engines}::text[]) AND j."engine" = ANY(r."allowedEngines")
        ORDER BY j."createdAt", j."id" LIMIT 1 FOR UPDATE OF j SKIP LOCKED`;
      if (!rows[0]) return null;
      const job = await tx.job.update({
        where: { id: rows[0].id },
        data: { status: 'LEASED', version: { increment: 1 }, attemptSequence: { increment: 1 } },
        include: { repository: true },
      });
      const leaseToken = randomToken();
      const attempt = await tx.jobAttempt.create({
        data: {
          jobId: job.id,
          workerId,
          leaseHash: hash(leaseToken),
          leaseVersion: job.attemptSequence,
          expiresAt: new Date(now.getTime() + this.ttlMs),
        },
      });
      await record(tx, job.id, `worker:${workerId}`, 'job.leased', { attemptId: attempt.id });
      return {
        job: {
          id: job.id,
          repository: job.repository.fullName,
          instruction: job.instruction,
          kind: job.kind,
          engine: job.engine,
          timeoutSeconds: job.timeoutSeconds,
        },
        attemptId: attempt.id,
        leaseVersion: attempt.leaseVersion,
        leaseToken,
        expiresAt: attempt.expiresAt,
      };
    });
  }

  async validateLease(tx: Transaction, workerId: string, attemptId: string, proof: Lease) {
    const reference = await tx.jobAttempt.findUnique({
      where: { id: attemptId },
      select: { jobId: true },
    });
    requireCondition(reference, 'INVALID_LEASE', 403);
    // All lifecycle mutations lock job before attempt, including cancellation and expiry.
    await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = ${reference.jobId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "JobAttempt" WHERE "id" = ${attemptId} FOR UPDATE`;
    const attempt = await tx.jobAttempt.findUnique({
      where: { id: attemptId },
      include: { job: true },
    });
    requireCondition(
      attempt &&
        attempt.workerId === workerId &&
        attempt.leaseVersion === proof.leaseVersion &&
        attempt.leaseHash === hash(proof.leaseToken),
      'INVALID_LEASE',
      403,
    );
    requireCondition(attempt.expiresAt.getTime() > Date.now(), 'LOST_LEASE');
    requireCondition(attempt.job.status !== 'CANCELLED', 'JOB_CANCELLED');
    return attempt;
  }

  async heartbeat(workerId: string, proofs: ({ attemptId: string } & Lease)[]) {
    return this.db.$transaction(async (tx) => {
      await tx.worker.update({ where: { id: workerId }, data: { heartbeatAt: new Date() } });
      for (const proof of proofs) {
        const attempt = await this.validateLease(tx, workerId, proof.attemptId, proof);
        requireCondition(active.includes(attempt.status), 'ATTEMPT_FINISHED');
        await tx.jobAttempt.update({
          where: { id: attempt.id },
          data: { status: 'RUNNING', expiresAt: new Date(Date.now() + this.ttlMs) },
        });
        await tx.job.updateMany({
          where: { id: attempt.jobId, status: 'LEASED' },
          data: { status: 'RUNNING', version: { increment: 1 } },
        });
      }
      return { ok: true };
    });
  }

  async event(
    workerId: string,
    attemptId: string,
    input: Lease & { eventId: string; message: string },
  ) {
    input = { ...input, message: redactLog(input.message) };
    return this.db.$transaction(async (tx) => {
      const attempt = await this.validateLease(tx, workerId, attemptId, input);
      requireCondition(active.includes(attempt.status), 'ATTEMPT_FINISHED');
      const eventId = `attempt:${attemptId}:${input.eventId}`;
      const existing = await tx.jobEvent.findUnique({ where: { eventId } });
      if (existing) {
        requireCondition(existing.message === input.message, 'IDEMPOTENCY_CONFLICT');
        return existing;
      }
      return tx.jobEvent.create({
        data: { jobId: attempt.jobId, eventId, kind: 'WORKER_EVENT', message: input.message },
      });
    });
  }

  async complete(
    workerId: string,
    attemptId: string,
    input: Lease & { eventId: string; result: RunResult },
  ) {
    return this.db.$transaction(async (tx) => {
      const attempt = await this.validateLease(tx, workerId, attemptId, input);
      const eventId = `complete:${attemptId}:${input.eventId}`;
      const existing = await tx.jobEvent.findUnique({ where: { eventId } });
      const fingerprint = hash(JSON.stringify(input.result));
      if (existing) {
        requireCondition(existing.message === fingerprint, 'IDEMPOTENCY_CONFLICT');
        return { accepted: true, duplicate: true };
      }
      requireCondition(active.includes(attempt.status), 'ATTEMPT_FINISHED');
      requireCondition(attempt.job.status === 'RUNNING', 'HEARTBEAT_REQUIRED');
      const status =
        input.result.status === 'success'
          ? 'NEEDS_HUMAN_ACTION'
          : input.result.status === 'cancelled'
            ? 'CANCELLED'
            : 'FAILED';
      const changed = await tx.job.updateMany({
        where: { id: attempt.jobId, version: attempt.job.version, status: 'RUNNING' },
        data: {
          status,
          errorCode: input.result.status === 'success' ? 'RESULT_REQUIRES_VERIFICATION' : null,
          version: { increment: 1 },
        },
      });
      requireCondition(changed.count === 1, 'CONCURRENT_MODIFICATION');
      await tx.jobAttempt.update({
        where: { id: attemptId },
        data: {
          status: 'COMPLETED',
          result: { ...input.result, summary: redactLog(input.result.summary) },
        },
      });
      await tx.jobEvent.create({
        data: { jobId: attempt.jobId, eventId, kind: 'ATTEMPT_COMPLETED', message: fingerprint },
      });
      await record(tx, attempt.jobId, `worker:${workerId}`, 'attempt.completed', {
        attemptId,
        status,
      });
      return { accepted: true, duplicate: false };
    });
  }

  async expireLeases() {
    const stale = await this.db.jobAttempt.findMany({
      where: { status: { in: active }, expiresAt: { lte: new Date() } },
    });
    for (const attempt of stale) {
      await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = ${attempt.jobId} FOR UPDATE`;
        const changed = await tx.jobAttempt.updateMany({
          where: { id: attempt.id, status: { in: active }, expiresAt: { lte: new Date() } },
          data: { status: 'EXPIRED' },
        });
        if (!changed.count) return;
        const job = await tx.job.findUniqueOrThrow({ where: { id: attempt.jobId } });
        await tx.job.updateMany({
          where: { id: attempt.jobId, status: { in: [...active, 'PUBLISHING'] } },
          data: {
            status: job.status === 'PUBLISHING' ? 'NEEDS_HUMAN_ACTION' : 'FAILED',
            errorCode: 'LOST_LEASE_REQUIRES_RECONCILIATION',
            version: { increment: 1 },
          },
        });
        await record(tx, attempt.jobId, 'scheduler', 'attempt.expired', { attemptId: attempt.id });
      });
    }
    return stale.length;
  }
}

export { DomainError };
