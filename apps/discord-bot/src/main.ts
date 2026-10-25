import { Client, Events, GatewayIntentBits, REST, Routes } from 'discord.js';
import { readFileSync } from 'node:fs';
import { commands, handleCommand } from './commands.js';
import { createControlClient } from './control-client.js';

const { DISCORD_APPLICATION_ID, DISCORD_GUILD_ID, BOT_API_TOKEN, CONTROL_API_URL } = process.env;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN_FILE
  ? readFileSync(process.env.DISCORD_BOT_TOKEN_FILE, 'utf8').trim()
  : process.env.DISCORD_BOT_TOKEN;
if (
  !DISCORD_BOT_TOKEN ||
  !DISCORD_APPLICATION_ID ||
  !DISCORD_GUILD_ID ||
  !BOT_API_TOKEN ||
  !CONTROL_API_URL
)
  throw new Error('Discord token/application/guild and control API URL/token are required');
const api = createControlClient(CONTROL_API_URL, BOT_API_TOKEN);
// Guild-scoped registration is explicit, separate from normal bot startup.
if (process.argv.includes('--register-commands')) {
  await new REST()
    .setToken(DISCORD_BOT_TOKEN)
    .put(Routes.applicationGuildCommands(DISCORD_APPLICATION_ID, DISCORD_GUILD_ID), {
      body: commands.map((command) => command.toJSON()),
    });
  console.log('Registered guild slash commands.');
} else {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isChatInputCommand())
      void handleCommand(interaction, api).catch(() =>
        console.error('Discord interaction failed.'),
      );
  });
  client.once(Events.ClientReady, () => console.log('Discord bot connected.'));
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      void client.destroy();
    });
  await client.login(DISCORD_BOT_TOKEN);
}
