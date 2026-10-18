/** Installed only in the owned diagnostic page, before application scripts. */
export function installCancellationDiagnostics() {
  const events = [];
  const cancellations = [];
  const signals = new WeakMap();
  const streams = new WeakMap();
  const readers = new WeakMap();
  let sequence = 0;
  let dropped = 0;
  let droppedCancellations = 0;
  let observationErrors = 0;
  // Only diagnostic work is guarded; every native call stays outside this catch.
  const observe = callback => {
    try {
      return callback();
    } catch {
      observationErrors++;
    }
  };
  const describe = value => {
    if (value === undefined) return undefined;
    if (value instanceof Error || value instanceof DOMException)
      return `${value.name}: ${value.message}`.slice(0, 1024);
    return typeof value === 'string'
      ? value.slice(0, 1024)
      : `<${typeof value}>`;
  };
  const record = (kind, owner, reason) => {
    const event = {
      kind,
      ...owner,
      timeMs: Math.round(performance.now()),
      reason: observe(() => describe(reason)),
      stack: new Error('Cancellation diagnostic').stack?.slice(0, 4096),
    };
    events.push(event);
    if (events.length > 128) {
      events.shift();
      dropped++;
    }
    if (kind.endsWith('.abort') || kind.endsWith('.cancel')) {
      cancellations.push(event);
      if (cancellations.length > 64) {
        cancellations.shift();
        droppedCancellations++;
      }
    }
  };
  globalThis.__solidCancellationDiagnostics = {
    snapshot: () => ({
      events: events.slice(),
      dropped,
      cancellations: cancellations.slice(),
      droppedCancellations,
      observationErrors,
    }),
  };

  const controllerSignal = Object.getOwnPropertyDescriptor(
    AbortController.prototype,
    'signal',
  ).get;
  const signalAborted = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    'aborted',
  ).get;
  const signalReason = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    'reason',
  ).get;
  const requestSignal = Object.getOwnPropertyDescriptor(
    Request.prototype,
    'signal',
  ).get;
  const requestUrl = Object.getOwnPropertyDescriptor(
    Request.prototype,
    'url',
  ).get;
  const addEventListener = EventTarget.prototype.addEventListener;
  const abort = AbortController.prototype.abort;
  AbortController.prototype.abort = function (...args) {
    observe(() =>
      record(
        'controller.abort',
        signals.get(Reflect.apply(controllerSignal, this, [])),
        args[0],
      ),
    );
    return Reflect.apply(abort, this, args);
  };
  const fetch = globalThis.fetch;
  globalThis.fetch = function (...args) {
    // Preserve native validation, getters, settlement and unhandled rejections.
    const result = Reflect.apply(fetch, this, args);
    observe(() => {
      const [input, options] = args;
      const owner = {
        id: ++sequence,
        url: (input instanceof Request
          ? Reflect.apply(requestUrl, input, [])
          : typeof input === 'string'
            ? input
            : '<non-string input>'
        ).slice(0, 2048),
      };
      const descriptor =
        options == null
          ? undefined
          : Object.getOwnPropertyDescriptor(options, 'signal');
      // Never invoke an options getter a second time. Unknown inherited/accessor
      // options remain unobserved rather than guessing which signal fetch used.
      const plainOptions =
        options == null ||
        Object.getPrototypeOf(options) === Object.prototype ||
        Object.getPrototypeOf(options) === null;
      let signal;
      if (descriptor && 'value' in descriptor && descriptor.value !== undefined)
        signal = descriptor.value;
      else if (
        (!descriptor && plainOptions) ||
        (descriptor && 'value' in descriptor)
      )
        signal =
          input instanceof Request
            ? Reflect.apply(requestSignal, input, [])
            : undefined;
      record('fetch.request', owner);
      if (signal != null)
        observe(() => {
          const aborted = Reflect.apply(signalAborted, signal, []);
          signals.set(signal, owner);
          record(
            'fetch.signal',
            owner,
            aborted ? Reflect.apply(signalReason, signal, []) : undefined,
          );
          Reflect.apply(addEventListener, signal, [
            'abort',
            () =>
              observe(() =>
                record(
                  'fetch.abort',
                  owner,
                  Reflect.apply(signalReason, signal, []),
                ),
              ),
            { once: true },
          ]);
        });
    });
    return result;
  };
  const body = Object.getOwnPropertyDescriptor(Response.prototype, 'body');
  const responseUrl = Object.getOwnPropertyDescriptor(
    Response.prototype,
    'url',
  ).get;
  Object.defineProperty(Response.prototype, 'body', {
    ...body,
    get() {
      const stream = Reflect.apply(body.get, this, []);
      observe(() => {
        if (stream)
          streams.set(stream, {
            url: Reflect.apply(responseUrl, this, []).slice(0, 2048),
          });
      });
      return stream;
    },
  });
  const getReader = ReadableStream.prototype.getReader;
  ReadableStream.prototype.getReader = function (...args) {
    const reader = Reflect.apply(getReader, this, args);
    observe(() => {
      const owner = streams.get(this);
      if (owner) readers.set(reader, owner);
    });
    return reader;
  };
  const cancelBody = ReadableStream.prototype.cancel;
  ReadableStream.prototype.cancel = function (...args) {
    observe(() => record('body.cancel', streams.get(this), args[0]));
    return Reflect.apply(cancelBody, this, args);
  };
  for (const Reader of [
    ReadableStreamDefaultReader,
    ReadableStreamBYOBReader,
  ]) {
    const cancel = Reader.prototype.cancel;
    Reader.prototype.cancel = function (...args) {
      observe(() => record('reader.cancel', readers.get(this), args[0]));
      return Reflect.apply(cancel, this, args);
    };
  }
}
