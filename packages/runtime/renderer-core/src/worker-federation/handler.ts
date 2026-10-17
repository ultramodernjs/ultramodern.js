import {
  type AdmittedWorkerFederationExpose,
  type AdmitWorkerRendererContract,
  admitWorkerFederationExpose,
  readWorkerFederationEnvelope,
  readWorkerFederationPublication,
  workerFederationEnvelope,
  workerFederationRecord,
  workerFederationWireJson,
} from './contract';
import {
  assertWorkerFederationBodySize,
  checkWorkerFederationDeadline,
  readWorkerFederationJsonBody,
  WorkerFederationBodyTooLargeError,
  workerAbortable,
  workerAbortReason,
  workerFederationErrorMessage,
} from './lease';

export interface WorkerFederationExecution {
  readonly admitted: AdmittedWorkerFederationExpose;
  readonly signal: AbortSignal;
}

/** Bind once to the compiled registry and this Worker's own publication. */
export function createWorkerFederationHandler<NativeRequest>(options: {
  publication: { readonly renderer: unknown; readonly worker: unknown };
  manifestUrl: string;
  exposes: Readonly<Record<string, () => Promise<unknown>>>;
  admitRendererContract: AdmitWorkerRendererContract;
  /** Native codec admission runs before even loading the exposed module. */
  admitNativeRequest(
    payload: unknown,
    execution: WorkerFederationExecution,
  ): NativeRequest | Promise<NativeRequest>;
  /** Close the admitted native lease, including a preparation resolving after abort. */
  releaseNativeRequest(request: NativeRequest): void | Promise<void>;
  renderNativeSnapshot(
    module: unknown,
    request: NativeRequest,
    execution: WorkerFederationExecution,
  ): unknown | Promise<unknown>;
  requestTimeout?: number;
}): (request: Request) => Promise<Response | undefined> {
  if (
    typeof options.admitRendererContract !== 'function' ||
    typeof options.admitNativeRequest !== 'function' ||
    typeof options.releaseNativeRequest !== 'function' ||
    typeof options.renderNativeSnapshot !== 'function'
  )
    throw new Error(
      'Worker federation requires canonical and native admission callbacks.',
    );
  const timeout = options.requestTimeout ?? 3000;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error('Worker federation requires a positive request deadline.');
  const renderer = options.admitRendererContract(options.publication.renderer);
  const worker = readWorkerFederationPublication(
    options.publication.worker,
    renderer.identities,
  );
  const manifest = JSON.parse(
    workerFederationWireJson({
      metaData: {
        ultramodernRenderer: renderer,
        ultramodernWorkerFederation: worker,
      },
    }),
  );
  const loaders = workerFederationRecord(options.exposes, 'compiled exposes');
  if (
    Object.keys(loaders).length !== Object.keys(worker.exposes).length ||
    Object.keys(loaders).some(
      expose =>
        !Object.hasOwn(worker.exposes, expose) ||
        typeof loaders[expose] !== 'function',
    )
  )
    throw new Error(
      'Worker federation registry conflicts with its own publication.',
    );
  const pinnedLoaders = { ...options.exposes };
  const endpoints = new Map<string, AdmittedWorkerFederationExpose>();
  for (const [expose, coordinate] of Object.entries(worker.exposes)) {
    for (const locale of Object.keys(coordinate.paths)) {
      const admitted = admitWorkerFederationExpose({
        manifest,
        manifestUrl: options.manifestUrl,
        remote: worker.remote,
        expose,
        locale,
        admitRendererContract: options.admitRendererContract,
      });
      endpoints.set(admitted.path, admitted);
    }
  }
  const admitNativeRequest = options.admitNativeRequest;
  const releaseNativeRequest = options.releaseNativeRequest;
  const renderNativeSnapshot = options.renderNativeSnapshot;

  return async request => {
    const deadlineAt = performance.now() + timeout;
    const url = new URL(request.url);
    const admitted = endpoints.get(url.pathname);
    if (!admitted) return undefined;
    if (
      request.method !== 'POST' ||
      url.href !== admitted.endpoint ||
      request.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase() !== 'application/json'
    ) {
      void request.body?.cancel().catch(() => undefined);
      return new Response(
        'Worker federation endpoint coordinate conflicts with its publication.',
        { status: 400 },
      );
    }
    if (request.signal.aborted) {
      void request.body?.cancel().catch(() => undefined);
      throw workerAbortReason(request.signal);
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const checkDeadline = () =>
      checkWorkerFederationDeadline(deadlineAt, signal, controller);
    const execution = Object.freeze({ admitted, signal });
    const deadline = setTimeout(
      () => {
        controller.abort(
          new Error('Worker federation request deadline exceeded.'),
        );
      },
      Math.max(0, deadlineAt - performance.now()),
    );
    let executing = false;
    let admittedRequest: { value: NativeRequest } | undefined;
    let release: Promise<void> | undefined;
    let response: Response | undefined;
    let failedRequest: { error: unknown } | undefined;
    const releaseOnce = (value: NativeRequest): Promise<void> => {
      if (!release) {
        try {
          release = Promise.resolve(releaseNativeRequest(value));
        } catch (error) {
          release = Promise.reject(error);
        }
      }
      return release ?? Promise.resolve();
    };
    try {
      if (!request.body)
        throw new Error('Worker federation request has no native payload.');
      const envelope = await readWorkerFederationJsonBody(
        request.body,
        signal,
        request.headers.get('content-length'),
        checkDeadline,
      );
      checkDeadline();
      const payload = readWorkerFederationEnvelope(
        envelope,
        'request',
        admitted,
      );
      checkDeadline();
      const preparing = Promise.resolve().then(() => {
        checkDeadline();
        return admitNativeRequest(payload, execution);
      });
      void preparing.then(
        value => {
          if (signal.aborted) void releaseOnce(value).catch(() => undefined);
        },
        () => undefined,
      );
      const nativeRequest = await workerAbortable(preparing, signal);
      admittedRequest = { value: nativeRequest };
      checkDeadline();
      executing = true;
      const module = await workerAbortable(
        pinnedLoaders[admitted.expose](),
        signal,
      );
      checkDeadline();
      const snapshot = await workerAbortable(
        Promise.resolve(renderNativeSnapshot(module, nativeRequest, execution)),
        signal,
      );
      checkDeadline();
      if (typeof snapshot === 'string')
        assertWorkerFederationBodySize(snapshot);
      const body = assertWorkerFederationBodySize(
        workerFederationWireJson(
          workerFederationEnvelope('response', admitted, snapshot),
        ),
      );
      checkDeadline();
      response = new Response(body, {
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      let failure = error;
      try {
        checkDeadline();
      } catch (deadlineError) {
        failure = deadlineError;
      }
      failedRequest = { error: failure };
      response = new Response(
        workerFederationErrorMessage(
          failure,
          'Worker federation request failed.',
        ),
        {
          status: signal.aborted
            ? 504
            : executing
              ? 502
              : failure instanceof WorkerFederationBodyTooLargeError
                ? 413
                : 400,
        },
      );
    } finally {
      try {
        if (admittedRequest) {
          const releasing = releaseOnce(admittedRequest.value);
          if (signal.aborted) void releasing.catch(() => undefined);
          else {
            try {
              await workerAbortable(releasing, signal);
              checkDeadline();
            } catch (error) {
              void response?.body?.cancel().catch(() => undefined);
              let releaseFailure = error;
              try {
                checkDeadline();
              } catch (deadlineError) {
                releaseFailure = new AggregateError(
                  [error, deadlineError],
                  `${workerFederationErrorMessage(error, 'Native request release failed.', 384)}; ${workerFederationErrorMessage(deadlineError, 'Worker federation deadline exceeded.', 384)}`,
                );
              }
              const failure = failedRequest
                ? new AggregateError(
                    [failedRequest.error, releaseFailure],
                    `${workerFederationErrorMessage(failedRequest.error, 'Worker federation request failed.', 384)}; native request release failed: ${workerFederationErrorMessage(releaseFailure, 'Native request release failed.', 384)}`,
                  )
                : releaseFailure;
              response = new Response(
                workerFederationErrorMessage(
                  failure,
                  'Worker federation native request release failed.',
                ),
                { status: signal.aborted ? 504 : 502 },
              );
            }
          }
        }
      } finally {
        clearTimeout(deadline);
      }
    }
    if (request.signal.aborted) {
      void response?.body?.cancel().catch(() => undefined);
      throw workerAbortReason(request.signal);
    }
    return response;
  };
}
