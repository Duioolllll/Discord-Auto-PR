import { spawn, execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  chatGPTLoginConfirmed,
  codexAuthDirectory,
  codexLoginEnvironment,
  codexVersion,
  fileCredentialArguments,
  lockCodexProfile,
  validateCodexAuthDirectory,
} from '@hub/agent-codex';

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((argument) => !['--status', '--browser'].includes(argument)))
    throw new Error('Use --status or --browser only');
  const statusOnly = arguments_.includes('--status');
  const directory = codexAuthDirectory(process.env.HUB_CODEX_AUTH_DIR);
  if (!statusOnly) await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await validateCodexAuthDirectory(directory, statusOnly);
  } catch {
    console.error(
      'A private worker Codex login profile is required. Run pnpm codex:login to initialize it (directory 0700, auth.json private).',
    );
    return 1;
  }
  const environment = codexLoginEnvironment(directory);
  const executable = process.env.HUB_CODEX_CLI || 'codex';
  const exec = promisify(execFile);
  const release = await lockCodexProfile(directory);
  try {
    let version: string;
    try {
      version = (
        await exec(executable, ['--version'], { env: environment, timeout: 10000, maxBuffer: 8192 })
      ).stdout.trim();
    } catch {
      console.error(`Install Codex CLI ${codexVersion} on the worker or set HUB_CODEX_CLI.`);
      return 1;
    }
    if (version !== `codex-cli ${codexVersion}`) {
      console.error(`Expected Codex CLI ${codexVersion}; refusing an unverified CLI version.`);
      return 1;
    }
    if (statusOnly) {
      let result;
      try {
        const status = await exec(executable, [...fileCredentialArguments, 'login', 'status'], {
          env: environment,
          timeout: 10000,
          maxBuffer: 8192,
        });
        result = { code: 0, output: status.stdout, stderr: status.stderr };
      } catch {
        result = { code: 1, output: '', stderr: '' };
      }
      const loggedIn = chatGPTLoginConfirmed(result);
      console.log(
        loggedIn
          ? 'Codex CLI: ChatGPT login detected. Model access and sandbox readiness still require separate checks.'
          : 'Codex CLI: ChatGPT login not detected. Run pnpm codex:login.',
      );
      return loggedIn ? 0 : 1;
    }
    const stop = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
    console.log(
      'Opening the official Codex CLI login flow for this private worker profile. Keep this profile out of shared environment snapshots.',
    );
    return await new Promise<number>((resolve) => {
      const child = spawn(
        executable,
        [
          ...fileCredentialArguments,
          'login',
          ...(arguments_.includes('--browser') ? [] : ['--device-auth']),
        ],
        { env: environment, stdio: 'inherit', signal: stop.signal },
      );
      child.once('error', () => resolve(1));
      child.once('close', (code) => resolve(code ?? 1));
    });
  } finally {
    await release();
  }
}
process.exitCode = await main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Codex CLI login failed');
  return 1;
});
