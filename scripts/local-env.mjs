import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile, readFile, lstat, chmod, rename, rm } from 'node:fs/promises';
import { URL } from 'node:url';
import { parseEnv } from 'node:util';

const token = () => randomBytes(32).toString('hex');
const localEnvironment = new URL('../.env', import.meta.url);
async function initialize() {
  let original;
  try {
    const info = await lstat(localEnvironment);
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid()))
      throw new Error('unsafe environment file');
    original = await readFile(localEnvironment, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const current = parseEnv(original ?? '');
  const defaults = {
    DATABASE_URL: 'postgresql://hub:hub_local_only@127.0.0.1:5432/hub',
    TEST_DATABASE_URL: 'postgresql://hub:hub_local_only@127.0.0.1:5432/hub_test',
    REDIS_URL: 'redis://127.0.0.1:6379',
    CONTROL_API_URL: 'http://127.0.0.1:3001',
    HOST: '127.0.0.1',
    PORT: '3001',
  };
  const privateKeys = [
    'ADMIN_API_TOKEN',
    'BOT_API_TOKEN',
    'WORKER_ENROLLMENT_TOKEN',
    'GITHUB_WEBHOOK_SECRET',
    'DASHBOARD_SESSION_SECRET',
  ];
  const added = Object.fromEntries(
    Object.entries(defaults).filter(([key]) => current[key] === undefined || current[key] === ''),
  );
  for (const key of privateKeys)
    if (current[key] === undefined || current[key] === '') added[key] = token();
  if (Object.keys(added).length) {
    const preserved = (original ?? '')
      .split(/\r?\n/)
      .filter(
        (line) =>
          !Object.hasOwn(
            added,
            /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1] ?? '',
          ),
      )
      .join('\n')
      .trimEnd();
    const contents = `${preserved ? preserved + '\n' : ''}${Object.entries(added)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join('\n')}\n`;
    if (original === undefined)
      await writeFile(localEnvironment, contents, { flag: 'wx', mode: 0o600 });
    else {
      const temp = new URL(`../.env.setup-${randomUUID()}`, import.meta.url);
      try {
        await writeFile(temp, contents, { flag: 'wx', mode: 0o600 });
        if ((await readFile(localEnvironment, 'utf8')) !== original)
          throw new Error('environment changed during setup');
        await rename(temp, localEnvironment);
      } finally {
        await rm(temp, { force: true });
      }
    }
    console.log(
      `Local .env initialized: ${Object.keys(added).join(', ')}. Values are not displayed; existing nonempty settings were preserved.`,
    );
  } else console.log('Existing .env preserved.');
  await chmod(localEnvironment, 0o600);
  const result = { ...current, ...added };
  const invalid = privateKeys.filter((key) => result[key].length < 32);
  if (invalid.length)
    console.warn(
      `Check configured internal keys (values preserved): ${invalid.join(', ')} must have at least 32 characters.`,
    );
  if (
    new Set([result.ADMIN_API_TOKEN, result.BOT_API_TOKEN, result.WORKER_ENROLLMENT_TOKEN]).size !==
    3
  )
    console.warn(
      'Configured ADMIN_API_TOKEN, BOT_API_TOKEN and WORKER_ENROLLMENT_TOKEN must be distinct. Existing values were preserved.',
    );
}
await initialize().catch(() => {
  console.error(
    'LOCAL_ENV_SETUP_FAILED: .env must be an owned regular file. Check permissions, concurrent edits and available disk space. No values were displayed.',
  );
  process.exitCode = 1;
});
