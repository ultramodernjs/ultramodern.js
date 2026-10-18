import type { NativeFederationBinding } from '@modern-js/renderer-core/federation';
import {
  assertRendererIdentity,
  type RendererIdentity,
} from '@modern-js/renderer-core/identity';
import {
  type ComponentBody,
  createRoot,
  hydrateRoot,
  type Root,
  type RootContainer,
  type RootOptions,
} from 'octane';
import {
  bootstrapStreamedSignalHydration,
  type StreamedSignalHydration,
} from 'octane/hydration/streamed-signals';
import {
  assertNativeHydrationBuildId,
  assertOctaneIdentity,
} from './bootstrap';
import {
  createFederationScope,
  FederationApplication,
  type OctaneFederationScope,
} from './federation-context';
import {
  type OctaneWorkerFederationFactory,
  type OctaneWorkerFederationScope,
  WorkerFederationApplication,
} from './worker-federation-context';

export type { OctaneDocumentBootstrap } from './bootstrap';
export { readOctaneDocumentBootstrap } from './bootstrap';

export interface OctaneApplicationModule {
  readonly default: ComponentBody;
  readonly props?: Record<string, unknown>;
  /** Request-independent resources owned by this browser application module. */
  readonly dispose?: () => void;
}

export interface OctaneApplicationHandle {
  readonly root: Root;
  readonly identity: Readonly<RendererIdentity>;
  update(application: OctaneApplicationModule): void;
  dispose(): void;
}

export interface OctaneApplicationOptions {
  readonly container: Exclude<RootContainer, Document>;
  readonly identity: RendererIdentity;
  readonly nativeHydrationBuildId: string;
  /** Cancels startup ownership and retires an active application. */
  readonly signal?: AbortSignal;
  /** Hydration installs the native signal bridge before invoking this importer. */
  readonly load: () => Promise<OctaneApplicationModule>;
  readonly options?: Omit<RootOptions, 'signalOwner' | 'externalSnapshots'>;
  /** This browser compilation's native Module Federation runtime. */
  readonly federation?: NativeFederationBinding;
  readonly workerFederation?:
    | OctaneWorkerFederationScope
    | OctaneWorkerFederationFactory;
  /** Trusted document bootstrap identity, also present for a CSR document. */
  readonly documentId?: string;
}

export interface OctaneHydrationOptions extends OctaneApplicationOptions {
  readonly documentIdentity: RendererIdentity;
  readonly documentNativeHydrationBuildId: string;
  readonly documentId: string;
}

const roots = new WeakMap<RootContainer, symbol>();
const documents = new WeakMap<Document, symbol>();
const moduleResources = new WeakMap<
  () => void,
  { users: number; retired: boolean }
>();

function claimModuleResources(
  application: OctaneApplicationModule,
): () => void {
  const dispose = application.dispose;
  if (!dispose) return () => {};
  let resources = moduleResources.get(dispose);
  if (resources?.retired) {
    throw new Error(
      'A retired Octane application requires a fresh module resource instance.',
    );
  }
  if (!resources) {
    resources = { users: 0, retired: false };
    moduleResources.set(dispose, resources);
  }
  resources.users++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    resources.users--;
    if (resources.users === 0 && !resources.retired) {
      resources.retired = true;
      dispose();
    }
  };
}

function retireAbandonedModule(application: OctaneApplicationModule): void {
  if (application.dispose && moduleResources.get(application.dispose)?.users)
    return;
  if (application.dispose && moduleResources.get(application.dispose)?.retired)
    return;
  claimModuleResources(application)();
}

function observeRootErrors(options: OctaneApplicationOptions['options']) {
  let failed = false;
  let failure: unknown;
  let handle: OctaneApplicationHandle | undefined;
  return {
    options: {
      ...options,
      onUncaughtError(error: unknown) {
        if (failed) return;
        failed = true;
        failure = error;
        if (handle) {
          // Native reporting can occur inside a flush. Retire the application
          // after that flush so unmount does not reenter the native renderer.
          const failedHandle = handle;
          queueMicrotask(() => {
            try {
              failedHandle.dispose();
            } catch (cleanupError) {
              failure = new AggregateError(
                [error, cleanupError],
                'Octane rendering and cleanup failed.',
              );
            }
            if (options?.onUncaughtError) options.onUncaughtError(failure);
            else throw failure;
          });
        }
      },
    },
    attach(next: OctaneApplicationHandle) {
      handle = next;
    },
    assertInitialRender() {
      if (failed) {
        options?.onUncaughtError?.(failure);
        throw failure;
      }
    },
  };
}

function claimRoot(container: RootContainer): () => void {
  if (container.nodeType === 9) {
    throw new Error(
      'An Octane application requires a subtree root in its framework-owned document.',
    );
  }
  if (roots.has(container)) {
    throw new Error('An Octane application already owns this root container.');
  }
  const owner = Symbol('Octane root owner');
  roots.set(container, owner);
  return () => {
    if (roots.get(container) === owner) roots.delete(container);
  };
}

function cleanupResources(cleanups: (() => void)[]): void {
  const errors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, 'Octane application cleanup failed.');
  }
}

function reportCleanupError(
  input: OctaneApplicationOptions,
  error: unknown,
): void {
  if (input.options?.onUncaughtError) input.options.onUncaughtError(error);
  else
    queueMicrotask(() => {
      throw error;
    });
}

/** An import cannot be aborted, but its root and bridge leases can be. */
function loadApplication(
  input: OctaneApplicationOptions,
  abandon: () => void,
): Promise<{
  application: OctaneApplicationModule;
  releaseModule: () => void;
}> {
  const acquire = (application: OctaneApplicationModule) => {
    try {
      validateModule(application);
    } catch (error) {
      if (application && typeof application.dispose === 'function')
        retireAbandonedModule(application);
      throw error;
    }
    return { application, releaseModule: claimModuleResources(application) };
  };
  const { signal } = input;
  if (!signal) return input.load().then(acquire);
  return new Promise((resolve, reject) => {
    let settled = false;
    let abandoned = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      abandoned = true;
      signal.removeEventListener('abort', onAbort);
      try {
        abandon();
        reject(signal.reason);
      } catch (cleanupError) {
        reject(
          new AggregateError(
            [signal.reason, cleanupError],
            'Octane startup cancellation failed.',
          ),
        );
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    let loading: Promise<OctaneApplicationModule>;
    try {
      loading = input.load();
    } catch (error) {
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
      return;
    }
    loading.then(
      application => {
        if (abandoned) {
          // Other consumers of the same import reserve resources in their
          // resolution callbacks before an abandoned consumer can retire them.
          queueMicrotask(() => {
            try {
              retireAbandonedModule(application);
            } catch (error) {
              reportCleanupError(input, error);
            }
          });
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        try {
          resolve(acquire(application));
        } catch (error) {
          reject(error);
        }
      },
      error => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function validateModule(application: OctaneApplicationModule): void {
  if (!application || typeof application.default !== 'function') {
    throw new TypeError(
      'An Octane application module must default-export a native component.',
    );
  }
  if (
    application.dispose !== undefined &&
    typeof application.dispose !== 'function'
  ) {
    throw new TypeError('An Octane application disposer must be a function.');
  }
}

function createHandle(input: {
  root: Root;
  identity: RendererIdentity;
  releaseModule: () => void;
  release: () => void;
  bridge?: StreamedSignalHydration;
  signal?: AbortSignal;
  onCleanupError?: (error: unknown) => void;
  federation?: OctaneFederationScope;
  workerFederation?: OctaneWorkerFederationScope;
  retireWorkerFederation?: () => void;
}): OctaneApplicationHandle {
  let releaseModule = input.releaseModule;
  let disposed = false;
  const handle: OctaneApplicationHandle = {
    root: input.root,
    identity: Object.freeze({ ...input.identity }),
    update(next) {
      if (disposed)
        throw new Error('Cannot update a disposed Octane application.');
      validateModule(next);
      const previousRelease = releaseModule;
      const nextRelease = claimModuleResources(next);
      releaseModule = nextRelease;
      try {
        input.workerFederation
          ? input.root.render(WorkerFederationApplication, {
              scope: input.workerFederation,
              federation: input.federation,
              application: next,
            })
          : input.federation
            ? input.root.render(FederationApplication, {
                scope: input.federation,
                application: next,
              })
            : input.root.render(next.default, next.props);
        previousRelease();
      } catch (error) {
        cleanupResources([previousRelease, () => handle.dispose()]);
        throw error;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      input.signal?.removeEventListener('abort', onAbort);
      cleanupResources([
        () => input.retireWorkerFederation?.(),
        () => input.root.unmount(),
        () => releaseModule(),
        () => input.bridge?.dispose(),
        input.release,
      ]);
    },
  };
  function onAbort() {
    // An abort can originate in a native render/layout effect. Retire after
    // the current flush, matching the native error retirement path.
    queueMicrotask(() => {
      try {
        handle.dispose();
      } catch (error) {
        input.onCleanupError?.(error);
      }
    });
  }
  // Callers check the signal synchronously before constructing the handle.
  input.signal?.addEventListener('abort', onAbort, { once: true });
  return handle;
}

async function startApplication(
  input: OctaneApplicationOptions,
  release: () => void,
  hydration?: { document: Document; documentId: string },
): Promise<OctaneApplicationHandle> {
  const errors = observeRootErrors(input.options);
  const workerController = input.workerFederation
    ? new AbortController()
    : undefined;
  let workerFederation: OctaneWorkerFederationScope | undefined;
  const retireWorkerFederation = () =>
    cleanupResources([
      () =>
        workerController?.abort(
          new DOMException(
            'The Worker federation document was disposed',
            'AbortError',
          ),
        ),
      () => workerFederation?.transport.dispose(),
    ]);
  let bridge: StreamedSignalHydration | undefined;
  let root: Root | undefined;
  let releaseModule: (() => void) | undefined;
  let handle: OctaneApplicationHandle | undefined;
  let cleaned = false;
  const cleanup = () => {
    if (handle) {
      handle.dispose();
      return;
    }
    if (cleaned) return;
    cleaned = true;
    cleanupResources([
      retireWorkerFederation,
      () => root?.unmount(),
      () => releaseModule?.(),
      () => bridge?.dispose(),
      release,
    ]);
  };
  try {
    if (input.workerFederation && workerController) {
      const signal = AbortSignal.any([
        workerController.signal,
        ...(input.signal ? [input.signal] : []),
      ]);
      const scope =
        typeof input.workerFederation === 'function'
          ? input.workerFederation(signal)
          : input.workerFederation;
      workerFederation = {
        ...scope,
        signal: scope.signal ? AbortSignal.any([signal, scope.signal]) : signal,
      };
    }
    if (workerFederation && !hydration && !input.documentId)
      throw new Error(
        'Worker federation requires the trusted document identity before application loading',
      );
    // Capture the host before imports and retain Worker SSR's provider ranges
    // even when no regular Module Federation binding is configured.
    const federation =
      input.federation || workerFederation
        ? createFederationScope(input.federation, false)
        : undefined;
    if (hydration) {
      const { document, documentId } = hydration;
      bridge = bootstrapStreamedSignalHydration({
        buildId: input.nativeHydrationBuildId,
        documentId,
        ...(document.defaultView === null
          ? {}
          : {
              target: document.defaultView as unknown as Record<
                string,
                unknown
              >,
            }),
      });
    }
    const loaded = await loadApplication(input, cleanup);
    const application = loaded.application;
    releaseModule = loaded.releaseModule;
    input.signal?.throwIfAborted();
    if (bridge) {
      root = hydrateRoot(
        input.container,
        workerFederation
          ? WorkerFederationApplication
          : federation
            ? FederationApplication
            : application.default,
        workerFederation
          ? { scope: workerFederation, federation, application }
          : federation
            ? { scope: federation, application }
            : application.props,
        {
          ...errors.options,
          signalOwner: bridge.signalOwner,
          externalSnapshots: { documentId: hydration!.documentId },
        },
      );
    } else {
      root = createRoot(input.container, {
        ...errors.options,
        ...(input.documentId
          ? { externalSnapshots: { documentId: input.documentId } }
          : {}),
      });
      workerFederation
        ? root.render(WorkerFederationApplication, {
            scope: workerFederation,
            federation,
            application,
          })
        : federation
          ? root.render(FederationApplication, {
              scope: federation,
              application,
            })
          : root.render(application.default, application.props);
    }
    errors.assertInitialRender();
    input.signal?.throwIfAborted();
    handle = createHandle({
      root,
      identity: input.identity,
      releaseModule,
      release,
      bridge,
      federation,
      workerFederation,
      retireWorkerFederation,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      onCleanupError: error => reportCleanupError(input, error),
    });
    errors.attach(handle);
    return handle;
  } catch (error) {
    cleanup();
    throw error;
  }
}

export async function mountOctaneApplication(
  input: OctaneApplicationOptions,
): Promise<OctaneApplicationHandle> {
  assertOctaneIdentity(input.identity);
  assertNativeHydrationBuildId(input.nativeHydrationBuildId);
  input.signal?.throwIfAborted();
  return startApplication(input, claimRoot(input.container));
}

export async function hydrateOctaneApplication(
  input: OctaneHydrationOptions,
): Promise<OctaneApplicationHandle> {
  assertOctaneIdentity(input.identity);
  assertNativeHydrationBuildId(input.nativeHydrationBuildId);
  assertNativeHydrationBuildId(input.documentNativeHydrationBuildId);
  if (input.nativeHydrationBuildId !== input.documentNativeHydrationBuildId) {
    throw new Error(
      'Octane hydration bytes belong to a different native client compilation.',
    );
  }
  assertRendererIdentity(input.documentIdentity, input.identity);
  input.signal?.throwIfAborted();
  if (
    typeof input.documentId !== 'string' ||
    input.documentId.trim().length === 0
  ) {
    throw new Error('Octane hydration requires a nonempty document identity.');
  }
  const document = input.container.ownerDocument;
  if (!document)
    throw new Error('An Octane hydration root requires a document.');
  if (document !== globalThis.document) {
    throw new Error(
      'Octane hydration requires a root in the active browser document.',
    );
  }
  if (documents.has(document)) {
    throw new Error('An Octane signal bridge already owns this document.');
  }
  const releaseRoot = claimRoot(input.container);
  const documentOwner = Symbol(input.documentId);
  documents.set(document, documentOwner);
  const release = () => {
    releaseRoot();
    if (documents.get(document) === documentOwner) documents.delete(document);
  };
  return startApplication(input, release, {
    document,
    documentId: input.documentId,
  });
}
