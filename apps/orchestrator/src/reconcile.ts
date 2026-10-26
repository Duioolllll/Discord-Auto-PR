import type { Database } from '@hub/db';
import type { GitHubGateway } from '@hub/github';

export async function synchronizePullRequests(
  db: Database,
  github: GitHubGateway,
  signal?: AbortSignal,
) {
  let cursor: string | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const links = await db.pRLink.findMany({
      where: {
        ...(cursor ? { id: { gt: cursor } } : {}),
        job: {
          status: { in: ['PR_OPEN', 'CI_WAIT', 'APPROVAL_WAIT', 'NEEDS_HUMAN_ACTION', 'MERGING'] },
        },
      },
      include: { job: { include: { repository: true } } },
      orderBy: { id: 'asc' },
      take: 50,
    });
    for (const link of links) {
      signal?.throwIfAborted();
      try {
        const evidence = await github.evidence(link.job.repository, link.number);
        signal?.throwIfAborted();
        await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = ${link.jobId} FOR UPDATE`;
          const job = await tx.job.findUniqueOrThrow({ where: { id: link.jobId } });
          if (job.version !== link.job.version) return;
          if (evidence.headSha !== link.headSha) {
            await tx.approval.deleteMany({ where: { jobId: job.id } });
            await tx.pRLink.update({ where: { id: link.id }, data: { headSha: evidence.headSha } });
            await tx.jobEvent.upsert({
              where: { eventId: `head:${link.id}:${evidence.headSha}` },
              create: {
                jobId: job.id,
                eventId: `head:${link.id}:${evidence.headSha}`,
                kind: 'HEAD_CHANGED',
                message: 'PR HEAD changed; existing Discord approvals invalidated.',
              },
              update: {},
            });
            await tx.auditEvent.create({
              data: {
                actorId: 'github-sync',
                action: 'approval.invalidated',
                resourceId: job.id,
                details: { previousSha: link.headSha, headSha: evidence.headSha },
              },
            });
          }
          if (evidence.mergedSha) {
            await tx.mergeRecord.upsert({
              where: { jobId: job.id },
              create: {
                jobId: job.id,
                sha: evidence.mergedSha,
                headSha: evidence.headSha,
                actorId: `github:${evidence.mergedBy ?? 'unknown'}`,
              },
              update: {},
            });
            await tx.job.update({
              where: { id: job.id },
              data: { status: 'MERGED', errorCode: null, version: { increment: 1 } },
            });
            await tx.auditEvent.create({
              data: {
                actorId: `github:${evidence.mergedBy ?? 'unknown'}`,
                action: 'merge.observed',
                resourceId: job.id,
                details: { sha: evidence.mergedSha, headSha: evidence.headSha },
              },
            });
            return;
          }
          const intent = await tx.jobStep.findUnique({
            where: { jobId_key: { jobId: job.id, key: 'merge-pr' } },
          });
          if (job.status === 'MERGING' || intent?.status === 'STARTED') {
            if (job.status === 'MERGING' && Date.now() - job.updatedAt.getTime() > 300000)
              await tx.job.update({
                where: { id: job.id },
                data: {
                  status: 'NEEDS_HUMAN_ACTION',
                  errorCode: 'MERGE_REQUIRES_RECONCILIATION',
                  version: { increment: 1 },
                },
              });
            return;
          }
          const checksOk = link.job.repository.requiredChecks.every((name) => {
            const checks = evidence.checks.filter(
              (check) => check.name === name && check.headSha === evidence.headSha,
            );
            return checks.length === 1 && checks[0]?.conclusion === 'success';
          });
          const status = !evidence.open
            ? 'NEEDS_HUMAN_ACTION'
            : checksOk &&
                evidence.reviewsSatisfied &&
                evidence.rulesSatisfied &&
                !evidence.draft &&
                evidence.mergeable
              ? 'APPROVAL_WAIT'
              : 'CI_WAIT';
          if (status !== job.status || evidence.headSha !== link.headSha)
            await tx.job.update({
              where: { id: job.id },
              data: {
                status,
                errorCode: !evidence.open
                  ? 'PR_CLOSED'
                  : evidence.headSha !== link.headSha
                    ? 'HEAD_CHANGED_APPROVALS_INVALIDATED'
                    : null,
                version: { increment: 1 },
              },
            });
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        /* Preserve the last observed state; merge always fetches fresh evidence. */
      }
    }
    if (links.length < 50) return;
    cursor = links.at(-1)!.id;
  }
}
