import type { FederatedAssets } from '@modern-js/renderer-core/federation';
import type { SolidFederationScope } from './federation-context';

/**
 * The server half of same-renderer Module Federation. federatedComponent()
 * names each remote it server-rendered by an asset key, and the response's
 * document resolves that key through the same host's federation scope.
 */

/** Asset keys for server-rendered remotes, e.g. `ultramodern-federation:remote/Widget`. */
export const FEDERATED_ASSET_PREFIX = 'ultramodern-federation:';

interface CapturedServerAssets {
  readonly hydration: string;
  readonly assets: FederatedAssets;
}

const capturedAssets = new WeakMap<
  SolidFederationScope,
  Map<string, CapturedServerAssets>
>();

/** Retain the assets admitted with this module until its response resolves them. */
export function captureFederatedServerAssets(
  scope: SolidFederationScope,
  id: string,
  assets: FederatedAssets | undefined,
): string | undefined {
  const instance = scope.instance;
  if (!assets || !scope.hydrationModule || !instance?.name) return undefined;
  // The browser module finds this host by name among the realm's instances.
  const hydration = `${scope.hydrationModule}?id=${encodeURIComponent(id)}&host=${encodeURIComponent(instance.name)}`;
  let records = capturedAssets.get(scope);
  if (!records) {
    records = new Map();
    capturedAssets.set(scope, records);
  }
  const baseKey = federatedAssetKey(id);
  let key = baseKey;
  // Two loads of one remote may straddle a development revision in one response.
  // Give each loaded module its own key rather than replacing earlier assets.
  for (let revision = 1; records.has(key); revision += 1)
    key = `${baseKey}:${revision}`;
  records.set(key, { hydration, assets });
  return key;
}

export function federatedAssetKey(id: string): string {
  return `${FEDERATED_ASSET_PREFIX}${id}`;
}

interface ResolvedDocumentAssets {
  js: string[];
  css: string[];
  preloads?: Record<string, unknown>[];
}

interface StaticAssetChunk {
  file: string;
  css?: string[];
  imports?: string[];
  preloads?: Record<string, unknown>[];
}

/** Solid's own asset path join: absolute URLs pass through. */
function joinAssetPath(base: unknown, file: string): string {
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//iu.test(file)) return file;
  let prefix = typeof base === 'string' && base ? base : '/';
  if (!prefix.endsWith('/')) prefix += '/';
  return prefix + (file.startsWith('/') ? file.slice(1) : file);
}

/** Solid's static manifest walk, so a resolver can extend a static manifest. */
function resolveStaticAssets(
  manifest: Record<string, unknown>,
  key: string,
): ResolvedDocumentAssets | null {
  if (key === '_base' || !Object.hasOwn(manifest, key)) return null;
  const base = manifest._base;
  const js: string[] = [];
  const css: string[] = [];
  let preloads: Record<string, unknown>[] | undefined;
  const visited = new Set<string>();
  const walk = (name: string) => {
    if (visited.has(name) || name === '_base') return;
    visited.add(name);
    const chunk = manifest[name] as StaticAssetChunk | undefined;
    if (!chunk) return;
    js.push(joinAssetPath(base, chunk.file));
    for (const file of chunk.css ?? []) css.push(joinAssetPath(base, file));
    for (const link of chunk.preloads ?? []) {
      const href = typeof link.href === 'string' && link.href;
      if (!href && typeof link.imagesrcset !== 'string') continue;
      preloads ??= [];
      if (href) preloads.push({ ...link, href: joinAssetPath(base, href) });
      else {
        const { href: _ignored, ...rest } = link;
        preloads.push(rest);
      }
    }
    for (const dependency of chunk.imports ?? []) walk(dependency);
  };
  walk(key);
  return preloads ? { js, css, preloads } : { js, css };
}

/**
 * Extend a static Solid asset manifest with the remotes this response
 * server-rendered through its host. The first module is the host's hydration
 * module for that remote, which Solid imports before hydrating the boundary
 * that rendered it.
 */
export function withFederatedAssets<Manifest>(
  manifest: Manifest,
  scope: SolidFederationScope | undefined,
): Manifest {
  if (
    !scope?.hydrationModule ||
    manifest === null ||
    typeof manifest !== 'object' ||
    typeof (manifest as { resolve?: unknown }).resolve === 'function'
  )
    return manifest;
  const modules = manifest as Record<string, unknown>;
  const resolve = (key: string): ResolvedDocumentAssets | null => {
    if (!key.startsWith(FEDERATED_ASSET_PREFIX))
      return resolveStaticAssets(modules, key);
    const remote = capturedAssets.get(scope)?.get(key);
    if (!remote) return null;
    return {
      js: [joinAssetPath(modules._base, remote.hydration), ...remote.assets.js],
      css: [...remote.assets.css],
    };
  };
  return { resolve, resolveSync: resolve } as Manifest;
}
