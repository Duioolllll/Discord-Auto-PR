import type { Database } from '@hub/db';
import type { Queue } from '@hub/queue';

export async function dispatchOutbox(db: Database, queue: Queue, signal?: AbortSignal) {
  if (signal?.aborted) return 0;
  const entries = await db.transactionOutbox.findMany({
    where: { publishedAt: null, attempts: { lt: 5 }, nextAttemptAt: { lte: new Date() } },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  let published = 0;
  for (const entry of entries) {
    if (signal?.aborted) break;
    // Retain queue IDs: a crash between add() and the DB update must deduplicate on retry.
    try {
      await queue.add(entry.topic, entry.payload, {
        jobId: entry.id,
        removeOnComplete: false,
        removeOnFail: false,
      });
      const changed = await db.$transaction(async (tx) => {
        const result = await tx.transactionOutbox.updateMany({
          where: { id: entry.id, publishedAt: null },
          data: { publishedAt: new Date(), lastError: null },
        });
        // Another producer may have recorded its failure while this add was in flight.
        await tx.deadLetter.deleteMany({ where: { eventId: entry.id } });
        return result.count;
      });
      published += changed;
    } catch {
      await db.$transaction(async (tx) => {
        const changed = await tx.transactionOutbox.updateMany({
          where: { id: entry.id, publishedAt: null, attempts: entry.attempts },
          data: {
            attempts: { increment: 1 },
            lastError: 'QUEUE_PUBLISH_FAILED',
            nextAttemptAt: new Date(Date.now() + Math.min(60000, 1000 * 2 ** entry.attempts)),
          },
        });
        if (changed.count && entry.attempts + 1 >= 5)
          await tx.deadLetter.upsert({
            where: { eventId: entry.id },
            create: { eventId: entry.id, topic: entry.topic, reason: 'QUEUE_PUBLISH_FAILED' },
            update: {},
          });
      });
    }
  }
  return published;
}
