import { expect, it } from 'vitest';
import { readFile, stat, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { commands } from '../../apps/discord-bot/src/commands.js';
import { cliFakeToken, cliIds, discordCliFixture } from '../helpers/discord-cli.js';

it('runs the actual pnpm setup, check, registration and bot commands through a terminal and real Discord REST client', async () => {
  const fixture = await discordCliFixture();
  try {
    fixture.state.emptyGuildsFirst = true;
    const setup = fixture.run('discord:setup', true);
    await setup.reply('봇 토큰 붙여넣기', cliFakeToken);
    await setup.reply('서버 번호 또는 서버 ID');
    await setup.reply('서버 번호 또는 서버 ID', '999999999999999999');
    await setup.reply('서버 번호 또는 서버 ID', '1');
    await setup.reply('권한을 확인할 본인 Discord 사용자 ID', 'not-a-user-id');
    await setup.reply('권한을 확인할 본인 Discord 사용자 ID', cliIds.user);
    expect(await setup.finish()).toBe(0);
    expect(setup.output()).toContain('서버 명령 10개 등록 확인');
    expect(setup.output()).not.toContain(cliFakeToken);
    const envText = await fixture.readEnvironment();
    const env = parseEnv(envText);
    expect(env.DISCORD_APPLICATION_ID).toBe(cliIds.app);
    expect(env.DISCORD_GUILD_ID).toBe(cliIds.guild);
    expect(env.DISCORD_CHECK_USER_ID).toBe(cliIds.user);
    expect(env.DISCORD_ADMIN_USER_IDS).toBeUndefined();
    expect(env.GITHUB_APP_ID).toBe('keep-test-value');
    for (const key of [
      'ADMIN_API_TOKEN',
      'BOT_API_TOKEN',
      'WORKER_ENROLLMENT_TOKEN',
      'GITHUB_WEBHOOK_SECRET',
      'DASHBOARD_SESSION_SECRET',
    ])
      expect(env[key]).toHaveLength(64);
    expect(
      new Set([env.ADMIN_API_TOKEN, env.BOT_API_TOKEN, env.WORKER_ENROLLMENT_TOKEN]).size,
    ).toBe(3);
    expect((await stat(join(fixture.root, '.env'))).mode & 0o777).toBe(0o600);
    expect((await stat(env.DISCORD_BOT_TOKEN_FILE!)).mode & 0o777).toBe(0o600);
    expect(await readFile(env.DISCORD_BOT_TOKEN_FILE!, 'utf8')).toBe(`${cliFakeToken}\n`);
    expect(fixture.state.commands.map((command) => command.name)).toEqual(
      expect.arrayContaining(['unmanaged', ...commands.map((command) => command.name)]),
    );
    const writes = fixture.state.calls.filter((call) => call.method === 'POST').length;
    expect(writes).toBe(10);

    const resumed = fixture.run('discord:setup', true);
    await resumed.reply('기존 봇 토큰을 사용할까요?');
    await resumed.reply('서버 번호 또는 서버 ID');
    await resumed.reply('권한을 확인할 본인 Discord 사용자 ID');
    expect(await resumed.finish(), resumed.output()).toBe(0);
    expect(await fixture.readEnvironment()).toBe(envText);
    expect(fixture.state.calls.filter((call) => call.method === 'POST')).toHaveLength(writes);

    const check = fixture.run('discord:check');
    expect(await check.finish()).toBe(0);
    expect(check.output()).toContain('서버 명령 10개 등록 확인');
    expect(check.output()).not.toContain(cliFakeToken);
    expect(await fixture.readEnvironment()).toBe(envText);
    expect(fixture.state.calls.filter((call) => call.method === 'POST')).toHaveLength(writes);

    const register = fixture.run('--filter @hub/discord-bot dev --register-commands');
    const registered = await register.finish();
    expect(registered, register.output()).toBe(0);
    expect(register.output()).toContain('(0개 갱신)');
    expect(fixture.state.calls.filter((call) => call.method === 'POST')).toHaveLength(writes);

    fixture.state.commands = fixture.state.commands.filter((command) => command.name !== 'help');
    const missing = fixture.run('discord:check');
    expect(await missing.finish()).toBe(1);
    expect(missing.output()).toContain('명령 1개 누락');
    expect(fixture.state.calls.filter((call) => call.method === 'POST')).toHaveLength(writes);

    const bot = fixture.run('dev:bot');
    await bot.waitFor('Discord 봇 온라인');
    const deadline = Date.now() + 3000;
    while (!fixture.state.gatewayReplies.length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.state.gatewayReplies).toHaveLength(1);
    expect(fixture.state.gatewayReplies[0]).toMatchObject({
      content: expect.stringContaining('/ping'),
      allowedMentions: { parse: [] },
    });
    expect(bot.output()).not.toContain(cliFakeToken);
    expect(
      fixture.state.calls.filter(
        (call) => call.method === 'POST' && call.path.includes('/commands'),
      ),
    ).toHaveLength(writes + 1);
    expect(fixture.state.commands.some((command) => command.name === 'unmanaged')).toBe(true);
    await fixture.stop(bot.child);
  } finally {
    await fixture.close();
  }
}, 60000);

it('treats terminal cancellation as cancellation and does not contact Discord or persist a token', async () => {
  const fixture = await discordCliFixture();
  try {
    const setup = fixture.run('discord:setup', true);
    await setup.waitFor('봇 토큰 붙여넣기');
    setup.child.stdin.write('\x03');
    expect(await setup.finish()).toBe(130);
    expect(setup.output()).toContain('DISCORD_SETUP_CANCELLED');
    expect(setup.output()).not.toContain('DISCORD_CONNECTION_FAILED');
    expect(fixture.state.calls).toHaveLength(0);
    expect(parseEnv(await fixture.readEnvironment()).DISCORD_BOT_TOKEN_FILE).toBeUndefined();
  } finally {
    await fixture.close();
  }
}, 30000);

it('cancels an in-flight Discord request without registering any commands', async () => {
  const fixture = await discordCliFixture();
  try {
    fixture.state.stallAuthentication = true;
    const setup = fixture.run('discord:setup', true);
    await setup.reply('봇 토큰 붙여넣기', cliFakeToken);
    const deadline = Date.now() + 3000;
    while (!fixture.state.calls.length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fixture.state.calls.length).toBeGreaterThan(0);
    setup.child.stdin.write('\x03');
    expect(await setup.finish(), setup.output()).toBe(130);
    expect(setup.output()).toContain('DISCORD_SETUP_CANCELLED');
    expect(setup.output()).not.toContain(cliFakeToken);
    expect(fixture.state.calls.some((call) => call.method === 'POST')).toBe(false);
  } finally {
    await fixture.close();
  }
}, 30000);

it('reports a Discord REST timeout at authentication and exits without command writes', async () => {
  const fixture = await discordCliFixture();
  try {
    fixture.state.stallAuthentication = true;
    const setup = fixture.run('discord:setup', true);
    await setup.reply('봇 토큰 붙여넣기', cliFakeToken);
    expect(await setup.finish(), setup.output()).toBe(1);
    expect(setup.output()).toContain('중단 단계: Discord 봇 인증');
    expect(setup.output()).toContain('DISCORD_REQUEST_TIMEOUT');
    expect(setup.output()).not.toContain(cliFakeToken);
    expect(fixture.state.calls.some((call) => call.method === 'POST')).toBe(false);
  } finally {
    await fixture.close();
  }
}, 30000);

it('distinguishes verified Discord setup from an API that is not ready and clears a skipped invalid diagnostic ID', async () => {
  const fixture = await discordCliFixture();
  try {
    fixture.state.apiStatus = 401;
    await writeFile(
      join(fixture.root, '.env'),
      `${await fixture.readEnvironment()}DISCORD_CHECK_USER_ID=invalid-old-id\n`,
    );
    const setup = fixture.run('discord:setup', true);
    await setup.reply('봇 토큰 붙여넣기', cliFakeToken);
    await setup.reply('서버 번호 또는 서버 ID', '1');
    await setup.reply('권한을 확인할 본인 Discord 사용자 ID');
    expect(await setup.finish(), setup.output()).toBe(0);
    expect(setup.output()).toContain('서버 명령 10개 등록 확인');
    expect(setup.output()).toContain('API는 준비 대기 중');
    expect(parseEnv(await fixture.readEnvironment()).DISCORD_CHECK_USER_ID).toBe('');
    const check = fixture.run('discord:check');
    expect(await check.finish()).toBe(1);
    expect(check.output()).toContain('UNAUTHORIZED');
    expect(check.output()).not.toContain(cliFakeToken);
  } finally {
    await fixture.close();
  }
}, 30000);

it('fails at the correct authentication or registration stage without exposing SDK request credentials', async () => {
  for (const failure of ['authentication', 'registration'] as const) {
    const fixture = await discordCliFixture();
    try {
      if (failure === 'authentication') fixture.state.discordStatus = 401;
      else fixture.state.registrationStatus = 403;
      const setup = fixture.run('discord:setup', true);
      await setup.reply('봇 토큰 붙여넣기', cliFakeToken);
      if (failure === 'registration') {
        await setup.reply('서버 번호 또는 서버 ID', '1');
        await setup.reply('권한을 확인할 본인 Discord 사용자 ID');
      }
      expect(await setup.finish()).toBe(1);
      expect(setup.output()).toContain(
        failure === 'authentication' ? 'DISCORD_UNAUTHORIZED' : 'DISCORD_FORBIDDEN',
      );
      expect(setup.output()).toContain(
        failure === 'authentication'
          ? '중단 단계: Discord 봇 인증'
          : '중단 단계: 서버 명령 등록·재조회',
      );
      expect(setup.output()).not.toContain(cliFakeToken);
      expect(setup.output()).not.toContain('다음: pnpm dev:bot');
    } finally {
      await fixture.close();
    }
  }
}, 45000);

it('initializes a fresh checkout without credentials and explains a non-interactive setup attempt', async () => {
  const fixture = await discordCliFixture();
  try {
    await rm(join(fixture.root, '.env'));
    const setup = fixture.run('discord:setup');
    expect(await setup.finish()).toBe(1);
    expect(setup.output()).toContain('DISCORD_TERMINAL_REQUIRED');
    expect(fixture.state.calls).toHaveLength(0);
    const before = await fixture.readEnvironment();
    const initialize = fixture.run('setup:local');
    expect(await initialize.finish()).toBe(0);
    expect(await fixture.readEnvironment()).toBe(before);
    const pkg = JSON.parse(await readFile(join(fixture.root, 'package.json'), 'utf8'));
    delete pkg.scripts['discord:setup'];
    await writeFile(join(fixture.root, 'package.json'), JSON.stringify(pkg));
    const outdated = fixture.run('discord:setup');
    expect(await outdated.finish()).not.toBe(0);
    expect(outdated.output()).toContain('discord:setup');
    expect(fixture.state.calls).toHaveLength(0);
  } finally {
    await fixture.close();
  }
}, 30000);

it('does not follow an environment symlink or disclose its contents during local initialization', async () => {
  const fixture = await discordCliFixture();
  try {
    const target = join(fixture.root, 'private-fixture');
    const secret = 'fake-private-config-must-remain-unread';
    await writeFile(target, secret, { mode: 0o600 });
    await rm(join(fixture.root, '.env'));
    await symlink(target, join(fixture.root, '.env'));
    const setup = fixture.run('setup:local');
    expect(await setup.finish()).toBe(1);
    expect(setup.output()).toContain('LOCAL_ENV_SETUP_FAILED');
    expect(setup.output()).not.toContain(secret);
    expect(await readFile(target, 'utf8')).toBe(secret);
    expect(fixture.state.calls).toHaveLength(0);
  } finally {
    await fixture.close();
  }
}, 30000);
