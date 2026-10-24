import { describe, expect, it } from 'vitest';
import { parseCodexEvents, sandboxArguments } from '@hub/agent-codex';
import { validateChanges } from '@hub/github';

describe('Codex versioned event protocol', () => {
  it('requires a completed turn and parses usage without claiming provider billing', () => {
    const output = [
      { type: 'item.completed', item: { type: 'agent_message', text: 'implemented' } },
      { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4 } },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');
    expect(parseCodexEvents(output)).toMatchObject({
      status: 'success',
      summary: 'implemented',
      usage: [{ source: 'token_estimate', inputTokens: 12, outputTokens: 4 }],
    });
    expect(parseCodexEvents('{"type":"turn.started"}').status).toBe('failed');
    expect(() => parseCodexEvents('invalid JSON')).toThrow();
  });
  it('uses a fixed argv and isolated container limits', () => {
    const args = sandboxArguments(
      'test',
      {
        image: `sha256:${'a'.repeat(64)}`,
        workspace: '/tmp/isolated',
        timeoutSeconds: 30,
        maxOutputBytes: 1024,
      },
      ['codex', 'exec', '-'],
    );
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--memory=1g');
    expect(args).toContain('none');
    expect(args).not.toContain('/var/run/docker.sock');
    expect(() =>
      sandboxArguments(
        'test',
        { image: 'latest', workspace: '/tmp/job', timeoutSeconds: 30, maxOutputBytes: 1024 },
        [],
      ),
    ).toThrow('immutable');
  });
  it.each([
    '../escape',
    '/etc/passwd',
    'a/../../escape',
    '.github/workflows/build.yml',
    '.env',
    '.git/config',
    'a\\b',
  ])('rejects unsafe or protected change %s', (path) => {
    expect(() =>
      validateChanges([{ path, contentBase64: Buffer.from('x').toString('base64') }]),
    ).toThrow();
  });
});
