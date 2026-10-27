import { createHash } from 'node:crypto';
import path from 'node:path';
import { mime } from '@modern-js/utils';
import { type Rspack, rspack } from '@rsbuild/core';
import { nativeFederationDevGraphPublicPath } from './native-federation-dev-public-path';

export interface NativeDevelopmentAsset {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly immutable?: boolean;
  readonly revision?: string;
  readonly graphManifest?: string;
}

export const NATIVE_FEDERATION_DEV_REVISION_HEADER =
  'x-ultramodern-mf-revision';

/** Stable across identical compiles; changes with any admitted container asset. */
export function nativeFederationDevRevision(
  assets: ReadonlyMap<string, NativeDevelopmentAsset>,
): string {
  const hash = createHash('sha256');
  for (const [url, asset] of [...assets].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    hash.update(`${Buffer.byteLength(url)}:`).update(url);
    hash.update(`${asset.bytes.length}:`).update(asset.bytes);
  }
  return hash.digest('hex');
}

const retainedFederationBudget = 256 * 1024 * 1024;

/** Prepare atomically. Old hosts retain their admitted graphs; exceeding the
 * budget refuses the next publication rather than evicting an unknown reader. */
export function retainNativeFederationDevAssets(
  retained: ReadonlyMap<string, NativeDevelopmentAsset>,
  candidate: ReadonlyMap<string, NativeDevelopmentAsset>,
  budget = retainedFederationBudget,
): ReadonlyMap<string, NativeDevelopmentAsset> {
  if (!Number.isSafeInteger(budget) || budget < 0)
    throw new Error(
      'Native federation graph retention requires a nonnegative byte budget',
    );
  const next = new Map(retained);
  // Include URL bytes so even an empty emitted asset has a bounded cost.
  let bytes = [...retained].reduce(
    (total, [url, asset]) =>
      total + Buffer.byteLength(url) + asset.bytes.length,
    0,
  );
  for (const [url, asset] of candidate) {
    if (!asset.immutable) continue;
    const existing = next.get(url);
    if (existing) {
      if (
        existing.contentType !== asset.contentType ||
        !existing.bytes.equals(asset.bytes)
      )
        throw new Error(
          `Native federation immutable graph changed at ${url}; restart the development server before publishing it`,
        );
      continue;
    }
    bytes += Buffer.byteLength(url) + asset.bytes.length;
    if (bytes > budget)
      throw new Error(
        `Native federation retained graph budget exceeded (${bytes} > ${budget} bytes); restart the development server to release old graphs before publishing another build`,
      );
    next.set(url, asset);
  }
  return next;
}

interface NativeFederationContainer {
  readonly name: string;
  readonly browserManifest?: string;
}

export interface NativeFederationDevGraph {
  readonly publicPath: string;
  readonly manifest: string;
  readonly immutableManifest: string;
}

/** The native MF owner marks its container, rather than exposing server output. */
const containers = new WeakMap<Rspack.Compilation, NativeFederationContainer>();
const compilerContainers = new WeakMap<
  Rspack.Compiler,
  NativeFederationContainer
>();

/** The configured discovery route is owned before its first graph publishes. */
export function nativeFederationDevManifest(
  compiler: Rspack.Compiler,
): string | undefined {
  const descriptor = compilerContainers.get(compiler);
  if (!descriptor?.browserManifest) return;
  const publicPath = compiler.options.output.publicPath;
  if (typeof publicPath !== 'string')
    throw new Error(
      'Native development federation requires a browser publicPath',
    );
  return new URL(
    descriptor.browserManifest,
    publicPath.endsWith('/') ? publicPath : `${publicPath}/`,
  ).href;
}

export function nativeFederationDevGraph(
  result: Rspack.Stats,
): NativeFederationDevGraph | undefined {
  const compilation = result.compilation;
  const descriptor = containers.get(compilation);
  if (!descriptor?.browserManifest) return;
  const publicPath = compilation.outputOptions.publicPath;
  if (typeof publicPath !== 'string' || !compilation.fullHash)
    throw new Error(
      'Native development federation requires a completed browser publicPath and full hash',
    );
  return {
    publicPath,
    manifest: new URL(
      descriptor.browserManifest,
      publicPath.endsWith('/') ? publicPath : `${publicPath}/`,
    ).href,
    immutableManifest: new URL(
      descriptor.browserManifest,
      nativeFederationDevGraphPublicPath(publicPath, compilation.fullHash),
    ).href,
  };
}

export class NativeFederationDevAssetsPlugin {
  constructor(
    private readonly container: string,
    private readonly options: { readonly browserManifest?: string } = {},
  ) {}

  apply(compiler: Rspack.Compiler): void {
    const name = 'UltraModernFederationDevAssets';
    compilerContainers.set(compiler, { name: this.container, ...this.options });
    compiler.hooks.thisCompilation.tap(name, compilation => {
      containers.set(compilation, { name: this.container, ...this.options });
      const manifestFile = this.options.browserManifest;
      if (!manifestFile) return;
      if (!safeAssetPathname(`/${manifestFile}`))
        throw new Error('Unsafe native development federation manifest path');
      const publicPath = compilation.outputOptions.publicPath;
      if (typeof publicPath !== 'string')
        throw new Error(
          'Native development federation requires an explicit browser publicPath',
        );
      const graphPublicPath = publicPath;
      class GraphPublicPathRuntimeModule extends rspack.RuntimeModule {
        constructor() {
          super(
            'native federation graph publicPath',
            rspack.RuntimeModule.STAGE_ATTACH,
          );
          // Participate in Rspack's full-hash runtime regeneration so hot apply
          // also advances publicPath before a previously unloaded chunk loads.
          this.fullHash = true;
        }
        generate() {
          // Rspack generates once before its full hash exists, then regenerates
          // fullHash modules during final hashing. Emit that completed graph
          // directly: HMR may execute this module before installing its new
          // hash getter, so reading the getter can address a different graph.
          const graph = nativeFederationDevGraphPublicPath(
            graphPublicPath,
            this.compilation?.fullHash || undefined,
          );
          return `${rspack.RuntimeGlobals.publicPath} = ${JSON.stringify(graph)};`;
        }
      }
      compilation.hooks.additionalTreeRuntimeRequirements.tap(
        name,
        (chunk, requirements) => {
          if (chunk.name !== this.container) return;
          requirements.add(rspack.RuntimeGlobals.publicPath);
          compilation.addRuntimeModule(
            chunk,
            new GraphPublicPathRuntimeModule(),
          );
        },
      );
      // MF emits its manifest at OPTIMIZE_TRANSFER. Publish its final browser
      // graph prefix afterwards, preserving the independently owned Node URL.
      compilation.hooks.processAssets.tap(
        { name, stage: rspack.Compilation.PROCESS_ASSETS_STAGE_REPORT + 1 },
        () => {
          const asset = compilation.getAsset(manifestFile);
          if (!asset || !compilation.fullHash)
            throw new Error(
              'Native development federation browser manifest was not emitted by a completed compilation',
            );
          const manifest = JSON.parse(asset.source.source().toString());
          if (
            !manifest ||
            typeof manifest !== 'object' ||
            !manifest.metaData ||
            typeof manifest.metaData !== 'object' ||
            manifest.metaData.name !== this.container
          )
            throw new Error(
              'Native development federation manifest belongs to another container',
            );
          manifest.metaData.publicPath = nativeFederationDevGraphPublicPath(
            publicPath,
            compilation.fullHash,
          );
          compilation.updateAsset(
            manifestFile,
            new rspack.sources.RawSource(JSON.stringify(manifest)),
          );
        },
      );
    });
  }
}

function safeAssetPathname(pathname: string): boolean {
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return false;
  try {
    return pathname.split('/').every(segment => {
      const decoded = decodeURIComponent(segment);
      return decoded !== '.' && decoded !== '..' && !/[\\/\0]/u.test(decoded);
    });
  } catch {
    return false;
  }
}

/** Only the current completed container graph may be fetched by another host. */
export async function collectNativeFederationDevAssets(
  result: Rspack.Stats,
  privateEntries: readonly string[],
  readAsset: (name: string) => Promise<Buffer>,
): Promise<ReadonlyMap<string, NativeDevelopmentAsset>> {
  const assets = new Map<string, NativeDevelopmentAsset>();
  const compilation = result.compilation;
  const descriptor = containers.get(compilation);
  if (!descriptor) return assets;
  const container = descriptor.name;
  if (privateEntries.includes(container))
    throw new Error(
      'Native development federation container conflicts with an application entry',
    );
  const entry = compilation.entrypoints.get(container);
  if (!entry)
    throw new Error(
      `Native development federation container ${container} was not emitted`,
    );
  const graph = nativeFederationDevGraph(result);
  const publicPath = graph
    ? nativeFederationDevGraphPublicPath(
        graph.publicPath,
        compilation.fullHash!,
      )
    : compilation.outputOptions.publicPath;
  const prefix = typeof publicPath === 'string' ? URL.parse(publicPath) : null;
  if (
    !prefix ||
    !['http:', 'https:'].includes(prefix.protocol) ||
    prefix.username ||
    prefix.password ||
    prefix.search ||
    prefix.hash ||
    !safeAssetPathname(prefix.pathname)
  )
    throw new Error(
      'Native development federation requires an explicit safe HTTP publicPath',
    );
  if (!prefix.pathname.endsWith('/')) prefix.pathname += '/';
  const privateFiles = new Set(
    privateEntries.flatMap(name => [
      ...(compilation.entrypoints.get(name)?.getEntrypointChunk().files ?? []),
    ]),
  );
  const chunks = entry.getEntrypointChunk().getAllReferencedChunks();
  const files = new Set(
    chunks
      .flatMap(chunk => [...chunk.files])
      .filter(name => /\.(?:[cm]?js|css)$/u.test(name)),
  );
  for (const chunk of chunks)
    for (const name of chunk.auxiliaryFiles) {
      const type = mime.contentType(path.extname(name));
      if (
        type &&
        /^(?:image\/|font\/|audio\/|video\/|application\/(?:wasm|vnd\.ms-fontobject|font-sfnt)(?:;|$))/u.test(
          type,
        )
      )
        files.add(name);
    }
  if (descriptor.browserManifest) files.add(descriptor.browserManifest);
  for (const name of files) {
    if (privateFiles.has(name) || /\.hot-update\./u.test(name)) continue;
    const asset = compilation.getAsset(name);
    if (!asset)
      throw new Error(
        `Native development federation asset ${name} was not emitted`,
      );
    if (
      asset.info.hotModuleReplacement ||
      asset.info.development ||
      (name !== descriptor.browserManifest &&
        asset.info.sourceFilename &&
        /\.(?:map|json|[cm]?[jt]sx?|g[jt]s|ya?ml|toml)$|(?:^|[/\\])\.env(?:\.|$)/u.test(
          asset.info.sourceFilename.split(/[?#]/u)[0],
        ))
    )
      continue;
    if (
      !name ||
      path.win32.isAbsolute(name) ||
      name
        .split('/')
        .some(segment => !segment || segment === '.' || segment === '..') ||
      /[\\\0?#]/u.test(name)
    )
      throw new Error(`Unsafe native development federation asset ${name}`);
    const url = new URL(
      name.split('/').map(encodeURIComponent).join('/'),
      prefix,
    );
    const published = {
      bytes: await readAsset(name),
      contentType:
        mime.contentType(path.extname(name)) || 'application/octet-stream',
      ...(graph ? { immutable: true } : {}),
    };
    assets.set(url.href, published);
    if (graph && name === descriptor.browserManifest)
      assets.set(graph.manifest, { ...published, immutable: false });
  }
  return assets;
}

/** Reject normalized traversal and alternate origins before exact lookup. */
export function resolveNativeFederationDevAsset(
  assets: ReadonlyMap<string, NativeDevelopmentAsset>,
  target: string,
  origin: string,
): NativeDevelopmentAsset | undefined {
  const pathname = target.split('?')[0];
  if (target.includes('#') || !safeAssetPathname(pathname)) return undefined;
  const url = URL.parse(target, origin);
  if (!url || url.pathname !== pathname) return undefined;
  url.search = '';
  return assets.get(url.href);
}

/** The stable discovery route belongs to this server's completed publication.
 * Its absolute public URL can use a different listener alias from the request.
 * Only that exact manifest is routed here; immutable assets keep exact origins. */
export function resolveNativeFederationDevManifest(
  assets: ReadonlyMap<string, NativeDevelopmentAsset>,
  target: string,
  manifest: string,
): NativeDevelopmentAsset | undefined {
  const published = URL.parse(manifest);
  if (!published) return;
  const requested = URL.parse(target, published.origin);
  if (requested?.pathname !== published.pathname) return;
  return resolveNativeFederationDevAsset(assets, target, published.origin);
}
