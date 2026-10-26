import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { createDatabase, type Database } from '@hub/db';
import type { Queue } from '@hub/queue';
import { dispatchOutbox } from '../../apps/orchestrator/src/outbox.js';
import { prepareTestDatabase } from '../helpers/test-db.js';

process.loadEnvFile('.env');
const connection = process.env.TEST_DATABASE_URL!;
const url = new URL(connection);
if (url.pathname !== '/hub_cli_test' || !['localhost', '127.0.0.1'].includes(url.hostname))
  throw new Error('Use the dedicated loopback hub_cli_test database');
let db: Database;
beforeAll(async () => {
  await prepareTestDatabase(connection);
  db = createDatabase(connection);
});
beforeEach(async () => {
  await db.deadLetter.deleteMany();
  await db.transactionOutbox.deleteMany();
});
afterAll(async () => db.$disconnect());
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function producer(add: () => Promise<unknown>) {
  return { add } as unknown as Queue;
}

it('does not record a delayed failure after another producer confirms publication', async () => {
  const entry = await db.transactionOutbox.create({ data: { topic: 'fixture', payload: {} } });
  const entered = gate(),
    released = gate();
  const pending = dispatchOutbox(
    db,
    producer(async () => {
      entered.release();
      await released.promise;
      throw new Error('offline');
    }),
  );
  try {
    await entered.promise;
    expect(
      await dispatchOutbox(
        db,
        producer(async () => undefined),
      ),
    ).toBe(1);
  } finally {
    released.release();
  }
  await pending;
  const saved = await db.transactionOutbox.findUniqueOrThrow({ where: { id: entry.id } });
  expect(saved.publishedAt).not.toBeNull();
  expect(saved.attempts).toBe(0);
  expect(saved.lastError).toBeNull();
});
it('clears a concurrent dead letter when a pending publication succeeds', async () => {
  const entry = await db.transactionOutbox.create({
    data: { topic: 'fixture', payload: {}, attempts: 4 },
  });
  const entered = gate(),
    released = gate();
  const pending = dispatchOutbox(
    db,
    producer(async () => {
      entered.release();
      await released.promise;
    }),
  );
  try {
    await entered.promise;
    await dispatchOutbox(
      db,
      producer(async () => {
        throw new Error('offline');
      }),
    );
    expect(await db.deadLetter.count({ where: { eventId: entry.id } })).toBe(1);
  } finally {
    released.release();
  }
  expect(await pending).toBe(1);
  expect(await db.deadLetter.count({ where: { eventId: entry.id } })).toBe(0);
  expect(
    (await db.transactionOutbox.findUniqueOrThrow({ where: { id: entry.id } })).lastError,
  ).toBeNull();
});
