import type { BuilderConfig } from '@modern-js/builder';
import type { ServerCompilerProvider } from '@modern-js/server-utils/compiler';
import type { UnwrapBuilderConfig } from '../utils';

type BuilderToolsConfig = UnwrapBuilderConfig<BuilderConfig, 'tools'>;

export interface ToolsUserConfig extends Omit<BuilderToolsConfig, 'swc'> {
  /** Compiler provider for BFF and custom-server config, checks and DTS. */
  serverCompiler?: ServerCompilerProvider;
  /**
   * Used to custom SWC configurations.
   * @requires `swc` plugin.
   * The configuration of `swc` is provided by `swc` plugin.
   * Please use `yarn new` or `pnpm new` to enable the corresponding capability.
   */
  swc?: BuilderToolsConfig['swc'];
}
