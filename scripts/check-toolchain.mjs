import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { URL } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const pins = JSON.parse(await read('toolchain.json'));
const pkg = JSON.parse(await read('package.json'));
assert.equal((await read('.node-version')).trim(), pins.node, 'Node CI pin differs');
assert.equal(
  pkg.engines.node,
  `>=${pins.node} <${Number(pins.node.split('.')[0]) + 1}`,
  'Node engine range differs',
);
assert.equal(pkg.packageManager, `pnpm@${pins.pnpm}`, 'pnpm pin differs');
assert.match(pins.codex, /^\d+\.\d+\.\d+$/, 'Codex must be a stable release');
assert.match(pins.nodeLinuxX64Sha256, /^[a-f0-9]{64}$/, 'Node distribution integrity missing');
assert.match(
  pins.codexLinuxX64Integrity,
  /^sha512-[A-Za-z0-9+/]{86}==$/,
  'Codex integrity missing',
);
assert.ok(pins.nodeImage.startsWith(`node:${pins.node}-bookworm-slim@sha256:`));
assert.match(pins.nodeImage, /^node:\d+\.\d+\.\d+-bookworm-slim@sha256:[a-f0-9]{64}$/);
const dockerfile = await read('infra/docker/codex.Dockerfile');
assert.equal(dockerfile.split('\n').filter((line) => line.startsWith('FROM ')).length, 2);
assert.ok(
  dockerfile
    .split('\n')
    .filter((line) => line.startsWith('FROM '))
    .every(
      (line) => line === `FROM ${pins.nodeImage}` || line === `FROM ${pins.nodeImage} AS unpack`,
    ),
  'Runner base image differs',
);
assert.ok(
  (await read('.github/workflows/ci.yml')).includes(`docker pull ${pins.nodeImage}`),
  'CI test image differs',
);
const actual = process.versions.node.split('.').map(Number);
const minimum = pins.node.split('.').map(Number);
assert.ok(
  actual[0] === minimum[0] &&
    (actual[1] > minimum[1] || (actual[1] === minimum[1] && actual[2] >= minimum[2])),
  `Use Node ${pins.node} LTS or a newer patch in the same major`,
);
const manager = execFileSync('pnpm', ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim();
assert.equal(manager, pins.pnpm, 'Use the project-pinned pnpm via Corepack');
console.log(
  `Toolchain OK: Node ${process.versions.node} LTS, pnpm ${pins.pnpm}, Codex stable ${pins.codex}`,
);
