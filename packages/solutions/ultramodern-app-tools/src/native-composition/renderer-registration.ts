import { createRequire } from 'node:module';
import type { AppTools, CliPlugin } from '@modern-js/app-tools/cli-config';
import type { PolicyDefaultsOptions } from '@modern-js/app-tools-extensions/policy-defaults';
import type { Renderer } from '@modern-js/renderer-core';
import type {
  ComposedRendererAdapter,
  NativeRendererAdapter,
} from '@modern-js/renderer-core/adapter';
import { reactRendererAdapter } from '../renderers/react/adapter';

export type ComposedUltramodernRendererAdapter = ComposedRendererAdapter<
  Renderer,
  CliPlugin<AppTools>,
  PolicyDefaultsOptions
>;

export type UltramodernRendererAdapter =
  | NativeRendererAdapter
  | ComposedUltramodernRendererAdapter;

export type RegisteredRenderer = 'react' | 'solid' | 'octane';

const requireAdapter = createRequire(import.meta.url);

interface RendererRegistration {
  /**
   * Native adapters live in their renderer package's build-only `./plugin`
   * entry and load only when selected. Loading is synchronous (`require` of
   * ESM) because configuration, metadata and scaffolding read renderer
   * profiles synchronously.
   */
  load(): UltramodernRendererAdapter;
  /**
   * Packages whose imports mark a module as authored for this renderer. A
   * trailing `/` names a whole scope. Kept here, not on the adapter, so route
   * and dependency ownership checks work without loading or even installing
   * the renderer package.
   */
  readonly ownedPackages: readonly string[];
  /** Source extensions only this renderer compiles. */
  readonly ownedExtensions: readonly string[];
}

const rendererRegistrations: Readonly<
  Record<RegisteredRenderer, RendererRegistration>
> = {
  react: {
    load: () => reactRendererAdapter,
    ownedPackages: [
      'react',
      'react-dom',
      'react-router',
      'react-router-dom',
      '@modern-js/runtime',
      '@modern-js/plugin-tanstack',
      '@modern-js/plugin-i18n',
      '@tanstack/react-router',
      '@tanstack/redact',
      'rsbuild-redact-plugin',
    ],
    ownedExtensions: [],
  },
  solid: {
    load: () =>
      requireAdapter('@modern-js/renderer-solid/plugin').rendererAdapter,
    ownedPackages: [
      'solid-js',
      '@solidjs/',
      '@tanstack/solid-router',
      '@modern-js/renderer-solid',
    ],
    ownedExtensions: [],
  },
  octane: {
    load: () =>
      requireAdapter('@modern-js/renderer-octane/plugin').rendererAdapter,
    ownedPackages: ['octane', '@octanejs/', '@modern-js/renderer-octane'],
    ownedExtensions: ['.tsrx'],
  },
};

export const registeredRenderers = Object.freeze(
  Object.keys(rendererRegistrations) as RegisteredRenderer[],
);

const loadedAdapters = new Map<
  RegisteredRenderer,
  UltramodernRendererAdapter
>();

/** Application admission is finite even though transport identities are generic. */
export function resolveRendererAdapter(
  value: unknown = 'react',
): UltramodernRendererAdapter & { readonly name: RegisteredRenderer } {
  const renderer = registeredRenderers.find(name => name === value);
  if (!renderer)
    throw new Error(`Unsupported UltraModern renderer: ${String(value)}`);
  let adapter = loadedAdapters.get(renderer);
  if (!adapter) {
    adapter = rendererRegistrations[renderer].load();
    if (adapter?.name !== renderer || adapter.profile?.renderer !== renderer)
      throw new Error(
        `The ${renderer} renderer package exports no matching renderer adapter`,
      );
    loadedAdapters.set(renderer, adapter);
  }
  return adapter as UltramodernRendererAdapter & {
    readonly name: RegisteredRenderer;
  };
}

export function resolveNativeRendererAdapter(
  renderer: Renderer,
): NativeRendererAdapter {
  const adapter = resolveRendererAdapter(renderer);
  if (adapter.kind !== 'native')
    throw new Error(
      `Unsupported UltraModern native renderer: ${String(renderer)}`,
    );
  return adapter;
}

/** The registered renderer that owns an imported package, without loading it. */
export function specifierRenderer(
  specifier: string,
): RegisteredRenderer | undefined {
  return registeredRenderers.find(renderer =>
    rendererRegistrations[renderer].ownedPackages.some(name =>
      name.endsWith('/')
        ? specifier.startsWith(name)
        : specifier === name || specifier.startsWith(`${name}/`),
    ),
  );
}

/** The registered renderer that alone compiles a source extension, e.g. Octane `.tsrx`. */
export function extensionRenderer(
  extension: string,
): RegisteredRenderer | undefined {
  return registeredRenderers.find(renderer =>
    rendererRegistrations[renderer].ownedExtensions.includes(extension),
  );
}

/** Source extensions any registered renderer compiles on its own. */
export const ownedSourceExtensions: readonly string[] = Object.freeze(
  registeredRenderers.flatMap(
    renderer => rendererRegistrations[renderer].ownedExtensions,
  ),
);

/** The infrastructure plugin that owns a native renderer's entries. */
export function nativeInfrastructurePluginName(renderer: Renderer): string {
  return `@modern-js/renderer-${renderer}-infrastructure`;
}
