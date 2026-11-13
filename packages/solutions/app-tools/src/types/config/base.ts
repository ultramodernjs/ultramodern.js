import type { CLIPlugin, CLIPluginExtends } from '@modern-js/plugin/cli';
import type {
  BffUserConfig,
  ServerUserConfig,
} from '@modern-js/server-core/config-types';
import type { NestedRoute, PageRoute } from '@modern-js/types/cli/base';
import type { RsbuildConfig } from '@rsbuild/core';
import type {
  AppToolsExtendAPIBase,
  AppToolsExtendContextBase,
  AppToolsExtendHooksBase,
} from '../plugin-base';
import type { DeployUserConfig } from './deploy';
import type { DevUserConfig } from './dev';
import type { ExperimentsUserConfig } from './experiments';
import type { HtmlUserConfig } from './html';
import type { OutputUserConfig } from './output';
import type { PerformanceUserConfig } from './performance';
import type { ResolveUserConfig } from './resolve';
import type { SecurityUserConfig } from './security';
import type { SourceUserConfig } from './source';
import type { ToolsUserConfig } from './tools';

export * from './output';

export type AppToolsBuilderPlugins = NonNullable<RsbuildConfig['plugins']>;

export interface AppToolsUserConfigBase<Routes> {
  resolve?: ResolveUserConfig;
  server?: ServerUserConfig;
  source?: SourceUserConfig;
  output?: OutputUserConfig;
  experiments?: ExperimentsUserConfig;
  /**
   * The configuration of `bff` is provided by `bff` plugin.
   * Please use `yarn new` or `pnpm new` to enable the corresponding capability.
   * @requires `bff` plugin
   */
  bff?: BffUserConfig;
  dev?: DevUserConfig;
  deploy?: DeployUserConfig;
  html?: HtmlUserConfig;
  tools?: ToolsUserConfig;
  security?: SecurityUserConfig;
  builderPlugins?: AppToolsBuilderPlugins;
  performance?: PerformanceUserConfig;
  environments?: RsbuildConfig['environments'];
  splitChunks?: RsbuildConfig['splitChunks'];
  plugins?: CliPlugin<AppToolsBase<Routes>>[];
}

interface SharedNormalizedConfig<RawConfig> {
  cliOptions?: Record<string, any>;
  _raw: RawConfig;
}

export type AppToolsNormalizedConfig<Config = AppToolsUserConfig> =
  Required<Config> & SharedNormalizedConfig<Config>;

/** Renderer packages opt into JSX element typing through their owned type entry. */
// biome-ignore lint/suspicious/noEmptyInterface: Renderer-owned type entries augment this registry.
export interface CLIElementTypes {}
export type CLIElement = CLIElementTypes[keyof CLIElementTypes];
export type CLIFileSystemRoute<Element> =
  | NestedRoute<string, Element>
  | PageRoute<Element>;

export type AppToolsBase<Routes> = Required<
  CLIPluginExtends<
    AppToolsUserConfigBase<Routes>,
    AppToolsNormalizedConfig<AppToolsUserConfigBase<Routes>>,
    AppToolsExtendContextBase<AppToolsBase<Routes>>,
    AppToolsExtendAPIBase<AppToolsBase<Routes>, Routes>,
    AppToolsExtendHooksBase<Routes>
  >
>;

export type AppTools = AppToolsBase<CLIFileSystemRoute<CLIElement>>;
export type AppToolsUserConfig = AppToolsUserConfigBase<
  CLIFileSystemRoute<CLIElement>
>;
export type AppUserConfig = AppToolsUserConfig;
export type AppNormalizedConfig = AppToolsNormalizedConfig;

export type CliPlugin<Extends extends CLIPluginExtends> = CLIPlugin<Extends>;
