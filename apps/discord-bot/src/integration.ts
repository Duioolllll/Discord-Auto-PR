import { REST, Routes } from 'discord.js';
import { isDeepStrictEqual } from 'node:util';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';

export const discordId = /^\d{17,20}$/;
export class DiscordSetupError extends Error {
  constructor(
    readonly code: string,
    readonly hint: string,
  ) {
    super(code);
  }
}
export function setupFailure(error: unknown) {
  if (error instanceof DiscordSetupError) return `${error.code}: ${error.hint}`;
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  if (status === 401)
    return 'DISCORD_UNAUTHORIZED: 봇 토큰이 유효하지 않습니다. Developer Portal → Bot에서 확인하고 pnpm discord:setup을 실행하세요.';
  if (status === 403)
    return 'DISCORD_FORBIDDEN: 봇 초대와 대상 서버 권한을 확인하고 pnpm discord:setup을 실행하세요.';
  if (status === 429)
    return 'DISCORD_RATE_LIMITED: Discord 요청 한도에 도달했습니다. 잠시 후 다시 실행하세요.';
  if (error instanceof Error && error.name === 'RateLimitError')
    return 'DISCORD_RATE_LIMITED: Discord 요청 한도에 도달했습니다. 잠시 후 다시 실행하세요.';
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    return 'DISCORD_REQUEST_TIMEOUT: Discord 응답 시간이 초과되었습니다. HTTPS 연결·방화벽·프록시 설정을 확인하세요.';
  return 'DISCORD_CONNECTION_FAILED: Discord 연결 또는 설정 파일을 확인하세요. pnpm discord:check로 점검할 수 있습니다.';
}
export function discordRest(token: string, signal?: AbortSignal) {
  // Never print the SDK error object: it can contain the authenticated request.
  const rest = new REST({ timeout: 10_000, retries: 0, rejectOnRateLimit: () => true }).setToken(
    token,
  );
  if (signal) {
    const request = rest.request.bind(rest);
    rest.request = (options) => request({ ...options, signal });
  }
  return rest;
}
export interface DiscordTransport {
  get(route: `/${string}`, options?: { query?: URLSearchParams }): Promise<unknown>;
  post(route: `/${string}`, options: { body: unknown }): Promise<unknown>;
}
export async function botToken(
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  let token = env.DISCORD_BOT_TOKEN?.trim();
  if (env.DISCORD_BOT_TOKEN_FILE) {
    let file;
    try {
      file = await open(
        env.DISCORD_BOT_TOKEN_FILE,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const info = await file.stat();
      const maxBytes = 128 * 1024;
      if (
        !info.isFile() ||
        info.size > maxBytes ||
        info.mode & 0o077 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error();
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maxBytes) throw new Error();
      token = buffer.subarray(0, bytesRead).toString('utf8').trim();
    } catch {
      throw new DiscordSetupError(
        'DISCORD_TOKEN_FILE_INVALID',
        '봇 토큰 파일은 본인 소유의 128 KiB 이하 일반 파일이며 권한이 0600이어야 합니다. 파일 경로·권한을 확인하세요.',
      );
    } finally {
      await file?.close();
    }
  }
  if (!token) return undefined;
  if (!/^[A-Za-z0-9_.-]+$/.test(token))
    throw new DiscordSetupError(
      'DISCORD_TOKEN_INVALID',
      'Bot → Reset Token에서 받은 토큰만 입력하세요. Bot 접두사나 여러 줄은 넣지 않습니다.',
    );
  return token;
}
export async function applicationId(rest: DiscordTransport, configured?: string) {
  const app = (await rest.get(Routes.oauth2CurrentApplication())) as {
    id?: unknown;
    interactions_endpoint_url?: unknown;
  };
  if (typeof app.id !== 'string' || !discordId.test(app.id))
    throw new DiscordSetupError(
      'DISCORD_APPLICATION_INVALID',
      'Discord에서 Application ID를 확인하지 못했습니다.',
    );
  if (configured && configured !== app.id)
    throw new DiscordSetupError(
      'DISCORD_APPLICATION_MISMATCH',
      '봇 토큰과 Application ID가 다른 앱입니다. pnpm discord:setup으로 토큰 기준 설정을 다시 저장하세요.',
    );
  if (app.interactions_endpoint_url)
    throw new DiscordSetupError(
      'DISCORD_INTERACTIONS_ENDPOINT_SET',
      '이 봇은 Gateway 방식입니다. Developer Portal의 Interactions Endpoint URL을 비운 뒤 다시 실행하세요. 기존 외부 연동에 사용 중인 앱이라면 별도 앱을 만드세요.',
    );
  return app.id;
}
export function inviteUrl(appId: string, guildId?: string) {
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({
    client_id: appId,
    scope: 'bot applications.commands',
    permissions: '3072',
    ...(guildId ? { guild_id: guildId, disable_guild_select: 'true' } : {}),
  }).toString();
  return url.toString();
}
export async function botGuilds(rest: DiscordTransport) {
  const result = await rest.get(Routes.userGuilds(), {
    query: new URLSearchParams({ limit: '200' }),
  });
  if (!Array.isArray(result))
    throw new DiscordSetupError('DISCORD_GUILDS_INVALID', 'Discord 서버 목록을 읽지 못했습니다.');
  return result.filter(
    (guild): guild is { id: string; name: string } =>
      guild &&
      typeof guild.id === 'string' &&
      discordId.test(guild.id) &&
      typeof guild.name === 'string',
  );
}
export async function requireGuild(rest: DiscordTransport, guildId: string, appId: string) {
  if (!discordId.test(guildId))
    throw new DiscordSetupError(
      'DISCORD_GUILD_REQUIRED',
      '연결할 서버가 없습니다. pnpm discord:setup으로 서버를 선택하세요.',
    );
  try {
    await rest.get(Routes.guild(guildId));
  } catch (error) {
    const status =
      error && typeof error === 'object' && 'status' in error ? error.status : undefined;
    if (status === 403 || status === 404)
      throw new DiscordSetupError(
        'DISCORD_GUILD_UNAVAILABLE',
        `봇이 대상 서버에 접근할 수 없습니다. 다음 링크로 초대한 뒤 다시 실행하세요.\n${inviteUrl(appId, guildId)}`,
      );
    throw error;
  }
}
type Definition = {
  name: string;
  type?: number;
  description?: string;
  options?: {
    type: number;
    name: string;
    description: string;
    required?: boolean;
    autocomplete?: boolean;
    choices?: readonly unknown[];
  }[];
};
// Discord adds IDs, versions and default fields. Compare only the fields this bot manages.
function definition(value: Definition): unknown {
  return {
    type: value.type ?? 1,
    name: value.name,
    description: value.description,
    options: (value.options ?? []).map((option) => ({
      type: option.type,
      name: option.name,
      description: option.description,
      required: option.required ?? false,
      autocomplete: option.autocomplete ?? false,
      choices: option.choices ?? [],
    })),
  };
}
export async function commandState(
  rest: DiscordTransport,
  appId: string,
  guildId: string,
  desired: Definition[],
) {
  const current = await rest.get(Routes.applicationGuildCommands(appId, guildId));
  if (!Array.isArray(current))
    throw new DiscordSetupError('DISCORD_COMMANDS_INVALID', '등록된 명령을 확인하지 못했습니다.');
  return desired.filter(
    (wanted) =>
      !current.some(
        (existing) =>
          existing.type === (wanted.type ?? 1) &&
          existing.name === wanted.name &&
          isDeepStrictEqual(definition(existing), definition(wanted)),
      ),
  );
}
export async function syncCommands(
  rest: DiscordTransport,
  appId: string,
  guildId: string,
  desired: Definition[],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const pending = await commandState(rest, appId, guildId, desired);
  // POST upserts a named command. Preserve other commands registered by this application.
  for (const body of pending) {
    signal?.throwIfAborted();
    await rest.post(Routes.applicationGuildCommands(appId, guildId), { body });
  }
  signal?.throwIfAborted();
  const remaining = await commandState(rest, appId, guildId, desired);
  if (remaining.length)
    throw new DiscordSetupError(
      'DISCORD_COMMANDS_NOT_READY',
      '명령 등록을 확인하지 못했습니다. pnpm discord:check로 다시 점검하세요.',
    );
  return pending.length;
}
