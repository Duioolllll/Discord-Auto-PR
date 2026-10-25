import { Client, Events, GatewayIntentBits } from 'discord.js';
import { commands, handleCommand, handleAutocomplete } from './commands.js';
import { ControlApiError, createControlClient, type ControlClient } from './control-client.js';
import {
  applicationId,
  botToken,
  discordRest,
  DiscordSetupError,
  requireGuild,
  setupFailure,
  syncCommands,
} from './integration.js';

async function main() {
  const token = await botToken(process.env);
  if (!token)
    throw new DiscordSetupError(
      'DISCORD_TOKEN_REQUIRED',
      '봇 연결 설정이 없습니다. pnpm discord:setup을 실행하세요.',
    );
  const rest = discordRest(token);
  const appId = await applicationId(rest, process.env.DISCORD_APPLICATION_ID);
  const guildId = process.env.DISCORD_GUILD_ID ?? '';
  await requireGuild(rest, guildId, appId);
  console.log('Discord 인증·서버 접근 확인. 명령을 자동 등록합니다…');
  const changed = await syncCommands(
    rest,
    appId,
    guildId,
    commands.map((command) => command.toJSON()),
  );
  console.log(`서버 명령 ${commands.length}개 확인 완료 (${changed}개 갱신).`);
  // Backwards-compatible manual registration; API configuration is not needed for registration.
  if (process.argv.includes('--register-commands')) return;
  let api: ControlClient = {
    request: async () => {
      throw new ControlApiError('CONTROL_API_NOT_CONFIGURED');
    },
  };
  if (process.env.CONTROL_API_URL && process.env.BOT_API_TOKEN) {
    try {
      api = createControlClient(process.env.CONTROL_API_URL, process.env.BOT_API_TOKEN);
    } catch {
      api = {
        request: async () => {
          throw new ControlApiError('CONTROL_API_CONFIG_INVALID');
        },
      };
      console.warn(
        'CONTROL_API_URL이 유효하지 않습니다. /help는 사용 가능합니다. .env의 API 주소를 확인하세요.',
      );
    }
  } else
    console.warn(
      'API 설정이 없습니다. /help는 사용 가능합니다. pnpm setup:local 후 API·봇을 다시 시작하세요.',
    );
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.guildId !== guildId) return;
    if (interaction.isAutocomplete())
      void handleAutocomplete(interaction, api).catch(() =>
        console.error('Discord autocomplete failed.'),
      );
    else if (interaction.isChatInputCommand())
      void handleCommand(interaction, api).catch(() =>
        console.error('Discord interaction failed.'),
      );
  });
  client.once(Events.ClientReady, () =>
    console.log(
      'Discord 봇 온라인. 대상 서버 채팅창에서 /help → /ping을 선택하세요. 명령이 보이지 않으면 pnpm discord:check를 실행하세요.',
    ),
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      void client.destroy();
    });
  try {
    await client.login(token);
  } catch (error) {
    await client.destroy();
    throw error;
  }
}
await main().catch((error) => {
  console.error(setupFailure(error));
  process.exitCode = 1;
});
