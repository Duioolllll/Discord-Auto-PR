import { createHash } from 'node:crypto';
import { mkdir, readFile, copyFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import toolchain from '../toolchain.json' with { type: 'json' };

if (process.platform !== 'linux' || process.arch !== 'x64')
  throw new Error('The pinned runner currently supports Linux x64 only');
const context = resolve('.local/runner-context', toolchain.codex);
await mkdir(context, { recursive: true });
const tar = join(context, 'codex-native.tgz');
const expected = toolchain.codexLinuxX64Integrity;
try {
  await access(tar);
} catch {
  const pack = spawnSync(
    'npm',
    ['pack', `@openai/codex@${toolchain.codex}-linux-x64`, '--pack-destination', context, '--json'],
    { encoding: 'utf8' },
  );
  if (pack.status !== 0) throw new Error('Failed to download the pinned Codex npm artifact');
  const metadata = JSON.parse(pack.stdout) as { filename: string; integrity: string }[];
  if (metadata[0]?.integrity !== expected || !metadata[0].filename.startsWith('openai-codex-'))
    throw new Error('Codex registry integrity mismatch');
  await copyFile(join(context, metadata[0].filename), tar);
}
if (
  `sha512-${createHash('sha512')
    .update(await readFile(tar))
    .digest('base64')}` !== expected
)
  throw new Error('Codex artifact checksum mismatch; refusing to build');
const build = spawnSync(
  'docker',
  [
    'build',
    '--network=none',
    '-f',
    resolve('infra/docker/codex.Dockerfile'),
    '-t',
    `hub-codex:${toolchain.codex}`,
    context,
  ],
  { stdio: 'inherit' },
);
if (build.error) throw build.error;
process.exit(build.status ?? 1);
