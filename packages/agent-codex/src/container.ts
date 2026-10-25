import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertSeparateProfile, validateCodexAuthDirectory } from './auth.js';

const exec = promisify(execFile);
export const codexSeccompPath = fileURLToPath(
  new URL('../../../infra/security/codex.seccomp.json', import.meta.url),
);
export const codexSeccompDigest =
  '222c2fe09326c903267c96c71c99535f395a95caf2956c74dbe6eb22103eb26e';
export const codexAppArmorProfile = 'discord-hub-codex-v1';
export type ProbeReason =
  | 'CODEX_VERSION_MISMATCH'
  | 'CODEX_HOME_UNAVAILABLE'
  | 'NAMESPACE_SANDBOX_UNAVAILABLE'
  | 'SECCOMP_POLICY_INVALID'
  | 'SANDBOX_PROCESS_FAILED'
  | 'SANDBOX_OUTPUT_MISMATCH'
  | 'RUNNER_PROBE_FAILED';

export class RunnerFailure extends Error {
  constructor(
    readonly reason: ProbeReason,
    readonly diagnostic: string,
  ) {
    super(`${reason}: ${diagnostic}`);
  }
}

export interface SandboxOptions {
  image: string;
  workspace: string;
  network?: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
  env?: Record<string, string>;
  codexAuthDirectory?: string;
  // Omit for ordinary verification containers, which retain Docker's default seccomp.
  seccompProfilePath?: string;
  apparmorProfile?: string;
}

export function policyDigest(profile: unknown) {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}

export async function validateSeccompPolicy(path: string) {
  try {
    if (!isAbsolute(path)) throw new Error();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > 131072) throw new Error();
      const profile: unknown = JSON.parse(await file.readFile('utf8'));
      if (policyDigest(profile) !== codexSeccompDigest) throw new Error();
      return JSON.stringify(profile);
    } finally {
      await file.close();
    }
  } catch {
    throw new RunnerFailure('SECCOMP_POLICY_INVALID', 'MISSING_OR_UNAPPROVED_PROFILE');
  }
}

export async function verifyRunnerImage(image: string) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image))
    throw new RunnerFailure('RUNNER_PROBE_FAILED', 'IMMUTABLE_IMAGE_ID_REQUIRED');
  try {
    const result = await exec(
      'docker',
      [
        'image',
        'inspect',
        image,
        '--format',
        '{"id":{{json .Id}},"os":{{json .Os}},"arch":{{json .Architecture}}}',
      ],
      { timeout: 10000, maxBuffer: 8192 },
    );
    const metadata = JSON.parse(result.stdout) as { id: string; os: string; arch: string };
    if (metadata.id !== image || metadata.os !== 'linux' || metadata.arch !== 'amd64')
      throw new Error();
  } catch {
    throw new RunnerFailure('RUNNER_PROBE_FAILED', 'IMAGE_INTEGRITY_OR_PLATFORM_INVALID');
  }
}

export function sandboxArguments(name: string, options: SandboxOptions, command: string[]) {
  if (!/^sha256:[a-f0-9]{64}$/.test(options.image))
    throw new Error('Runner image must be an immutable local sha256 image ID');
  if (
    options.network &&
    options.network !== 'none' &&
    !/^hub-egress-[a-z0-9-]+$/.test(options.network)
  )
    throw new Error('Runner network must be an operator-provisioned hub-egress-* network');
  const uid = process.getuid?.() ?? 0;
  if (uid === 0) throw new Error('Worker supervisor must run as a non-root user');
  if (
    !Number.isFinite(options.timeoutSeconds) ||
    options.timeoutSeconds <= 0 ||
    !Number.isSafeInteger(options.maxOutputBytes) ||
    options.maxOutputBytes < 1
  )
    throw new Error('Invalid runner limits');
  const workspace = resolve(options.workspace);
  if (/[\n\r,\0]/.test(workspace)) throw new Error('Invalid workspace path');
  if (Object.keys(options.env ?? {}).some((key) => key !== 'CODEX_API_KEY'))
    throw new Error('Only explicit Codex API authentication can be passed to the container');
  if (options.seccompProfilePath && !isAbsolute(options.seccompProfilePath))
    throw new RunnerFailure('SECCOMP_POLICY_INVALID', 'ABSOLUTE_PROFILE_PATH_REQUIRED');
  if (
    options.apparmorProfile &&
    (!options.seccompProfilePath || options.apparmorProfile !== codexAppArmorProfile)
  )
    throw new RunnerFailure('NAMESPACE_SANDBOX_UNAVAILABLE', 'UNAPPROVED_APPARMOR_PROFILE');
  if (options.codexAuthDirectory) {
    if (!isAbsolute(options.codexAuthDirectory) || /[\n\r,\0]/.test(options.codexAuthDirectory))
      throw new Error('Invalid Codex authentication directory');
    assertSeparateProfile(options.codexAuthDirectory, workspace);
  }
  return [
    'create',
    '--rm',
    '-i',
    '--pull=never',
    '--label',
    'io.discord-ai-pr-hub.runner=1',
    '--name',
    name,
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    ...(options.seccompProfilePath
      ? ['--security-opt', `seccomp=${options.seccompProfilePath}`]
      : []),
    ...(options.apparmorProfile ? ['--security-opt', `apparmor=${options.apparmorProfile}`] : []),
    '--user',
    `${uid}:${process.getgid?.() ?? 1000}`,
    '--pids-limit=128',
    '--memory=1g',
    '--memory-swap=1g',
    '--cpus=1',
    '--network',
    options.network ?? 'none',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=134217728,mode=1777',
    '--mount',
    `type=bind,source=${workspace},target=/workspace`,
    '--workdir',
    '/workspace',
    '--tmpfs',
    `/home/runner:rw,nosuid,nodev,size=67108864,uid=${uid},gid=${process.getgid?.() ?? 1000},mode=700`,
    '--env',
    'HOME=/home/runner',
    '--env',
    'CODEX_HOME=/home/runner/.codex',
    '--env',
    'NPM_CONFIG_CACHE=/tmp/npm',
    ...(options.codexAuthDirectory
      ? ['--mount', `type=bind,source=${options.codexAuthDirectory},target=/home/runner/.codex`]
      : []),
    ...Object.keys(options.env ?? {}).flatMap((key) => ['--env', key]),
    options.image,
    ...command,
  ];
}

async function inspectContainer(name: string, options: SandboxOptions) {
  // Never inspect Config.Env: the explicit API key, when used, is stored there by Docker.
  const result = await exec(
    'docker',
    [
      'container',
      'inspect',
      '--format',
      '{"user":{{json .Config.User}},"image":{{json .Image}},"apparmor":{{json .AppArmorProfile}},"host":{{json .HostConfig}},"mounts":{{json .Mounts}}}',
      name,
    ],
    { timeout: 10000, maxBuffer: 131072 },
  );
  const spec = JSON.parse(result.stdout) as {
    user: string;
    image: string;
    apparmor: string;
    host: {
      ReadonlyRootfs: boolean;
      Privileged: boolean;
      CapAdd: string[] | null;
      CapDrop: string[];
      PidsLimit: number;
      Memory: number;
      MemorySwap: number;
      NanoCpus: number;
      NetworkMode: string;
      PidMode: string;
      SecurityOpt: string[];
      AutoRemove: boolean;
      Tmpfs: Record<string, string>;
    };
    mounts: { Type: string; Source: string; Destination: string; RW: boolean }[];
  };
  const h = spec.host;
  const allowedBinds = new Map([['/workspace', options.workspace]]);
  if (options.codexAuthDirectory)
    allowedBinds.set('/home/runner/.codex', options.codexAuthDirectory);
  const binds = spec.mounts.filter((mount) => mount.Type === 'bind');
  if (
    spec.image !== options.image ||
    spec.user !== `${process.getuid?.()}:${process.getgid?.()}` ||
    !h.ReadonlyRootfs ||
    h.Privileged ||
    (h.CapAdd?.length ?? 0) !== 0 ||
    h.CapDrop.length !== 1 ||
    h.CapDrop[0] !== 'ALL' ||
    h.PidsLimit !== 128 ||
    h.Memory !== 1073741824 ||
    h.MemorySwap !== 1073741824 ||
    h.NanoCpus !== 1000000000 ||
    h.NetworkMode !== (options.network ?? 'none') ||
    h.PidMode !== '' ||
    !h.AutoRemove ||
    !h.SecurityOpt.some((option) => /^no-new-privileges(?::true)?$/.test(option)) ||
    !h.Tmpfs['/home/runner'] ||
    !h.Tmpfs['/tmp'] ||
    binds.length !== allowedBinds.size ||
    binds.some((mount) => allowedBinds.get(mount.Destination) !== mount.Source || !mount.RW)
  )
    throw new RunnerFailure('RUNNER_PROBE_FAILED', 'CONTAINER_GUARDS_NOT_APPLIED');
  const seccomp = h.SecurityOpt.filter((option) => option.startsWith('seccomp='));
  const apparmor = h.SecurityOpt.filter((option) => option.startsWith('apparmor='));
  if (options.apparmorProfile) {
    if (
      spec.apparmor !== codexAppArmorProfile ||
      apparmor.length !== 1 ||
      apparmor[0] !== `apparmor=${codexAppArmorProfile}`
    )
      throw new RunnerFailure('NAMESPACE_SANDBOX_UNAVAILABLE', 'APPARMOR_PROFILE_NOT_APPLIED');
  } else if (apparmor.length) {
    throw new RunnerFailure('NAMESPACE_SANDBOX_UNAVAILABLE', 'UNEXPECTED_APPARMOR_OVERRIDE');
  }
  if (options.seccompProfilePath) {
    try {
      if (
        seccomp.length !== 1 ||
        policyDigest(JSON.parse(seccomp[0]!.slice(8))) !== codexSeccompDigest
      )
        throw new Error();
    } catch {
      throw new RunnerFailure('SECCOMP_POLICY_INVALID', 'DOCKER_POLICY_MISMATCH');
    }
  } else if (seccomp.length) {
    throw new RunnerFailure('SECCOMP_POLICY_INVALID', 'VERIFIER_REQUIRES_DOCKER_DEFAULT');
  }
}

async function removeContainer(name: string) {
  try {
    await exec('docker', ['rm', '-f', name], { timeout: 10000, maxBuffer: 8192 });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'stderr' in error &&
      typeof error.stderr === 'string' &&
      /No such (?:container|object):/.test(error.stderr)
    )
      return;
    throw new RunnerFailure('RUNNER_PROBE_FAILED', 'CONTAINER_CLEANUP_FAILED');
  }
}

export async function runSandbox(
  options: SandboxOptions,
  command: string[],
  input: string,
  signal: AbortSignal,
) {
  const workspace = await realpath(options.workspace);
  options = {
    ...options,
    workspace,
    apparmorProfile: options.seccompProfilePath
      ? (options.apparmorProfile ?? process.env.HUB_CODEX_APPARMOR_PROFILE?.trim()) || undefined
      : options.apparmorProfile,
  };
  if (options.codexAuthDirectory) {
    const directory = await validateCodexAuthDirectory(options.codexAuthDirectory);
    assertSeparateProfile(directory, workspace);
    options.codexAuthDirectory = directory;
  }
  const name = `hub-${randomUUID()}`;
  const stop = new AbortController();
  const combined = AbortSignal.any([
    signal,
    stop.signal,
    AbortSignal.timeout(options.timeoutSeconds * 1000),
  ]);
  let snapshot: string | undefined;
  let attemptedCreate = false;
  let exceeded = false;
  try {
    if (options.seccompProfilePath) {
      const contents = await validateSeccompPolicy(options.seccompProfilePath);
      snapshot = await mkdtemp(join(tmpdir(), 'hub-seccomp-'));
      const path = join(snapshot, 'profile.json');
      await writeFile(path, contents, { mode: 0o600, flag: 'wx' });
      options.seccompProfilePath = path;
    }
    const args = sandboxArguments(name, options, command);
    await verifyRunnerImage(options.image);
    if (combined.aborted) throw new Error();
    attemptedCreate = true;
    try {
      await exec('docker', args, {
        env: { ...process.env, ...options.env },
        signal: combined,
        timeout: 15000,
        maxBuffer: 16384,
      });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'stderr' in error &&
        typeof error.stderr === 'string' &&
        /apparmor/i.test(error.stderr)
      )
        throw new RunnerFailure('NAMESPACE_SANDBOX_UNAVAILABLE', 'APPARMOR_PROFILE_UNAVAILABLE');
      if (
        error &&
        typeof error === 'object' &&
        'stderr' in error &&
        typeof error.stderr === 'string' &&
        /seccomp|BPF|filter.*(?:load|install)/i.test(error.stderr)
      )
        throw new RunnerFailure('SECCOMP_POLICY_INVALID', 'DOCKER_REJECTED_PROFILE');
      throw error;
    }
    await inspectContainer(name, options);
    if (combined.aborted)
      throw new RunnerFailure('RUNNER_PROBE_FAILED', signal.aborted ? 'CANCELLED' : 'TIMEOUT');
    const output: Buffer[] = [];
    const stderr: Buffer[] = [];
    let total = 0;
    const code = await new Promise<number>((resolveResult, reject) => {
      const child = spawn('docker', ['start', '--attach', '--interactive', name], {
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: combined,
      });
      const append = (chunk: Buffer, target: Buffer[]) => {
        total += chunk.length;
        if (total > options.maxOutputBytes) {
          exceeded = true;
          stop.abort();
          return;
        }
        target.push(chunk);
      };
      child.stdout.on('data', (chunk: Buffer) => append(chunk, output));
      child.stderr.on('data', (chunk: Buffer) => append(chunk, stderr));
      child.once('error', reject);
      child.once('close', (code) => resolveResult(code ?? 1));
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    });
    return {
      code,
      output: Buffer.concat(output).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    };
  } catch (error) {
    if (error instanceof RunnerFailure) throw error;
    throw new RunnerFailure(
      'RUNNER_PROBE_FAILED',
      exceeded
        ? 'OUTPUT_LIMIT_EXCEEDED'
        : signal.aborted
          ? 'CANCELLED'
          : combined.aborted
            ? 'TIMEOUT'
            : 'DOCKER_EXECUTION_FAILED',
    );
  } finally {
    try {
      if (attemptedCreate) await removeContainer(name);
    } finally {
      if (snapshot) await rm(snapshot, { recursive: true, force: true });
    }
  }
}
