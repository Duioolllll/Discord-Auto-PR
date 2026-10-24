import type { GitHubGateway, PullEvidence } from '@hub/github';
import { DomainError } from '@hub/policy';
import type { FileChange } from '@hub/contracts';

export class FakeGitHub implements GitHubGateway {
  writes = 0;
  merges = 0;
  failure = false;
  mergeFailure = false;
  headSha = 'b'.repeat(40);
  checksHead = 'b'.repeat(40);
  checkConclusion = 'success';
  reset() {
    this.writes = 0;
    this.merges = 0;
    this.failure = false;
    this.mergeFailure = false;
    this.headSha = 'b'.repeat(40);
    this.checksHead = this.headSha;
    this.checkConclusion = 'success';
  }
  async snapshot() {
    return {
      baseSha: 'a'.repeat(40),
      files: [{ path: 'README.md', contentBase64: Buffer.from('original\n').toString('base64') }],
    };
  }
  async publish(_repo: unknown, _job: unknown, changes: FileChange[]) {
    this.writes++;
    if (this.failure || !changes.length) throw new Error('simulated network failure');
    return {
      number: 1,
      url: 'https://github.com/test/installed/pull/1',
      headSha: this.headSha,
      baseSha: 'a'.repeat(40),
    };
  }
  async evidence(): Promise<PullEvidence> {
    return {
      headSha: this.headSha,
      author: 'agent-author',
      open: true,
      draft: false,
      base: 'main',
      mergeable: true,
      reviewsSatisfied: true,
      rulesSatisfied: true,
      humanApprovers: ['reviewer'],
      checks: [{ name: 'ci', headSha: this.checksHead, conclusion: this.checkConclusion }],
    };
  }
  async user(token: string) {
    if (token !== 'test-oauth-proof') throw new DomainError(403, 'BAD_PROOF');
    return { id: '123', login: 'reviewer' };
  }
  async canReview(_repo: unknown, login: string) {
    return login === 'reviewer';
  }
  async merge(_repo: unknown, _number: number, sha: string) {
    if (this.mergeFailure) throw new Error('simulated uncertain merge response');
    if (sha !== this.headSha) throw new DomainError(409, 'HEAD_CHANGED');
    this.merges++;
    return { sha: 'd'.repeat(40) };
  }
}
