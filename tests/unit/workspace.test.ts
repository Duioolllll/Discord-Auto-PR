import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  collectChanges,
  materialize,
  workspaceEntryLimit,
} from '../../apps/worker-supervisor/src/workspace.js';

const roots: string[] = [];
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'hub-workspace-test-'));
  roots.push(root);
  return root;
}
const empty = { baseSha: 'a'.repeat(40), files: [] };
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('keeps tracked ignored files and drops untracked generated files', async () => {
  const root = join(await temporary(), 'job');
  const original = {
    ...empty,
    files: [
      { path: 'dist/tracked.js', contentBase64: Buffer.from('before').toString('base64') },
      { path: 'removed.txt', contentBase64: Buffer.from('removed').toString('base64') },
    ],
  };
  await materialize(root, original);
  await writeFile(join(root, 'dist/tracked.js'), 'after');
  await writeFile(join(root, 'dist/generated.js'), 'ignore');
  await rm(join(root, 'removed.txt'));
  expect(await collectChanges(root, original)).toEqual([
    {
      path: 'dist/tracked.js',
      contentBase64: Buffer.from('after').toString('base64'),
      executable: false,
    },
    { path: 'removed.txt', contentBase64: null },
  ]);
});
it('counts empty directories in the traversal budget', async () => {
  const root = await temporary();
  for (let offset = 0; offset <= workspaceEntryLimit; offset += 100)
    await Promise.all(
      Array.from({ length: Math.min(100, workspaceEntryLimit + 1 - offset) }, (_, i) =>
        mkdir(join(root, `d-${offset + i}`)),
      ),
    );
  await expect(collectChanges(root, empty)).rejects.toThrow('Workspace entry limit');
});
it('rejects symlink cycles without following them', async () => {
  const root = await temporary();
  await symlink(root, join(root, 'cycle'));
  await expect(collectChanges(root, empty)).rejects.toThrow('Unsupported filesystem entry');
});
it('honors cancellation before materialization and during recursive collection', async () => {
  const root = await temporary();
  const stopped = new AbortController();
  stopped.abort();
  await expect(materialize(join(root, 'never-created'), empty, stopped.signal)).rejects.toThrow();
  for (let i = 0; i < 100; i++) await writeFile(join(root, `f-${i}`), 'fixture');
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 1);
  try {
    await expect(collectChanges(root, empty, stop.signal)).rejects.toThrow();
  } finally {
    clearTimeout(timer);
  }
});
it('reports inaccessible directories for the supervisor to quarantine', async () => {
  const root = await temporary();
  const locked = join(root, 'locked');
  await mkdir(locked);
  await writeFile(join(locked, 'fixture'), 'fixture');
  await chmod(locked, 0);
  try {
    await expect(collectChanges(root, empty)).rejects.toHaveProperty('code', 'EACCES');
  } finally {
    await chmod(locked, 0o700);
  }
});
