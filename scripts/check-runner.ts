import { execFileSync } from 'node:child_process';
import { checkCodexSandbox } from '@hub/agent-codex';
const image =
  process.env.HUB_CODEX_IMAGE ??
  execFileSync('docker', ['image', 'inspect', 'hub-codex:0.163.0', '--format', '{{.Id}}'], {
    encoding: 'utf8',
  }).trim();
const result = await checkCodexSandbox(image);
console.log(JSON.stringify(result));
process.exit(result.ready ? 0 : 2);
