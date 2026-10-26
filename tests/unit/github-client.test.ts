import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { App } from '@octokit/app';
import { AppGitHubGateway } from '@hub/github';

function transport() {
  let branch: string | undefined;
  let baseSha = 'a'.repeat(40);
  const pulls: { number: number; state: string; html_url: string; head: { sha: string } }[] = [];
  const request = vi.fn(async (route: string, args: Record<string, unknown>) => {
    if (route === 'GET /repos/{owner}/{repo}') return { data: { id: 1 } };
    if (route === 'GET /repos/{owner}/{repo}/branches/{branch}')
      return { data: { commit: { sha: baseSha } } };
    if (route === 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}')
      return { data: { tree: { sha: 'base-tree' } } };
    if (route === 'POST /repos/{owner}/{repo}/git/blobs')
      return { data: { sha: createHash('sha1').update(String(args.content)).digest('hex') } };
    if (route === 'POST /repos/{owner}/{repo}/git/trees') return { data: { sha: 'next-tree' } };
    if (route === 'POST /repos/{owner}/{repo}/git/commits')
      return { data: { sha: createHash('sha1').update(JSON.stringify(args)).digest('hex') } };
    if (route === 'GET /repos/{owner}/{repo}/git/ref/{ref}') {
      if (!branch) throw Object.assign(new Error('missing'), { status: 404 });
      return { data: { object: { sha: branch } } };
    }
    if (route === 'POST /repos/{owner}/{repo}/git/refs') {
      branch = String(args.sha);
      return { data: {} };
    }
    if (route === 'GET /repos/{owner}/{repo}/pulls') return { data: pulls };
    if (route === 'POST /repos/{owner}/{repo}/pulls') {
      const pr = {
        number: 1,
        state: 'open',
        html_url: 'https://github.com/org/repo/pull/1',
        head: { sha: branch! },
      };
      pulls.push(pr);
      return { data: pr };
    }
    throw new Error(`Unexpected route: ${route}`);
  });
  const application = {
    getInstallationOctokit: vi.fn(
      async () => ({ request }) as unknown as Awaited<ReturnType<App['getInstallationOctokit']>>,
    ),
  };
  return {
    application,
    request,
    setBranch: (sha: string) => {
      branch = sha;
    },
    setBase: (sha: string) => {
      baseSha = sha;
    },
    closePull: () => {
      pulls[0]!.state = 'closed';
    },
  };
}
const repo = { fullName: 'org/repo', installationId: '42', baseBranch: 'main' };
const job = {
  id: '00000000-0000-4000-8000-000000000001',
  baseSha: 'a'.repeat(40),
  createdAt: new Date('2026-10-24T00:00:00Z'),
  instruction: 'not sent to shell',
};
const changes = [{ path: 'README.md', contentBase64: Buffer.from('changed').toString('base64') }];
it('replays a deterministic commit/branch/PR plan without duplicate pull requests', async () => {
  const { request, application } = transport();
  const github = new AppGitHubGateway(
    { appId: '1', privateKey: 'fixture-private-key' },
    undefined,
    true,
    application,
  );
  const first = await github.publish(repo, job, changes);
  const second = await github.publish(repo, job, changes);
  expect(second).toEqual(first);
  expect(
    request.mock.calls.filter(([route]) => route === 'POST /repos/{owner}/{repo}/pulls'),
  ).toHaveLength(1);
  expect(
    request.mock.calls.filter(([route]) => route === 'POST /repos/{owner}/{repo}/git/refs'),
  ).toHaveLength(1);
  const commits = request.mock.calls.filter(
    ([route]) => route === 'POST /repos/{owner}/{repo}/git/commits',
  );
  expect(commits[0]?.[1]).toEqual(commits[1]?.[1]);
});
it('recovers an already-created matching PR after the base advances without another ref or PR', async () => {
  const fake = transport();
  const github = new AppGitHubGateway(
    { appId: '1', privateKey: 'fixture' },
    undefined,
    true,
    fake.application,
  );
  const first = await github.publish(repo, job, changes);
  fake.setBase('c'.repeat(40));
  expect(await github.publish(repo, job, changes)).toEqual(first);
  expect(
    fake.request.mock.calls.filter(([route]) => route === 'POST /repos/{owner}/{repo}/pulls'),
  ).toHaveLength(1);
  expect(
    fake.request.mock.calls.filter(([route]) => route === 'POST /repos/{owner}/{repo}/git/refs'),
  ).toHaveLength(1);
});
it('still blocks new publication on a changed base and refuses to reopen a closed PR', async () => {
  const fake = transport();
  const github = new AppGitHubGateway(
    { appId: '1', privateKey: 'fixture' },
    undefined,
    true,
    fake.application,
  );
  fake.setBase('c'.repeat(40));
  await expect(github.publish(repo, job, changes)).rejects.toThrow(
    'BASE_CHANGED_REQUIRES_REVALIDATION',
  );
  expect(fake.request.mock.calls.some(([route]) => route.startsWith('POST'))).toBe(false);
  fake.setBase(job.baseSha);
  await github.publish(repo, job, changes);
  fake.closePull();
  await expect(github.publish(repo, job, changes)).rejects.toThrow('PR_REQUIRES_RECONCILIATION');
});
it('rejects a pre-existing branch with a different commit instead of forcing an update', async () => {
  const fake = transport();
  fake.setBranch('c'.repeat(40));
  const github = new AppGitHubGateway(
    { appId: '1', privateKey: 'fixture-private-key' },
    undefined,
    true,
    fake.application,
  );
  await expect(github.publish(repo, job, changes)).rejects.toThrow('BRANCH_CONFLICT');
  expect(fake.request.mock.calls.some(([route]) => route.includes('PATCH'))).toBe(false);
});
it('performs no external calls when writes are disabled', async () => {
  const { request, application } = transport();
  const github = new AppGitHubGateway(
    { appId: '1', privateKey: 'fixture-private-key' },
    undefined,
    false,
    application,
  );
  await expect(github.publish(repo, job, changes)).rejects.toThrow('GITHUB_WRITES_DISABLED');
  expect(request).not.toHaveBeenCalled();
});
