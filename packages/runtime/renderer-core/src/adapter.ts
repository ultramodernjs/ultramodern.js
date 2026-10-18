import type { RsbuildPlugin } from '@rsbuild/core';
import type { Renderer, RendererIdentity } from './identity';

/**
 * Renderer adapters are build-side descriptors. A renderer package exports one
 * from its `./plugin` entry; UltraModern loads only the selected adapter and
 * drives native entries, compilation, artifacts, deployment and scaffolding
 * from its data. Nothing here is imported by application runtime code.
 */

export interface RendererBuildProfile<TRenderer extends Renderer = Renderer> {
  renderer: TRenderer;
  status: 'stable' | 'preview';
  protocolVersion: 1;
  minimumNode: '26.12.0';
  hmr: {
    editedBoundary: 'may-reset';
    unaffectedComponents: 'preserved';
    document: 'preserved';
    roots: 'single';
    cleanup: 'exactly-once';
  };
  compiler: { name: string; version: string };
  hydration: { name: string; version: string };
  router: {
    name: string;
    version: string;
    coreName: string;
    coreVersion: string;
  };
  sourceExtensions: readonly string[];
  jsxImportSource: string;
  dependencies: Readonly<Record<string, string>>;
  capabilities: {
    worker: boolean;
    /**
     * `true`: Module Federation with SSR. React federates through the React
     * MF plugin; native renderers server-render same-renderer federated
     * components from a native module-federation.config.
     * `'client'`: native same-renderer federated components rendered on the
     * client only.
     */
    moduleFederation: boolean | 'client';
    rsc: boolean;
    ssg: boolean;
    i18n: boolean;
    svgComponent: boolean;
  };
}

export interface NativeRendererCompilerOptions {
  /** The selected native infrastructure owns these source-build identities. */
  rendererIdentities(): Readonly<Record<string, RendererIdentity>>;
  /** Rsbuild environment that renders server documents inside a web worker. */
  readonly workerEnvironmentName: string;
}

export interface NativeCompilerArtifactContext {
  /** Hash from the completed client compiler, when validating emitted output. */
  readonly compilationHash?: string;
  /** Hydration identity retained with a development snapshot. */
  readonly hydrationBuildId?: string;
  readonly development?: boolean;
}

export interface ValidatedNativeCompilerArtifact {
  readonly nativeManifest: unknown;
  /** Optional compiler-owned hydration and document cache identity. */
  readonly hydrationBuildId?: string;
}

/** The selected compiler owns its artifact ABI; lifecycle consumers keep it opaque. */
export interface NativeCompilerArtifacts {
  clientManifestFile(entryName: string): string;
  validateClientManifest(
    value: unknown,
    identity: RendererIdentity,
    context: NativeCompilerArtifactContext,
  ): Promise<ValidatedNativeCompilerArtifact>;
  isMutableDevelopmentAsset(
    filename: string,
    entryNames: readonly string[],
  ): boolean;
}

/** Public modules the generated native entries and the host import. */
export interface NativeRendererRuntime {
  /** The renderer's own reactive runtime package, e.g. `solid-js`. */
  readonly package: string;
  /** The renderer package that owns this adapter and its runtime modules. */
  readonly bootstrap: string;
  readonly entryClient: string;
  readonly entryServer: string;
  readonly router: string;
  readonly i18n?: string;
  /**
   * Exports the renderer's `compilerArtifacts`, which the production server
   * loads to validate compiler module manifests; also proves the installed
   * owner.
   */
  readonly manifest: string;
}

export interface NativeRendererFederation {
  /** Runtime singletons a host and every remote share (`pkg/` for subpaths). */
  readonly shared: readonly string[];
  /** Required providers, with the native import each compilation owns. */
  readonly sharedByEnvironment?: Readonly<
    Record<'client' | 'server', Readonly<Record<string, string>>>
  >;
  /** Browser container format, matching the renderer's client chunks. */
  readonly library: 'module';
  /** Whether federated components also render on the server. */
  readonly ssr: boolean;
}

export interface RendererWorkerSupport {
  /** Worker documents come from the renderer's native server handler. */
  readonly nativeDocuments: boolean;
  readonly rsc: boolean;
}

export interface NativeEntryClientStub {
  /** Ambient declarations the generated client entry needs. */
  readonly declarations: string;
  /** Extra `startNativeClient` fields, as source expressions. */
  readonly fields: Readonly<Record<string, string>>;
}

export interface RendererAppSourceOptions {
  appId: string;
  title: string;
  entryName: string;
  sourceExtension: '.tsx' | '.tsrx';
  jsxImportSource: string;
  capabilities: { ssr: boolean; federation: boolean };
}

export interface RendererAppSources {
  sourceExtension: '.tsx' | '.tsrx';
  jsxImportSource: string;
  artifacts: { path: string; content: string }[];
}

export interface RendererCreatePackages {
  /** Framework packages the generated application depends on directly. */
  frameworkDependencies: readonly string[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  typecheckCommand?: string;
  tsconfig?: Record<string, unknown>;
}

export interface RendererCreateSupport {
  /** Deployment templates the adapter admits in generated workspaces. */
  readonly templates?: {
    readonly federation: boolean;
    readonly workers: boolean;
  };
  dependencies(
    profile: RendererBuildProfile,
    context: { readonly typescriptVersion: string },
  ): RendererCreatePackages;
  generateAppSources(options: RendererAppSourceOptions): RendererAppSources;
}

interface RendererAdapterDescriptor<TRenderer extends Renderer> {
  readonly name: TRenderer;
  readonly profile: RendererBuildProfile<TRenderer>;
  readonly routerFrameworks: readonly string[];
  readonly worker: RendererWorkerSupport;
  readonly create?: RendererCreateSupport;
}

export interface NativeRendererAdapter<TRenderer extends Renderer = Renderer>
  extends RendererAdapterDescriptor<TRenderer> {
  readonly kind: 'native';
  readonly runtime: NativeRendererRuntime;
  readonly federation?: NativeRendererFederation;
  readonly entryClient?: NativeEntryClientStub;
  /**
   * Who links the stylesheets of lazy components in a server document.
   * `'renderer'`: the server render links each one beside the markup it
   * renders. `'document'`: the render cannot report which lazy modules it
   * rendered, so the document links every lazy stylesheet up front.
   */
  readonly lazyStyles: 'renderer' | 'document';
  /** Path of a CommonJS module exporting `(parts) => source` for `?component` SVGs. */
  svgComponentTemplate?(): string;
  /** The renderer compiler; UltraModern applies SVG and ownership policy. */
  compiler(options: NativeRendererCompilerOptions): RsbuildPlugin;
  readonly artifacts: NativeCompilerArtifacts;
  assertSupportedSource?(source: string | false | undefined): Promise<void>;
}

/** A renderer composed from an existing plugin stack (React only). */
export interface ComposedRendererAdapter<
  TRenderer extends Renderer = Renderer,
  TPlugin = unknown,
  TPolicy = unknown,
> extends RendererAdapterDescriptor<TRenderer> {
  readonly kind: 'composed';
  /** Public modules whose installed owners pin the profile versions. */
  readonly frameworkModules: readonly {
    readonly specifier: string;
    readonly request: string;
  }[];
  compose(consumerPlugins: readonly TPlugin[], policy?: TPolicy): TPlugin;
}

export type RendererAdapter<TRenderer extends Renderer = Renderer> =
  | NativeRendererAdapter<TRenderer>
  | ComposedRendererAdapter<TRenderer>;

const adapterError = (name: unknown, detail: string) =>
  new Error(`Invalid renderer adapter ${String(name)}: ${detail}`);

/** Validate an adapter's internal consistency and freeze its descriptor data. */
export function defineRendererAdapter<T extends RendererAdapter>(
  adapter: T,
): T {
  const { name, profile } = adapter;
  if (profile.renderer !== name)
    throw adapterError(name, `profile names ${profile.renderer}`);
  if (!adapter.routerFrameworks.length)
    throw adapterError(name, 'it declares no router framework');
  if (adapter.worker.rsc !== profile.capabilities.rsc)
    throw adapterError(name, 'worker RSC support contradicts its profile');
  if (adapter.kind === 'native') {
    if (adapter.worker.nativeDocuments !== true)
      throw adapterError(name, 'native documents come from its server handler');
    const federation = adapter.federation;
    const capability = profile.capabilities.moduleFederation;
    if (
      (federation === undefined) !== (capability === false) ||
      (federation !== undefined && federation.ssr !== (capability === true))
    )
      throw adapterError(name, 'federation support contradicts its profile');
  }
  return Object.freeze(adapter);
}

/** Third-party runtime packages a generated native application installs. */
export function nativeRendererDependencies(
  profile: RendererBuildProfile,
): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(profile.dependencies).filter(
        ([name]) => !name.startsWith('@modern-js/'),
      ),
    ),
    [profile.router.coreName]:
      profile.dependencies[profile.router.coreName] ??
      profile.router.coreVersion,
  };
}
