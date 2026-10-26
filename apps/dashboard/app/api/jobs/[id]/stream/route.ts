import { sessionToken } from '../../../../../lib/api';
import { controlApiUrl } from '../../../../../lib/control-url';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const token = await sessionToken();
  if (!token) return new Response(null, { status: 401 });
  const { id } = await params;
  if (!/^[a-f0-9-]{36}$/.test(id)) return new Response(null, { status: 400 });
  try {
    const base = controlApiUrl();
    const response = await fetch(new URL(`/jobs/${id}/stream`, base), {
      headers: {
        authorization: `Bearer ${token}`,
        'last-event-id': request.headers.get('last-event-id') ?? '0',
      },
      cache: 'no-store',
      redirect: 'error',
      // The upstream stream normally closes after 15s; bound stalled headers and bodies too.
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(20000)]),
    });
    if (!response.ok) return new Response(null, { status: response.status });
    return new Response(response.body, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
    });
  } catch {
    return new Response(null, { status: 503 });
  }
}
