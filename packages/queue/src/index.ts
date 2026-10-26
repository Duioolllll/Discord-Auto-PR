import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export { Redis };
export type { Queue };
export const queueName = 'hub-events';
class ProducerQueue extends Queue {
  constructor(private producer: Redis) {
    super(queueName, { connection: producer });
  }
  override async add(...args: Parameters<Queue['add']>) {
    // BullMQ's initial waitUntilReady otherwise waits through unlimited reconnects.
    if (this.producer.status !== 'ready') throw new Error('QUEUE_UNAVAILABLE');
    return super.add(...args);
  }
}
export function createQueue(url: string) {
  // This is a producer. Fail commands during outages so the database outbox can retry them.
  const connection = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    commandTimeout: 3000,
    enableOfflineQueue: false,
  });
  return { connection, queue: new ProducerQueue(connection) };
}
