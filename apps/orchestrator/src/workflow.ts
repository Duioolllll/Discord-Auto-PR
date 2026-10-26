import { type Database } from '@hub/db';
import { canMerge, requireCondition, redactLog } from '@hub/policy';
import { validateChanges, type GitHubGateway } from '@hub/github';
import { PublishResult, RunResult, type RepositorySnapshot } from '@hub/contracts';
import { hash, Orchestrator, type Actor } from './service.js';

export class Workflow {
  constructor(
    private db: Database,
    private orchestrator: Orchestrator,
    private github?: GitHubGateway,
  ) {}
  private remote() {
    requireCondition(this.github, 'GITHUB_NOT_CONFIGURED', 503);
    return this.github;
  }
  private async reviewer(actor: Actor, repositoryId: string) {
    const repository = await this.db.repository.findUnique({ where: { id: repositoryId } });
    requireCondition(repository?.enabled, 'REPOSITORY_DISABLED', 403);
    if (actor.admin) return;
    const role = await this.db.roleBinding.findUnique({
      where: { actorId_repositoryId: { actorId: actor.id, repositoryId } },
    });
    requireCondition(
      role && ['reviewer', 'admin'].includes(role.role),
      'REVIEWER_ROLE_REQUIRED',
      403,
    );
  }

  async snapshot(
    workerId: string,
    attemptId: string,
    proof: { leaseToken: string; leaseVersion: number },
  ): Promise<RepositorySnapshot> {
    const job = await this.db.$transaction(
      async (tx) => (await this.orchestrator.validateLease(tx, workerId, attemptId, proof)).job,
    );
    const repo = await this.db.repository.findUniqueOrThrow({ where: { id: job.repositoryId } });
    requireCondition(repo.enabled, 'REPOSITORY_DISABLED', 403);
    const snapshot = await this.remote().snapshot(repo);
    await this.db.$transaction(async (tx) => {
      const current = await this.orchestrator.validateLease(tx, workerId, attemptId, proof);
      requireCondition(
        !current.job.baseSha || current.job.baseSha === snapshot.baseSha,
        'BASE_CHANGED_REQUIRES_REVALIDATION',
      );
      await tx.job.update({ where: { id: job.id }, data: { baseSha: snapshot.baseSha } });
      await tx.repository.update({ where: { id: repo.id }, data: { verifiedAt: new Date() } });
    });
    return snapshot;
  }

  async publish(workerId: string, attemptId: string, input: unknown) {
    const body = PublishResult.parse(input);
    body.result.summary = redactLog(body.result.summary);
    validateChanges(body.changes);
    requireCondition(body.result.status === 'success', 'SUCCESSFUL_RESULT_REQUIRED');
    const fingerprint = hash(JSON.stringify(body.changes));
    const prepared = await this.db.$transaction(async (tx) => {
      const attempt = await this.orchestrator.validateLease(tx, workerId, attemptId, body);
      const existing = await tx.jobStep.findUnique({
        where: { jobId_key: { jobId: attempt.jobId, key: 'publish-pr' } },
      });
      if (existing) {
        requireCondition(existing.inputHash === fingerprint, 'IDEMPOTENCY_CONFLICT');
        requireCondition(existing.status === 'DONE', 'PUBLISH_REQUIRES_RECONCILIATION');
        return { job: attempt.job, duplicate: true };
      }
      requireCondition(
        attempt.job.status === 'RUNNING' && attempt.job.baseSha === body.baseSha,
        'INVALID_PUBLISH_STATE',
      );
      await tx.jobStep.create({
        data: {
          jobId: attempt.jobId,
          key: 'publish-pr',
          inputHash: fingerprint,
          status: 'STARTED',
          result: { baseSha: body.baseSha, changes: body.changes, result: body.result },
        },
      });
      await tx.job.update({
        where: { id: attempt.jobId },
        data: { status: 'PUBLISHING', version: { increment: 1 } },
      });
      return { job: attempt.job, duplicate: false };
    });
    if (prepared.duplicate)
      return this.db.pRLink.findUniqueOrThrow({ where: { jobId: prepared.job.id } });
    const repo = await this.db.repository.findUniqueOrThrow({
      where: { id: prepared.job.repositoryId },
    });
    try {
      requireCondition(repo.enabled, 'REPOSITORY_DISABLED', 403);
      const pr = await this.remote().publish(
        repo,
        { ...prepared.job, baseSha: body.baseSha },
        body.changes,
      );
      return await this.db.$transaction(async (tx) => {
        await this.orchestrator.validateLease(tx, workerId, attemptId, body);
        const link = await tx.pRLink.create({
          data: { ...pr, branch: `hub/job-${prepared.job.id}`, jobId: prepared.job.id },
        });
        await tx.jobStep.update({
          where: { jobId_key: { jobId: prepared.job.id, key: 'publish-pr' } },
          data: { status: 'DONE', result: { ...pr } },
        });
        await tx.job.update({
          where: { id: prepared.job.id },
          data: { status: 'PR_OPEN', version: { increment: 1 } },
        });
        await tx.jobAttempt.update({
          where: { id: attemptId },
          data: { status: 'COMPLETED', result: body.result },
        });
        await tx.jobEvent.create({
          data: {
            jobId: prepared.job.id,
            eventId: `pr:${prepared.job.id}`,
            kind: 'PR_OPEN',
            message: pr.url,
          },
        });
        await tx.auditEvent.create({
          data: {
            actorId: `worker:${workerId}`,
            resourceId: prepared.job.id,
            action: 'pr.opened',
            details: { ...pr },
          },
        });
        await tx.transactionOutbox.create({
          data: { topic: 'job.pr_opened', payload: { jobId: prepared.job.id, url: pr.url } },
        });
        return link;
      });
    } catch (error) {
      await this.db.job.updateMany({
        where: { id: prepared.job.id, status: 'PUBLISHING' },
        data: {
          status: 'NEEDS_HUMAN_ACTION',
          errorCode: 'PUBLISH_REQUIRES_RECONCILIATION',
          version: { increment: 1 },
        },
      });
      throw error;
    }
  }

  async linkIdentity(actor: Actor, token: string) {
    const user = await this.remote().user(token);
    return this.db.identity.upsert({
      where: { actorId: actor.id },
      create: { actorId: actor.id, githubId: user.id, githubLogin: user.login },
      update: { githubId: user.id, githubLogin: user.login, verifiedAt: new Date() },
    });
  }

  async reconcilePublish(actor: Actor, jobId: string) {
    requireCondition(actor.admin, 'ADMIN_REQUIRED', 403);
    const prepared = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = ${jobId} FOR UPDATE`;
      const job = await tx.job.findUniqueOrThrow({
        where: { id: jobId },
        include: { repository: true },
      });
      requireCondition(job.status === 'NEEDS_HUMAN_ACTION', 'RECONCILIATION_NOT_REQUIRED');
      requireCondition(job.repository.enabled, 'REPOSITORY_DISABLED', 403);
      const step = await tx.jobStep.findUnique({
        where: { jobId_key: { jobId, key: 'publish-pr' } },
      });
      requireCondition(step?.status === 'STARTED' && step.result, 'NO_PUBLISH_PLAN');
      const plan = step.result as { baseSha: string; changes: unknown; result?: unknown };
      const changes = PublishResult.shape.changes.parse(plan.changes);
      validateChanges(changes);
      const result = plan.result ? RunResult.parse(plan.result) : undefined;
      requireCondition(
        hash(JSON.stringify(changes)) === step.inputHash && plan.baseSha === job.baseSha,
        'PLAN_CHANGED',
      );
      // Claim the operation under the same job lock used by cancellation and lease expiry.
      await tx.job.update({
        where: { id: jobId },
        data: { status: 'PUBLISHING', version: { increment: 1 } },
      });
      return { job, step, changes, result, baseSha: plan.baseSha, version: job.version + 1 };
    });
    try {
      const repository = await this.db.repository.findUniqueOrThrow({
        where: { id: prepared.job.repositoryId },
      });
      requireCondition(repository.enabled, 'REPOSITORY_DISABLED', 403);
      const pr = await this.remote().publish(
        repository,
        { ...prepared.job, baseSha: prepared.baseSha },
        prepared.changes,
      );
      return await this.db.$transaction(async (tx) => {
        const changed = await tx.job.updateMany({
          where: { id: jobId, status: 'PUBLISHING', version: prepared.version },
          data: { status: 'PR_OPEN', errorCode: null, version: { increment: 1 } },
        });
        requireCondition(changed.count === 1, 'CONCURRENT_MODIFICATION');
        const link = await tx.pRLink.upsert({
          where: { jobId },
          create: { ...pr, jobId, branch: `hub/job-${jobId}` },
          update: { ...pr },
        });
        await tx.jobStep.update({
          where: { id: prepared.step.id },
          data: { status: 'DONE', result: { ...pr } },
        });
        await tx.jobAttempt.updateMany({
          where: { jobId, status: { in: ['LEASED', 'RUNNING'] } },
          data: { status: 'COMPLETED', ...(prepared.result ? { result: prepared.result } : {}) },
        });
        await tx.jobEvent.upsert({
          where: { eventId: `pr:${jobId}` },
          create: { jobId, eventId: `pr:${jobId}`, kind: 'PR_OPEN', message: pr.url },
          update: {},
        });
        await tx.auditEvent.create({
          data: {
            actorId: actor.id,
            resourceId: jobId,
            action: 'publish.reconciled',
            details: { ...pr },
          },
        });
        await tx.transactionOutbox.create({
          data: { topic: 'job.pr_opened', payload: { jobId, url: pr.url } },
        });
        return link;
      });
    } catch (error) {
      await this.db.job.updateMany({
        where: { id: jobId, status: 'PUBLISHING', version: prepared.version },
        data: {
          status: 'NEEDS_HUMAN_ACTION',
          errorCode: 'PUBLISH_REQUIRES_RECONCILIATION',
          version: { increment: 1 },
        },
      });
      throw error;
    }
  }

  async approve(actor: Actor, jobId: string) {
    const job = await this.orchestrator.getJob(actor, jobId);
    await this.reviewer(actor, job.repositoryId);
    const pr = await this.db.pRLink.findUnique({ where: { jobId } });
    requireCondition(
      pr && ['PR_OPEN', 'CI_WAIT', 'APPROVAL_WAIT'].includes(job.status),
      'PR_NOT_READY',
    );
    const identity = await this.db.identity.findUnique({ where: { actorId: actor.id } });
    requireCondition(identity, 'GITHUB_ACCOUNT_LINK_REQUIRED', 403);
    const requester = await this.db.identity.findUnique({ where: { actorId: job.actorId } });
    requireCondition(
      requester && requester.githubId !== identity.githubId,
      'DISTINCT_LINKED_REVIEWER_REQUIRED',
      403,
    );
    requireCondition(
      job.actorId !== actor.id &&
        (await this.remote().canReview(job.repository, identity.githubLogin, identity.githubId)),
      'REVIEWER_REQUIRED',
      403,
    );
    const evidence = await this.remote().evidence(job.repository, pr.number);
    requireCondition(identity.githubLogin !== evidence.author, 'SELF_APPROVAL_FORBIDDEN', 403);
    requireCondition(evidence.headSha === pr.headSha, 'HEAD_CHANGED');
    requireCondition(
      evidence.humanApprovers.includes(identity.githubLogin),
      'GITHUB_REVIEW_APPROVAL_REQUIRED',
      403,
    );
    return this.db.$transaction(async (tx) => {
      const approval = await tx.approval.upsert({
        where: { jobId_headSha_actorId: { jobId, headSha: pr.headSha, actorId: actor.id } },
        create: {
          jobId,
          headSha: pr.headSha,
          actorId: actor.id,
          githubId: identity.githubId,
          expiresAt: new Date(Date.now() + 3600000),
        },
        update: { expiresAt: new Date(Date.now() + 3600000), githubId: identity.githubId },
      });
      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          resourceId: jobId,
          action: 'job.approved',
          details: { headSha: pr.headSha },
        },
      });
      const changed = await tx.job.updateMany({
        where: { id: jobId, version: job.version },
        data: { status: 'APPROVAL_WAIT', version: { increment: 1 } },
      });
      requireCondition(changed.count === 1, 'CONCURRENT_MODIFICATION');
      return approval;
    });
  }

  async merge(actor: Actor, jobId: string) {
    const job = await this.orchestrator.getJob(actor, jobId);
    await this.reviewer(actor, job.repositoryId);
    const oldRecord = await this.db.mergeRecord.findUnique({ where: { jobId } });
    if (oldRecord) return oldRecord;
    const identity = await this.db.identity.findUnique({ where: { actorId: actor.id } });
    const pr = await this.db.pRLink.findUnique({ where: { jobId } });
    requireCondition(identity && pr && job.status === 'APPROVAL_WAIT', 'MERGE_NOT_READY', 403);
    const approval = await this.db.approval.findUnique({
      where: { jobId_headSha_actorId: { jobId, headSha: pr.headSha, actorId: actor.id } },
    });
    requireCondition(approval && approval.githubId === identity.githubId, 'APPROVAL_REQUIRED', 403);
    const requester = await this.db.identity.findUnique({ where: { actorId: job.actorId } });
    requireCondition(
      requester && requester.githubId !== identity.githubId,
      'DISTINCT_LINKED_REVIEWER_REQUIRED',
      403,
    );
    const locked = await this.db.job.updateMany({
      where: { id: jobId, version: job.version, status: 'APPROVAL_WAIT' },
      data: { status: 'MERGING', version: { increment: 1 } },
    });
    requireCondition(locked.count === 1, 'MERGE_IN_PROGRESS');
    let requested = false;
    try {
      await this.reviewer(actor, job.repositoryId);
      const permission = await this.remote().canReview(
        job.repository,
        identity.githubLogin,
        identity.githubId,
      );
      // Re-fetch after acquiring the single merge lock. GitHub also enforces expected head SHA.
      const e = await this.remote().evidence(job.repository, pr.number);
      requireCondition(
        canMerge({
          actorLinked: true,
          authorized: permission,
          actorIsAuthor: !e.author || e.author === identity.githubLogin || job.actorId === actor.id,
          prOpen: e.open,
          draft: e.draft,
          correctRepositoryAndBase: e.base === job.repository.baseBranch,
          blocked: !e.humanApprovers.includes(identity.githubLogin),
          headSha: e.headSha,
          approvedSha: approval.headSha,
          approvalExpiresAt: approval.expiresAt.getTime(),
          githubReviewsSatisfied: e.reviewsSatisfied,
          githubRulesSatisfied: e.rulesSatisfied,
          mergeable: e.mergeable,
          requiredChecks: job.repository.requiredChecks,
          checks: e.checks,
        }),
        'MERGE_POLICY_REJECTED',
      );
      await this.db.$transaction(async (tx) => {
        const fenced = await tx.job.updateMany({
          where: { id: jobId, status: 'MERGING', version: job.version + 1 },
          data: { version: { increment: 1 } },
        });
        requireCondition(fenced.count === 1, 'MERGE_CONTEXT_CHANGED');
        const currentApproval = await tx.approval.findUnique({ where: { id: approval.id } });
        const currentIdentity = await tx.identity.findUnique({ where: { actorId: actor.id } });
        requireCondition(
          currentApproval &&
            currentApproval.githubId === currentIdentity?.githubId &&
            currentApproval.expiresAt.getTime() > Date.now(),
          'APPROVAL_CHANGED',
        );
        const old = await tx.jobStep.findUnique({
          where: { jobId_key: { jobId, key: 'merge-pr' } },
        });
        requireCondition(
          !old || old.status === 'RECONCILED_NOT_MERGED',
          'MERGE_REQUIRES_RECONCILIATION',
        );
        const plan = {
          jobId,
          key: 'merge-pr',
          inputHash: hash(e.headSha),
          status: 'STARTED',
          result: { headSha: e.headSha, actorId: actor.id, githubId: identity.githubId },
        };
        await tx.jobStep.upsert({
          where: { jobId_key: { jobId, key: 'merge-pr' } },
          create: plan,
          update: plan,
        });
        await tx.auditEvent.create({
          data: {
            actorId: actor.id,
            resourceId: jobId,
            action: 'merge.requested',
            details: { headSha: e.headSha, githubId: identity.githubId },
          },
        });
      });
      requested = true;
      const result = await this.remote().merge(job.repository, pr.number, e.headSha);
      return await this.db.$transaction(async (tx) => {
        await tx.jobStep.update({
          where: { jobId_key: { jobId, key: 'merge-pr' } },
          data: {
            status: 'DONE',
            result: {
              sha: result.sha,
              headSha: e.headSha,
              actorId: actor.id,
              githubId: identity.githubId,
            },
          },
        });
        const record = await tx.mergeRecord.upsert({
          where: { jobId },
          create: { jobId, sha: result.sha, headSha: e.headSha, actorId: actor.id },
          update: {},
        });
        await tx.job.update({
          where: { id: jobId },
          data: { status: 'MERGED', version: { increment: 1 } },
        });
        await tx.auditEvent.create({
          data: {
            actorId: actor.id,
            resourceId: jobId,
            action: 'job.merged',
            details: { sha: result.sha, headSha: e.headSha, githubLogin: identity.githubLogin },
          },
        });
        await tx.transactionOutbox.create({
          data: { topic: 'job.merged', payload: { jobId, sha: result.sha } },
        });
        return record;
      });
    } catch (error) {
      await this.db.job.updateMany({
        where: { id: jobId, status: 'MERGING' },
        data: {
          status: requested ? 'NEEDS_HUMAN_ACTION' : 'APPROVAL_WAIT',
          errorCode: requested ? 'MERGE_REQUIRES_RECONCILIATION' : 'MERGE_POLICY_REJECTED',
          version: { increment: 1 },
        },
      });
      throw error;
    }
  }

  async reconcileMerge(actor: Actor, jobId: string) {
    requireCondition(actor.admin, 'ADMIN_REQUIRED', 403);
    const job = await this.orchestrator.getJob(actor, jobId);
    requireCondition(
      ['MERGING', 'NEEDS_HUMAN_ACTION'].includes(job.status),
      'RECONCILIATION_NOT_REQUIRED',
    );
    const pr = await this.db.pRLink.findUniqueOrThrow({ where: { jobId } });
    const evidence = await this.remote().evidence(job.repository, pr.number);
    requireCondition(
      evidence.mergedSha ||
        (evidence.open &&
          evidence.headSha === pr.headSha &&
          Date.now() - job.updatedAt.getTime() >= 300000),
      'MERGE_OUTCOME_NOT_SETTLED',
    );
    return this.db.$transaction(async (tx) => {
      const changed = await tx.job.updateMany({
        where: { id: jobId, version: job.version },
        data: {
          status: evidence.mergedSha ? 'MERGED' : 'APPROVAL_WAIT',
          errorCode: null,
          version: { increment: 1 },
        },
      });
      requireCondition(changed.count === 1, 'CONCURRENT_MODIFICATION');
      await tx.jobStep.updateMany({
        where: { jobId, key: 'merge-pr' },
        data: { status: evidence.mergedSha ? 'DONE' : 'RECONCILED_NOT_MERGED' },
      });
      if (evidence.mergedSha)
        await tx.mergeRecord.upsert({
          where: { jobId },
          create: {
            jobId,
            sha: evidence.mergedSha,
            headSha: evidence.headSha,
            actorId: `github:${evidence.mergedBy ?? 'unknown'}`,
          },
          update: {},
        });
      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          resourceId: jobId,
          action: 'merge.reconciled',
          details: {
            merged: Boolean(evidence.mergedSha),
            headSha: evidence.headSha,
            githubActor: evidence.mergedBy ?? null,
          },
        },
      });
      return { merged: Boolean(evidence.mergedSha) };
    });
  }
}
