import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Engine, Kind, type RepositorySnapshot } from '@hub/contracts';
import type { AgentAdapter } from '@hub/agent-core';
import { WorkerApiError, WorkerClient } from './client.js';
import { materialize, collectChanges } from './workspace.js';

const Claim = z.object({
  attemptId: z.string().uuid(),
  leaseToken: z.string(),
  leaseVersion: z.number(),
  job: z.object({
    id: z.string().uuid(),
    repository: z.string(),
    instruction: z.string(),
    engine: Engine,
    kind: Kind,
    timeoutSeconds: z.number(),
    maxCostCents: z.number(),
  }),
});
export async function supervise(options: {
  baseUrl: string;
  enrollmentToken: string;
  root: string;
  adapter: AgentAdapter;
  signal: AbortSignal;
  once?: boolean;
  retryDelayMs?: number;
  verify: (workspace: string, signal: AbortSignal) => Promise<boolean>;
}) {
  if (!(await options.adapter.healthcheck()))
    throw new Error('Engine version, image or credentials not ready');
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const enrollment = new WorkerClient(options.baseUrl, options.enrollmentToken);
  const registration = z.object({ workerId: z.string().uuid(), token: z.string() }).parse(
    await enrollment.request('/workers/register', {
      name: 'isolated-codex-worker',
      engines: [options.adapter.engine],
      maxConcurrent: 1,
    }),
  );
  const client = new WorkerClient(options.baseUrl, registration.token);
  let retryDelay = options.retryDelayMs ?? 1000;
  while (!options.signal.aborted) {
    let raw: Awaited<ReturnType<WorkerClient['request']>>;
    try {
      await client.request(
        `/workers/${registration.workerId}/heartbeat`,
        { leases: [] },
        options.signal,
      );
      raw = await client.request('/workers/claim', {}, options.signal);
      retryDelay = options.retryDelayMs ?? 1000;
    } catch (error) {
      if (options.signal.aborted) break;
      if (error instanceof WorkerApiError && [400, 401, 403, 404].includes(error.status))
        throw error;
      await delay(retryDelay, undefined, { signal: options.signal }).catch(() => undefined);
      retryDelay = Math.min(retryDelay * 2, 10000);
      continue;
    }
    if (!raw) {
      if (options.once) return;
      await delay(2000, undefined, { signal: options.signal }).catch(() => undefined);
      continue;
    }
    const lease = Claim.parse(raw);
    const proof = { leaseToken: lease.leaseToken, leaseVersion: lease.leaseVersion };
    const stop = new AbortController();
    const signal = AbortSignal.any([
      options.signal,
      stop.signal,
      AbortSignal.timeout(lease.job.timeoutSeconds * 1000),
    ]);
    const progress = (eventId: string, message: string) =>
      client.request(`/attempts/${lease.attemptId}/events`, { ...proof, eventId, message }, signal);
    const directory = resolve(options.root, lease.attemptId);
    const heartbeat = async () =>
      client.request(
        `/workers/${registration.workerId}/heartbeat`,
        {
          leases: [{ attemptId: lease.attemptId, ...proof }],
        },
        signal,
      );
    let heartbeatPending = false;
    const timer = setInterval(() => {
      if (heartbeatPending || signal.aborted) return;
      heartbeatPending = true;
      void heartbeat()
        .catch(() => stop.abort())
        .finally(() => {
          heartbeatPending = false;
        });
    }, 10000);
    try {
      await heartbeat();
      await progress('snapshot', 'Fetching the installation-scoped repository snapshot.');
      const snapshot = (await client.request(
        `/attempts/${lease.attemptId}/snapshot`,
        proof,
        signal,
      )) as unknown as RepositorySnapshot;
      await materialize(directory, snapshot, signal);
      const [owner, name] = lease.job.repository.split('/');
      if (!owner || !name || !options.adapter.supports(lease.job.kind))
        throw new Error('Unsupported workload');
      await progress('engine', 'Starting the isolated agent runner.');
      const result = await options.adapter.run(
        {
          jobId: lease.job.id,
          attemptId: lease.attemptId,
          workspaceId: lease.attemptId,
          engine: lease.job.engine,
          kind: lease.job.kind,
          instruction: lease.job.instruction,
          repo: { owner, name, baseSha: snapshot.baseSha },
          limits: {
            timeoutSeconds: lease.job.timeoutSeconds,
            maxCostUsd: lease.job.maxCostCents / 100,
            maxOutputBytes: 1024 * 1024,
          },
        },
        signal,
      );
      if (result.status === 'success') {
        await progress('verification', 'Running the independent repository verification command.');
        if (!(await options.verify(directory, signal))) {
          result.status = 'failed';
          result.summary = 'Repository verification command failed; changes were not published.';
          await progress('verification-failed', result.summary);
        }
      }
      if (signal.aborted) throw new Error('Lease revoked');
      const changes = await collectChanges(directory, snapshot, signal);
      signal.throwIfAborted();
      result.changedPaths = changes.map((change) => change.path);
      await heartbeat();
      if (result.status === 'success' && changes.length && lease.job.kind !== 'review') {
        await progress(
          'publishing',
          `Submitting ${changes.length} validated file changes for PR publication.`,
        );
        signal.throwIfAborted();
        await client.request(
          `/attempts/${lease.attemptId}/publish`,
          {
            ...proof,
            eventId: `result-${lease.attemptId}`,
            baseSha: snapshot.baseSha,
            changes,
            result,
          },
          signal,
        );
      } else {
        await client.request(
          `/attempts/${lease.attemptId}/complete`,
          {
            ...proof,
            eventId: `result-${lease.attemptId}`,
            result,
          },
          signal,
        );
      }
    } catch {
      await client
        .request(`/attempts/${lease.attemptId}/complete`, {
          ...proof,
          eventId: `failure-${lease.attemptId}`,
          result: {
            status: signal.aborted ? 'cancelled' : 'failed',
            summary:
              'Worker execution failed or requires reconciliation. Sensitive engine output withheld.',
            changedPaths: [],
            artifacts: [],
            usage: [],
          },
        })
        .catch(() => undefined);
    } finally {
      clearInterval(timer);
      stop.abort();
      try {
        await rm(directory, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        // The job cannot control its parent. Move its inaccessible tree out of the execution path.
        try {
          const quarantine = await mkdtemp(join(options.root, `.quarantine-${lease.attemptId}-`));
          await rename(directory, join(quarantine, 'workspace'));
        } catch {
          // Attempt IDs are never reused, even if this host cannot rename the retained tree.
        }
        console.error('Workspace cleanup failed; isolated job files require operator cleanup.');
      }
    }
    if (options.once) return;
  }
}
