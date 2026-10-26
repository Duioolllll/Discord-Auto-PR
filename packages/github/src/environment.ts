import { readFileSync } from 'node:fs';
import { AppGitHubGateway } from './client.js';
import { createGitHubApp } from './http.js';

export function githubFromEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const { GITHUB_APP_ID, GITHUB_MERGE_APP_ID } = env;
  const GITHUB_APP_PRIVATE_KEY = env.GITHUB_APP_PRIVATE_KEY_FILE
    ? readFileSync(env.GITHUB_APP_PRIVATE_KEY_FILE, 'utf8')
    : env.GITHUB_APP_PRIVATE_KEY;
  const GITHUB_MERGE_APP_PRIVATE_KEY = env.GITHUB_MERGE_APP_PRIVATE_KEY_FILE
    ? readFileSync(env.GITHUB_MERGE_APP_PRIVATE_KEY_FILE, 'utf8')
    : env.GITHUB_MERGE_APP_PRIVATE_KEY;
  if (!GITHUB_APP_ID && !GITHUB_APP_PRIVATE_KEY) return undefined;
  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY)
    throw new Error('Both GitHub development App fields are required');
  if (Boolean(GITHUB_MERGE_APP_ID) !== Boolean(GITHUB_MERGE_APP_PRIVATE_KEY))
    throw new Error('Both GitHub merge App fields are required');
  if (GITHUB_MERGE_APP_ID === GITHUB_APP_ID)
    throw new Error('Merge App must be separate from the development App');
  const mergeApp =
    GITHUB_MERGE_APP_ID && GITHUB_MERGE_APP_PRIVATE_KEY
      ? createGitHubApp({
          appId: GITHUB_MERGE_APP_ID,
          privateKey: GITHUB_MERGE_APP_PRIVATE_KEY.replaceAll('\\n', '\n'),
        })
      : undefined;
  return new AppGitHubGateway(
    { appId: GITHUB_APP_ID, privateKey: GITHUB_APP_PRIVATE_KEY.replaceAll('\\n', '\n') },
    mergeApp,
    env.GITHUB_MUTATIONS_ENABLED === 'true',
  );
}
