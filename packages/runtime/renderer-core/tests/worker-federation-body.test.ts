import { expect, it, rstest } from '@rstest/core';
import {
  assertWorkerFederationBodySize,
  checkWorkerFederationDeadline,
  readWorkerFederationJsonBody,
  WORKER_FEDERATION_MAX_BODY_BYTES,
  WorkerFederationBodyTooLargeError,
} from '../src/worker-federation/lease';

const encoder = new TextEncoder();

it('accepts an exact-limit JSON body and rejects one extra byte', async () => {
  expect(WORKER_FEDERATION_MAX_BODY_BYTES).toBe(8 * 1024 * 1024);
  const value = 'x'.repeat(WORKER_FEDERATION_MAX_BODY_BYTES - 2);
  const exact = encoder.encode(JSON.stringify(value));
  expect(exact.byteLength).toBe(WORKER_FEDERATION_MAX_BODY_BYTES);
  const accepted = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(exact);
      controller.close();
    },
  });
  await expect(
    readWorkerFederationJsonBody(
      accepted,
      new AbortController().signal,
      String(exact.byteLength),
    ),
  ).resolves.toBe(value);
  expect(accepted.locked).toBe(false);

  const oversized = encoder.encode(JSON.stringify(`${value}x`));
  expect(oversized.byteLength).toBe(WORKER_FEDERATION_MAX_BODY_BYTES + 1);
  const cancel = rstest.fn();
  const rejected = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(oversized);
    },
    cancel,
  });
  await expect(
    readWorkerFederationJsonBody(rejected, new AbortController().signal),
  ).rejects.toBeInstanceOf(WorkerFederationBodyTooLargeError);
  expect(cancel).toHaveBeenCalledExactlyOnceWith(
    expect.any(WorkerFederationBodyTooLargeError),
  );
  expect(rejected.locked).toBe(false);
});

it('cancels an oversized Content-Length before requesting any bytes', async () => {
  const pull = rstest.fn(
    (controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(encoder.encode('{}'));
    },
  );
  const cancel = rstest.fn();
  const body = new ReadableStream<Uint8Array>(
    { pull, cancel },
    { highWaterMark: 0 },
  );
  await expect(
    readWorkerFederationJsonBody(
      body,
      new AbortController().signal,
      String(WORKER_FEDERATION_MAX_BODY_BYTES + 1),
    ),
  ).rejects.toBeInstanceOf(WorkerFederationBodyTooLargeError);
  expect(pull).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledExactlyOnceWith(
    expect.any(WorkerFederationBodyTooLargeError),
  );
  expect(body.locked).toBe(false);
});

it.each([undefined, null, '1'])(
  'checks actual streamed bytes when Content-Length is %s',
  async contentLength => {
    let chunks = 0;
    const cancel = rstest.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          chunks++;
          controller.enqueue(
            new Uint8Array(
              chunks === 1 ? WORKER_FEDERATION_MAX_BODY_BYTES - 1 : 2,
            ),
          );
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    await expect(
      readWorkerFederationJsonBody(
        body,
        new AbortController().signal,
        contentLength,
      ),
    ).rejects.toBeInstanceOf(WorkerFederationBodyTooLargeError);
    expect(chunks).toBe(2);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(
      expect.any(WorkerFederationBodyTooLargeError),
    );
    expect(body.locked).toBe(false);
  },
);

it.each(['Buffer', 'Uint8Array'])(
  'copies retained %s subviews before the producer reuses their backing buffer',
  async kind => {
    const backing =
      kind === 'Buffer'
        ? Buffer.alloc(1024 * 1024, 0x7f)
        : new Uint8Array(1024 * 1024).fill(0x7f);
    const view = backing.subarray(1024, 1029);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = ['{"v":', 'true}'][pulls++];
          if (chunk === undefined) {
            controller.close();
            return;
          }
          view.set(encoder.encode(chunk));
          controller.enqueue(view);
        },
      },
      { highWaterMark: 0 },
    );
    await expect(
      readWorkerFederationJsonBody(body, new AbortController().signal),
    ).resolves.toEqual({ v: true });
    expect(pulls).toBe(3);
    expect(new TextDecoder().decode(view)).toBe('true}');
    expect(body.locked).toBe(false);
  },
);

it.each([
  ['ASCII', 'a', 1],
  ['two-byte characters', 'é', 2],
  ['three-byte characters', '€', 3],
  ['surrogate pairs', '😀', 4],
  ['unpaired high surrogates', '\ud800', 3],
  ['unpaired low surrogates', '\udc00', 3],
] as const)(
  'counts UTF-8 bytes for %s at the exact limit',
  (_name, character, bytes) => {
    const exact =
      character.repeat(Math.floor(WORKER_FEDERATION_MAX_BODY_BYTES / bytes)) +
      'x'.repeat(WORKER_FEDERATION_MAX_BODY_BYTES % bytes);
    expect(encoder.encode(exact).byteLength).toBe(
      WORKER_FEDERATION_MAX_BODY_BYTES,
    );
    expect(assertWorkerFederationBodySize(exact)).toBe(exact);
    expect(() => assertWorkerFederationBodySize(`${exact}x`)).toThrow(
      WorkerFederationBodyTooLargeError,
    );
  },
);

it('rejects overflow without awaiting a cancellation promise that never resolves', async () => {
  const cancel = rstest.fn(() => new Promise<void>(() => undefined));
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(
          new Uint8Array(WORKER_FEDERATION_MAX_BODY_BYTES + 1),
        );
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      readWorkerFederationJsonBody(body, new AbortController().signal).then(
        () => new Error('Overflow unexpectedly succeeded.'),
        error => error,
      ),
      new Promise<Error>(resolve => {
        watchdog = setTimeout(() => {
          resolve(new Error('Body rejection waited for cancellation.'));
        }, 250);
      }),
    ]);
    expect(outcome).toBeInstanceOf(WorkerFederationBodyTooLargeError);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(outcome);
    expect(body.locked).toBe(false);
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
});

it('aborts a pending partial body at the same monotonic deadline', async () => {
  let now = 100;
  rstest.spyOn(performance, 'now').mockImplementation(() => now);
  const controller = new AbortController();
  const deadlineAt = performance.now() + 10;
  const checkDeadline = () =>
    checkWorkerFederationDeadline(deadlineAt, controller.signal, controller);
  let entered!: () => void;
  const pendingRead = new Promise<void>(resolve => {
    entered = resolve;
  });
  let pulls = 0;
  const cancel = rstest.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(stream) {
        if (++pulls === 1) {
          stream.enqueue(encoder.encode('{"unfinished":'));
          return;
        }
        entered();
        return new Promise<void>(() => undefined);
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const outcome = readWorkerFederationJsonBody(
    body,
    controller.signal,
    undefined,
    checkDeadline,
  ).catch(error => error);
  await pendingRead;
  now = deadlineAt - 1;
  expect(checkDeadline).not.toThrow();
  expect(controller.signal.aborted).toBe(false);
  now = deadlineAt;
  expect(checkDeadline).toThrow('Worker federation request deadline exceeded.');
  expect(await outcome).toBe(controller.signal.reason);
  expect(cancel).toHaveBeenCalledExactlyOnceWith(controller.signal.reason);
  expect(pulls).toBe(2);
  expect(body.locked).toBe(false);
});

it('does not renew the monotonic deadline while a hot stream keeps yielding chunks', async () => {
  let now = 200;
  rstest.spyOn(performance, 'now').mockImplementation(() => now);
  const controller = new AbortController();
  const deadlineAt = performance.now() + 10;
  const cancel = rstest.fn();
  const bytes = encoder.encode('{"value":true}');
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(stream) {
        now += 3;
        if (pulls === bytes.byteLength) {
          stream.close();
          return;
        }
        const offset = pulls++;
        stream.enqueue(bytes.subarray(offset, pulls));
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  await expect(
    readWorkerFederationJsonBody(body, controller.signal, undefined, () => {
      checkWorkerFederationDeadline(deadlineAt, controller.signal, controller);
    }),
  ).rejects.toThrow('Worker federation request deadline exceeded.');
  expect(pulls).toBe(4);
  expect(controller.signal.aborted).toBe(true);
  expect(cancel).toHaveBeenCalledExactlyOnceWith(controller.signal.reason);
  expect(body.locked).toBe(false);
});
