# Runner seccomp assets

`docker-default.seccomp.json` is vendored from Moby profiles `seccomp/v0.2.4`, commit
`245180c51918481c0525424b3ee025d2b435d46c`.
Source: https://github.com/moby/profiles/blob/245180c51918481c0525424b3ee025d2b435d46c/seccomp/default.json.
Copyright belongs to the Moby authors; see `LICENSE.moby` (Apache-2.0).

`codex.seccomp.json` preserves that baseline and appends the narrowly filtered rules in
`generate-seccomp.mjs`. Only trusted Codex runner containers use this extension; ordinary
verification containers retain Docker's built-in policy.

Run `pnpm security:check` to validate the baseline and generated policy. Runtime validation
also pins the generated profile's semantic SHA-256. Never replace it with an allow-all policy.

The security model, syscall/flag justification, platform requirements, tests and update
instructions are documented in [runner-security.md](../../docs/runner-security.md).
