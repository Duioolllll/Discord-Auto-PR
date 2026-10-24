import { lstat, mkdir, open, realpath, rmdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type CodexAuthentication =
  | { mode: 'chatgpt'; directory: string }
  | { mode: 'api-key'; apiKey: string };

// A dedicated application profile; never discover or copy this agent's ambient Codex login.
export const defaultCodexAuthDirectory = fileURLToPath(
  new URL('../../../.local/codex-auth', import.meta.url),
);
export const fileCredentialArguments = ['-c', 'cli_auth_credentials_store="file"'];

export function codexAuthDirectory(value?: string) {
  if (!value) return defaultCodexAuthDirectory;
  if (!isAbsolute(value)) throw new Error('HUB_CODEX_AUTH_DIR must be an absolute path');
  if (/[\n\r,\0]/.test(value)) throw new Error('Invalid Codex authentication directory');
  return resolve(value);
}

export async function validateCodexAuthDirectory(directory: string, requireLogin = true) {
  const canonical = await realpath(directory);
  if (/[\n\r,\0]/.test(canonical)) throw new Error('Invalid Codex authentication directory');
  const status = await lstat(canonical);
  if (
    !status.isDirectory() ||
    (status.mode & 0o077) !== 0 ||
    (process.getuid && status.uid !== process.getuid())
  ) {
    throw new Error('Codex profile must be worker-owned with directory permissions 0700');
  }
  if (requireLogin) {
    const credential = await lstat(join(canonical, 'auth.json'));
    if (
      !credential.isFile() ||
      credential.isSymbolicLink() ||
      (credential.mode & 0o077) !== 0 ||
      (process.getuid && credential.uid !== process.getuid())
    ) {
      throw new Error('Codex auth.json must be a private worker-owned regular file');
    }
    const file = await open(
      join(canonical, 'auth.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const metadata = await file.stat();
      if (metadata.size > 65536) throw new Error('Invalid Codex login profile size');
      let record: unknown;
      try {
        record = JSON.parse(await file.readFile('utf8'));
      } catch {
        throw new Error('Invalid Codex login profile. Run pnpm codex:login.');
      }
      const tokens =
        record && typeof record === 'object' && 'tokens' in record ? record.tokens : undefined;
      if (
        !tokens ||
        typeof tokens !== 'object' ||
        !['access_token', 'refresh_token', 'id_token'].every((key) => {
          const value = (tokens as Record<string, unknown>)[key];
          return typeof value === 'string' && value.trim().length > 0;
        })
      )
        throw new Error('ChatGPT login tokens are missing. Run pnpm codex:login.');
    } finally {
      await file.close();
    }
  }
  return canonical;
}

export function assertSeparateProfile(directory: string, workspace: string) {
  const within = (child: string, parent: string) => {
    const path = relative(parent, child);
    return (
      path === '' ||
      (!path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
        path !== '..' &&
        !isAbsolute(path))
    );
  };
  if (within(directory, workspace) || within(workspace, directory))
    throw new Error('Codex login profile must be separate from the job workspace');
}

export async function lockCodexProfile(directory: string) {
  const lock = join(directory, '.hub-profile.lock');
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new Error(
        'Codex profile is in use. Stop its worker/login process; remove a stale .hub-profile.lock only after confirming it is no longer running.',
      );
    throw error;
  }
  return async () => {
    await rmdir(lock);
  };
}

export function chatGPTLoginConfirmed(result: { code: number; output: string; stderr: string }) {
  // The pinned CLI prints status to stderr; never forward it (API-key status includes a key hint).
  return (
    result.code === 0 &&
    /(?:^|\n)Logged in using ChatGPT(?:\r?\n|$)/.test(`${result.output}\n${result.stderr}`)
  );
}

export function codexExecArguments() {
  return [
    'codex',
    '-a',
    'never',
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    ...fileCredentialArguments,
    '--json',
    '--ephemeral',
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    '--cd',
    '/workspace',
    '-',
  ];
}

export function codexLoginEnvironment(
  directory: string,
  ambient: Partial<NodeJS.ProcessEnv> = process.env,
) {
  const permitted = [
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'TMPDIR',
    'TEMP',
    'TMP',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    'SYSTEMROOT',
    'WINDIR',
  ];
  const environment: NodeJS.ProcessEnv = { NODE_ENV: ambient.NODE_ENV ?? 'production' };
  for (const name of permitted) if (ambient[name] !== undefined) environment[name] = ambient[name];
  // This is a child CLI's documented configuration, not a change to the host agent's CODEX_HOME.
  environment.CODEX_HOME = directory;
  return environment;
}
