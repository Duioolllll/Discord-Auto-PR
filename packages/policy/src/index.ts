import type { JobStatus } from '@hub/contracts';
export function containsOAuthCredential(value: string) {
  return (
    /\b(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+|rt_[A-Za-z0-9_-]{20,})\b/.test(
      value,
    ) || /["'](?:access_token|refresh_token|id_token)["']\s*:\s*["'][^"'\r\n]{12,}["']/i.test(value)
  );
}
export function redactLog(message: string, secrets: string[] = []) {
  let safe = message;
  for (const secret of secrets)
    if (secret.length >= 8) safe = safe.replaceAll(secret, '[REDACTED]');
  return safe
    .replace(
      /\b(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+|rt_[A-Za-z0-9_-]{20,})\b/g,
      '[REDACTED]',
    )
    .replace(
      /(["'](?:access_token|refresh_token|id_token)["']\s*:\s*)["'][^"'\r\n]*["']/gi,
      '$1"[REDACTED]"',
    )
    .replace(/(Bearer\s+)[^\s"'<>]+/gi, '$1[REDACTED]')
    .replace(
      /\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{16,}|[a-f0-9]{64})\b/g,
      '[REDACTED]',
    );
}

export class DomainError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
  ) {
    super(code);
  }
}
export function requireCondition(
  condition: unknown,
  code: string,
  status = 409,
): asserts condition {
  if (!condition) throw new DomainError(status, code);
}

const transitions: Partial<Record<JobStatus, JobStatus[]>> = {
  QUEUED: ['LEASED', 'CANCELLED'],
  LEASED: ['RUNNING', 'CANCELLED', 'FAILED'],
  RUNNING: ['PUBLISHING', 'NEEDS_HUMAN_ACTION', 'FAILED', 'CANCELLED'],
  PUBLISHING: ['PR_OPEN', 'NEEDS_HUMAN_ACTION'],
  PR_OPEN: ['REVIEWING', 'CANCELLED'],
  REVIEWING: ['FIXING', 'CI_WAIT', 'FAILED', 'CANCELLED'],
  FIXING: ['REVIEWING', 'FAILED', 'CANCELLED'],
  CI_WAIT: ['APPROVAL_WAIT', 'FAILED', 'CANCELLED'],
  APPROVAL_WAIT: ['MERGING', 'CANCELLED'],
  MERGING: ['MERGED', 'FAILED'],
  NEEDS_HUMAN_ACTION: ['CANCELLED'],
};
export function assertTransition(from: JobStatus, to: JobStatus) {
  requireCondition(transitions[from]?.includes(to), 'INVALID_TRANSITION');
}

// This gate is a pure policy contract. No merge endpoint or merge credentials exist in P0.
export interface MergeEvidence {
  actorLinked: boolean;
  authorized: boolean;
  actorIsAuthor: boolean;
  prOpen: boolean;
  draft: boolean;
  correctRepositoryAndBase: boolean;
  blocked: boolean;
  headSha: string;
  approvedSha: string;
  approvalExpiresAt: number;
  githubReviewsSatisfied: boolean;
  githubRulesSatisfied: boolean;
  mergeable: boolean;
  requiredChecks: string[];
  checks: { name: string; headSha: string; conclusion: string }[];
}
export function canMerge(e: MergeEvidence, now = Date.now()): boolean {
  if (!/^[a-f0-9]{40}$/.test(e.headSha)) return false;
  return (
    e.actorLinked &&
    e.authorized &&
    !e.actorIsAuthor &&
    e.prOpen &&
    !e.draft &&
    e.correctRepositoryAndBase &&
    !e.blocked &&
    e.approvedSha === e.headSha &&
    e.approvalExpiresAt > now &&
    e.githubReviewsSatisfied &&
    e.githubRulesSatisfied &&
    e.mergeable &&
    e.requiredChecks.every((name) => {
      const matching = e.checks.filter((c) => c.name === name && c.headSha === e.headSha);
      return matching.length === 1 && matching[0]?.conclusion === 'success';
    })
  );
}
