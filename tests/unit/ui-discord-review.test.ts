import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { handleCommand } from '../../apps/discord-bot/src/commands.js';
import { botToken } from '../../apps/discord-bot/src/integration.js';
import { controlApiUrl } from '../../apps/dashboard/lib/control-url.js';

vi.mock('../../apps/dashboard/lib/api', () => ({ sessionToken: async () => 'fixture-session' }));
import { GET } from '../../apps/dashboard/app/api/jobs/[id]/stream/route.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('keeps the newest Discord event visible when older events exceed the reply limit', async () => {
  const editReply = vi.fn(async (_payload: unknown) => undefined);
  await handleCommand(
    {
      commandName: 'logs',
      id: 'fixture-interaction',
      user: { id: '123456789012345678' },
      options: { getString: () => randomUUID() },
      deferReply: async () => undefined,
      editReply,
    } as unknown as Parameters<typeof handleCommand>[0],
    {
      request: async () => ({
        events: Array.from({ length: 10 }, (_, i) => ({
          kind: 'WORKER_EVENT',
          message: `event-${i + 1}: ${'x'.repeat(750)}`,
        })),
      }),
    },
  );
  const reply = editReply.mock.calls[0]![0] as unknown as { content: string };
  expect(reply.content).toContain('event-10:');
  expect(reply.content).not.toContain('event-1:');
  expect(reply.content.length).toBeLessThanOrEqual(1800);
});

it('bounds one oversized newest Discord event without replacing it with an older event', async () => {
  const editReply = vi.fn(async (_payload: unknown) => undefined);
  await handleCommand(
    {
      commandName: 'logs',
      id: 'fixture-interaction',
      user: { id: '123456789012345678' },
      options: { getString: () => randomUUID() },
      deferReply: async () => undefined,
      editReply,
    } as unknown as Parameters<typeof handleCommand>[0],
    {
      request: async () => ({
        events: [
          { kind: 'OLD', message: 'old event' },
          { kind: 'LATEST', message: `newest ${'x'.repeat(8000)}` },
        ],
      }),
    },
  );
  const reply = editReply.mock.calls[0]![0] as unknown as { content: string };
  expect(reply.content).toMatch(/^LATEST: newest/);
  expect(reply.content).toHaveLength(1800);
  expect(reply.content.endsWith('…')).toBe(true);
});

it('rejects oversized and symlinked Discord token files without reading fallback credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-token-size-'));
  try {
    const file = join(root, 'token');
    await writeFile(file, 'x'.repeat(128 * 1024 + 1), { mode: 0o600 });
    await expect(
      botToken({ DISCORD_BOT_TOKEN_FILE: file, DISCORD_BOT_TOKEN: 'fallback' }),
    ).rejects.toMatchObject({ code: 'DISCORD_TOKEN_FILE_INVALID' });
    await writeFile(file, 'fixture-token', { mode: 0o600 });
    await symlink(file, join(root, 'link'));
    await expect(botToken({ DISCORD_BOT_TOKEN_FILE: join(root, 'link') })).rejects.toMatchObject({
      code: 'DISCORD_TOKEN_FILE_INVALID',
    });
    expect(await botToken({ DISCORD_BOT_TOKEN_FILE: file })).toBe('fixture-token');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects malformed, credential-bearing and nonlocal HTTP dashboard API addresses with fixed errors', () => {
  for (const value of [
    'invalid',
    'https://private-user:secret-sentinel@api.example',
    'http://api.example',
  ]) {
    expect(() => controlApiUrl(value)).toThrow('CONTROL_API_CONFIG_INVALID');
    try {
      controlApiUrl(value);
    } catch (error) {
      expect(String(error)).not.toContain('secret-sentinel');
    }
  }
  expect(controlApiUrl('http://127.0.0.1:3001').origin).toBe('http://127.0.0.1:3001');
});

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('CONTROL_API_URL', `http://127.0.0.1:${(server.address() as { port: number }).port}`);
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
const request = () => new Request(`http://127.0.0.1/api/jobs/${randomUUID()}/stream`);
const params = () => ({ params: Promise.resolve({ id: randomUUID() }) });

it('returns a bounded service error for stalled upstream SSE headers', async () => {
  const server = createServer(() => undefined);
  await listen(server);
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const timer = setTimeout(() => deadline.abort(), 20);
  try {
    const result = await GET(request(), params());
    expect(timeout).toHaveBeenCalledWith(20000);
    expect(result.status).toBe(503);
    expect(await result.text()).toBe('');
  } finally {
    clearTimeout(timer);
    await close(server);
  }
});

it('also aborts a stalled upstream SSE body after headers have been relayed', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': heartbeat\n\n');
  });
  await listen(server);
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  try {
    const result = await GET(request(), params());
    expect(result.status).toBe(200);
    const reader = result.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    deadline.abort();
    await expect(reader.read()).rejects.toThrow();
  } finally {
    await close(server);
  }
});
