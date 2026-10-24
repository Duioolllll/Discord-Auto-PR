import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { Prisma, type Database } from '@hub/db';
import {
  CreateJob,
  RegisterWorker,
  LeaseProof,
  CompleteAttempt,
  AttemptEvent,
} from '@hub/contracts';
import { verifyWebhook } from '@hub/github';
import { Orchestrator, hash, type Actor } from '@hub/orchestrator';
import { DomainError, requireCondition } from '@hub/policy';
import type { ApiEnvironment } from './config.js';
import type { GitHubGateway } from '@hub/github';
import { operations } from './operations.js';

export function buildApp(options: {
  db: Database;
  config: ApiEnvironment;
  pingRedis: () => Promise<unknown>;
  logger?: boolean;
  github?: GitHubGateway;
}) {
  const { db, config } = options;
  const service = new Orchestrator(db);
  const app = Fastify({
    bodyLimit: 256 * 1024,
    logger: options.logger
      ? {
          redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
          level: 'info',
        }
      : false,
  });
  const bearer = (req: FastifyRequest) =>
    /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
  const matches = (actual: string, expected: string) =>
    timingSafeEqual(Buffer.from(hash(actual), 'hex'), Buffer.from(hash(expected), 'hex'));
  const actor = (req: FastifyRequest): Actor => {
    const token = bearer(req);
    if (matches(token, config.ADMIN_API_TOKEN)) return { id: 'local-admin', admin: true };
    if (matches(token, config.BOT_API_TOKEN)) {
      const discordId = z
        .string()
        .regex(/^\d{17,20}$/)
        .parse(req.headers['x-discord-user-id']);
      return {
        id: `discord:${discordId}`,
        admin: config.DISCORD_ADMIN_USER_IDS?.split(',').includes(discordId) ?? false,
      };
    }
    throw new DomainError(401, 'UNAUTHORIZED');
  };
  const worker = (req: FastifyRequest) => service.workerForToken(bearer(req));
  const id = (req: FastifyRequest) => z.object({ id: z.string().uuid() }).parse(req.params).id;
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: 'INVALID_REQUEST',
        issues: error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
      });
    if (error instanceof DomainError)
      return reply.code(error.statusCode).send({ error: error.code });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025')
      return reply.code(404).send({ error: 'RESOURCE_NOT_FOUND' });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      return reply.code(409).send({ error: 'CONFLICT' });
    const statusCode =
      error instanceof Error && 'statusCode' in error ? Number(error.statusCode) : 500;
    if (statusCode >= 400 && statusCode < 500)
      return reply.code(statusCode).send({ error: 'INVALID_REQUEST' });
    app.log.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Request failed');
    return reply.code(500).send({ error: 'INTERNAL_ERROR' });
  });

  app.get('/healthz', async () => ({ ok: true }));
  operations(app, db, service, actor, worker, options.github);
  app.get('/readyz', async (_req, reply) => {
    try {
      await db.$queryRaw`SELECT 1`;
      await options.pingRedis();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
  app.post('/jobs', async (req, reply) => {
    const identity = actor(req);
    const result = await service.createJob(identity, CreateJob.parse(req.body));
    return reply.code(result.created ? 201 : 200).send(result);
  });
  app.get('/jobs/:id', async (req) => service.getJob(actor(req), id(req)));
  app.post('/jobs/:id/cancel', async (req) => service.cancel(actor(req), id(req)));

  app.post('/workers/register', async (req, reply) => {
    requireCondition(matches(bearer(req), config.WORKER_ENROLLMENT_TOKEN), 'UNAUTHORIZED', 401);
    return reply.code(201).send(await service.register(RegisterWorker.parse(req.body)));
  });
  app.post('/workers/claim', async (req, reply) => {
    const identity = await worker(req);
    const result = await service.claim(identity.id);
    return result ?? reply.code(204).send();
  });
  app.post('/workers/:id/heartbeat', async (req) => {
    const identity = await worker(req);
    requireCondition(identity.id === id(req), 'FORBIDDEN', 403);
    const body = z
      .object({ leases: z.array(LeaseProof.extend({ attemptId: z.string().uuid() })).max(8) })
      .strict()
      .parse(req.body);
    return service.heartbeat(identity.id, body.leases);
  });
  app.post('/attempts/:id/events', async (req) => {
    const identity = await worker(req);
    return service.event(identity.id, id(req), AttemptEvent.parse(req.body));
  });
  app.post('/attempts/:id/complete', async (req) => {
    const identity = await worker(req);
    return service.complete(identity.id, id(req), CompleteAttempt.parse(req.body));
  });

  app.register(async (webhook) => {
    webhook.removeAllContentTypeParsers();
    webhook.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );
    webhook.post('/webhooks/github', async (req, reply) => {
      const raw = req.body as Buffer;
      const signature =
        typeof req.headers['x-hub-signature-256'] === 'string'
          ? req.headers['x-hub-signature-256']
          : undefined;
      requireCondition(
        verifyWebhook(raw, signature, config.GITHUB_WEBHOOK_SECRET),
        'INVALID_SIGNATURE',
        401,
      );
      const deliveryId = z.string().min(1).max(200).parse(req.headers['x-github-delivery']);
      const event = z.string().min(1).max(100).parse(req.headers['x-github-event']);
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new DomainError(400, 'INVALID_JSON');
      }
      const metadata = z
        .object({
          repository: z.object({ id: z.number().int(), full_name: z.string() }),
          installation: z.object({ id: z.number().int() }),
        })
        .safeParse(payload);
      if (event !== 'ping') {
        requireCondition(metadata.success, 'REPOSITORY_NOT_INSTALLED', 403);
        const repository = await db.repository.findUnique({
          where: { fullName: metadata.data.repository.full_name },
        });
        requireCondition(
          repository?.enabled &&
            repository.installationId === String(metadata.data.installation.id),
          'REPOSITORY_NOT_INSTALLED',
          403,
        );
      }
      const payloadHash = hash(raw);
      try {
        await db.$transaction(async (tx) => {
          const inbox = await tx.webhookInbox.create({
            data: {
              provider: 'github',
              deliveryId,
              event,
              payloadHash,
              payload: metadata.success
                ? {
                    repository: metadata.data.repository.full_name,
                    action:
                      typeof (payload as Record<string, unknown>).action === 'string'
                        ? String((payload as Record<string, unknown>).action)
                        : null,
                  }
                : {},
            },
          });
          // Store metadata only. Untrusted comments, source and instructions are not promoted to control data.
          await tx.transactionOutbox.create({
            data: {
              topic: 'github.webhook.received',
              payload: {
                inboxId: inbox.id,
                event,
                repository: metadata.success ? metadata.data.repository.full_name : null,
              },
            },
          });
        });
        return reply.code(202).send({ accepted: true, duplicate: false });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
          throw error;
        const inbox = await db.webhookInbox.findUniqueOrThrow({
          where: { provider_deliveryId: { provider: 'github', deliveryId } },
        });
        requireCondition(
          inbox.payloadHash === payloadHash && inbox.event === event,
          'DELIVERY_CONFLICT',
        );
        return reply.code(200).send({ accepted: true, duplicate: true });
      }
    });
  });
  return app;
}
