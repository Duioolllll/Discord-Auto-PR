import { WorkerClient } from './client.js';
import {
  CodexAdapter,
  runSandbox,
  codexAuthDirectory,
  lockCodexProfile,
  validateCodexAuthDirectory,
} from '@hub/agent-codex';
import { supervise } from './supervisor.js';
import { resolve } from 'node:path';

const { CONTROL_API_URL, WORKER_ENROLLMENT_TOKEN } = process.env;
if (!CONTROL_API_URL || !WORKER_ENROLLMENT_TOKEN)
  throw new Error('CONTROL_API_URL and WORKER_ENROLLMENT_TOKEN required');
if (!process.argv.includes('--probe')) {
  const root = resolve(process.env.WORKER_ROOT ?? '.local/jobs');
  const { HUB_CODEX_IMAGE, HUB_RUNNER_NETWORK } = process.env;
  let directory: string;
  try {
    directory = await validateCodexAuthDirectory(
      codexAuthDirectory(process.env.HUB_CODEX_AUTH_DIR),
    );
  } catch {
    throw new Error(
      'Codex CLI ChatGPT login required. Run pnpm codex:login on the worker and use a private HUB_CODEX_AUTH_DIR.',
    );
  }
  const testCommand = JSON.parse(process.env.WORKER_TEST_COMMAND ?? 'null') as unknown;
  if (
    !Array.isArray(testCommand) ||
    testCommand.length < 1 ||
    testCommand.length > 32 ||
    !testCommand.every((value) => typeof value === 'string' && value.length <= 512) ||
    !['node', 'npm', 'pnpm', 'python3', 'pytest', 'cargo', 'go'].includes(testCommand[0])
  )
    throw new Error(
      'WORKER_TEST_COMMAND must specify an operator-owned test argv using an allowed executable',
    );
  if (!HUB_CODEX_IMAGE || !HUB_RUNNER_NETWORK)
    throw new Error('HUB_CODEX_IMAGE and an approved HUB_RUNNER_NETWORK are required');
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
  const release = await lockCodexProfile(directory);
  try {
    await supervise({
      baseUrl: CONTROL_API_URL,
      enrollmentToken: WORKER_ENROLLMENT_TOKEN,
      root,
      adapter: new CodexAdapter({
        image: HUB_CODEX_IMAGE,
        auth: { directory },
        network: HUB_RUNNER_NETWORK,
        workspaceRoot: root,
      }),
      signal: stop.signal,
      once: process.argv.includes('--once'),
      verify: async (workspace, signal) => {
        const result = await runSandbox(
          {
            image: HUB_CODEX_IMAGE,
            workspace,
            network: 'none',
            timeoutSeconds: 300,
            maxOutputBytes: 1024 * 1024,
          },
          testCommand,
          '',
          signal,
        );
        return result.code === 0;
      },
    });
  } finally {
    await release();
  }
} else {
  const enrollment = new WorkerClient(CONTROL_API_URL, WORKER_ENROLLMENT_TOKEN);
  const registration = await enrollment.request('/workers/register', {
    name: 'connectivity-probe',
    engines: [],
    maxConcurrent: 1,
  });
  if (
    !registration ||
    typeof registration.token !== 'string' ||
    typeof registration.workerId !== 'string'
  )
    throw new Error('Invalid registration response');
  const worker = new WorkerClient(CONTROL_API_URL, registration.token);
  await worker.request(`/workers/${registration.workerId}/heartbeat`, { leases: [] });
  const claim = await worker.request('/workers/claim', {});
  if (claim !== null) throw new Error('Probe worker must not receive execution work');
  console.log('Worker register/heartbeat/poll succeeded; no engine capabilities advertised.');
}
