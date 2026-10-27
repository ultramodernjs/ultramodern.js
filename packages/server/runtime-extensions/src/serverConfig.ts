import type {} from '@modern-js/plugin/server';
import type {
  BffRuntimeUserConfig,
  BffRuntimeFramework as CanonicalBffRuntimeFramework,
  ServerSourceConfigExtension,
  ServerTelemetryConfigExtension,
} from '@modern-js/runtime-extensions/server-config';
import type { BffUserConfig, ServerUserConfig } from '@modern-js/server-core';

export type {
  BffEffectDataPlatformUserConfig,
  BffEffectOpenApiUserConfig,
} from '@modern-js/runtime-extensions/server-config';

type BffConfigExtension = Omit<BffRuntimeUserConfig, 'runtimeFramework'>;

type ForkBffRuntimeRegistry = Record<
  Exclude<CanonicalBffRuntimeFramework, 'hono'>,
  true
>;

declare module '@modern-js/plugin/server' {
  interface BffRuntimeRegistry extends ForkBffRuntimeRegistry {}
}

declare module '@modern-js/server-core' {
  interface BffUserConfig extends BffConfigExtension {}
  interface ServerUserConfig extends ServerTelemetryConfigExtension {}
  interface SourceUserConfig extends ServerSourceConfigExtension {}
}

export type UltramodernBffUserConfig = Omit<
  BffUserConfig,
  keyof BffRuntimeUserConfig
> &
  BffRuntimeUserConfig;

export type UltramodernServerUserConfig = ServerUserConfig &
  ServerTelemetryConfigExtension;
