import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runSandbox, codexExecArguments, codexVersion } from '@hub/agent-codex';

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
      { image, workspace: directory, timeoutSeconds: 20, maxOutputBytes: 16384 },
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
