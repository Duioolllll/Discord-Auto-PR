import { randomBytes } from 'node:crypto';
import { writeFile, readFile, appendFile } from 'node:fs/promises';
import { URL } from 'node:url';

const token = () => randomBytes(32).toString('hex');
try {
  await writeFile(
    new URL('../.env', import.meta.url),
    [
      'DATABASE_URL=postgresql://hub:hub_local_only@127.0.0.1:5432/hub',
      'TEST_DATABASE_URL=postgresql://hub:hub_local_only@127.0.0.1:5432/hub_test',
      'REDIS_URL=redis://127.0.0.1:6379',
      'CONTROL_API_URL=http://127.0.0.1:3001',
      'HOST=127.0.0.1',
      'PORT=3001',
      `ADMIN_API_TOKEN=${token()}`,
      `BOT_API_TOKEN=${token()}`,
      `WORKER_ENROLLMENT_TOKEN=${token()}`,
      `GITHUB_WEBHOOK_SECRET=${token()}`,
      '',
    ].join('\n'),
    { flag: 'wx', mode: 0o600 },
  );
  console.log('Created ignored .env with local-only tokens. No external credentials configured.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Existing .env preserved.');
}

const localEnvironment = new URL('../.env', import.meta.url);
if (
  !(await readFile(localEnvironment, 'utf8'))
    .split('\n')
    .some((line) => line.startsWith('DASHBOARD_SESSION_SECRET='))
) {
  await appendFile(localEnvironment, `\nDASHBOARD_SESSION_SECRET=${token()}\n`);
  console.log('Added local dashboard session key; existing settings preserved.');
}
