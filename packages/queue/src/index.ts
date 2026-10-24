import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export { Redis };
export type { Queue };
export const queueName = 'hub-events';
export function createQueue(url: string) {
  const connection = new Redis(url, { maxRetriesPerRequest: null });
  return { connection, queue: new Queue(queueName, { connection }) };
}
