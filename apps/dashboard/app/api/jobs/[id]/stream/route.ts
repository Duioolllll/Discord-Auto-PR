import { sessionToken } from '../../../../../lib/api';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const token = await sessionToken();
  if (!token) return new Response(null, { status: 401 });
  const { id } = await params;
  if (!/^[a-f0-9-]{36}$/.test(id)) return new Response(null, { status: 400 });
  const base = new URL(process.env.CONTROL_API_URL ?? 'http://127.0.0.1:3001');
  if (
    base.protocol !== 'https:' &&
    !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname))
  )
    return new Response(null, { status: 503 });
  const response = await fetch(new URL(`/jobs/${id}/stream`, base), {
    headers: {
      authorization: `Bearer ${token}`,
      'last-event-id': request.headers.get('last-event-id') ?? '0',
    },
    cache: 'no-store',
    redirect: 'error',
    signal: request.signal,
  });
  if (!response.ok) return new Response(null, { status: response.status });
  return new Response(response.body, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
  });
}
