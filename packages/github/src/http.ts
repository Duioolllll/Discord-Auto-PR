import { App } from '@octokit/app';

export function timedGitHubFetch(fetcher: typeof fetch, timeoutMs = 10000): typeof fetch {
  return (input, init) =>
    fetcher(input, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
}

export function createGitHubApp(credentials: { appId: string; privateKey: string }) {
  // Reuse App's Octokit implementation; defaults also reach installation-token subrequests.
  const Octokit = new App(credentials).octokit.constructor as NonNullable<
    ConstructorParameters<typeof App>[0]['Octokit']
  >;
  return new App({
    ...credentials,
    Octokit: Octokit.defaults({ request: { fetch: timedGitHubFetch(fetch) } }),
  });
}
