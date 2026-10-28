import fs from 'node:fs';
import path from 'node:path';
import type { AppTools, CliPlugin } from '@modern-js/app-tools/cli-config';
import {
  createConfigOptions,
  createLoadedConfig,
  type LoadedConfig,
} from '@modern-js/plugin/cli';
import type { Renderer } from '@modern-js/renderer-core';
import { CONFIG_FILE_EXTENSIONS } from '@modern-js/utils';
import { withEntryMetadataRead } from './config-read-context';
import { validateRedactConfig } from './redact-config';
import { resolveRendererAdapter } from './renderer-registration';
import { resolveEntrypointRouterBindings } from './renderer-router-resolution';
import {
  assertCapturedRenderer,
  assertNoAdditionalBasePlugins,
  assertRendererCliPlugins,
  ULTRAMODERN_BASE_PLUGIN,
} from './renderer-selection';
import type {
  UltramodernAppUserConfig,
  UltramodernConfigLoader,
} from './types';

export interface ConfigParams {
  env: string;
  command: string;
}

export type UserConfigExport<Config> =
  | Config
  | ((context: ConfigParams) => Config | Promise<Config>);

export type SelectedCompositionFactory = (
  renderer: Renderer,
  consumerPlugins: readonly CliPlugin<AppTools>[],
) => CliPlugin<AppTools>;

const selectedRenderer = Symbol.for('ultramodern.selected-renderer');

function isConfigPromise(
  value: UltramodernAppUserConfig | Promise<UltramodernAppUserConfig>,
): value is Promise<UltramodernAppUserConfig> {
  return 'then' in value && typeof value.then === 'function';
}

function selectConfig(
  config: UltramodernAppUserConfig,
  factory: SelectedCompositionFactory,
): UltramodernAppUserConfig {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('UltraModern configuration must be an object');
  }
  validateRedactConfig(config.redact);
  const renderer = resolveRendererAdapter(config.renderer).name;
  const plugins = config.plugins ?? [];
  assertNoAdditionalBasePlugins(plugins);
  assertRendererCliPlugins(renderer, plugins);
  const base = factory(renderer, plugins);
  Object.defineProperty(base, selectedRenderer, {
    value: renderer,
    enumerable: true,
  });
  return {
    ...config,
    renderer,
    plugins: [base, ...plugins],
  };
}

/** Used by the public export and the plain-TS owning admission fixture. */
export function createDefineConfig(factory: SelectedCompositionFactory) {
  return (config: UserConfigExport<UltramodernAppUserConfig>) => {
    if (typeof config !== 'function') return selectConfig(config, factory);
    return (context: ConfigParams) => {
      const result = config(context);
      return result && isConfigPromise(result)
        ? Promise.resolve(result).then(value => selectConfig(value, factory))
        : selectConfig(result, factory);
    };
  };
}

/** Evaluate a configuration callback once with its caller's exact context. */
export async function resolveUltramodernConfig(
  config: UserConfigExport<UltramodernAppUserConfig>,
  context: ConfigParams,
): Promise<UltramodernAppUserConfig> {
  const resolved =
    typeof config === 'function' ? await config(context) : config;
  validateRedactConfig(resolved.redact);
  const renderer = resolveRendererAdapter(resolved.renderer).name;
  return resolved.renderer === undefined ? { ...resolved, renderer } : resolved;
}

export interface LoadUltramodernConfigOptions extends ConfigParams {
  appDirectory: string;
  configFile?: string;
  config?: UltramodernAppUserConfig;
}

export type LoadedUltramodernConfig = LoadedConfig<UltramodernAppUserConfig>;

/** Load and evaluate authored TS/JS config through the owning Modern loader. */
export async function loadUltramodernConfigFile({
  appDirectory,
  configFile,
  config,
  env,
  command,
}: LoadUltramodernConfigOptions): Promise<LoadedUltramodernConfig> {
  const resolvedFile = configFile
    ? path.resolve(appDirectory, configFile)
    : CONFIG_FILE_EXTENSIONS.map(extension =>
        path.join(appDirectory, `modern.config${extension}`),
      ).find(file => fs.existsSync(file));
  if (!resolvedFile) {
    throw new Error(`Cannot find modern.config in ${appDirectory}`);
  }
  const loaded = await createLoadedConfig<UltramodernAppUserConfig>(
    appDirectory,
    resolvedFile,
    config,
    { env, command },
  );
  const renderer = resolveRendererAdapter(loaded.config.renderer).name;
  loaded.config = { ...loaded.config, renderer };
  const bases = (loaded.config.plugins ?? []).filter(
    plugin => plugin.name === ULTRAMODERN_BASE_PLUGIN,
  );
  if (bases.length !== 1) {
    throw new Error('Exactly one UltraModern base composition is required');
  }
  const captured = (
    bases[0] as CliPlugin<AppTools> & {
      [selectedRenderer]?: Renderer;
    }
  )[selectedRenderer];
  if (
    resolveRendererAdapter(renderer).kind === 'native' &&
    captured === undefined
  )
    throw new Error(
      'Native renderer selection must use UltraModern defineConfig; an unselected legacy base cannot own native compilation',
    );
  if (captured !== undefined) assertCapturedRenderer(loaded.config, captured);
  assertNoAdditionalBasePlugins(
    (loaded.config.plugins ?? []).filter(plugin => plugin !== bases[0]),
  );
  assertCapturedRenderer(loaded.config, renderer);
  return loaded;
}

export async function loadUltramodernConfig(
  options: LoadUltramodernConfigOptions,
): Promise<UltramodernAppUserConfig> {
  return (await loadUltramodernConfigFile(options)).config;
}

/** Resolve the real convention/custom entries without invoking output hooks. */
export async function resolveUltramodernEntryIdentities({
  appDirectory,
  installedAppDirectory = appDirectory,
  config,
  command = 'metadata',
  configFile = false,
}: {
  appDirectory: string;
  /** Staged source may use the original application's installed packages. */
  installedAppDirectory?: string;
  config: UltramodernAppUserConfig;
  command?: string;
  configFile?: string | false;
}) {
  return withEntryMetadataRead(async () => {
    const contextPlugin: CliPlugin<UltramodernConfigLoader> = {
      name: '@modern-js/ultramodern-entry-config-context',
      setup(api) {
        api.updateAppContext({ configFile });
      },
    };
    const resolved = await createConfigOptions<UltramodernConfigLoader>({
      cwd: appDirectory,
      configFile: false,
      command,
      config,
      internalPlugins: [contextPlugin],
    });
    const context = resolved.getAppContext();
    const hooks = context._internalContext.pluginAPI?.getHooks();
    if (!hooks) throw new Error('The owning entry hooks are unavailable');
    const { getBundleEntry } = await import('@modern-js/app-tools/builder');
    const { entrypoints } = await hooks.modifyEntrypoints.call({
      entrypoints: await getBundleEntry(hooks, context, resolved.config),
    });
    const entries = entrypoints.map(({ entryName, isMainEntry }) => ({
      entryName,
      isMainEntry,
    }));
    const primary = entries.find(entry => entry.isMainEntry) ?? entries[0];
    if (!primary)
      throw new Error('UltraModern configuration has no application entries');
    const renderer = resolveRendererAdapter(config.renderer).name;
    const routerBindings = await resolveEntrypointRouterBindings(
      renderer,
      entrypoints,
      context.plugins.map(plugin => plugin.name),
      undefined,
      installedAppDirectory,
    );
    return { entries, primaryEntryName: primary.entryName, routerBindings };
  });
}
