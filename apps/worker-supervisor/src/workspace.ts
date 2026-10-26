import { lstat, mkdir, opendir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { SafePath, type FileChange, type RepositorySnapshot } from '@hub/contracts';
import ignore from 'ignore';

export async function materialize(
  root: string,
  snapshot: RepositorySnapshot,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  await mkdir(root, { recursive: false, mode: 0o700 });
  let bytes = 0;
  const paths = new Set<string>();
  for (const file of snapshot.files) {
    signal?.throwIfAborted();
    const path = SafePath.parse(file.path);
    if (paths.has(path)) throw new Error('Duplicate snapshot path');
    paths.add(path);
    const content = Buffer.from(file.contentBase64, 'base64');
    bytes += content.length;
    if (
      bytes > 5 * 1024 * 1024 ||
      paths.size > 1000 ||
      content.toString('base64') !== file.contentBase64
    )
      throw new Error('Snapshot size/encoding limit');
    const target = resolve(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { flag: 'wx', mode: file.executable ? 0o700 : 0o600, signal });
  }
}

export const workspaceEntryLimit = 2000;

export async function collectChanges(
  root: string,
  original: RepositorySnapshot,
  signal?: AbortSignal,
): Promise<FileChange[]> {
  const deadline = AbortSignal.timeout(30000);
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
  stop.throwIfAborted();
  const before = new Map(original.files.map((file) => [file.path, file]));
  const trackedDirectories = new Set<string>();
  for (const path of before.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) trackedDirectories.add(parts.slice(0, i).join('/'));
  }
  const changes: FileChange[] = [];
  const ignored = ignore().add(['node_modules/', '.next/', '.turbo/', 'dist/', 'coverage/']);
  const gitignore = original.files.find((file) => file.path === '.gitignore');
  if (gitignore) ignored.add(Buffer.from(gitignore.contentBase64, 'base64').toString('utf8'));
  let bytes = 0;
  let count = 0;
  let entries = 0;
  async function walk(path: string) {
    stop.throwIfAborted();
    const directory = await opendir(resolve(root, path));
    for await (const entry of directory) {
      stop.throwIfAborted();
      if (++entries > workspaceEntryLimit) throw new Error('Workspace entry limit');
      const relative = SafePath.parse(path ? `${path}/${entry.name}` : entry.name);
      const target = resolve(root, relative);
      const stat = await lstat(target);
      stop.throwIfAborted();
      const tracked = before.has(relative) || trackedDirectories.has(relative);
      if (!tracked && ignored.ignores(stat.isDirectory() ? `${relative}/` : relative)) continue;
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink > 1)
      )
        throw new Error('Unsupported filesystem entry');
      if (stat.isDirectory()) {
        await walk(relative);
        continue;
      }
      count++;
      bytes += stat.size;
      if (count > 1000 || bytes > 5 * 1024 * 1024 || stat.size > 1024 * 1024)
        throw new Error('Workspace size limit');
      const contentBase64 = (await readFile(target, { signal: stop })).toString('base64');
      stop.throwIfAborted();
      const executable = Boolean(stat.mode & 0o111);
      if (
        before.get(relative)?.contentBase64 !== contentBase64 ||
        Boolean(before.get(relative)?.executable) !== executable
      )
        changes.push({ path: relative, contentBase64, executable });
      before.delete(relative);
    }
  }
  await walk('');
  stop.throwIfAborted();
  for (const path of before.keys()) changes.push({ path, contentBase64: null });
  if (changes.length > 100) throw new Error('Changed-file count limit');
  return changes;
}
