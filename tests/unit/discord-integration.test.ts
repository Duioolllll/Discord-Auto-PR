import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, symlink, writeFile, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
import {
  commands,
  handleAutocomplete,
  handleCommand,
} from '../../apps/discord-bot/src/commands.js';
import {
  applicationId,
  botToken,
  inviteUrl,
  requireGuild,
  setupFailure,
  syncCommands,
  type DiscordTransport,
} from '../../apps/discord-bot/src/integration.js';
import { saveDiscordConfig } from '../../scripts/discord-config.js';

const appId = '123456789012345678';
const guildId = '234567890123456789';
const userId = '345678901234567890';
const definitions = () => commands.map((command) => command.toJSON());

it('registers missing or changed commands, preserves unrelated commands, verifies and skips unchanged definitions', async () => {
  const expected = definitions();
  const unrelated = {
    name: 'other-command',
    description: 'Preserve this command',
    type: 1 as const,
  };
  const current: typeof expected = [
    unrelated,
    ...expected.slice(1).map((command) => ({
      ...command,
      type: 1 as const,
      id: 'remote-id',
      version: 'remote-version',
    })),
  ];
  // Simulate the old repository option without autocomplete.
  current[1] = {
    ...current[1]!,
    options: current[1]!.options?.map((option) => ({ ...option, autocomplete: false })),
  } as (typeof current)[number];
  const rest: DiscordTransport = {
    get: vi.fn(async () => structuredClone(current)),
    post: vi.fn(async (_route, { body }) => {
      const value = body as (typeof current)[number];
      const index = current.findIndex((command) => command.name === value.name);
      if (index < 0) current.push({ ...value, type: 1 });
      else current[index] = { ...value, type: 1 };
      return value;
    }),
  };
  expect(await syncCommands(rest, appId, guildId, expected)).toBe(2);
  expect(rest.post).toHaveBeenCalledTimes(2);
  expect(rest.post).toHaveBeenCalledWith(`/applications/${appId}/guilds/${guildId}/commands`, {
    body: expect.objectContaining({ name: expected[0]!.name }),
  });
  expect(current).toContainEqual(unrelated);
  expect(await syncCommands(rest, appId, guildId, expected)).toBe(0);
  expect(rest.post).toHaveBeenCalledTimes(2);
});

it('never reports command registration success if Discord does not return the written definitions', async () => {
  const rest = { get: vi.fn(async () => []), post: vi.fn(async () => ({})) };
  await expect(syncCommands(rest, appId, guildId, definitions())).rejects.toMatchObject({
    code: 'DISCORD_COMMANDS_NOT_READY',
  });
});

it('checks token/application identity and detects incompatible interaction webhook configuration', async () => {
  const rest = { get: vi.fn(async () => ({ id: appId })), post: vi.fn() };
  expect(await applicationId(rest)).toBe(appId);
  await expect(applicationId(rest, guildId)).rejects.toMatchObject({
    code: 'DISCORD_APPLICATION_MISMATCH',
  });
  expect(rest.post).not.toHaveBeenCalled();
  await expect(
    applicationId({
      ...rest,
      get: async () => ({
        id: appId,
        interactions_endpoint_url: 'https://example.test/interactions',
      }),
    }),
  ).rejects.toMatchObject({ code: 'DISCORD_INTERACTIONS_ENDPOINT_SET' });
});

it('creates a server-scoped invite with command scope and minimal channel permissions, without administrator', async () => {
  const url = new URL(inviteUrl(appId, guildId));
  expect(url.origin).toBe('https://discord.com');
  expect(url.searchParams.get('scope')).toBe('bot applications.commands');
  expect(url.searchParams.get('client_id')).toBe(appId);
  expect(url.searchParams.get('guild_id')).toBe(guildId);
  expect(Number(url.searchParams.get('permissions')) & 8).toBe(0);
  const rest = {
    get: async () => {
      throw { status: 404, message: 'fake-private-token' };
    },
    post: vi.fn(),
  };
  const error = await requireGuild(rest, guildId, appId).catch((e) => e);
  expect(setupFailure(error)).toContain('DISCORD_GUILD_UNAVAILABLE');
  expect(setupFailure(error)).toContain(inviteUrl(appId, guildId));
  expect(setupFailure(error)).not.toContain('fake-private-token');
});

it('does not print Discord SDK request data or unknown exception messages', () => {
  for (const error of [
    new Error('fake-secret'),
    { status: 401, requestBody: { token: 'fake-secret' } },
    { status: 403, rawError: 'fake-secret' },
  ])
    expect(setupFailure(error)).not.toContain('fake-secret');
});

it('saves only private local Discord settings and preserves unrelated configuration without granting admin roles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-discord-setup-'));
  try {
    const envFile = join(root, '.env');
    const internal = 'fake-internal-secret';
    await writeFile(
      envFile,
      `# Keep this comment\nBOT_API_TOKEN=${internal}\nGITHUB_APP_ID=123\nHUB_CODEX_AUTH_DIR=/private/profile\nDISCORD_BOT_TOKEN=old-fake-token\nDISCORD_GUILD_ID=000\nDISCORD_ADMIN_USER_IDS=\n`,
    );
    await saveDiscordConfig(root, 'fake-new-token', appId, guildId, userId);
    const text = await readFile(envFile, 'utf8');
    const env = parseEnv(text);
    expect(text).toContain('# Keep this comment');
    expect(text).not.toContain('fake-new-token');
    expect(text).not.toContain('old-fake-token');
    expect(env).toMatchObject({
      BOT_API_TOKEN: internal,
      GITHUB_APP_ID: '123',
      HUB_CODEX_AUTH_DIR: '/private/profile',
      DISCORD_APPLICATION_ID: appId,
      DISCORD_GUILD_ID: guildId,
      DISCORD_CHECK_USER_ID: userId,
      DISCORD_ADMIN_USER_IDS: '',
    });
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(await botToken(env)).toBe('fake-new-token');
    for (const file of [envFile, env.DISCORD_BOT_TOKEN_FILE!])
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, '.local', 'secrets'))).mode & 0o777).toBe(0o700);
    await saveDiscordConfig(root, 'fake-new-token', appId, guildId, userId);
    expect((await readFile(envFile, 'utf8')).match(/^DISCORD_GUILD_ID=/gm)).toHaveLength(1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('refuses symlinked configuration and private directories instead of writing secrets outside the checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-discord-links-'));
  try {
    const external = join(root, 'external');
    await writeFile(external, 'unchanged');
    await symlink(external, join(root, '.env'));
    await expect(saveDiscordConfig(root, 'fake-token', appId, guildId)).rejects.toMatchObject({
      code: 'DISCORD_CONFIG_UNSAFE',
    });
    expect(await readFile(external, 'utf8')).toBe('unchanged');
    await rm(join(root, '.env'));
    await writeFile(join(root, '.env'), 'BOT_API_TOKEN=fake-internal\n');
    await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(root, '.local'));
    await expect(saveDiscordConfig(root, 'fake-token', appId, guildId)).rejects.toMatchObject({
      code: 'DISCORD_CONFIG_UNSAFE',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects public and symlinked token files without falling back to an inline token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-discord-token-'));
  try {
    const file = join(root, 'token');
    await writeFile(file, 'fake-token', { mode: 0o644 });
    await chmod(file, 0o644);
    await expect(
      botToken({ DISCORD_BOT_TOKEN_FILE: file, DISCORD_BOT_TOKEN: 'fallback' }),
    ).rejects.toMatchObject({ code: 'DISCORD_TOKEN_FILE_INVALID' });
    await chmod(file, 0o600);
    expect(await botToken({ DISCORD_BOT_TOKEN_FILE: file })).toBe('fake-token');
    await symlink(file, join(root, 'link'));
    await expect(botToken({ DISCORD_BOT_TOKEN_FILE: join(root, 'link') })).rejects.toMatchObject({
      code: 'DISCORD_TOKEN_FILE_INVALID',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

function interaction(commandName: string) {
  return {
    commandName,
    id: 'interaction1',
    user: { id: userId },
    options: { getString: vi.fn() },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(),
  } as unknown as Parameters<typeof handleCommand>[0];
}
it('serves /help without an API and keeps /ping read-only and tied to the actual Discord user', async () => {
  const request = vi.fn(async (path: string) =>
    path === '/me' ? { id: `discord:${userId}` } : ([] as unknown as Record<string, unknown>),
  );
  const help = interaction('help');
  await handleCommand(help, { request });
  expect(request).not.toHaveBeenCalled();
  expect(help.editReply).toHaveBeenCalledWith({
    content: expect.stringContaining('/ping'),
    allowedMentions: { parse: [] },
  });
  const ping = interaction('ping');
  await handleCommand(ping, { request });
  expect(request.mock.calls).toEqual([
    ['/me', userId, 'GET'],
    ['/repositories', userId, 'GET'],
  ]);
  expect(ping.editReply).toHaveBeenCalledWith({
    content: expect.stringContaining('활성 저장소: 0개'),
    allowedMentions: { parse: [] },
  });
});

it('autocompletes only API-authorized active repositories and recent jobs using full IDs', async () => {
  const respond = vi.fn();
  const request = vi.fn(
    async () =>
      [
        { fullName: 'allowed/repo', enabled: true },
        { fullName: 'disabled/repo', enabled: false },
      ] as unknown as Record<string, unknown>,
  );
  await handleAutocomplete(
    {
      commandName: 'develop',
      user: { id: userId },
      options: { getFocused: () => ({ name: 'repository', value: 'repo' }) },
      respond,
    } as unknown as Parameters<typeof handleAutocomplete>[0],
    { request },
  );
  expect(request).toHaveBeenCalledWith('/repositories', userId, 'GET');
  expect(respond).toHaveBeenCalledWith([{ name: 'allowed/repo', value: 'allowed/repo' }]);
  const jobId = '4aa6225c-a79f-487e-8706-878617721bc1';
  const jobs = vi.fn(
    async () =>
      [
        { id: jobId, status: 'QUEUED', repository: { fullName: 'allowed/repo' } },
      ] as unknown as Record<string, unknown>,
  );
  await handleAutocomplete(
    {
      commandName: 'status',
      user: { id: userId },
      options: { getFocused: () => ({ name: 'job', value: '' }) },
      respond,
    } as unknown as Parameters<typeof handleAutocomplete>[0],
    { request: jobs },
  );
  expect(jobs).toHaveBeenCalledWith('/jobs?limit=25', userId, 'GET');
  expect(respond).toHaveBeenLastCalledWith([
    { name: expect.stringContaining('allowed/repo'), value: jobId },
  ]);
});

it('answers autocomplete within the Discord deadline and never exposes raw API errors', async () => {
  vi.useFakeTimers();
  try {
    const respond = vi.fn();
    const input = {
      commandName: 'refactor',
      user: { id: userId },
      options: { getFocused: () => ({ name: 'repository', value: '' }) },
      respond,
    } as unknown as Parameters<typeof handleAutocomplete>[0];
    const pending = handleAutocomplete(input, { request: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(respond).toHaveBeenCalledWith([]);
    await handleAutocomplete(input, {
      request: async () => {
        throw new Error('fake-secret');
      },
    });
    expect(respond).toHaveBeenLastCalledWith([]);
  } finally {
    vi.useRealTimers();
  }
});
