import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { DiscordSetupError, discordId } from '../apps/discord-bot/src/integration.js';

async function ownedFile(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) throw new Error();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw new DiscordSetupError(
      'DISCORD_CONFIG_UNSAFE',
      '.env와 봇 토큰은 본인 소유의 일반 파일이어야 합니다. 심볼릭 링크는 덮어쓰지 않습니다.',
    );
  }
}
async function privateDirectory(path: string) {
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const info = await lstat(path);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid()))
    throw new DiscordSetupError(
      'DISCORD_CONFIG_UNSAFE',
      '비밀 파일 디렉터리는 본인 소유의 일반 디렉터리여야 합니다.',
    );
  await chmod(path, 0o700);
}
async function atomicPrivateFile(path: string, contents: string) {
  await ownedFile(path);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, contents, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
export async function saveDiscordConfig(
  root: string,
  token: string,
  appId: string,
  guildId: string,
  checkUserId?: string,
) {
  if (
    !/^[A-Za-z0-9_.-]+$/.test(token) ||
    !discordId.test(appId) ||
    !discordId.test(guildId) ||
    (checkUserId && !discordId.test(checkUserId))
  )
    throw new DiscordSetupError('DISCORD_CONFIG_INVALID', '토큰과 Discord ID 형식을 확인하세요.');
  const envFile = join(root, '.env');
  await ownedFile(envFile);
  const original = await readFile(envFile, 'utf8');
  const parsed = parseEnv(original);
  for (const key of [
    'DISCORD_BOT_TOKEN',
    'DISCORD_BOT_TOKEN_FILE',
    'DISCORD_APPLICATION_ID',
    'DISCORD_GUILD_ID',
    'DISCORD_CHECK_USER_ID',
  ])
    if (parsed[key]?.includes('\n'))
      throw new DiscordSetupError(
        'DISCORD_CONFIG_MULTILINE',
        '.env의 Discord 항목은 한 줄이어야 합니다. 여러 줄 값을 제거한 뒤 다시 실행하세요.',
      );
  await privateDirectory(join(root, '.local'));
  await privateDirectory(join(root, '.local', 'secrets'));
  const secretFile = join(root, '.local', 'secrets', 'discord-bot-token');
  await atomicPrivateFile(secretFile, `${token}\n`);
  const values: Record<string, string> = {
    DISCORD_BOT_TOKEN_FILE: secretFile,
    DISCORD_APPLICATION_ID: appId,
    DISCORD_GUILD_ID: guildId,
    ...(checkUserId ? { DISCORD_CHECK_USER_ID: checkUserId } : {}),
  };
  const managed = new Set(['DISCORD_BOT_TOKEN', ...Object.keys(values)]);
  const preserved = original
    .split(/\r?\n/)
    .filter(
      (line) =>
        !managed.has(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1] ?? ''),
    )
    .join('\n')
    .trimEnd();
  await atomicPrivateFile(
    envFile,
    `${preserved}\n${Object.entries(values)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join('\n')}\n`,
  );
}
