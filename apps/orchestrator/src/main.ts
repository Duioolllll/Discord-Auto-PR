import { createDatabase } from '@hub/db';
import { createQueue } from '@hub/queue';
import { Orchestrator } from './service.js';
import { dispatchOutbox } from './outbox.js';
import { githubFromEnvironment } from '@hub/github';
import { synchronizePullRequests } from './reconcile.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) throw new Error('DATABASE_URL and REDIS_URL are required');
const db = createDatabase(databaseUrl);
const { queue, connection } = createQueue(redisUrl);
const orchestrator = new Orchestrator(db);
const stop = new AbortController();
const github = githubFromEnvironment();
let nextSync = 0;
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());
while (!stop.signal.aborted) {
  try {
    await orchestrator.expireLeases();
    if (github && Date.now() >= nextSync) {
      nextSync = Date.now() + 30000;
      await synchronizePullRequests(db, github);
    }
    await dispatchOutbox(db, queue);
  } catch {
    console.error('Scheduler iteration failed; pending database work retained for retry.');
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
await queue.close();
await connection.quit();
await db.$disconnect();
