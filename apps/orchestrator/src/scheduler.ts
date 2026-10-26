import { setTimeout as delay } from 'node:timers/promises';

export async function runPeriodicTasks(
  tasks: { name: string; intervalMs: number; run: () => Promise<unknown> }[],
  signal: AbortSignal,
  report: (name: string) => void,
) {
  await Promise.all(
    tasks.map(async (task) => {
      while (!signal.aborted) {
        try {
          await task.run();
        } catch {
          report(task.name);
        }
        await delay(task.intervalMs, undefined, { signal }).catch(() => undefined);
      }
    }),
  );
}
