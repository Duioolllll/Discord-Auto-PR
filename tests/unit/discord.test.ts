import { expect, it, vi } from 'vitest';
import { handleCommand, type ControlClient } from '../../apps/discord-bot/src/commands.js';
import {
  commandFailure,
  ControlApiError,
  createControlClient,
  normalizeRepository,
} from '../../apps/discord-bot/src/control-client.js';
import { WorkerClient } from '../../apps/worker-supervisor/src/client.js';

it('defers Discord interactions before calling the shared API with a stable idempotency key', async () => {
  const order: string[] = [];
  const request = vi.fn(async () => {
    order.push('api');
    return { job: { id: 'job1', status: 'QUEUED' } };
  });
  const interaction = {
    commandName: 'develop',
    id: 'interaction1',
    user: { id: '123456789012345678' },
    options: {
      getString: (key: string) => (key === 'repository' ? 'org/repo' : 'implement feature'),
    },
    deferReply: vi.fn(async () => {
      order.push('defer');
    }),
    editReply: vi.fn(async () => undefined),
  };
  await handleCommand(
    interaction as unknown as Parameters<typeof handleCommand>[0],
    { request } as ControlClient,
  );
  expect(order).toEqual(['defer', 'api']);
  expect(request).toHaveBeenCalledWith(
    '/jobs',
    interaction.user.id,
    'POST',
    expect.objectContaining({ externalRequestId: 'discord:interaction1' }),
  );
  expect(interaction.editReply).toHaveBeenCalledWith(
    expect.objectContaining({ allowedMentions: { parse: [] } }),
  );
});

it('requires HTTPS for remote worker connections', () => {
  expect(() => new WorkerClient('http://remote.example', 'token')).toThrow('HTTPS');
  expect(() => new WorkerClient('http://127.0.0.1:3001', 'token')).not.toThrow();
  expect(() => new WorkerClient('https://control.example', 'token')).not.toThrow();
});

function refactorInteraction(repository: string) {
  return {
    commandName: 'refactor',
    id: 'interaction-refactor',
    user: { id: '123456789012345678' },
    options: { getString: (key: string) => (key === 'repository' ? repository : '코드 검토') },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn<
      (reply: { content: string; allowedMentions: { parse: string[] } }) => Promise<void>
    >(async () => undefined),
  };
}

it('accepts canonical names and GitHub repository links without fetching the supplied URL', () => {
  for (const input of [
    ' Duioolllll/Discord-Auto-PR ',
    'https://github.com/Duioolllll/Discord-Auto-PR',
    'https://github.com/Duioolllll/Discord-Auto-PR.git/',
    '<https://github.com/Duioolllll/Discord-Auto-PR>',
    '[Discord-Auto-PR](https://github.com/Duioolllll/Discord-Auto-PR)',
    'https://github.com/Duioolllll/Discord-Auto-PR?tab=readme-ov-file#readme',
  ])
    expect(normalizeRepository(input)).toBe('Duioolllll/Discord-Auto-PR');
});

it('rejects ambiguous names, foreign hosts, credentials and non-repository GitHub paths', () => {
  for (const input of [
    'Discord-Auto-PR',
    'http://github.com/org/repo',
    'https://github.com.evil.example/org/repo',
    'https://github.com@evil.example/org/repo',
    'https://user:password@github.com/org/repo',
    'https://github.com:8443/org/repo',
    'https://github.com/org/repo/tree/main',
    'https://github.com/org/repo/issues/1',
    'org/repo extra text',
  ])
    expect(normalizeRepository(input)).toBeUndefined();
});

it('converts the reported Markdown link before submitting a refactor job', async () => {
  const interaction = refactorInteraction(
    '[Discord-Auto-PR](https://github.com/Duioolllll/Discord-Auto-PR)',
  );
  const request = vi.fn(async () => ({ job: { id: 'job1', status: 'QUEUED' } }));
  await handleCommand(interaction as unknown as Parameters<typeof handleCommand>[0], { request });
  expect(request).toHaveBeenCalledWith('/jobs', interaction.user.id, 'POST', {
    externalRequestId: 'discord:interaction-refactor',
    repository: 'Duioolllll/Discord-Auto-PR',
    instruction: '코드 검토',
    kind: 'refactor',
    engine: 'codex',
  });
  expect(interaction.editReply).toHaveBeenCalledWith({
    content: '작업 job1: QUEUED',
    allowedMentions: { parse: [] },
  });
});

it('does not send a job request when the repository input is invalid', async () => {
  const interaction = refactorInteraction('Discord-Auto-PR');
  const request = vi.fn();
  await handleCommand(interaction as unknown as Parameters<typeof handleCommand>[0], { request });
  expect(request).not.toHaveBeenCalled();
  expect(interaction.editReply).toHaveBeenCalledWith({
    content: expect.stringContaining('INVALID_REPOSITORY'),
    allowedMentions: { parse: [] },
  });
});

it('preserves safe API error codes without exposing other response fields or credentials', async () => {
  const fakeSecret = 'fake-private-token-for-regression-only';
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json(
      { error: 'REPOSITORY_NOT_INSTALLED', detail: fakeSecret, environment: fakeSecret },
      { status: 403 },
    ),
  );
  const interaction = refactorInteraction('org/repo');
  await handleCommand(
    interaction as unknown as Parameters<typeof handleCommand>[0],
    createControlClient('https://control.example', fakeSecret, fetcher),
  );
  const reply = interaction.editReply.mock.calls[0]?.[0];
  expect(reply).toEqual({
    content: expect.stringContaining('REPOSITORY_NOT_INSTALLED · HTTP 403'),
    allowedMentions: { parse: [] },
  });
  expect(JSON.stringify(reply)).not.toContain(fakeSecret);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledWith(
    new URL('https://control.example/jobs'),
    expect.objectContaining({
      redirect: 'error',
      signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ 'x-discord-user-id': interaction.user.id }),
    }),
  );
});

it.each([
  ['UNAUTHORIZED', 401, 'BOT_API_TOKEN'],
  ['FORBIDDEN', 403, '역할'],
  ['BUDGET_EXCEEDED', 402, '예산'],
  ['JOB_NOT_FOUND', 404, '전체 작업 ID'],
  ['GITHUB_ACCOUNT_LINK_REQUIRED', 403, '/identity/github'],
  ['MERGE_POLICY_REJECTED', 409, '필수 CI'],
] as const)('explains %s without weakening API policy', async (code, status, tip) => {
  const api = createControlClient('https://control.example', 'test-token', async () =>
    Response.json({ error: code }, { status }),
  );
  try {
    await api.request('/jobs', '123456789012345678', 'POST', {});
    expect.unreachable('The rejected API request must not succeed');
  } catch (error) {
    const message = commandFailure(error, 'refactor');
    expect(message).toContain(code);
    expect(message).toContain(tip);
    expect(message).toContain(`HTTP ${status}`);
  }
});

it('distinguishes invalid create input from invalid job IDs', () => {
  const error = new ControlApiError('INVALID_REQUEST', 400);
  expect(commandFailure(error, 'refactor')).toContain('instruction');
  expect(commandFailure(error, 'status')).toContain('UUID');
});

it('bounds error bodies and never echoes unknown error codes or raw exception messages', async () => {
  const fakeSecret = 'fake-secret-do-not-echo';
  for (const response of [
    Response.json({ error: fakeSecret, message: fakeSecret }, { status: 500 }),
    Response.json({ error: 'toString', message: fakeSecret }, { status: 500 }),
    new Response(fakeSecret.repeat(1000), { status: 500 }),
    new Response(`${fakeSecret} invalid JSON`, { status: 500 }),
  ]) {
    const api = createControlClient('https://control.example', 'test-token', async () => response);
    await expect(api.request('/jobs', '123456789012345678', 'POST', {})).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 500,
    });
  }
  expect(commandFailure(new Error(fakeSecret), 'refactor')).not.toContain(fakeSecret);
  expect(commandFailure(new ControlApiError('HTTP_ERROR', 401), 'refactor')).toContain(
    'BOT_API_TOKEN',
  );
});

it('reports connection failures safely and never retries potentially committed writes', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => {
    throw new Error('fake-secret-network-error');
  });
  const api = createControlClient('http://127.0.0.1:3001', 'test-token', fetcher);
  const error = await api.request('/jobs', '123456789012345678', 'POST', {}).catch((e) => e);
  expect(error).toMatchObject({ code: 'CONTROL_API_UNREACHABLE' });
  expect(commandFailure(error, 'refactor')).toContain('재요청 전에');
  expect(commandFailure(error, 'refactor')).not.toContain('fake-secret-network-error');
  expect(fetcher).toHaveBeenCalledOnce();
});

it('identifies a dashboard or malformed success response instead of treating it as job success', async () => {
  const api = createControlClient(
    'http://localhost:3000',
    'test-token',
    async () => new Response('<html>Dashboard</html>'),
  );
  const error = await api.request('/jobs', '123456789012345678', 'POST', {}).catch((e) => e);
  expect(error).toMatchObject({ code: 'CONTROL_API_INVALID_RESPONSE' });
  expect(commandFailure(error, 'refactor')).toContain('3001');
});

it('requires HTTPS and refuses URL credentials for the bot Control API client', () => {
  expect(() => createControlClient('http://remote.example', 'test-token')).toThrow('HTTPS');
  expect(() =>
    createControlClient('https://user:password@control.example', 'test-token'),
  ).toThrow();
  expect(() => createControlClient('http://127.0.0.1:3001', 'test-token')).not.toThrow();
});
