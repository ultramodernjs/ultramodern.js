/** Observe browser traffic without changing requests or application lifecycles. */
export function createRequestDiagnostics({
  limit = 128,
  abnormalLimit = 32,
  now = () => performance.now(),
} = {}) {
  const started = now();
  const requests = new WeakMap();
  const events = [];
  const abnormal = [];
  let sequence = 0;
  let dropped = 0;
  let droppedAbnormal = 0;
  let phase = 'startup';

  function record(page, kind, request, details = {}) {
    const timeMs = Math.round(now() - started);
    let owner = requests.get(request);
    if (owner === undefined) {
      owner = { id: ++sequence, startedAtMs: timeMs, startedPhase: phase };
      requests.set(request, owner);
    }
    if (kind === 'response') {
      owner.responseAtMs = timeMs;
      owner.responseStatus = details.status;
      owner.responseHeaders = details.headers;
    }
    const event = {
      ...owner,
      page,
      phase,
      kind,
      timeMs,
      method: request.method(),
      type: request.resourceType(),
      url: request.url().slice(0, 2048),
      ...details,
    };
    events.push(event);
    if (events.length > limit) {
      events.shift();
      dropped++;
    }
    // Keep the first abnormal outcomes independently of subsequent traffic.
    if (kind === 'failed' || details.status >= 400) {
      if (abnormal.length < abnormalLimit) abnormal.push(event);
      else droppedAbnormal++;
    }
  }

  return {
    phase(value) {
      phase = value;
    },
    attach(page, label) {
      page.on('request', request => record(label, 'request', request));
      page.on('response', response => {
        const headers = response.headers();
        record(label, 'response', response.request(), {
          status: response.status(),
          headers: Object.fromEntries(
            ['content-type', 'content-length', 'transfer-encoding'].flatMap(
              name =>
                headers[name] === undefined
                  ? []
                  : [[name, headers[name].slice(0, 256)]],
            ),
          ),
        });
      });
      page.on('requestfinished', request => record(label, 'finished', request));
      page.on('requestfailed', request =>
        record(label, 'failed', request, {
          failure: request.failure()?.errorText.slice(0, 512),
        }),
      );
    },
    snapshot() {
      return {
        dropped,
        events: events.map(event => structuredClone(event)),
        droppedAbnormal,
        abnormal: abnormal.map(event => structuredClone(event)),
      };
    },
  };
}
