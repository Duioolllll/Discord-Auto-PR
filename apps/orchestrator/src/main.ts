import { createDatabase } from '@hub/db';
import { createQueue } from '@hub/queue';
import { Orchestrator } from './service.js';
import { dispatchOutbox } from './outbox.js';
import { githubFromEnvironment } from '@hub/github';
import { synchronizePullRequests } from './reconcile.js';
import { runPeriodicTasks } from './scheduler.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) throw new Error('DATABASE_URL and REDIS_URL are required');
const db = createDatabase(databaseUrl);
const { queue, connection } = createQueue(redisUrl);
queue.on('error', () => console.error('Queue connection unavailable; outbox entries retained.'));
const orchestrator = new Orchestrator(db);
const stop = new AbortController();
const github = githubFromEnvironment();
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());
await runPeriodicTasks(
  [
    { name: 'leases', intervalMs: 1000, run: () => orchestrator.expireLeases() },
    {
      name: 'github',
      intervalMs: 30000,
      run: async () => {
        if (github) await synchronizePullRequests(db, github, stop.signal);
      },
    },
    { name: 'outbox', intervalMs: 1000, run: () => dispatchOutbox(db, queue, stop.signal) },
  ],
  stop.signal,
  (name) => console.error(`Scheduler ${name} failed; pending database work retained for retry.`),
);
connection.disconnect();
await queue.close();
await db.$disconnect();
