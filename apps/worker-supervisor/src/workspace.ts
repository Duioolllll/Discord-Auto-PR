import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { SafePath, type FileChange, type RepositorySnapshot } from '@hub/contracts';
import ignore from 'ignore';

export async function materialize(root: string, snapshot: RepositorySnapshot) {
  await mkdir(root, { recursive: false, mode: 0o700 });
  let bytes = 0;
  const paths = new Set<string>();
  for (const file of snapshot.files) {
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
    await writeFile(target, content, { flag: 'wx', mode: file.executable ? 0o700 : 0o600 });
  }
}

export async function collectChanges(
  root: string,
  original: RepositorySnapshot,
): Promise<FileChange[]> {
  const before = new Map(original.files.map((file) => [file.path, file]));
  const changes: FileChange[] = [];
  const ignored = ignore().add(['node_modules/', '.next/', '.turbo/', 'dist/', 'coverage/']);
  const gitignore = original.files.find((file) => file.path === '.gitignore');
  if (gitignore) ignored.add(Buffer.from(gitignore.contentBase64, 'base64').toString('utf8'));
  let bytes = 0;
  let count = 0;
  async function walk(path: string) {
    for (const name of await readdir(resolve(root, path))) {
      const relative = SafePath.parse(path ? `${path}/${name}` : name);
      const target = resolve(root, relative);
      const stat = await lstat(target);
      const tracked =
        before.has(relative) || [...before.keys()].some((key) => key.startsWith(`${relative}/`));
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
      const contentBase64 = (await readFile(target)).toString('base64');
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
  for (const path of before.keys()) changes.push({ path, contentBase64: null });
  if (changes.length > 100) throw new Error('Changed-file count limit');
  return changes;
}
