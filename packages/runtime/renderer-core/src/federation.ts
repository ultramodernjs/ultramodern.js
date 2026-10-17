/** The Node dev runtime captures assets before releasing a container load. */
const LOAD_WITH_CAPTURE = Symbol.for(
  'ultramodern.federation.load-with-capture',
);

/** The application compiler's native Module Federation runtime. */
export interface FederationInstance {
  /** The application's federation name, unique among this realm's instances. */
  readonly name?: string;
  loadRemote<T>(id: string): Promise<T | null>;
  [LOAD_WITH_CAPTURE]?: <T, Captured>(
    id: string,
    capture: (module: T | null, resolution?: LoadResolution) => Captured,
  ) => Promise<{ module: T | null; captured: Captured | undefined }>;
  readonly remoteHandler?: {
    readonly idToRemoteMap?: Record<string, { name: string; expose: string }>;
  };
  readonly moduleCache?: Map<string, { readonly remoteInfo: unknown }>;
  readonly snapshotHandler?: {
    getGlobalRemoteInfo(info: unknown): { remoteSnapshot?: RemoteSnapshot };
  };
}

interface RemoteSnapshot {
  readonly publicPath?: unknown;
  readonly remoteEntry?: unknown;
  readonly modules?: readonly {
    readonly modulePath?: unknown;
    readonly assets?: {
      readonly js?: { readonly sync?: readonly string[] };
      readonly css?: {
        readonly sync?: readonly string[];
        readonly async?: readonly string[];
      };
    };
  }[];
}

interface LoadResolution {
  readonly remoteSnapshot: unknown;
  readonly expose: string;
}

/** Generated entries retain their own compiler's host, including on the server. */
export interface NativeFederationBinding {
  readonly instance: () => FederationInstance;
  /**
   * Server bindings: the client module, relative to the client asset base,
   * that loads a server-rendered remote through this host before hydration.
   */
  readonly hydrationModule?: string;
}

export interface FederatedAssets {
  readonly js: readonly string[];
  readonly css: readonly string[];
}

/** Capture the host before importing application modules or remote containers. */
export function getFederationHost(
  binding: NativeFederationBinding | undefined,
): FederationInstance | undefined {
  if (binding === undefined) return undefined;
  if (typeof binding?.instance !== 'function')
    throw new TypeError('The native federation host binding is invalid.');
  const instance = binding.instance();
  if (!instance || typeof instance.loadRemote !== 'function')
    throw new TypeError('The application federation runtime has not started.');
  return instance;
}

/** Load through the selected application's runtime, never another app's host. */
export async function loadFederatedModule<T>(
  instance: FederationInstance | undefined,
  id: string,
): Promise<{ module: T; assets: FederatedAssets | undefined }> {
  if (!instance)
    throw new Error(
      `Cannot load ${id}: this application has no Module Federation runtime. Add module-federation.config.ts with its remotes.`,
    );
  const coupledLoad = instance[LOAD_WITH_CAPTURE];
  const result = coupledLoad
    ? await coupledLoad<T, FederatedAssets | undefined>(
        id,
        (_module, resolution) => remoteBrowserAssets(instance, id, resolution),
      )
    : {
        module: await instance.loadRemote<T>(id),
        captured: remoteBrowserAssets(instance, id),
      };
  const module = result.module;
  if (!module) throw new Error(`Remote module ${id} is unavailable`);
  return { module, assets: result.captured };
}

/** Browser assets from the native snapshot that admitted and loaded this remote. */
export function remoteBrowserAssets(
  instance: FederationInstance,
  id: string,
  resolution?: LoadResolution,
): FederatedAssets | undefined {
  const target = instance.remoteHandler?.idToRemoteMap?.[id];
  const loaded = target && instance.moduleCache?.get(target.name);
  const snapshot = (
    resolution
      ? resolution.remoteSnapshot
      : loaded &&
        instance.snapshotHandler?.getGlobalRemoteInfo(loaded.remoteInfo)
          .remoteSnapshot
  ) as RemoteSnapshot | undefined;
  if (
    !snapshot ||
    typeof snapshot.publicPath !== 'string' ||
    !snapshot.publicPath ||
    typeof snapshot.remoteEntry !== 'string' ||
    !snapshot.remoteEntry
  )
    return undefined;
  const expose = snapshot.modules?.find(
    module => module.modulePath === (resolution?.expose ?? target?.expose),
  );
  if (!expose?.assets) return undefined;
  const publicPath = snapshot.publicPath;
  const url = (file: string) =>
    /^(?:https?:)?\/\//iu.test(file)
      ? file
      : `${publicPath.replace(/\/$/u, '')}/${file.replace(/^\//u, '')}`;
  return {
    js: [url(snapshot.remoteEntry), ...(expose.assets.js?.sync ?? []).map(url)],
    css: [
      ...new Set(
        [
          ...(expose.assets.css?.sync ?? []),
          ...(expose.assets.css?.async ?? []),
        ].map(url),
      ),
    ],
  };
}
