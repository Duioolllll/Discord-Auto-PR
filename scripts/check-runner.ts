import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkCodexSandbox, type ProbeResult } from '@hub/agent-codex';

let result: ProbeResult;
try {
  const image =
    process.env.HUB_CODEX_IMAGE?.trim() ||
    (
      await promisify(execFile)(
        'docker',
        ['image', 'inspect', 'hub-codex:0.163.0', '--format', '{{.Id}}'],
        {
          timeout: 10000,
          maxBuffer: 8192,
        },
      )
    ).stdout.trim();
  result = await checkCodexSandbox(image);
} catch {
  result = {
    ready: false,
    reason: 'RUNNER_PROBE_FAILED',
    diagnostic: { stage: 'image', code: 'IMAGE_LOOKUP_FAILED' },
  };
}
console.log(JSON.stringify(result));
process.exitCode = result.ready ? 0 : 2;
