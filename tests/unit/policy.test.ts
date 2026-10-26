import { describe, expect, it } from 'vitest';
import { assertTransition, canMerge, type MergeEvidence } from '@hub/policy';
import { CreateJob, CompleteAttempt } from '@hub/contracts';

const headSha = 'a'.repeat(40);
const evidence: MergeEvidence = {
  actorLinked: true,
  authorized: true,
  actorIsAuthor: false,
  prOpen: true,
  draft: false,
  correctRepositoryAndBase: true,
  blocked: false,
  headSha,
  approvedSha: headSha,
  approvalExpiresAt: 2000,
  githubReviewsSatisfied: true,
  githubRulesSatisfied: true,
  mergeable: true,
  requiredChecks: ['ci'],
  checks: [{ name: 'ci', headSha, conclusion: 'success' }],
};
describe('SHA-bound merge policy contract', () => {
  it('accepts complete current-head evidence', () => expect(canMerge(evidence, 1000)).toBe(true));
  it.each([
    { approvedSha: 'b'.repeat(40) },
    { approvalExpiresAt: 999 },
    { actorIsAuthor: true },
    { actorLinked: false },
    { githubReviewsSatisfied: false },
    { githubRulesSatisfied: false },
    { authorized: false },
    { prOpen: false },
    { draft: true },
    { blocked: true },
    { correctRepositoryAndBase: false },
    { mergeable: false },
    { checks: [{ name: 'ci', headSha: 'b'.repeat(40), conclusion: 'success' }] },
    { checks: [{ name: 'ci', headSha, conclusion: 'failure' }] },
    {
      checks: [
        { name: 'ci', headSha, conclusion: 'success' },
        { name: 'ci', headSha, conclusion: 'failure' },
      ],
    },
    { checks: [] },
    { headSha: '' },
  ])('rejects unsafe evidence %j', (patch) =>
    expect(canMerge({ ...evidence, ...patch }, 1000)).toBe(false),
  );
});
describe('state machine and contracts', () => {
  it('rejects terminal and out-of-order state transitions', () => {
    expect(() => assertTransition('QUEUED', 'LEASED')).not.toThrow();
    expect(() => assertTransition('QUEUED', 'MERGED')).toThrow('INVALID_TRANSITION');
    expect(() => assertTransition('CANCELLED', 'RUNNING')).toThrow('INVALID_TRANSITION');
  });
  it('rejects repository URLs and unexpected authorization fields', () => {
    expect(
      CreateJob.safeParse({
        externalRequestId: '1',
        repository: 'http://169.254.169.254/a',
        instruction: 'test',
      }).success,
    ).toBe(false);
    expect(
      CreateJob.safeParse({
        externalRequestId: '1',
        repository: 'org/repo',
        instruction: 'test',
        admin: true,
      }).success,
    ).toBe(false);
  });
  it('rejects retired billing fields on CLI completion', () => {
    expect(
      CompleteAttempt.safeParse({
        leaseToken: 'x'.repeat(64),
        leaseVersion: 1,
        eventId: '1',
        result: {
          status: 'success',
          summary: '',
          changedPaths: [],
          artifacts: [],
          usage: [{ source: 'provider_actual', amountUsd: -1 }],
        },
      }).success,
    ).toBe(false);
  });
});
