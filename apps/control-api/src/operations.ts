import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '@hub/db';
import { Orchestrator, Workflow, type Actor } from '@hub/orchestrator';
import { LeaseProof } from '@hub/contracts';
import type { GitHubGateway } from '@hub/github';
import { requireCondition } from '@hub/policy';
import { setTimeout as delay } from 'node:timers/promises';

export function operations(
  app: FastifyInstance,
  db: Database,
  service: Orchestrator,
  actor: (request: FastifyRequest) => Actor,
  worker: (request: FastifyRequest) => Promise<{ id: string }>,
  github?: GitHubGateway,
) {
  const workflow = new Workflow(db, service, github);
  const id = (request: FastifyRequest) =>
    z.object({ id: z.string().uuid() }).parse(request.params).id;
  const admin = (request: FastifyRequest) => {
    const identity = actor(request);
    requireCondition(identity.admin, 'ADMIN_REQUIRED', 403);
    return identity;
  };
  app.get('/me', async (request) => actor(request));
  app.get('/repositories', async (request) => {
    const identity = actor(request);
    return db.repository.findMany({
      where: identity.admin ? {} : { roles: { some: { actorId: identity.id } } },
      include: { budget: true },
      orderBy: { fullName: 'asc' },
    });
  });
  app.get('/jobs', async (request) => {
    const identity = actor(request);
    const query = z
      .object({
        cursor: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(request.query);
    return db.job.findMany({
      where: identity.admin ? {} : { repository: { roles: { some: { actorId: identity.id } } } },
      include: { repository: true, pullRequest: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
  });
  app.get('/workers', async (request) => {
    admin(request);
    return db.worker.findMany({
      select: {
        id: true,
        name: true,
        engines: true,
        maxConcurrent: true,
        heartbeatAt: true,
        draining: true,
      },
      orderBy: { heartbeatAt: 'desc' },
      take: 100,
    });
  });
  app.post('/workers/:id/drain', async (request) => {
    const identity = admin(request);
    const workerId = id(request);
    const { draining } = z.object({ draining: z.boolean() }).strict().parse(request.body);
    await db.$transaction(async (tx) => {
      await tx.worker.update({ where: { id: workerId }, data: { draining } });
      await tx.auditEvent.create({
        data: {
          actorId: identity.id,
          action: 'worker.drain',
          resourceId: workerId,
          details: { draining },
        },
      });
    });
    return { ok: true };
  });
  app.get('/audit', async (request) => {
    const identity = actor(request);
    const query = z
      .object({ jobId: z.string().uuid(), after: z.coerce.date().optional() })
      .parse(request.query);
    await service.getJob(identity, query.jobId);
    return db.auditEvent.findMany({
      where: {
        resourceId: query.jobId,
        ...(query.after ? { createdAt: { gt: query.after } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
  });
  app.get('/jobs/:id/events', async (request) => {
    const jobId = id(request);
    await service.getJob(actor(request), jobId);
    const { after, latest, limit } = z
      .object({
        after: z.coerce.number().int().nonnegative().default(0),
        latest: z.enum(['true', 'false']).default('false'),
        limit: z.coerce.number().int().min(1).max(100).default(100),
      })
      .parse(request.query);
    requireCondition(latest !== 'true' || after === 0, 'INVALID_EVENT_CURSOR', 400);
    const events = await db.jobEvent.findMany({
      where: { jobId, sequence: { gt: after } },
      orderBy: { sequence: latest === 'true' ? 'desc' : 'asc' },
      take: limit,
    });
    if (latest === 'true') events.reverse();
    return { events, cursor: events.at(-1)?.sequence ?? after };
  });
  app.get('/jobs/:id/stream', async (request, reply) => {
    const jobId = id(request);
    const identity = actor(request);
    await service.getJob(identity, jobId);
    let cursor = z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(request.headers['last-event-id'] ?? 0);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });
    const stop = new AbortController();
    reply.raw.once('close', () => stop.abort());
    const deadline = Date.now() + 15000;
    try {
      while (!stop.signal.aborted && Date.now() < deadline) {
        await service.getJob(identity, jobId);
        const events = await db.jobEvent.findMany({
          where: { jobId, sequence: { gt: cursor } },
          orderBy: { sequence: 'asc' },
          take: 100,
        });
        for (const event of events) {
          reply.raw.write(`id: ${event.sequence}\nevent: job\ndata: ${JSON.stringify(event)}\n\n`);
          cursor = event.sequence;
        }
        if (!events.length) reply.raw.write(': heartbeat\n\n');
        await delay(1000, undefined, { signal: stop.signal }).catch(() => undefined);
      }
    } finally {
      reply.raw.end();
    }
  });
  app.post('/attempts/:id/snapshot', async (request) =>
    workflow.snapshot((await worker(request)).id, id(request), LeaseProof.parse(request.body)),
  );
  app.post('/attempts/:id/publish', { bodyLimit: 8 * 1024 * 1024 }, async (request) =>
    workflow.publish((await worker(request)).id, id(request), request.body),
  );
  app.post('/identity/github', async (request) => {
    const identity = actor(request);
    const { oauthToken } = z
      .object({ oauthToken: z.string().min(10).max(500) })
      .strict()
      .parse(request.body);
    return workflow.linkIdentity(identity, oauthToken);
  });
  app.post('/jobs/:id/approve', async (request) => workflow.approve(actor(request), id(request)));
  app.post('/jobs/:id/merge', async (request) => workflow.merge(actor(request), id(request)));
  app.post('/jobs/:id/reconcile-publish', async (request) =>
    workflow.reconcilePublish(admin(request), id(request)),
  );
  app.post('/jobs/:id/reconcile-merge', async (request) =>
    workflow.reconcileMerge(admin(request), id(request)),
  );
  app.get('/cost', async (request) => {
    const identity = actor(request);
    requireCondition(
      identity.admin ||
        (await db.roleBinding.count({ where: { actorId: identity.id, role: 'admin' } })) > 0,
      'PROJECT_ADMIN_REQUIRED',
      403,
    );
    const where = identity.admin
      ? {}
      : { job: { repository: { roles: { some: { actorId: identity.id, role: 'admin' } } } } };
    const bySource = await db.usageSample.groupBy({
      by: ['source', 'currency'],
      where,
      _sum: { amountMicros: true, inputTokens: true, outputTokens: true },
    });
    return {
      bySource,
      note: 'Provider actual, token estimate and runtime estimate are distinct. Reservations remain held until operator reconciliation.',
    };
  });
  app.get('/dead-letters', async (request) => {
    admin(request);
    return db.deadLetter.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  });
  app.post('/dead-letters/:id/retry', async (request) => {
    const identity = admin(request);
    const letter = await db.deadLetter.findUniqueOrThrow({ where: { id: id(request) } });
    return db.$transaction(async (tx) => {
      await tx.transactionOutbox.update({
        where: { id: letter.eventId },
        data: { attempts: 0, lastError: null, nextAttemptAt: new Date(), publishedAt: null },
      });
      await tx.deadLetter.delete({ where: { id: letter.id } });
      await tx.auditEvent.create({
        data: {
          actorId: identity.id,
          resourceId: letter.eventId,
          action: 'outbox.retry_requested',
          details: { topic: letter.topic },
        },
      });
      return { ok: true };
    });
  });
  app.post('/repositories/:id/budget', async (request) => {
    const identity = admin(request);
    const repositoryId = id(request);
    const { limitCents } = z
      .object({ limitCents: z.number().int().min(0).max(100000000) })
      .strict()
      .parse(request.body);
    return db.$transaction(async (tx) => {
      const budget = await tx.budget.upsert({
        where: { repositoryId },
        create: { repositoryId, limitCents },
        update: { limitCents },
      });
      await tx.auditEvent.create({
        data: {
          actorId: identity.id,
          action: 'budget.configured',
          resourceId: repositoryId,
          details: { limitCents },
        },
      });
      return budget;
    });
  });
  app.post('/jobs/:id/cost/reconcile', async (request) => {
    const identity = admin(request);
    const jobId = id(request);
    const input = z
      .object({
        actualCents: z.number().int().nonnegative().max(100000),
        evidenceReference: z.string().min(1).max(300),
      })
      .strict()
      .parse(request.body);
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = ${jobId} FOR UPDATE`;
      const job = await tx.job.findUniqueOrThrow({ where: { id: jobId } });
      requireCondition(
        [
          'MERGED',
          'CANCELLED',
          'FAILED',
          'NEEDS_HUMAN_ACTION',
          'PR_OPEN',
          'APPROVAL_WAIT',
        ].includes(job.status),
        'JOB_STILL_RUNNING',
      );
      const reservation = await tx.budgetReservation.findUniqueOrThrow({ where: { jobId } });
      requireCondition(reservation.status === 'RESERVED', 'ALREADY_RECONCILED');
      await tx.budget.update({
        where: { repositoryId: job.repositoryId },
        data: {
          reservedCents: { decrement: reservation.cents },
          spentCents: { increment: input.actualCents },
        },
      });
      await tx.budgetReservation.update({ where: { jobId }, data: { status: 'SETTLED' } });
      await tx.usageSample.create({
        data: {
          jobId,
          eventId: `reconciled:${jobId}`,
          source: 'provider_actual',
          amountMicros: input.actualCents * 10000,
          pricingVersion: input.evidenceReference,
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: identity.id,
          action: 'cost.reconciled',
          resourceId: jobId,
          details: input,
        },
      });
      return { ok: true };
    });
  });
}
