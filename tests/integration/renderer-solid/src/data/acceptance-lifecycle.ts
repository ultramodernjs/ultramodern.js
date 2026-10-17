/** Test fixture observability. It does not participate in application routing. */
export async function observe(request: Request, event: string): Promise<void> {
  const origin = process.env.SOLID_CONSUMER_OBSERVER_URL;
  const nonce = process.env.SOLID_CONSUMER_OBSERVER_NONCE;
  const id = request.headers.get('x-solid-acceptance-request');
  if (!origin || !nonce || !id) return;
  const response = await fetch(new URL('/event', origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: nonce },
    body: JSON.stringify({ id, event }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Solid acceptance observer rejected event');
}

export async function barrier(request: Request): Promise<void> {
  const origin = process.env.SOLID_CONSUMER_OBSERVER_URL;
  const nonce = process.env.SOLID_CONSUMER_OBSERVER_NONCE;
  const id = request.headers.get('x-solid-acceptance-request');
  if (!origin || !nonce || !id) return;
  const response = await fetch(
    new URL(`/barrier/${encodeURIComponent(id)}`, origin),
    {
      headers: { authorization: nonce },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
    },
  );
  if (!response.ok) throw new Error('Solid acceptance loader barrier failed');
}

export function observedLater(
  value: string,
  request: Request,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const complete = (aborted: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
      void observe(request, aborted ? 'aborted' : 'resolved')
        .then(() => observe(request, 'cleaned'))
        .then(() => {
          if (aborted) reject(request.signal.reason);
          else resolve(value);
        }, reject);
    };
    const abort = () => complete(true);
    const timer = setTimeout(() => complete(false), 1500);
    request.signal.addEventListener('abort', abort, { once: true });
    void observe(request, 'deferred-started').catch(reject);
    if (request.signal.aborted) abort();
  });
}
