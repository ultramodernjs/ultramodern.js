import { collectDocumentAssets, type DocumentAsset } from '../document';
import { assertRendererIdentity, type RendererIdentity } from '../identity';
import type {
  WorkerFederationPublication,
  WorkerFederationTransport,
} from '../worker-federation';
import { dispatchNativeRequest, rejectNativeRscRequest } from './dispatch';
import type {
  NativeExecutionContext,
  NativeServerConfig,
  NativeServerManifest,
} from './types';

/** Build-validated per-entry inputs a worker bundle cannot read from disk. */
export interface NativeWorkerEntryResources {
  readonly assets: readonly DocumentAsset[];
  /** Opaque compiler-owned JSON, revalidated by the native request handler. */
  readonly nativeManifest?: unknown;
  readonly hydrationBuildId?: string;
  readonly serverConfig: NativeServerConfig;
  /** Present only when the entry admits a CSR fallback request. */
  readonly csrFallbackHeader?: string;
  readonly nonce?: string;
  readonly workerFederation?: {
    readonly renderer: unknown;
    readonly worker: WorkerFederationPublication;
  };
  readonly workerFederationManifestUrl?: string;
  readonly workerFederationServices?: readonly {
    readonly remote: string;
    readonly alias?: string;
    readonly manifestUrl: string;
    readonly binding: string;
    readonly fragments: readonly {
      readonly expose: string;
      readonly boundaryId: string;
      readonly paths: Readonly<Record<string, string>>;
    }[];
  }[];
}

export interface NativeWorkerDispatchOptions<Bindings extends object> {
  readonly identity: RendererIdentity;
  /** The imported worker bundle: its namespace or default-exported manifest. */
  readonly bundle: unknown;
  readonly resources: NativeWorkerEntryResources;
  /** The module worker `env`, forwarded unchanged as the platform binding. */
  readonly bindings: Bindings | undefined;
  readonly executionContext?: NativeExecutionContext;
  /** Constructed by this compiled renderer entry for this document only. */
  readonly workerFederation?: WorkerFederationTransport;
}

function workerManifest<Bindings extends object>(
  bundle: unknown,
  identity: RendererIdentity,
): NativeServerManifest<Bindings> {
  const candidate =
    bundle &&
    typeof bundle === 'object' &&
    !('rendererIdentity' in bundle) &&
    'default' in bundle
      ? bundle.default
      : bundle;
  if (
    !candidate ||
    (typeof candidate !== 'object' && typeof candidate !== 'function') ||
    !('rendererIdentity' in candidate) ||
    !('nativeRequestHandler' in candidate) ||
    typeof candidate.nativeRequestHandler !== 'function'
  ) {
    throw new Error(
      'Native worker bundle requires its renderer identity and request handler.',
    );
  }
  assertRendererIdentity(
    candidate.rendererIdentity as RendererIdentity,
    identity,
  );
  return candidate as NativeServerManifest<Bindings>;
}

/** Worker Fetch dispatch over the same native handler the Node host loads. */
export function dispatchNativeWorkerRequest<Bindings extends object>(
  request: Request,
  options: NativeWorkerDispatchOptions<Bindings>,
): Promise<Response> {
  const rejection = rejectNativeRscRequest(request);
  if (rejection) return Promise.resolve(rejection);
  const { resources } = options;
  const query = new URL(request.url).searchParams;
  const forceCSR = Boolean(
    resources.csrFallbackHeader &&
      (query.get('csr') || request.headers.get(resources.csrFallbackHeader)),
  );
  const bindings = (
    options.bindings !== null && typeof options.bindings === 'object'
      ? options.bindings
      : {}
  ) as Bindings;
  return dispatchNativeRequest<Bindings>(request, {
    identity: options.identity,
    platform: 'worker',
    executionContext: options.executionContext,
    hydrationBuildId: resources.hydrationBuildId,
    loadManifest: () =>
      workerManifest<Bindings>(options.bundle, options.identity),
    context: {
      assets: collectDocumentAssets(resources.assets),
      nativeManifest: resources.nativeManifest,
      bindings,
      serverConfig: { ...resources.serverConfig, forceCSR },
      nonce: resources.nonce,
      workerFederation: options.workerFederation,
    },
  });
}
