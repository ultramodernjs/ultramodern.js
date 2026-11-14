import type { URL } from 'node:url';
import { resolveEffectTsrsCompiler } from '@modern-js/app-tools-extensions/build-config';
import {
  builderPluginAdapterPrecompress,
  type PrecompressConfig,
} from '@modern-js/app-tools-extensions/build-config/precompress/plugin';
import {
  type CloudflareDeployConfig,
  getBuildConfigEnvironment,
  type ResolveEffectTsgoCompilerOptions,
  resolveEffectTsgoCompiler,
} from '@modern-js/app-tools-extensions/config';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

const compilerOriginContract: Expect<
  Equal<ResolveEffectTsgoCompilerOptions['from'], string | URL>
> = true;
const compilerPath: string = resolveEffectTsgoCompiler({
  from: import.meta.url,
});
const environmentValue: string | undefined = getBuildConfigEnvironment(
  'PUBLIC_SURFACE_CONSUMER',
);

void compilerOriginContract;
void compilerPath;
const apiCompilerPath: string = resolveEffectTsrsCompiler({
  from: import.meta.url,
});
void apiCompilerPath;
void environmentValue;

const cloudflareConfig: CloudflareDeployConfig = {
  worker: { name: 'public-config-consumer', compatibilityDate: '2026-09-09' },
};
void cloudflareConfig;

const precompressConfig: PrecompressConfig = {
  gzip: { threshold: 2048 },
  brotli: false,
};
const precompressPlugin = builderPluginAdapterPrecompress(precompressConfig);
void precompressPlugin;
