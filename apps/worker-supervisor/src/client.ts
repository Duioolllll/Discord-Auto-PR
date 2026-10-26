export class WorkerApiError extends Error {
  constructor(readonly status: number) {
    super(`Worker API rejected request (${status})`);
  }
}

export class WorkerClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {
    const url = new URL(baseUrl);
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))
    )
      throw new Error('Worker requires HTTPS outside loopback');
  }
  async request(path: string, body: unknown, signal?: AbortSignal, timeoutMs = 10000) {
    signal?.throwIfAborted();
    const response = await fetch(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) throw new WorkerApiError(response.status);
    if (response.status === 204) return null;
    return response.json() as Promise<Record<string, unknown>>;
  }
}
