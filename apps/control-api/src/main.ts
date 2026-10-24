import { createDatabase } from '@hub/db';
import { Redis } from '@hub/queue';
import { buildApp } from './app.js';
import { ApiEnvironment } from './config.js';
import { githubFromEnvironment } from '@hub/github';
import { readFileSync } from 'node:fs';

const parsed = ApiEnvironment.safeParse({
  ...process.env,
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET_FILE
    ? readFileSync(process.env.GITHUB_WEBHOOK_SECRET_FILE, 'utf8').trim()
    : process.env.GITHUB_WEBHOOK_SECRET,
});
if (!parsed.success) {
  console.error(
    'Invalid API configuration:',
    parsed.error.issues.map((issue) => issue.path.join('.')).join(', '),
  );
  process.exit(1);
}
const config = parsed.data;
const db = createDatabase(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
const app = buildApp({
  db,
  config,
  pingRedis: () => redis.ping(),
  logger: true,
  github: githubFromEnvironment(),
});
app.addHook('onClose', async () => {
  await db.$disconnect();
  await redis.quit();
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ host: config.HOST, port: config.PORT });
