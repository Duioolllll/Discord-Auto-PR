import { expect, it, vi } from 'vitest';
import { handleCommand, type ControlClient } from '../../apps/discord-bot/src/commands.js';
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
