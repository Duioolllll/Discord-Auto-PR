import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import {
  classifyProbeFailure,
  codexSeccompDigest,
  codexSeccompPath,
  policyDigest,
  sandboxArguments,
  validateSeccompPolicy,
  codexSandboxArguments,
  probeDiagnostic,
} from '@hub/agent-codex';

interface Rule {
  names: string[];
  action: string;
  includes?: { caps?: string[]; arches?: string[] };
  excludes?: { caps?: string[]; arches?: string[] };
  args?: { index: number; value: number; valueTwo?: number; op: string }[];
  errnoRet?: number;
}
const baseline = JSON.parse(await readFile('infra/security/docker-default.seccomp.json', 'utf8'));
const profile = JSON.parse(await readFile(codexSeccompPath, 'utf8')) as {
  syscalls: Rule[];
  defaultAction: string;
};
// Independent evaluator for the namespace rules on amd64 with ALL capabilities dropped.
function permitted(name: string, value: number, index = 0) {
  return profile.syscalls.some(
    (rule) =>
      rule.names.includes(name) &&
      rule.action === 'SCMP_ACT_ALLOW' &&
      !rule.includes?.caps?.length &&
      !rule.excludes?.arches?.includes('amd64') &&
      (!rule.includes?.arches || rule.includes.arches.includes('amd64')) &&
      (rule.args ?? []).every(
        (arg) =>
          arg.index === index &&
          (arg.op === 'SCMP_CMP_EQ'
            ? value === arg.value
            : arg.op === 'SCMP_CMP_MASKED_EQ'
              ? (BigInt(value) & BigInt(arg.value)) === BigInt(arg.valueTwo ?? 0)
              : false),
      ),
  );
}

it('retains every pinned Docker rule and exactly the audited namespace additions', () => {
  expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
  expect(profile.syscalls.slice(0, baseline.syscalls.length)).toEqual(baseline.syscalls);
  expect(profile.syscalls.slice(baseline.syscalls.length)).toHaveLength(12);
  expect(
    new Set(profile.syscalls.slice(baseline.syscalls.length).flatMap((rule) => rule.names)),
  ).toEqual(new Set(['clone', 'unshare', 'mount', 'pivot_root', 'umount2']));
  expect(policyDigest(profile)).toBe(codexSeccompDigest);
  expect(
    execFileSync(process.execPath, ['infra/security/generate-seccomp.mjs', '--check'], {
      encoding: 'utf8',
    }),
  ).toContain(codexSeccompDigest);
});
it('allows only the bwrap namespace clone combinations, preserving normal threads', () => {
  for (const value of [0, 0x11, 0x78020011]) expect(permitted('clone', value)).toBe(true);
  for (const value of [0x20011, 0x38020011, 0x28020011, 0x7a020011, 0x10000011, 0x38020000])
    expect(permitted('clone', value)).toBe(false);
  expect(permitted('unshare', 0x10000000)).toBe(true);
  for (const value of [0, 0x20000, 0x20000000, 0x12000000, 0x78020000])
    expect(permitted('unshare', value)).toBe(false);
  expect(permitted('setns', 0x10000000, 1)).toBe(false);
  expect(permitted('clone3', 0)).toBe(false);
  expect(
    profile.syscalls.find(
      (rule) => rule.names.includes('clone3') && rule.action === 'SCMP_ACT_ERRNO',
    ),
  ).toMatchObject({ errnoRet: 38 });
});
it('restricts mount flags and lazy unmount, and keeps unrelated privileged syscalls denied', () => {
  for (const value of [
    6,
    10,
    14,
    0xd000,
    0xc0edd000,
    0x8c000,
    0x4c000,
    4096 | 32 | 1 | 2 | 4 | 32768 | 2097152,
  ])
    expect(permitted('mount', value, 3)).toBe(true);
  for (const value of [0, 8192, 4096, 0x100000]) expect(permitted('mount', value, 3)).toBe(false);
  expect(permitted('umount2', 2, 1)).toBe(true);
  expect(permitted('umount2', 0, 1)).toBe(false);
  for (const name of ['bpf', 'perf_event_open', 'keyctl', 'open_by_handle_at', 'reboot'])
    expect(permitted(name, 0)).toBe(false);
});
it('fails closed for absent, invalid, weakened or symbolic-link profiles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hub-policy-unit-'));
  try {
    for (const data of [
      'not JSON',
      '{}',
      JSON.stringify({ ...profile, defaultAction: 'SCMP_ACT_ALLOW' }),
    ]) {
      const path = join(directory, 'invalid.json');
      await writeFile(path, data);
      await expect(validateSeccompPolicy(path)).rejects.toMatchObject({
        reason: 'SECCOMP_POLICY_INVALID',
      });
    }
    await expect(validateSeccompPolicy(join(directory, 'missing.json'))).rejects.toMatchObject({
      reason: 'SECCOMP_POLICY_INVALID',
    });
    const { symlink } = await import('node:fs/promises');
    await symlink(codexSeccompPath, join(directory, 'link.json'));
    await expect(validateSeccompPolicy(join(directory, 'link.json'))).rejects.toMatchObject({
      reason: 'SECCOMP_POLICY_INVALID',
    });
    await expect(validateSeccompPolicy(codexSeccompPath)).resolves.toBe(JSON.stringify(profile));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('uses the fixed profile only for Codex and leaves ordinary verifiers on Docker defaults', () => {
  const options = {
    image: `sha256:${'a'.repeat(64)}`,
    workspace: '/tmp/isolated',
    timeoutSeconds: 10,
    maxOutputBytes: 4096,
  };
  const verifier = sandboxArguments('test', options, ['node', '--version']);
  const agent = sandboxArguments('test', { ...options, seccompProfilePath: codexSeccompPath }, [
    'codex',
    '--version',
  ]);
  expect(verifier.some((arg) => arg.startsWith('seccomp='))).toBe(false);
  expect(agent).toContain(`seccomp=${codexSeccompPath}`);
  expect(agent[0]).toBe('create');
  expect(agent).toContain('--pull=never');
  expect(agent).not.toContain('--privileged');
  expect(agent).not.toContain('seccomp=unconfined');
  expect(() =>
    sandboxArguments('test', { ...options, seccompProfilePath: 'unconfined' }, []),
  ).toThrow();
  expect(codexSandboxArguments(['node', '--version']).slice(0, 2)).toEqual(['codex', 'sandbox']);
});
it('classifies stderr without returning supplied text or credentials', () => {
  expect(classifyProbeFailure('bwrap: No permissions to create a new namespace')).toBe(
    'NAMESPACE_SANDBOX_UNAVAILABLE',
  );
  expect(classifyProbeFailure('CODEX_HOME_UNAVAILABLE')).toBe('CODEX_HOME_UNAVAILABLE');
  expect(classifyProbeFailure('private diagnostic must not be returned')).toBe(
    'SANDBOX_PROCESS_FAILED',
  );
  expect(probeDiagnostic('HUB_PROBE_OUTER_SWAP')).toBe('OUTER_SWAP');
  expect(probeDiagnostic('HUB_PROBE_secret-value')).toBe('ISOLATION_PROBE_FAILED');
  const denied = "bwrap: Can't make / slave: Permission denied";
  expect(classifyProbeFailure(denied)).toBe('NAMESPACE_SANDBOX_UNAVAILABLE');
  expect(probeDiagnostic(denied)).toBe('BWRAP_MOUNT_DENIED');
});
