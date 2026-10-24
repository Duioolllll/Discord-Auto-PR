import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  runSandbox,
  codexExecArguments,
  codexVersion,
  checkCodexSandbox,
  codexSeccompPath,
  codexSandboxArguments,
} from '@hub/agent-codex';

const codexImage = () =>
  execFileSync('docker', ['image', 'inspect', `hub-codex:${codexVersion}`, '--format', '{{.Id}}'], {
    encoding: 'utf8',
  }).trim();
const containers = () =>
  execFileSync('docker', ['ps', '-aq', '--filter', 'label=io.discord-ai-pr-hub.runner=1'], {
    encoding: 'utf8',
  }).trim();

it('passes the actual nested Codex security probe without model access or credentials', async () => {
  const before = containers();
  expect(await checkCodexSandbox(codexImage())).toEqual({ ready: true, reason: 'OK' });
  expect(containers()).toBe(before);
}, 60000);

it('keeps clone3, setns and unrelated privileged kernel interfaces blocked', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hub-syscall-probe-'));
  try {
    execFileSync('cc', [
      '-static',
      '-O2',
      'tests/fixtures/seccomp-probe.c',
      '-o',
      join(workspace, 'probe'),
    ]);
    const result = await runSandbox(
      {
        image: codexImage(),
        workspace,
        seccompProfilePath: codexSeccompPath,
        timeoutSeconds: 15,
        maxOutputBytes: 4096,
      },
      ['/workspace/probe'],
      '',
      new AbortController().signal,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toEqual({
      clone3: 38,
      setns: 1,
      unshare: 1,
      bpf: 1,
      keyctl: 1,
      vsock: 1,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}, 30000);

it('masks only the explicit login from sandbox commands and keeps API keys out of subprocesses', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hub-auth-mask-workspace-'));
  const profile = await mkdtemp(join(tmpdir(), 'hub-auth-mask-profile-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(profile, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'fixture-access',
          refresh_token: 'fixture-refresh',
          id_token: 'fixture-id',
        },
      }),
      { mode: 0o600 },
    );
    const result = await runSandbox(
      {
        image: codexImage(),
        workspace,
        codexAuthDirectory: profile,
        seccompProfilePath: codexSeccompPath,
        env: { CODEX_API_KEY: 'fixture-key' },
        timeoutSeconds: 20,
        maxOutputBytes: 4096,
      },
      codexSandboxArguments([
        'node',
        '-e',
        `const fs=require('node:fs');require('node:assert/strict').throws(()=>fs.readFileSync('/home/runner/.codex/auth.json'));require('node:assert/strict').equal(process.env.CODEX_API_KEY,undefined);fs.writeSync(1,'credentials-isolated');`,
      ]),
      '',
      new AbortController().signal,
    );
    expect(result.code).toBe(0);
    expect(result.output).toBe('credentials-isolated');
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(workspace)).toEqual([]);
    expect(await readFile(join(profile, 'auth.json'), 'utf8')).not.toContain(
      'credentials-isolated',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  }
}, 30000);

it('removes timed-out and output-limited containers, including stopped containers', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hub-cleanup-probe-'));
  const before = containers();
  try {
    const options = {
      image: codexImage(),
      workspace,
      seccompProfilePath: codexSeccompPath,
      timeoutSeconds: 8,
      maxOutputBytes: 1024,
    };
    await expect(
      runSandbox(
        options,
        [
          'node',
          '-e',
          `require('node:fs').writeFileSync('/workspace/started','yes');setInterval(()=>{},1000);`,
        ],
        '',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ diagnostic: 'TIMEOUT' });
    expect(await readFile(join(workspace, 'started'), 'utf8')).toBe('yes');
    expect(containers()).toBe(before);
    await expect(
      runSandbox(
        { ...options, timeoutSeconds: 15 },
        ['node', '-e', `process.stdout.write('x'.repeat(65536));setInterval(()=>{},1000);`],
        '',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ diagnostic: 'OUTPUT_LIMIT_EXCEEDED' });
    expect(containers()).toBe(before);
    const failure = await runSandbox(
      options,
      ['node', '-e', 'process.exit(7)'],
      '',
      new AbortController().signal,
    );
    expect(failure.code).toBe(7);
    expect(containers()).toBe(before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}, 30000);

it('creates no container when the seccomp profile is missing or changed', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hub-invalid-policy-'));
  const before = containers();
  try {
    const { writeFile } = await import('node:fs/promises');
    const bad = join(workspace, 'bad.json');
    await writeFile(bad, JSON.stringify({ defaultAction: 'SCMP_ACT_ALLOW', syscalls: [] }));
    for (const path of [join(workspace, 'missing.json'), bad])
      await expect(
        runSandbox(
          {
            image: codexImage(),
            workspace,
            seccompProfilePath: path,
            timeoutSeconds: 10,
            maxOutputBytes: 1024,
          },
          ['node', '--version'],
          '',
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ reason: 'SECCOMP_POLICY_INVALID' });
    expect(containers()).toBe(before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}, 30000);

it('enforces real Docker isolation while permitting workspace output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hub-sandbox-'));
  try {
    const image = execFileSync(
      'docker',
      [
        'image',
        'inspect',
        'node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df',
        '--format',
        '{{.Id}}',
      ],
      { encoding: 'utf8' },
    ).trim();
    const script = `const fs=require('node:fs');let denied=false;try{fs.writeFileSync('/etc/hub-probe','x')}catch{denied=true}fs.writeFileSync('/workspace/result.txt','sandbox-result');console.log(JSON.stringify({uid:process.getuid(),denied,network:Object.keys(require('node:os').networkInterfaces()),memory:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim()}));`;
    const result = await runSandbox(
      { image, workspace: directory, timeoutSeconds: 10, maxOutputBytes: 4096 },
      ['node', '-e', script],
      '',
      new AbortController().signal,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      denied: true,
      network: ['lo'],
      memory: '1073741824',
    });
    expect(JSON.parse(result.output).uid).not.toBe(0);
    expect(await readFile(join(directory, 'result.txt'), 'utf8')).toBe('sandbox-result');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

it('accepts the generated exec argv in the actual pinned Codex CLI without a model call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hub-codex-argv-'));
  try {
    const image = execFileSync(
      'docker',
      ['image', 'inspect', `hub-codex:${codexVersion}`, '--format', '{{.Id}}'],
      { encoding: 'utf8' },
    ).trim();
    const result = await runSandbox(
      {
        image,
        workspace: directory,
        timeoutSeconds: 20,
        maxOutputBytes: 16384,
        seccompProfilePath: codexSeccompPath,
      },
      [...codexExecArguments(), '--help'],
      '',
      new AbortController().signal,
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain('Run Codex non-interactively');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

it('mounts only the explicit CLI profile for token refresh and excludes it from test containers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hub-auth-container-'));
  const workspace = await mkdtemp(join(tmpdir(), 'hub-auth-workspace-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(directory, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'fixture-access',
          refresh_token: 'fixture-refresh',
          id_token: 'fixture-id',
        },
      }),
      { mode: 0o600 },
    );
    const image = execFileSync(
      'docker',
      [
        'image',
        'inspect',
        'node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df',
        '--format',
        '{{.Id}}',
      ],
      { encoding: 'utf8' },
    ).trim();
    const command = [
      'node',
      '-e',
      `const fs=require('node:fs');const auth=fs.existsSync('/home/runner/.codex/auth.json');if(auth)fs.writeFileSync('/home/runner/.codex/refresh-marker','fixture refresh');console.log(JSON.stringify({auth,key:process.env.CODEX_API_KEY!==undefined}));`,
    ];
    const withLogin = await runSandbox(
      { image, workspace, codexAuthDirectory: directory, timeoutSeconds: 10, maxOutputBytes: 4096 },
      command,
      '',
      new AbortController().signal,
    );
    expect(withLogin.code).toBe(0);
    expect(JSON.parse(withLogin.output)).toEqual({ auth: true, key: false });
    expect(await readFile(join(directory, 'refresh-marker'), 'utf8')).toBe('fixture refresh');
    const verification = await runSandbox(
      { image, workspace, timeoutSeconds: 10, maxOutputBytes: 4096 },
      command,
      '',
      new AbortController().signal,
    );
    expect(verification.code).toBe(0);
    expect(JSON.parse(verification.output)).toEqual({ auth: false, key: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}, 30000);
