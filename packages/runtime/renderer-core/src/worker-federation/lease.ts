export function checkWorkerFederationDeadline(
  deadlineAt: number,
  signal?: AbortSignal,
  controller?: AbortController,
): void {
  if (signal?.aborted) throw workerAbortReason(signal);
  if (performance.now() >= deadlineAt) {
    const error = new Error('Worker federation request deadline exceeded.');
    controller?.abort(error);
    throw error;
  }
}

export function workerFederationErrorMessage(
  error: unknown,
  fallback: string,
  maxLength = 1024,
): string {
  return error instanceof Error && error.message.length <= maxLength
    ? error.message
    : fallback;
}

export function workerAbortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException('Worker federation request aborted.', 'AbortError')
  );
}

export function workerAbortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(workerAbortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(workerAbortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export async function readWorkerFederationJsonBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  contentLength?: string | null,
  checkDeadline?: () => void,
): Promise<unknown> {
  if (signal.aborted) {
    void body.cancel().catch(() => undefined);
    throw workerAbortReason(signal);
  }
  try {
    checkDeadline?.();
    if (contentLength != null) {
      if (!/^\d+$/u.test(contentLength))
        throw new Error(
          'Worker federation body has an invalid Content-Length.',
        );
      if (Number(contentLength) > WORKER_FEDERATION_MAX_BODY_BYTES)
        throw new WorkerFederationBodyTooLargeError();
    }
  } catch (error) {
    void body.cancel(error).catch(() => undefined);
    throw error;
  }
  const reader = body.getReader();
  const onAbort = () => {
    void reader.cancel(workerAbortReason(signal)).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      checkDeadline?.();
      const chunk = await workerAbortable(reader.read(), signal);
      checkDeadline?.();
      if (chunk.done) break;
      if (chunk.value.byteLength > WORKER_FEDERATION_MAX_BODY_BYTES - length)
        throw new WorkerFederationBodyTooLargeError();
      // A small view must not retain an unbounded upstream backing buffer.
      chunks.push(new Uint8Array(chunk.value));
      length += chunk.value.byteLength;
    }
    checkDeadline?.();
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (signal.aborted) throw workerAbortReason(signal);
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    checkDeadline?.();
    const result: unknown = JSON.parse(decoded);
    checkDeadline?.();
    return result;
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
export const WORKER_FEDERATION_MAX_BODY_BYTES = 8 * 1024 * 1024;

export class WorkerFederationBodyTooLargeError extends Error {
  constructor() {
    super('Worker federation body exceeds 8 MiB.');
    this.name = 'WorkerFederationBodyTooLargeError';
  }
}

/** Count UTF-8 bytes without allocating a second encoded body. */
export function assertWorkerFederationBodySize(value: string): string {
  if (value.length > WORKER_FEDERATION_MAX_BODY_BYTES)
    throw new WorkerFederationBodyTooLargeError();
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes++;
    else if (code <= 0x7ff) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index++;
    } else bytes += 3;
    if (bytes > WORKER_FEDERATION_MAX_BODY_BYTES)
      throw new WorkerFederationBodyTooLargeError();
  }
  return value;
}
