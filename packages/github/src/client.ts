import { App } from '@octokit/app';
import { FileChange, SafePath, type RepositorySnapshot } from '@hub/contracts';
import { requireCondition, containsOAuthCredential } from '@hub/policy';

export interface RemoteRepository {
  mergeInstallationId?: string | null;
  fullName: string;
  installationId: string;
  baseBranch: string;
}
export interface RemotePullRequest {
  number: number;
  url: string;
  headSha: string;
  baseSha: string;
}
export interface PullEvidence {
  mergedSha?: string;
  mergedBy?: string;
  headSha: string;
  author: string;
  open: boolean;
  draft: boolean;
  base: string;
  mergeable: boolean;
  reviewsSatisfied: boolean;
  rulesSatisfied: boolean;
  checks: { name: string; headSha: string; conclusion: string }[];
  humanApprovers: string[];
}
export interface GitHubGateway {
  snapshot(repo: RemoteRepository): Promise<RepositorySnapshot>;
  publish(
    repo: RemoteRepository,
    job: { id: string; baseSha: string; createdAt: Date; instruction: string },
    changes: FileChange[],
  ): Promise<RemotePullRequest>;
  evidence(repo: RemoteRepository, number: number): Promise<PullEvidence>;
  user(token: string): Promise<{ id: string; login: string }>;
  canReview(repo: RemoteRepository, login: string, expectedUserId?: string): Promise<boolean>;
  merge(repo: RemoteRepository, number: number, expectedSha: string): Promise<{ sha: string }>;
}

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const repoParts = (repo: RemoteRepository) => {
  const [owner, name] = repo.fullName.split('/');
  requireCondition(
    owner && name && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.fullName),
    'INVALID_REPOSITORY',
  );
  return { owner, repo: name };
};
export function validateChanges(changes: FileChange[]) {
  requireCondition(changes.length > 0 && changes.length <= 100, 'CHANGE_LIMIT');
  const paths = new Set<string>();
  let bytes = 0;
  for (const change of changes) {
    SafePath.parse(change.path);
    requireCondition(!paths.has(change.path), 'DUPLICATE_PATH');
    paths.add(change.path);
    requireCondition(
      !/(^|\/)(\.env(?:\..*)?|\.npmrc|\.gitmodules|id_rsa|.*\.pem)$/.test(change.path) &&
        !change.path.startsWith('.github/workflows/'),
      'PROTECTED_PATH',
    );
    if (change.contentBase64 !== null) {
      const content = Buffer.from(change.contentBase64, 'base64');
      requireCondition(content.toString('base64') === change.contentBase64, 'INVALID_BASE64');
      requireCondition(
        !containsOAuthCredential(content.toString('utf8')),
        'POSSIBLE_SECRET_IN_CHANGE',
      );
      requireCondition(
        !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/.test(
          content.toString('utf8'),
        ),
        'POSSIBLE_SECRET_IN_CHANGE',
      );
      bytes += content.length;
    }
  }
  requireCondition(bytes <= MAX_SNAPSHOT_BYTES, 'CHANGE_SIZE_LIMIT');
}

export class AppGitHubGateway implements GitHubGateway {
  private app: Pick<App, 'getInstallationOctokit'>;
  constructor(
    credentials: { appId: string; privateKey: string },
    private mergeApp?: App,
    private mutations = false,
    app?: Pick<App, 'getInstallationOctokit'>,
  ) {
    this.app = app ?? new App(credentials);
  }
  private async client(repo: RemoteRepository, merge = false) {
    requireCondition(!merge || this.mergeApp, 'MERGE_APP_NOT_CONFIGURED', 503);
    requireCondition(!merge || repo.mergeInstallationId, 'MERGE_INSTALLATION_NOT_CONFIGURED', 503);
    const client = await (merge ? this.mergeApp! : this.app).getInstallationOctokit(
      Number(merge ? repo.mergeInstallationId : repo.installationId),
    );
    // A successful installation-scoped repository read verifies membership; config alone does not.
    await client.request('GET /repos/{owner}/{repo}', repoParts(repo));
    return client;
  }
  async snapshot(repo: RemoteRepository): Promise<RepositorySnapshot> {
    const client = await this.client(repo);
    const parts = repoParts(repo);
    const branch = await client.request('GET /repos/{owner}/{repo}/branches/{branch}', {
      ...parts,
      branch: repo.baseBranch,
    });
    const baseSha = branch.data.commit.sha;
    const tree = await client.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
      ...parts,
      tree_sha: baseSha,
      recursive: '1',
    });
    requireCondition(!tree.data.truncated && tree.data.tree.length <= 1000, 'SNAPSHOT_LIMIT');
    const files: RepositorySnapshot['files'] = [];
    let bytes = 0;
    for (const entry of tree.data.tree) {
      if (entry.type === 'tree') continue;
      requireCondition(
        entry.type === 'blob' && ['100644', '100755'].includes(entry.mode ?? ''),
        'UNSUPPORTED_REPOSITORY_ENTRY',
      );
      const path = SafePath.parse(entry.path);
      requireCondition(entry.sha && (entry.size ?? 0) <= 1024 * 1024, 'SNAPSHOT_LIMIT');
      bytes += entry.size ?? 0;
      requireCondition(bytes <= MAX_SNAPSHOT_BYTES, 'SNAPSHOT_LIMIT');
      const blob = await client.request('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', {
        ...parts,
        file_sha: entry.sha,
      });
      requireCondition(blob.data.encoding === 'base64', 'UNSUPPORTED_BLOB');
      const contentBase64 = Buffer.from(blob.data.content, 'base64').toString('base64');
      files.push({ path, contentBase64, executable: entry.mode === '100755' });
    }
    return { baseSha, files };
  }
  async publish(
    repo: RemoteRepository,
    job: { id: string; baseSha: string; createdAt: Date; instruction: string },
    changes: FileChange[],
  ) {
    requireCondition(this.mutations, 'GITHUB_WRITES_DISABLED', 503);
    validateChanges(changes);
    const client = await this.client(repo);
    const parts = repoParts(repo);
    const branch = `hub/job-${job.id}`;
    const base = await client.request('GET /repos/{owner}/{repo}/branches/{branch}', {
      ...parts,
      branch: repo.baseBranch,
    });
    requireCondition(base.data.commit.sha === job.baseSha, 'BASE_CHANGED_REQUIRES_REVALIDATION');
    const original = await client.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
      ...parts,
      commit_sha: job.baseSha,
    });
    const tree: { path: string; mode: '100644' | '100755'; type: 'blob'; sha: string | null }[] =
      [];
    for (const change of changes) {
      const sha =
        change.contentBase64 === null
          ? null
          : (
              await client.request('POST /repos/{owner}/{repo}/git/blobs', {
                ...parts,
                content: change.contentBase64,
                encoding: 'base64',
              })
            ).data.sha;
      tree.push({
        path: change.path,
        mode: change.executable ? '100755' : '100644',
        type: 'blob',
        sha,
      });
    }
    const nextTree = await client.request('POST /repos/{owner}/{repo}/git/trees', {
      ...parts,
      base_tree: original.data.tree.sha,
      tree,
    });
    const identity = {
      name: 'Discord AI PR Hub',
      email: 'hub@users.noreply.github.com',
      date: job.createdAt.toISOString(),
    };
    const commit = await client.request('POST /repos/{owner}/{repo}/git/commits', {
      ...parts,
      message: `hub: job ${job.id}`,
      tree: nextTree.data.sha,
      parents: [job.baseSha],
      author: identity,
      committer: identity,
    });
    try {
      const ref = await client.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
        ...parts,
        ref: `heads/${branch}`,
      });
      requireCondition(ref.data.object.sha === commit.data.sha, 'BRANCH_CONFLICT');
    } catch (error) {
      if (!(error instanceof Error && 'status' in error && error.status === 404)) throw error;
      try {
        await client.request('POST /repos/{owner}/{repo}/git/refs', {
          ...parts,
          ref: `refs/heads/${branch}`,
          sha: commit.data.sha,
        });
      } catch (creationError) {
        const ref = await client.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
          ...parts,
          ref: `heads/${branch}`,
        });
        requireCondition(ref.data.object.sha === commit.data.sha, 'BRANCH_CONFLICT');
        if (
          !(
            creationError instanceof Error &&
            'status' in creationError &&
            creationError.status === 422
          )
        )
          throw creationError;
      }
    }
    const find = async () =>
      (
        await client.request('GET /repos/{owner}/{repo}/pulls', {
          ...parts,
          state: 'all',
          head: `${parts.owner}:${branch}`,
          base: repo.baseBranch,
          per_page: 100,
        })
      ).data;
    let pulls: { number: number; state: string; html_url: string; head: { sha: string } }[] =
      await find();
    if (!pulls.length) {
      try {
        const created = await client.request('POST /repos/{owner}/{repo}/pulls', {
          ...parts,
          head: branch,
          base: repo.baseBranch,
          title: `Hub job ${job.id}`,
          body: `Automated changes for job ${job.id}.\n\nHuman review and required GitHub checks are required.\n\n<!-- hub-job:${job.id} -->`,
          draft: false,
        });
        pulls = [created.data];
      } catch (error) {
        pulls = await find();
        if (!pulls.length) throw error;
      }
    }
    requireCondition(
      pulls.length === 1 && pulls[0]?.state === 'open' && pulls[0].head.sha === commit.data.sha,
      'PR_REQUIRES_RECONCILIATION',
    );
    const pr = pulls[0];
    return { number: pr.number, url: pr.html_url, headSha: pr.head.sha, baseSha: job.baseSha };
  }
  async evidence(repo: RemoteRepository, number: number): Promise<PullEvidence> {
    const client = await this.client(repo);
    const parts = repoParts(repo);
    const { repository } = await client.graphql<{
      repository: {
        pullRequest: {
          headRefOid: string;
          baseRefName: string;
          state: string;
          isDraft: boolean;
          author: { login: string } | null;
          mergeCommit: { oid: string } | null;
          mergedBy: { login: string } | null;
          mergeable: string;
          mergeStateStatus: string;
          reviewDecision: string | null;
        };
      };
    }>(
      `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid baseRefName state isDraft author{login} mergeable mergeStateStatus reviewDecision mergeCommit{oid} mergedBy{login}}}}`,
      { ...parts, number },
    );
    const pr = repository.pullRequest;
    const checks = await client.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
      ...parts,
      ref: pr.headRefOid,
      per_page: 100,
      filter: 'latest',
    });
    requireCondition(checks.data.total_count <= 100, 'CHECK_PAGINATION_REQUIRES_REVIEW');
    const statuses = await client.request('GET /repos/{owner}/{repo}/commits/{ref}/status', {
      ...parts,
      ref: pr.headRefOid,
      per_page: 100,
    });
    requireCondition(statuses.data.total_count <= 100, 'CHECK_PAGINATION_REQUIRES_REVIEW');
    const reviews = await client.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
      ...parts,
      pull_number: number,
      per_page: 100,
    });
    requireCondition(reviews.data.length < 100, 'REVIEW_PAGINATION_REQUIRES_REVIEW');
    const latest = new Map<string, (typeof reviews.data)[number]>();
    for (const review of reviews.data)
      if (review.user && review.state !== 'COMMENTED') latest.set(review.user.login, review);
    return {
      headSha: pr.headRefOid,
      author: pr.author?.login ?? '',
      mergedSha: pr.state === 'MERGED' ? pr.mergeCommit?.oid : undefined,
      mergedBy: pr.mergedBy?.login,
      open: pr.state === 'OPEN',
      draft: pr.isDraft,
      base: pr.baseRefName,
      mergeable: pr.mergeable === 'MERGEABLE',
      reviewsSatisfied: pr.reviewDecision === 'APPROVED',
      rulesSatisfied: pr.mergeStateStatus === 'CLEAN',
      checks: [
        ...checks.data.check_runs.map((c) => ({
          name: c.name,
          headSha: c.head_sha,
          conclusion: c.conclusion ?? c.status,
        })),
        ...statuses.data.statuses.map((s) => ({
          name: s.context,
          headSha: pr.headRefOid,
          conclusion: s.state,
        })),
      ],
      humanApprovers: [...latest.values()]
        .filter(
          (r) =>
            r.state === 'APPROVED' &&
            r.commit_id === pr.headRefOid &&
            r.user?.type === 'User' &&
            r.user.login !== pr.author?.login,
        )
        .map((r) => r.user!.login),
    };
  }
  async user(token: string) {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    requireCondition(response.ok, 'GITHUB_IDENTITY_VERIFICATION_FAILED', 403);
    const data = (await response.json()) as { type?: string; id?: number; login?: string };
    requireCondition(
      data.type === 'User' && Number.isSafeInteger(data.id) && typeof data.login === 'string',
      'HUMAN_IDENTITY_REQUIRED',
      403,
    );
    return { id: String(data.id), login: data.login };
  }
  async canReview(repo: RemoteRepository, login: string, expectedUserId?: string) {
    const client = await this.client(repo);
    const result = await client.request(
      'GET /repos/{owner}/{repo}/collaborators/{username}/permission',
      { ...repoParts(repo), username: login },
    );
    return (
      ['admin', 'maintain', 'write'].includes(result.data.permission) &&
      Boolean(expectedUserId) &&
      String(result.data.user?.id) === expectedUserId
    );
  }
  async merge(repo: RemoteRepository, number: number, expectedSha: string) {
    requireCondition(this.mutations, 'GITHUB_WRITES_DISABLED', 503);
    const client = await this.client(repo, true);
    const result = await client.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {
      ...repoParts(repo),
      pull_number: number,
      sha: expectedSha,
      merge_method: 'squash',
    });
    requireCondition(result.data.merged && result.data.sha, 'MERGE_REJECTED');
    return { sha: result.data.sha };
  }
}
