import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { checkConfiguration, formatChecks, type ConfigCheck } from '../../scripts/check-config.js';

const local = () => ({
  DATABASE_URL: 'postgresql://fixture:password@127.0.0.1:5433/hub_cli',
  REDIS_URL: 'redis://127.0.0.1:6380',
  CONTROL_API_URL: 'http://127.0.0.1:3001',
  ADMIN_API_TOKEN: 'fixture-admin-'.padEnd(64, 'a'),
  BOT_API_TOKEN: 'fixture-api-bot-'.padEnd(64, 'b'),
  WORKER_ENROLLMENT_TOKEN: 'fixture-enroll-'.padEnd(64, 'c'),
  DASHBOARD_SESSION_SECRET: 'fixture-cookie-'.padEnd(64, 'd'),
  GITHUB_WEBHOOK_SECRET: 'fixture-webhook-'.padEnd(64, 'e'),
});
const discord = () => ({
  ...local(),
  DISCORD_BOT_TOKEN: 'fixture.discord.bot-token',
  DISCORD_APPLICATION_ID: '123456789012345678',
  DISCORD_GUILD_ID: '234567890123456789',
});
const worker = async () => {
  const profile = await directory();
  await writeFile(
    join(profile, 'auth.json'),
    JSON.stringify({
      tokens: {
        access_token: 'fixture-access',
        refresh_token: 'fixture-refresh',
        id_token: 'fixture-id',
      },
    }),
    { mode: 0o600 },
  );
  return {
    ...local(),
    HUB_CODEX_IMAGE: `sha256:${'a'.repeat(64)}`,
    HUB_RUNNER_NETWORK: 'hub-egress-tests',
    WORKER_TEST_COMMAND: '["node","--test"]',
    HUB_CODEX_AUTH_DIR: profile,
  };
};
const failures = (checks: ConfigCheck[]) => checks.filter((check) => check.status === 'fail');
const privateKey = () =>
  generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    })
    .toString();
const roots: string[] = [];
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'hub-config-check-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('lets local setup pass without unrelated external credentials', async () => {
  const checks = await checkConfiguration('local', local());
  expect(failures(checks)).toEqual([]);
  expect(checks.some((check) => check.key === 'DISCORD_BOT_TOKEN')).toBe(false);
});
it('reports internal token reuse without including tokens or URL credentials', async () => {
  const env = { ...local(), CONTROL_API_URL: 'https://configured-host-sentinel.example' };
  env.BOT_API_TOKEN = env.ADMIN_API_TOKEN;
  const checks = await checkConfiguration('local', env);
  expect(failures(checks).some((check) => check.key === 'INTERNAL_API_TOKENS')).toBe(true);
  const output = formatChecks(checks);
  for (const value of Object.values(env)) expect(output).not.toContain(value);
});
it('rejects nonlocal HTTP and URL credentials without echoing the bad input', async () => {
  const bad = 'http://do-not-print:secret-sentinel@remote.example:3001';
  const checks = await checkConfiguration('discord', { ...discord(), CONTROL_API_URL: bad });
  expect(failures(checks).some((check) => check.key === 'CONTROL_API_URL')).toBe(true);
  expect(formatChecks(checks)).not.toContain('secret-sentinel');
});
it('rejects a Bearer prefix on an internal token while allowing a session secret with spaces', async () => {
  const checks = await checkConfiguration('local', {
    ...local(),
    ADMIN_API_TOKEN: `Bearer ${local().ADMIN_API_TOKEN}`,
    DASHBOARD_SESSION_SECRET: 'fixture cookie encryption key with spaces',
  });
  expect(failures(checks).map((check) => check.key)).toEqual(['ADMIN_API_TOKEN']);
});
it('does not treat a numeric Discord ID or the internal API token as the Discord bot token', async () => {
  for (const value of ['123456789012345678', local().BOT_API_TOKEN]) {
    expect(
      failures(
        await checkConfiguration('discord', { ...discord(), DISCORD_BOT_TOKEN: value }),
      ).some((check) => check.key === 'DISCORD_BOT_TOKEN'),
    ).toBe(true);
  }
});
it('allows application ID discovery and makes diagnostic/admin IDs optional', async () => {
  const checks = await checkConfiguration('discord', { ...discord(), DISCORD_APPLICATION_ID: '' });
  expect(failures(checks)).toEqual([]);
  expect(checks).toContainEqual(
    expect.objectContaining({ key: 'DISCORD_APPLICATION_ID', status: 'warn' }),
  );
});
it('accepts help-only Discord mode but rejects partially configured API integration', async () => {
  const env = {
    DISCORD_BOT_TOKEN: discord().DISCORD_BOT_TOKEN,
    DISCORD_APPLICATION_ID: discord().DISCORD_APPLICATION_ID,
    DISCORD_GUILD_ID: discord().DISCORD_GUILD_ID,
  };
  expect(failures(await checkConfiguration('discord', env))).toEqual([]);
  expect(
    failures(
      await checkConfiguration('discord', { ...env, CONTROL_API_URL: local().CONTROL_API_URL }),
    ).map((check) => check.key),
  ).toContain('BOT_API_TOKEN');
  expect(
    failures(
      await checkConfiguration('discord', { ...env, BOT_API_TOKEN: local().BOT_API_TOKEN }),
    ).map((check) => check.key),
  ).toContain('CONTROL_API_URL');
});
it('accepts surrounding whitespace on an inline Discord token like the bot does', async () => {
  expect(
    failures(
      await checkConfiguration('discord', {
        ...discord(),
        DISCORD_BOT_TOKEN: `  ${discord().DISCORD_BOT_TOKEN}  `,
      }),
    ),
  ).toEqual([]);
});
it('does not silently fall back to an inline token if the preferred file is missing', async () => {
  const root = await directory();
  const checks = await checkConfiguration('discord', {
    ...discord(),
    DISCORD_BOT_TOKEN_FILE: join(root, 'missing-private-token'),
  });
  expect(failures(checks).some((check) => check.key === 'DISCORD_BOT_TOKEN_FILE')).toBe(true);
  expect(formatChecks(checks)).not.toContain(root);
  expect(formatChecks(checks)).not.toContain(discord().DISCORD_BOT_TOKEN);
});
it('uses the preferred token file and leaves its contents and mtime unchanged', async () => {
  const file = join(await directory(), 'private-token');
  await writeFile(file, 'fixture.preferred.token\n', { mode: 0o600 });
  const before = await stat(file);
  const checks = await checkConfiguration('discord', {
    ...discord(),
    DISCORD_BOT_TOKEN: '123456789012345678',
    DISCORD_BOT_TOKEN_FILE: file,
  });
  expect(failures(checks)).toEqual([]);
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  expect(await readFile(file, 'utf8')).toBe('fixture.preferred.token\n');
  expect(formatChecks(checks)).not.toContain('fixture.preferred.token');
});
it('detects relative paths, symlinked bot tokens and exposed bot token permissions', async () => {
  const root = await directory();
  const file = join(root, 'token');
  const link = join(root, 'link');
  await writeFile(file, 'fixture.token', { mode: 0o644 });
  await chmod(file, 0o644);
  await symlink(file, link);
  for (const path of ['relative-token', file, link]) {
    expect(
      failures(
        await checkConfiguration('discord', { ...discord(), DISCORD_BOT_TOKEN_FILE: path }),
      ).some((check) => check.key === 'DISCORD_BOT_TOKEN_FILE'),
    ).toBe(true);
  }
});
it('catches a client ID in an App ID field and a token in a PEM field without echoing either', async () => {
  const checks = await checkConfiguration('github', {
    GITHUB_APP_ID: 'Iv23.fixture-client-id',
    GITHUB_APP_PRIVATE_KEY: 'fixture-sensitive-key-sentinel',
  });
  expect(failures(checks).map((check) => check.key)).toEqual(
    expect.arrayContaining(['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY']),
  );
  expect(formatChecks(checks)).not.toContain('fixture-sensitive-key-sentinel');
});
it('validates separate App credentials and catches App ID/PEM reuse', async () => {
  const dev = privateKey();
  const merge = privateKey();
  const env = {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: dev,
    GITHUB_MERGE_APP_ID: '23456',
    GITHUB_MERGE_APP_PRIVATE_KEY: merge,
  };
  expect(failures(await checkConfiguration('merge', env))).toEqual([]);
  expect(
    failures(
      await checkConfiguration('merge', { ...env, GITHUB_MERGE_APP_ID: env.GITHUB_APP_ID }),
    ).some((check) => check.key === 'GITHUB_MERGE_APP_ID'),
  ).toBe(true);
  const reused = await checkConfiguration('merge', { ...env, GITHUB_MERGE_APP_PRIVATE_KEY: dev });
  expect(failures(reused).some((check) => check.key === 'GITHUB_MERGE_APP_PRIVATE_KEY')).toBe(true);
  expect(formatChecks(reused)).not.toContain(dev);
});
it('detects the same RSA key in different PEM encodings without printing its fingerprint', async () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const pkcs1 = key.export({ type: 'pkcs1', format: 'pem' }).toString();
  const pkcs8 = key.export({ type: 'pkcs8', format: 'pem' }).toString();
  const checks = await checkConfiguration('merge', {
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: pkcs1,
    GITHUB_MERGE_APP_ID: '456',
    GITHUB_MERGE_APP_PRIVATE_KEY: pkcs8,
  });
  expect(failures(checks).map((check) => check.key)).toEqual(['GITHUB_MERGE_APP_PRIVATE_KEY']);
  expect(formatChecks(checks)).not.toContain(pkcs1);
  expect(formatChecks(checks)).not.toContain(pkcs8);
});
it('checks file-backed PEM instead of an unused inline credential', async () => {
  const file = join(await directory(), 'app.pem');
  await writeFile(file, privateKey(), { mode: 0o600 });
  const checks = await checkConfiguration('github', {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY_FILE: file,
    GITHUB_APP_PRIVATE_KEY: 'ignored-invalid-value',
  });
  expect(failures(checks)).toEqual([]);
  expect(formatChecks(checks)).not.toContain(file);
});
it('validates the effective webhook file instead of the generated unused inline value', async () => {
  const file = join(await directory(), 'webhook');
  await writeFile(file, 'too-short', { mode: 0o600 });
  const checks = await checkConfiguration('local', {
    ...local(),
    GITHUB_WEBHOOK_SECRET_FILE: file,
  });
  expect(failures(checks).some((check) => check.key === 'GITHUB_WEBHOOK_SECRET')).toBe(true);
  expect(formatChecks(checks)).not.toContain('too-short');
});
it('checks worker configuration without executing Docker or a test command', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const env = await worker();
  expect(failures(await checkConfiguration('worker', env))).toEqual([]);
  const checks = await checkConfiguration('worker', {
    ...env,
    HUB_CODEX_IMAGE: 'hub-codex:latest',
    HUB_RUNNER_NETWORK: "sdcom1214's network",
    WORKER_TEST_COMMAND: '["sh","-c","echo sensitive-command"]',
  });
  expect(failures(checks).map((check) => check.key)).toEqual(
    expect.arrayContaining(['HUB_CODEX_IMAGE', 'HUB_RUNNER_NETWORK', 'WORKER_TEST_COMMAND']),
  );
  expect(formatChecks(checks)).not.toContain('sensitive-command');
  expect(fetcher).not.toHaveBeenCalled();
});
it('requires a private CLI login profile without exposing credentials', async () => {
  const env = await worker();
  expect(failures(await checkConfiguration('worker', env))).toEqual([]);
  const missing = await checkConfiguration('worker', {
    ...env,
    HUB_CODEX_AUTH_DIR: '/absent-cli-profile',
  });
  expect(failures(missing).map((check) => check.key)).toContain('HUB_CODEX_AUTH_DIR');
  expect(formatChecks(missing)).not.toContain('/absent-cli-profile');
  expect(formatChecks(await checkConfiguration('worker', env))).not.toContain('fixture-access');
});
it('prints safe help and rejects an unknown scope before loading local credentials', () => {
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/check-config.ts', '--help'],
    { encoding: 'utf8' },
  );
  expect(output).toContain('--scope');
  try {
    execFileSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/check-config.ts', '--scope', 'sensitive-invalid-scope'],
      { encoding: 'utf8', stdio: 'pipe' },
    );
    throw new Error('Expected argument validation to fail');
  } catch (error) {
    expect(error).toHaveProperty('status', 2);
    expect(String((error as { stderr?: string }).stderr)).not.toContain('sensitive-invalid-scope');
  }
});
