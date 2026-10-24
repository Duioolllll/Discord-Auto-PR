import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { redactLog } from '@hub/policy';
import { validateChanges } from '@hub/github';
import {
  assertSeparateProfile,
  chatGPTLoginConfirmed,
  codexAuthDirectory,
  codexExecArguments,
  codexLoginEnvironment,
  lockCodexProfile,
  validateCodexAuthDirectory,
} from '@hub/agent-codex';

it('uses a dedicated CLI profile without inheriting platform or API credentials', () => {
  const environment = codexLoginEnvironment('/private/worker-profile', {
    PATH: '/usr/bin',
    HTTPS_PROXY: 'https://proxy.example',
    CODEX_HOME: '/ambient-profile',
    CODEX_API_KEY: 'fixture-api-key',
    OPENAI_API_KEY: 'fixture-openai-key',
    GH_TOKEN: 'fixture-github-key',
    CODEX_SESSION_ID: 'fixture-session',
    GITHUB_APP_PRIVATE_KEY: 'fixture-private-key',
  });
  expect(environment).toEqual({
    NODE_ENV: 'production',
    PATH: '/usr/bin',
    HTTPS_PROXY: 'https://proxy.example',
    CODEX_HOME: '/private/worker-profile',
  });
});
it('recognizes the pinned CLI ChatGPT status and rejects API-key or failed status', () => {
  expect(chatGPTLoginConfirmed({ code: 0, output: '', stderr: 'Logged in using ChatGPT\n' })).toBe(
    true,
  );
  expect(
    chatGPTLoginConfirmed({ code: 0, output: '', stderr: 'Logged in using an API key - masked\n' }),
  ).toBe(false);
  expect(chatGPTLoginConfirmed({ code: 1, output: '', stderr: 'Logged in using ChatGPT\n' })).toBe(
    false,
  );
});
it('masks OAuth login material without reading the login profile', () => {
  const token = ['eyJ' + 'a'.repeat(16), 'b'.repeat(16), 'c'.repeat(16)].join('.');
  const refresh = 'rt_' + 'd'.repeat(24);
  const logged = redactLog(JSON.stringify({ access_token: token, refresh_token: refresh }));
  expect(logged.includes(token)).toBe(false);
  expect(logged.includes(refresh)).toBe(false);
});
it('blocks publishing OAuth login material as an agent source change', () => {
  const token = ['eyJ' + 'a'.repeat(16), 'b'.repeat(16), 'c'.repeat(16)].join('.');
  expect(() =>
    validateChanges([{ path: 'README.md', contentBase64: Buffer.from(token).toString('base64') }]),
  ).toThrow('POSSIBLE_SECRET_IN_CHANGE');
});
it('places exec-only options after the CLI subcommand and retains the sandbox', () => {
  const command = codexExecArguments();
  expect(command.indexOf('--ignore-user-config')).toBeGreaterThan(command.indexOf('exec'));
  expect(command.indexOf('--ignore-rules')).toBeGreaterThan(command.indexOf('exec'));
  expect(command).toContain('default_permissions="hub"');
  expect(command.some((argument) => argument.includes('extends=":workspace"'))).toBe(true);
  expect(command.some((argument) => argument.includes('auth.json"="deny"'))).toBe(true);
  expect(command).toContain('--ephemeral');
  expect(command).not.toContain('--dangerously-bypass-approvals-and-sandbox');
});
it.each(['/work/job', '/work/job/login', '/work'])(
  'rejects credential/workspace overlap %s',
  (directory) => {
    expect(() => assertSeparateProfile(directory, '/work/job')).toThrow('separate');
  },
);
it('accepts a separate profile and requires explicit paths to be absolute', () => {
  expect(() => assertSeparateProfile('/private/codex', '/work/job')).not.toThrow();
  expect(() => codexAuthDirectory('relative/profile')).toThrow('absolute');
  expect(() => codexAuthDirectory('/private/profile,readonly=false')).toThrow('Invalid');
});
it('checks the private profile shape without returning tokens and rejects exposed permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hub-auth-unit-'));
  try {
    await writeFile(
      join(directory, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'fixture-access',
          refresh_token: 'fixture-refresh',
          id_token: 'fixture-id',
        },
      }),
      {
        mode: 0o600,
      },
    );
    expect(await validateCodexAuthDirectory(directory)).toBe(directory);
    await chmod(join(directory, 'auth.json'), 0o644);
    await expect(validateCodexAuthDirectory(directory)).rejects.toThrow('private');
    await chmod(join(directory, 'auth.json'), 0o600);
    await chmod(directory, 0o755);
    await expect(validateCodexAuthDirectory(directory)).rejects.toThrow('0700');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it.each(['{}', 'not JSON', JSON.stringify({ tokens: { access_token: 'fixture-only' } })])(
  'rejects empty or incomplete login profiles',
  async (value) => {
    const directory = await mkdtemp(join(tmpdir(), 'hub-invalid-auth-'));
    try {
      await writeFile(join(directory, 'auth.json'), value, { mode: 0o600 });
      await expect(validateCodexAuthDirectory(directory)).rejects.toThrow(
        /Codex login|ChatGPT login/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
it('rejects symlinked credential files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hub-auth-link-'));
  try {
    await writeFile(join(directory, 'fixture'), 'non-secret fixture', { mode: 0o600 });
    await symlink(join(directory, 'fixture'), join(directory, 'auth.json'));
    await expect(validateCodexAuthDirectory(directory)).rejects.toThrow('regular file');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('serializes profile use and never silently steals a live profile lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hub-auth-lock-'));
  try {
    const release = await lockCodexProfile(directory);
    await expect(lockCodexProfile(directory)).rejects.toThrow('in use');
    await release();
    const again = await lockCodexProfile(directory);
    await again();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
