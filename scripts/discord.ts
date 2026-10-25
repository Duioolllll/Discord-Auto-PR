import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { commands } from '../apps/discord-bot/src/commands.js';
import { commandFailure, createControlClient } from '../apps/discord-bot/src/control-client.js';
import {
  applicationId,
  botGuilds,
  botToken,
  commandState,
  discordId,
  discordRest,
  DiscordSetupError,
  inviteUrl,
  requireGuild,
  setupFailure,
  syncCommands,
} from '../apps/discord-bot/src/integration.js';
import { saveDiscordConfig } from './discord-config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const definitions = commands.map((command) => command.toJSON());
const label = (value: string) => value.replace(/[\p{C}]/gu, '').slice(0, 100);
let stage = '실행 준비';

async function checkApi(userId?: string, signal?: AbortSignal) {
  if (!process.env.CONTROL_API_URL || !process.env.BOT_API_TOKEN) {
    console.log('[실패] API 설정 없음 → pnpm setup:local 후 API·봇 재시작');
    return false;
  }
  try {
    let api;
    try {
      const fetcher: typeof fetch = signal
        ? (input, options) =>
            fetch(input, {
              ...options,
              signal: AbortSignal.any([signal, ...(options?.signal ? [options.signal] : [])]),
            })
        : fetch;
      api = createControlClient(process.env.CONTROL_API_URL, process.env.BOT_API_TOKEN, fetcher);
    } catch {
      console.log(
        '[실패] CONTROL_API_URL 확인: 로컬 http://127.0.0.1:3001 또는 원격 HTTPS API 주소여야 합니다.',
      );
      return false;
    }
    const readiness = await api.request('/readyz', '', 'GET');
    if (readiness.ok !== true) {
      console.log('[실패] API의 DB·Redis 준비 상태를 확인하세요.');
      return false;
    }
    console.log('[정상] Control API · PostgreSQL · Redis 연결');
    if (userId && discordId.test(userId)) {
      await api.request('/me', userId, 'GET');
      const repositories = await api.request('/repositories', userId, 'GET');
      if (!Array.isArray(repositories)) throw new Error();
      console.log(
        `[정상] 봇 내부 API 토큰 인증 · 사용자 ${userId}의 활성 저장소 ${repositories.filter((repo) => repo.enabled).length}개`,
      );
      if (!repositories.some((repo) => repo.enabled))
        console.log(
          '[안내] 저장소가 없습니다. 저장소 등록 및 이 사용자에 대한 developer 역할을 확인하세요. docs/discord-quickstart.md 참고',
        );
    } else console.log('[미확인] 개인 역할·내부 API 토큰 인증 → Discord /ping으로 확인하세요.');
    return true;
  } catch (error) {
    signal?.throwIfAborted();
    console.log(`[실패] ${commandFailure(error, 'ping')}`);
    console.log('API 실행: 별도 터미널에서 pnpm dev');
    return false;
  }
}
async function check() {
  console.log('Discord 연결 점검 (설정·명령·권한을 변경하지 않습니다)');
  let ready = false;
  try {
    const token = await botToken(process.env);
    if (!token)
      throw new DiscordSetupError(
        'DISCORD_TOKEN_REQUIRED',
        'pnpm discord:setup에서 봇 토큰을 연결하세요.',
      );
    const rest = discordRest(token);
    const appId = await applicationId(rest, process.env.DISCORD_APPLICATION_ID);
    console.log('[정상] 봇 토큰 · Application ID 확인');
    const guildId = process.env.DISCORD_GUILD_ID ?? '';
    await requireGuild(rest, guildId, appId);
    console.log(`[정상] 대상 서버 ${guildId}에 봇 접근 가능`);
    console.log(`초대·권한 다시 연결: ${inviteUrl(appId, guildId)}`);
    const pending = await commandState(rest, appId, guildId, definitions);
    ready = pending.length === 0;
    console.log(
      ready
        ? `[정상] 서버 명령 ${definitions.length}개 등록 확인`
        : `[실패] 명령 ${pending.length}개 누락/이전 버전 → pnpm dev:bot이 자동으로 갱신합니다.`,
    );
    console.log(
      '명령이 여전히 안 보이면: 대상 서버의 일반 채팅창 → 앱 다시 열기(Ctrl+R) → 서버 설정 > 연동 > 봇의 명령 권한, 채널의 「애플리케이션 명령어 사용」 권한 확인. DM에서는 사용할 수 없습니다.',
    );
    console.log(
      '[미확인] Gateway 온라인·개인 채널 권한은 이 점검으로 확정할 수 없습니다. pnpm dev:bot 실행 후 /help를 확인하세요.',
    );
  } catch (error) {
    console.log(`[실패] ${setupFailure(error)}`);
  }
  const apiReady = await checkApi(
    process.env.DISCORD_CHECK_USER_ID || process.env.DISCORD_ADMIN_USER_IDS?.split(',')[0],
  );
  if (!ready || !apiReady) process.exitCode = 1;
}
async function setup() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new DiscordSetupError(
      'DISCORD_TERMINAL_REQUIRED',
      'Ubuntu/WSL의 대화형 터미널에서 pnpm discord:setup을 실행하세요.',
    );
  let hidden = false;
  // Readline handles editing; its output is suppressed while receiving the token.
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!hidden) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const abort = new AbortController();
  rl.once('close', () => abort.abort());
  rl.on('SIGINT', () => {
    abort.abort();
    rl.close();
  });
  const ask = async (question: string, secret = false) => {
    if (secret) {
      process.stdout.write(question);
      hidden = true;
    }
    try {
      return (await rl.question(secret ? '' : question, { signal: abort.signal })).trim();
    } finally {
      if (secret) {
        hidden = false;
        process.stdout.write('\n');
      }
    }
  };
  const askId = async (question: string, defaultValue: string) => {
    for (;;) {
      const value = (await ask(question)) || defaultValue;
      if (!value || discordId.test(value)) return value;
      console.log(
        'Discord 사용자 ID는 17~20자리 숫자입니다. 개발자 모드에서 ID를 복사하거나 Enter로 건너뛰세요.',
      );
    }
  };
  try {
    console.log('Discord 빠른 연결 — 봇 토큰 → 서버 선택 → 명령 등록');
    console.log(
      'Developer Portal: https://discord.com/developers/applications → Bot → Reset Token',
    );
    stage = '봇 토큰 입력';
    let token: string | undefined;
    try {
      token = await botToken(process.env);
    } catch (error) {
      console.log(setupFailure(error));
    }
    if (token && (await ask('기존 봇 토큰을 사용할까요? [Y/n] ')).toLowerCase() === 'n')
      token = undefined;
    token ??= await ask('봇 토큰 붙여넣기 (화면에 표시되지 않음): ', true);
    token = await botToken({ DISCORD_BOT_TOKEN: token });
    if (!token) throw new DiscordSetupError('DISCORD_TOKEN_REQUIRED', '봇 토큰이 비어 있습니다.');
    const rest = discordRest(token, abort.signal);
    stage = 'Discord 봇 인증';
    // Setup intentionally repairs a stale Application ID using the verified bot token.
    const appId = await applicationId(rest);
    abort.signal.throwIfAborted();
    console.log(`[정상] 봇 인증 · Application ID ${appId} 자동 확인`);
    console.log(
      `봇을 초대할 서버를 선택하세요. 다음 링크를 브라우저에서 열어 초대할 수도 있습니다.\n${inviteUrl(appId)}`,
    );
    let guildId = '';
    stage = '서버 선택·접근 확인';
    while (!guildId) {
      const guilds = await botGuilds(rest);
      guilds
        .slice(0, 25)
        .forEach((guild, i) => console.log(`${i + 1}. ${label(guild.name)} (${guild.id})`));
      const defaultGuild =
        guilds.find((guild) => guild.id === process.env.DISCORD_GUILD_ID) ??
        (guilds.length === 1 ? guilds[0] : undefined);
      const input = await ask(
        `서버 번호 또는 서버 ID${defaultGuild ? ` (Enter: ${label(defaultGuild.name)})` : ' (Enter: 초대 후 다시 조회)'}: `,
      );
      const selected = !input
        ? defaultGuild?.id
        : discordId.test(input)
          ? input
          : guilds[Number(input) - 1]?.id;
      if (!selected) {
        console.log('위 링크에서 초대를 완료한 뒤 다시 선택하세요.');
        continue;
      }
      try {
        await requireGuild(rest, selected, appId);
      } catch (error) {
        if (error instanceof DiscordSetupError && error.code === 'DISCORD_GUILD_UNAVAILABLE') {
          console.log(setupFailure(error));
          continue;
        }
        throw error;
      }
      guildId = selected;
    }
    const configuredUser =
      process.env.DISCORD_CHECK_USER_ID || process.env.DISCORD_ADMIN_USER_IDS?.split(',')[0] || '';
    const defaultUser = discordId.test(configuredUser) ? configuredUser : '';
    const userId = await askId(
      `권한을 확인할 본인 Discord 사용자 ID (선택, Enter: ${defaultUser || '건너뛰기'}): `,
      defaultUser,
    );
    if (abort.signal.aborted) throw new Error();
    stage = '설정 파일 저장';
    await saveDiscordConfig(root, token, appId, guildId, userId);
    abort.signal.throwIfAborted();
    console.log(
      '[정상] 설정 저장 (.env 0600 · 봇 토큰 파일 0600). 기존 API·GitHub·Codex 설정은 보존했습니다.',
    );
    stage = '서버 명령 등록·재조회';
    const count = await syncCommands(rest, appId, guildId, definitions, abort.signal);
    console.log(`[정상] 서버 명령 ${definitions.length}개 등록 확인 (${count}개 갱신)`);
    stage = 'Control API 연결 점검';
    console.log('Control API 연결을 확인합니다…');
    const apiReady = await checkApi(userId, abort.signal);
    abort.signal.throwIfAborted();
    console.log(
      apiReady
        ? 'Discord 명령 등록과 API 연결 확인을 마쳤습니다.'
        : 'Discord 명령 등록을 마쳤습니다. API는 준비 대기 중입니다. 별도 터미널에서 pnpm dev 실행 후 /ping으로 확인하세요.',
    );
    console.log(
      '다음: pnpm dev:bot → 「봇 온라인」 확인 → 선택한 서버에서 /help → /ping\n명령은 /를 누른 뒤 목록에서 선택하세요. 예시의 repository: 부분을 일반 메시지로 붙여 넣지 않습니다.\nAPI나 워커가 아직 없어도 명령 등록과 /help는 사용할 수 있습니다.',
    );
  } catch (error) {
    if (abort.signal.aborted)
      throw new DiscordSetupError(
        'DISCORD_SETUP_CANCELLED',
        '사용자가 설정을 취소했습니다. 완료된 설정은 보존됩니다.',
      );
    throw error;
  } finally {
    rl.close();
  }
}
try {
  if (process.argv[2] === 'setup') await setup();
  else if (process.argv[2] === 'check') await check();
  else
    throw new DiscordSetupError(
      'DISCORD_USAGE',
      'pnpm discord:setup 또는 pnpm discord:check를 실행하세요.',
    );
} catch (error) {
  console.error(`중단 단계: ${stage}`);
  console.error(setupFailure(error));
  process.exitCode =
    error instanceof DiscordSetupError && error.code === 'DISCORD_SETUP_CANCELLED' ? 130 : 1;
}
