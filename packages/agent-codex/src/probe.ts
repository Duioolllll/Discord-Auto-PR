import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codexSandboxArguments } from './auth.js';
import { codexSeccompPath, RunnerFailure, runSandbox, type ProbeReason } from './container.js';

export const codexVersion = '0.163.0';
export interface ProbeResult {
  ready: boolean;
  reason: ProbeReason | 'OK';
  diagnostic?: { stage: string; code: string; exitCode?: number };
}

// All diagnostics are fixed categories. Never forward arbitrary stderr or environment data.
export function classifyProbeFailure(stderr: string): ProbeReason {
  if (
    /CODEX_HOME_UNAVAILABLE|could not create PATH aliases|app-server socket directory/i.test(stderr)
  )
    return 'CODEX_HOME_UNAVAILABLE';
  if (
    /No permissions.*namespace|Creating new namespace failed|unshare user ns|namespace.*Operation not permitted|user\.max_user_namespaces/i.test(
      stderr,
    )
  )
    return 'NAMESPACE_SANDBOX_UNAVAILABLE';
  return 'SANDBOX_PROCESS_FAILED';
}

const innerProbe = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const assert = require('node:assert/strict');
const outer = JSON.parse(fs.readFileSync('/workspace/.hub-probe-outer.json','utf8'));
const ns = (name) => fs.readlinkSync('/proc/self/ns/' + name);
const status = fs.readFileSync('/proc/self/status','utf8');
for (const name of ['user','mnt','pid','ipc','net']) assert.notEqual(ns(name),outer.namespaces[name]);
assert.ok(process.getuid() > 0);
for (const field of ['CapEff','CapPrm','CapBnd']) assert.match(status,new RegExp(field + ':\\s+0+\\n'));
assert.match(status,/NoNewPrivs:\s+1/);
assert.match(status,/Seccomp:\s+2/);
assert.ok(Number(/Seccomp_filters:\s+(\d+)/.exec(status)?.[1]) > outer.filters);
assert.throws(() => fs.writeFileSync('/home/runner/outside-sentinel','changed'));
assert.throws(() => fs.readFileSync('/home/runner/.codex/auth.json'));
assert.throws(() => fs.readFileSync('/proc/self/root/home/runner/.codex/auth.json'));
assert.equal(fs.existsSync('/workspace/auth.json'),false);
assert.equal(process.env.CODEX_API_KEY,undefined);
fs.writeFileSync('/workspace/.hub-probe-written','verified');
// A loopback server in the outer container proves the inner network boundary even offline.
const socket = net.createConnection({host:'127.0.0.1',port:outer.port});
const blocked = () => { fs.writeSync(1,'sandbox-ready'); socket.destroy(); };
socket.once('error',blocked);
socket.once('connect',() => { socket.destroy(); process.exitCode=2; });
socket.setTimeout(1500,() => { socket.destroy(); process.exitCode=3; });
`;

function outerProbe() {
  // This function is serialized and run inside the no-credential container.
  // Its source contains no host environment or authentication values.
  return String.raw`
const fs = require('node:fs');
const net = require('node:net');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const namespaces = {};
const status = fs.readFileSync('/proc/self/status','utf8');
assert.ok(process.getuid() > 0);
for (const field of ['CapEff','CapPrm','CapBnd']) assert.match(status,new RegExp(field + ':\\s+0+\\n'));
assert.match(status,/NoNewPrivs:\s+1/);
assert.match(status,/Seccomp:\s+2/);
assert.equal(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),'1073741824');
assert.equal(fs.readFileSync('/sys/fs/cgroup/memory.swap.max','utf8').trim(),'0');
assert.equal(fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(),'128');
const cpu = fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim().split(/\s+/).map(Number);
assert.equal(cpu[0]/cpu[1],1);
assert.deepEqual(Object.keys(require('node:os').networkInterfaces()),['lo']);
assert.throws(() => fs.writeFileSync('/etc/hub-probe','x'));
const home = process.env.CODEX_HOME;
try {
  assert.equal(home,'/home/runner/.codex');
  const metadata=fs.statSync(home);
  assert.equal(metadata.uid,process.getuid());
  assert.equal(metadata.mode & 0o777,0o700);
  assert.equal(fs.existsSync(home+'/auth.json'),false);
  fs.writeFileSync(home+'/probe-home','temporary',{mode:0o600});
} catch { fs.writeSync(2,'CODEX_HOME_UNAVAILABLE'); process.exit(78); }
// A synthetic fixture verifies secret masking; never mount or read a real login during checks.
fs.writeFileSync(home+'/auth.json',JSON.stringify({tokens:{access_token:'probe-fixture',refresh_token:'probe-fixture',id_token:'probe-fixture'}}),{mode:0o600});
fs.writeFileSync('/home/runner/outside-sentinel','unchanged');
for (const name of ['user','mnt','pid','ipc','net']) namespaces[name]=fs.readlinkSync('/proc/self/ns/'+name);
process.env.CODEX_API_KEY='probe-fixture';
const server = net.createServer((socket) => socket.end());
server.listen(0,'127.0.0.1',() => {
  fs.writeFileSync('/workspace/.hub-probe-outer.json',JSON.stringify({namespaces,filters:Number(/Seccomp_filters:\s+(\d+)/.exec(status)?.[1]),port:server.address().port}));
  const child = spawn('codex',${JSON.stringify(codexSandboxArguments(['node', '-e', innerProbe]).slice(1))},{stdio:'inherit'});
  child.once('error',() => {server.close();process.exitCode=4;});
  child.once('close',(code) => {server.close();process.exitCode=code??4;});
});
`;
}

export async function checkCodexSandbox(image: string): Promise<ProbeResult> {
  const workspace = await mkdtemp(join(tmpdir(), 'hub-codex-probe-'));
  let stage = 'version';
  try {
    const options = {
      image,
      workspace,
      network: 'none',
      timeoutSeconds: 25,
      maxOutputBytes: 8192,
      seccompProfilePath: codexSeccompPath,
    };
    const version = await runSandbox(
      options,
      ['codex', '--version'],
      '',
      new AbortController().signal,
    );
    if (version.code !== 0)
      return {
        ready: false,
        reason: classifyProbeFailure(version.stderr),
        diagnostic: { stage, code: 'VERSION_PROCESS_FAILED', exitCode: version.code },
      };
    if (version.output !== `codex-cli ${codexVersion}\n`)
      return { ready: false, reason: 'CODEX_VERSION_MISMATCH' };
    stage = 'sandbox';
    const result = await runSandbox(
      options,
      ['node', '-e', outerProbe()],
      '',
      new AbortController().signal,
    );
    if (result.code !== 0)
      return {
        ready: false,
        reason: classifyProbeFailure(result.stderr),
        diagnostic: { stage, code: 'ISOLATION_PROBE_FAILED', exitCode: result.code },
      };
    if (result.output !== 'sandbox-ready')
      return { ready: false, reason: 'SANDBOX_OUTPUT_MISMATCH' };
    if ((await readFile(join(workspace, '.hub-probe-written'), 'utf8')) !== 'verified')
      return { ready: false, reason: 'SANDBOX_OUTPUT_MISMATCH' };
    return { ready: true, reason: 'OK' };
  } catch (error) {
    return error instanceof RunnerFailure
      ? { ready: false, reason: error.reason, diagnostic: { stage, code: error.diagnostic } }
      : {
          ready: false,
          reason: 'RUNNER_PROBE_FAILED',
          diagnostic: { stage, code: 'PROBE_EXECUTION_FAILED' },
        };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
