/** Passive Network events only: never enable Fetch interception or read bodies. */
export async function observeDeferredLoaderNetwork(page) {
  const session = await page.context().newCDPSession(page);
  const requests = new Map();
  let dropped = 0;
  session.on('Network.requestWillBeSent', event => {
    const url = new URL(event.request.url);
    if (
      url.searchParams.get('case') !== 'deferred' ||
      !url.searchParams.has('__loader')
    )
      return;
    if (requests.size === 16 && !requests.has(event.requestId)) {
      requests.delete(requests.keys().next().value);
      dropped++;
    }
    requests.set(event.requestId, {
      requestId: event.requestId,
      url: event.request.url.slice(0, 2048),
      started: event.timestamp,
      chunks: 0,
      dataLength: 0,
      encodedDataLength: 0,
    });
  });
  session.on('Network.responseReceived', event => {
    const request = requests.get(event.requestId);
    if (!request) return;
    const { response } = event;
    const headers = {};
    for (const [name, value] of Object.entries(response.headers)) {
      if (
        [
          'content-type',
          'content-length',
          'transfer-encoding',
          'content-encoding',
        ].includes(name.toLowerCase())
      )
        headers[name.toLowerCase()] = String(value).slice(0, 256);
    }
    request.response = {
      at: event.timestamp,
      status: response.status,
      protocol: response.protocol,
      fromServiceWorker: response.fromServiceWorker,
      fromDiskCache: response.fromDiskCache,
      connectionReused: response.connectionReused,
      headers,
    };
  });
  session.on('Network.dataReceived', event => {
    const request = requests.get(event.requestId);
    if (!request) return;
    request.chunks++;
    request.dataLength += event.dataLength;
    request.encodedDataLength += event.encodedDataLength;
    request.lastDataAt = event.timestamp;
  });
  session.on('Network.loadingFailed', event => {
    const request = requests.get(event.requestId);
    if (!request) return;
    request.failure = {
      at: event.timestamp,
      errorText: event.errorText,
      canceled: event.canceled,
      blockedReason: event.blockedReason,
      corsErrorStatus: event.corsErrorStatus,
      type: event.type,
    };
  });
  session.on('Network.loadingFinished', event => {
    const request = requests.get(event.requestId);
    if (request)
      request.finished = {
        at: event.timestamp,
        encodedDataLength: event.encodedDataLength,
      };
  });
  await session.send('Network.enable');
  // The session belongs to this page and closes with its owning browser.
  return {
    snapshot: () => ({
      dropped,
      requests: structuredClone([...requests.values()]),
    }),
  };
}

/** Diagnostic only: real TCP/Chromium loader consumption without app scripts. */
export async function probeRawDeferredLoader(
  browser,
  origin,
  { evaluationTimeoutMs = 12000 } = {},
) {
  const context = await browser.newContext({ javaScriptEnabled: false });
  let closing;
  const close = () => (closing ??= context.close());
  try {
    const page = await context.newPage();
    const network = await observeDeferredLoaderNetwork(page);
    const failures = [];
    page.on('requestfailed', request =>
      failures.push({
        url: request.url(),
        error: request.failure()?.errorText,
      }),
    );
    // A same-origin ordinary SSR document gives fetch its real browser origin;
    // disabling page JavaScript prevents entry, hydration and router activation.
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15000 });
    let transport;
    let timer;
    try {
      transport = await Promise.race([
        page.evaluate(async () => {
          const started = performance.now();
          const response = await fetch(
            '/?case=deferred&__loader=index_page&__ssrDirect=true',
            { signal: AbortSignal.timeout(10000) },
          );
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let body = '';
          let chunks = 0;
          let bytes = 0;
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            chunks++;
            bytes += item.value.byteLength;
            if (bytes > 65536)
              throw new Error('Raw loader diagnostic exceeded 64 KiB');
            body += decoder.decode(item.value, { stream: true });
          }
          body += decoder.decode();
          const facts = {
            status: response.status,
            contentType: response.headers.get('content-type'),
            elapsedMs: Math.round(performance.now() - started),
            trueEof: true,
            chunks,
            bytes,
          };
          try {
            const frames = body
              .trim()
              .split('\n')
              .map(line => JSON.parse(line));
            return {
              ...facts,
              frameTypes: frames.map(frame => frame.type),
              completeFrames: frames.filter(frame => frame.type === 'complete')
                .length,
            };
          } catch (error) {
            return { ...facts, frameError: String(error).slice(0, 2048) };
          }
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Raw loader diagnostic evaluation timed out'));
            // Closing this owned context interrupts a hung renderer/evaluation.
            // The same close Promise is awaited in the outer finally.
            void close();
          }, evaluationTimeoutMs);
        }),
      ]);
    } catch (error) {
      // Preserve the original acceptance failure and report this independent
      // diagnostic outcome; no application errors are filtered or accepted.
      transport = { error: String(error).slice(0, 2048) };
    } finally {
      clearTimeout(timer);
    }
    return { transport, failures, network: network.snapshot() };
  } finally {
    await close();
  }
}
