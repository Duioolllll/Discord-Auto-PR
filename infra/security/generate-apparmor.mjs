import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

// Moby apparmor/v0.2.3, commit 245180c51918481c0525424b3ee025d2b435d46c.
const source = await readFile(new URL('./docker-apparmor-template.go', import.meta.url), 'utf8');
const sha = (value) => createHash('sha256').update(value).digest('hex');
if (sha(source) !== 'cce1c730656ad73cb04b19bf25caa2351732a00e04a06eeaf3010105e1ba6a57')
  throw new Error('Pinned Moby AppArmor template changed.');
const template = /const baseTemplate = `([\s\S]*)`/.exec(source)?.[1];
if (!template) throw new Error('Moby template not found');
function render(name) {
  const result = template
    .replace('{{if .Abi}}abi <{{.Abi}}>,\n{{- end}}', 'abi <abi/3.0>,')
    .replace('{{range $value := .Imports}}\n{{$value}}\n{{- end}}', '#include <tunables/global>')
    .replace(
      '{{- range $value := .InnerImports}}\n  {{$value}}\n{{- end}}{{if .InnerImports}}\n{{end}}',
      '  #include <abstractions/base>',
    )
    .replaceAll('{{.Name}}', name)
    .replaceAll('{{.DaemonProfile}}', 'unconfined');
  if (result.includes('{{')) throw new Error('Unresolved AppArmor template');
  return result;
}
const baseline = render('docker-default');
const profile = render('discord-hub-codex-v1').replace(
  '  deny mount,',
  '  # Bwrap setup only; paired with the pinned seccomp flag filters and ALL caps dropped.\n  mount,\n  pivot_root,',
);
if (!baseline.includes('  deny mount,') || profile.includes('  deny mount,'))
  throw new Error('Unexpected mount policy');
for (const [name, value] of [
  ['docker-default.apparmor', baseline],
  ['codex.apparmor', profile],
]) {
  const destination = new URL(`./${name}`, import.meta.url);
  if (process.argv.includes('--check')) {
    if ((await readFile(destination, 'utf8')) !== value)
      throw new Error(`Unapproved AppArmor asset: ${name}`);
  } else await writeFile(destination, value);
}
console.log(`Codex AppArmor SHA-256: ${sha(profile)}`);
