import type { NativeWorkerDispatchOptions } from '@modern-js/renderer-core/server';
import {
  type AdmitWorkerRendererContract,
  createWorkerFederationHandler,
  createWorkerFederationTransport,
} from '@modern-js/renderer-core/worker-federation';
import {
  type ExternalSnapshotRenderOptions,
  prepareExternalSnapshotRequest,
  releasePreparedExternalSnapshotRequest,
  renderExternalSnapshot,
  type ServerRenderNode,
  serializeExternalSnapshot,
} from 'octane/server';
import { createFederationScope, FederationContext } from './federation-context';
import { WorkerFederationContext } from './worker-federation-context';

type NativeSnapshotRequest = Awaited<
  ReturnType<typeof prepareExternalSnapshotRequest>
>;
type HandlerOptions = Parameters<
  typeof createWorkerFederationHandler<NativeSnapshotRequest>
>[0];

function isNativeWorkerComponent(
  value: unknown,
): value is Extract<ServerRenderNode, (props: never) => unknown> {
  return typeof value === 'function';
}

/** The compiled registry pins its renderer publication and literal imports. */
export interface OctaneWorkerFederationRegistry {
  initialize(
    options: Omit<HandlerOptions, 'publication' | 'exposes'> & {
      publication: unknown;
    },
  ): (request: Request) => Promise<Response | undefined>;
}

/** Created per dispatch; no publisher or native snapshot cache crosses documents. */
export function createNativeWorkerFederationRuntime<Bindings extends object>(
  options: NativeWorkerDispatchOptions<Bindings>,
  compiler: {
    readonly admitRendererContract: AdmitWorkerRendererContract;
    readonly registry?: OctaneWorkerFederationRegistry;
  },
) {
  const { resources } = options;
  const bindings = options.bindings;
  const transport = resources.workerFederationServices?.length
    ? createWorkerFederationTransport({
        admitRendererContract: compiler.admitRendererContract,
        services: resources.workerFederationServices.map(service => {
          const binding: unknown =
            bindings && Reflect.get(bindings, service.binding);
          if (
            !binding ||
            (typeof binding !== 'object' && typeof binding !== 'function') ||
            !('fetch' in binding) ||
            typeof binding.fetch !== 'function'
          )
            throw new Error(
              `Native Worker federation requires service binding ${service.binding}.`,
            );
          return { ...service, fetch: binding.fetch.bind(binding) };
        }),
      })
    : undefined;
  let handle: ((request: Request) => Promise<Response | undefined>) | undefined;
  if (resources.workerFederation) {
    if (!compiler.registry || !resources.workerFederationManifestUrl)
      throw new Error(
        'Native Worker federation requires its compiled expose registry and pinned manifest URL.',
      );
    handle = compiler.registry.initialize({
      publication: resources.workerFederation.worker,
      manifestUrl: resources.workerFederationManifestUrl,
      admitRendererContract: compiler.admitRendererContract,
      admitNativeRequest(payload, { admitted, signal }) {
        const initializeContexts: ExternalSnapshotRenderOptions['initializeContexts'] =
          transport
            ? (provide, request) => {
                provide(
                  FederationContext,
                  createFederationScope(undefined, true, request.nonce),
                );
                provide(WorkerFederationContext, {
                  transport,
                  locale: admitted.locale,
                  signal,
                });
              }
            : undefined;
        return prepareExternalSnapshotRequest(payload, {
          authority: admitted.coordinate.native,
          signal,
          ...(initializeContexts ? { initializeContexts } : {}),
        });
      },
      releaseNativeRequest: releasePreparedExternalSnapshotRequest,
      async renderNativeSnapshot(module, request, { admitted }) {
        const component =
          module && typeof module === 'object' && 'default' in module
            ? module.default
            : undefined;
        if (!isNativeWorkerComponent(component))
          throw new TypeError(
            `Native Worker expose ${admitted.expose} requires a default Octane component.`,
          );
        return serializeExternalSnapshot(
          await renderExternalSnapshot(component, request),
        );
      },
    });
  }
  return {
    transport,
    handleRequest: handle ?? (() => Promise.resolve(undefined)),
  };
}
