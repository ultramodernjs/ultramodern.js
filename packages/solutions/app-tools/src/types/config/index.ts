import type { PluginSvgrOptions } from '@modern-js/app-tools-extensions/svgr';
import type { CLIPlugin, CLIPluginExtends } from '@modern-js/plugin/cli';
import type { NestedRouteForCli, PageRoute } from '@modern-js/types/cli';
import type { ReactNode } from 'react';
import type {
  AppToolsExtendAPI,
  AppToolsExtendContext,
  AppToolsExtendHooks,
} from '../plugin';
import type {
  AppToolsUserConfigBase,
  AppToolsNormalizedConfig as BaseNormalizedConfig,
} from './base';

declare module '@modern-js/builder/types' {
  interface BuilderSvgOptions {
    options: PluginSvgrOptions;
  }
}

declare module './base' {
  interface CLIElementTypes {
    react: ReactNode;
  }
}

export type { AppToolsBuilderPlugins } from './base';
export * from './output';

export interface AppToolsUserConfig
  extends Omit<
    AppToolsUserConfigBase<NestedRouteForCli | PageRoute>,
    'plugins'
  > {
  plugins?: CliPlugin<AppTools>[];
}

export type AppToolsNormalizedConfig<Config = AppToolsUserConfig> =
  BaseNormalizedConfig<Config>;
export type AppTools = Required<
  CLIPluginExtends<
    AppToolsUserConfig,
    AppToolsNormalizedConfig,
    AppToolsExtendContext,
    AppToolsExtendAPI,
    AppToolsExtendHooks
  >
>;
export type CliPlugin<Extends extends CLIPluginExtends> = CLIPlugin<Extends>;
