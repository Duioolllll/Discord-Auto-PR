import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

// Moby profiles seccomp/v0.2.4, commit 245180c51918481c0525424b3ee025d2b435d46c.
const baseline = JSON.parse(
  await readFile(new URL('./docker-default.seccomp.json', import.meta.url)),
);
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
if (digest(baseline) !== '4dc1298afa7676147c1320afa42d72691fc55379ae762b392b56853574a7a38a')
  throw new Error('The pinned Moby baseline changed; audit it before regenerating.');
const allow = (names, args, comment) => ({
  names,
  action: 'SCMP_ACT_ALLOW',
  ...(args ? { args } : {}),
  includes: { arches: ['amd64'] },
  comment,
});
const equal = (index, value) => [{ index, value, op: 'SCMP_CMP_EQ' }];
// bwrap raw_clone: require NEWUSER + NEWNS + NEWPID + NEWIPC + NEWNET + SIGCHLD.
const additions = [
  ...[0x78020011].map((flags) =>
    allow(['clone'], equal(0, flags), 'Codex bwrap fresh user/mount/PID/IPC namespaces'),
  ),
  allow(['unshare'], equal(0, 0x10000000), 'bwrap second user namespace for devpts UID mapping'),
  // Exact setup mounts observed with the pinned bundled bwrap.
  ...[0x8c000, 0x4c000, 6, 10, 14, 0xd000, 0xc0edd000].map((flags) =>
    allow(['mount'], equal(3, flags), 'bwrap propagation, tmpfs, devpts, proc or recursive bind'),
  ),
  allow(
    ['mount'],
    [
      {
        index: 3,
        // Only bind-remount; preserve filesystem-specific mount attributes across hosts.
        value:
          (0xffffffff ^
            (1 |
              2 |
              4 |
              8 |
              16 |
              64 |
              128 |
              1024 |
              2048 |
              32768 |
              2097152 |
              16777216 |
              33554432)) >>>
          0,
        valueTwo: 4096 | 32,
        op: 'SCMP_CMP_MASKED_EQ',
      },
    ],
    'bwrap bind remount with inherited filesystem attributes',
  ),
  allow(['pivot_root'], undefined, 'bwrap switches root within its new mount/user namespaces'),
  allow(['umount2'], equal(1, 2), 'bwrap MNT_DETACH cleanup only'),
];
const profile = { ...baseline, syscalls: [...baseline.syscalls, ...additions] };
const destination = new URL('./codex.seccomp.json', import.meta.url);
if (process.argv.includes('--check')) {
  if (JSON.stringify(JSON.parse(await readFile(destination))) !== JSON.stringify(profile))
    throw new Error('Codex seccomp policy differs from its audited generator.');
} else {
  await writeFile(destination, `${JSON.stringify(profile, null, 2)}\n`);
}
console.log(`Codex seccomp SHA-256: ${digest(profile)}`);
