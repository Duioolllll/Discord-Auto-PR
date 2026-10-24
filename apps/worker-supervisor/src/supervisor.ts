import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Engine, Kind, type RepositorySnapshot } from '@hub/contracts';
import type { AgentAdapter } from '@hub/agent-core';
import { WorkerClient } from './client.js';
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
  while (!options.signal.aborted) {
    await client.request(`/workers/${registration.workerId}/heartbeat`, { leases: [] });
    const raw = await client.request('/workers/claim', {});
    if (!raw) {
      if (options.once) return;
      await delay(2000, undefined, { signal: options.signal }).catch(() => undefined);
      continue;
    }
    const lease = Claim.parse(raw);
    const proof = { leaseToken: lease.leaseToken, leaseVersion: lease.leaseVersion };
    const progress = (eventId: string, message: string) =>
      client.request(`/attempts/${lease.attemptId}/events`, { ...proof, eventId, message });
    const stop = new AbortController();
    const signal = AbortSignal.any([
      options.signal,
      stop.signal,
      AbortSignal.timeout(lease.job.timeoutSeconds * 1000),
    ]);
    const directory = resolve(options.root, lease.attemptId);
    const heartbeat = async () =>
      client.request(`/workers/${registration.workerId}/heartbeat`, {
        leases: [{ attemptId: lease.attemptId, ...proof }],
      });
    let heartbeatPending = false;
    const timer = setInterval(() => {
      if (heartbeatPending) return;
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
      )) as unknown as RepositorySnapshot;
      await materialize(directory, snapshot);
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
      const changes = await collectChanges(directory, snapshot);
      result.changedPaths = changes.map((change) => change.path);
      await heartbeat();
      if (result.status === 'success' && changes.length && lease.job.kind !== 'review') {
        await progress(
          'publishing',
          `Submitting ${changes.length} validated file changes for PR publication.`,
        );
        await client.request(`/attempts/${lease.attemptId}/publish`, {
          ...proof,
          eventId: `result-${lease.attemptId}`,
          baseSha: snapshot.baseSha,
          changes,
          result,
        });
      } else {
        await client.request(`/attempts/${lease.attemptId}/complete`, {
          ...proof,
          eventId: `result-${lease.attemptId}`,
          result,
        });
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
      await rm(directory, { recursive: true, force: true });
    }
    if (options.once) return;
  }
}
