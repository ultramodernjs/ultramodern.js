import { createHash } from 'node:crypto';
import path from 'node:path';
import { mime } from '@modern-js/utils';
import type { Rspack } from '@rsbuild/core';

export interface NativeDevelopmentAsset {
  readonly bytes: Buffer;
  readonly contentType: string;
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

/** The native MF owner marks its container, rather than exposing server output. */
const containers = new WeakMap<Rspack.Compilation, string>();

export class NativeFederationDevAssetsPlugin {
  constructor(private readonly container: string) {}

  apply(compiler: Rspack.Compiler): void {
    compiler.hooks.thisCompilation.tap(
      'UltraModernFederationDevAssets',
      compilation => containers.set(compilation, this.container),
    );
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
  const container = containers.get(compilation);
  if (!container) return assets;
  if (privateEntries.includes(container))
    throw new Error(
      'Native development federation container conflicts with an application entry',
    );
  const entry = compilation.entrypoints.get(container);
  if (!entry)
    throw new Error(
      `Native development federation container ${container} was not emitted`,
    );
  const publicPath = compilation.outputOptions.publicPath;
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
      (asset.info.sourceFilename &&
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
    assets.set(url.href, {
      bytes: await readAsset(name),
      contentType:
        mime.contentType(path.extname(name)) || 'application/octet-stream',
    });
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
