import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from '@rstest/core';

const requireFromTest = createRequire(import.meta.url);
const compilers = [
  { name: 'TypeScript', package: 'typescript', binary: 'tsc' },
];

// These programs import the canonical source backing. They do not certify a
// packed installation or replace any producer declaration with a test facade.
function checkSourceContract(
  compiler: (typeof compilers)[number],
  source: string,
  react: boolean,
) {
  const fixture = fs.mkdtempSync(
    path.join(__dirname, '.tmp-neutral-config-backing-'),
  );
  try {
    fs.writeFileSync(path.join(fixture, 'consumer.ts'), source);
    fs.writeFileSync(
      path.join(fixture, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          strict: true,
          skipLibCheck: false,
          target: 'ESNext',
          module: 'Preserve',
          moduleResolution: 'Bundler',
          jsx: 'preserve',
          types: react ? ['node', 'react'] : ['node'],
          customConditions: ['modern:source'],
        },
        files: ['consumer.ts'],
      }),
    );
    const manifest = requireFromTest.resolve(
      `${compiler.package}/package.json`,
    );
    const compilerManifest = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
    expect(compilerManifest).toMatchObject({
      name: 'typescript',
      version: '7.0.2',
    });
    const launcher = path.resolve(
      path.dirname(manifest),
      compilerManifest.bin[compiler.binary],
    );
    const result = spawnSync(
      process.execPath,
      [
        launcher,
        '--project',
        path.join(fixture, 'tsconfig.json'),
        '--listFiles',
      ],
      { cwd: fixture, encoding: 'utf-8', timeout: 30_000 },
    );
    const lines = `${result.stdout ?? ''}${result.stderr ?? ''}`
      .split(/\r?\n/u)
      .filter(Boolean);
    const graph = lines.filter(
      line => path.isAbsolute(line) && fs.existsSync(line),
    );
    const diagnostics = lines.filter(line => !graph.includes(line)).join('\n');
    expect(result.error).toBeUndefined();
    expect(
      result.status,
      `${compiler.name} source contract:\n${diagnostics}`,
    ).toBe(0);
    return graph.map(file => file.replaceAll('\\', '/'));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

const structuralParity = `
import type * as React from 'react';
import type { AppContext, CLIPluginAPI, Hooks } from '@modern-js/plugin/cli';
import type { NestedRoute, NestedRouteForCli, PageRoute } from '@modern-js/types/cli';
import type * as LegacyConfig from '../../src/types/config';
import type * as BaseConfig from '../../src/types/config/base';
import type * as LegacyPlugin from '../../src/types/plugin';
import type * as BasePlugin from '../../src/types/plugin-base';
import type { DevUserConfig } from '../../src/types/config/dev';
import type * as LegacyDev from '../../../../server/server/src/types';
import type * as CanonicalDev from '../../../../server/server/src/types/dev';
import type { SetupMiddlewares as LegacySetupMiddlewares } from '@modern-js/server';
import type { BuilderOptions } from '../../src/builder/shared/types';
import { builderPluginAdapterBasic } from '../../src/builder/shared/builderPlugins/adapterBasic';
import { builderPluginAdapterHooks } from '../../src/builder/shared/builderPlugins/builderHooks';
import type { EagerRouteComponentFilesByEntry } from '@modern-js/utils/route-component-files';
import type { RsbuildPlugin } from '@rsbuild/core';

type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
type IsAny<T> = 0 extends 1 & T ? true : false;
type ReactRoutes = NestedRouteForCli | PageRoute;
type GenericAppTools = BaseConfig.AppToolsBase<ReactRoutes>;
type GenericConfig = BaseConfig.AppToolsUserConfigBase<ReactRoutes>;
type LegacyFields = Omit<LegacyConfig.AppToolsUserConfig, 'plugins'>;
type GenericFields = Omit<GenericConfig, 'plugins'>;
type FieldParity = { [Key in keyof LegacyFields]-?: Same<LegacyFields[Key], GenericFields[Key]> };

export type ConfigKeys = Assert<Same<keyof LegacyFields, keyof GenericFields>>;
export type ConfigFields = Assert<FieldParity[keyof FieldParity]>;
export type ConfigRecursion = Assert<Same<LegacyConfig.AppToolsUserConfig, GenericConfig>>;
export type NormalizedConfig = Assert<Same<
  LegacyConfig.AppToolsNormalizedConfig,
  BaseConfig.AppToolsNormalizedConfig<GenericConfig>
>>;
export type FullAppTools = Assert<Same<LegacyConfig.AppTools, GenericAppTools>>;
export type FullAPI = Assert<Same<CLIPluginAPI<LegacyConfig.AppTools>, CLIPluginAPI<GenericAppTools>>>;
export type ExtendedAPI = Assert<Same<
  LegacyPlugin.AppToolsExtendAPI,
  BasePlugin.AppToolsExtendAPIBase<GenericAppTools, ReactRoutes>
>>;
export type ExtendedContext = Assert<Same<
  LegacyPlugin.AppToolsExtendContext,
  BasePlugin.AppToolsExtendContextBase<GenericAppTools>
>>;
export type ExtendedHooks = Assert<Same<
  LegacyPlugin.AppToolsExtendHooks,
  BasePlugin.AppToolsExtendHooksBase<ReactRoutes>
>>;
export type FullContext = Assert<Same<
  LegacyPlugin.AppToolsContext,
  AppContext<GenericAppTools> & BasePlugin.AppToolsExtendContextBase<GenericAppTools>
>>;
export type FullHooks = Assert<Same<
  LegacyPlugin.AppToolsHooks,
  Hooks<GenericConfig, BaseConfig.AppToolsNormalizedConfig<GenericConfig>, {}, {}>
    & BasePlugin.AppToolsExtendHooksBase<ReactRoutes>
>>;
export type ConfigIsStrict = Assert<Same<IsAny<LegacyConfig.AppToolsUserConfig>, false>>;
export type NoLegacyTestingOption = Assert<Same<
  Extract<'testing', keyof LegacyConfig.AppToolsUserConfig>, never
>>;
export type NoLegacyJestOption = Assert<Same<
  Extract<'jest', keyof NonNullable<LegacyConfig.AppToolsUserConfig['tools']>>, never
>>;
export type DevServerAliases = Assert<Same<[
  LegacyDev.CorsOptions, LegacyDev.DevServerConfig,
  LegacyDev.DevServerOptions, LegacyDev.DevServerHttpsOptions
], [
  CanonicalDev.CorsOptions, CanonicalDev.DevServerConfig,
  CanonicalDev.DevServerOptions, CanonicalDev.DevServerHttpsOptions
]>>;
export type PublicMiddlewareAlias = Assert<Same<LegacySetupMiddlewares, CanonicalDev.SetupMiddlewares>>;
export type AppToolsMiddlewares = Assert<Same<DevUserConfig['setupMiddlewares'], CanonicalDev.SetupMiddlewares>>;

export type ExistingPluginAliases = Assert<Same<[
  LegacyPlugin.AppToolsModuleType, LegacyPlugin.AppToolsHookRunners,
  LegacyPlugin.BffCompilation, LegacyPlugin.BffGeneration,
  LegacyPlugin.BffClientArtifact, LegacyPlugin.BffClientArtifacts,
  LegacyPlugin.BffGeneratedModule, LegacyPlugin.BffGeneratedEntries,
  LegacyPlugin.BeforeBffCompileFn, LegacyPlugin.AfterBffCompileFn,
  LegacyPlugin.ModifyBffClientArtifactsFn, LegacyPlugin.ModifyBffGeneratedEntriesFn,
  LegacyPlugin.AfterPrepareFn, LegacyPlugin.CheckEntryPointFn,
  LegacyPlugin.ModifyEntrypointsFn, LegacyPlugin.ModifyBuilderEnvironmentsFn,
  LegacyPlugin.ModifyFileSystemRoutesFn, LegacyPlugin.DeplpoyFn,
  LegacyPlugin.GenerateEntryCodeFn, LegacyPlugin.BeforeGenerateRoutesFn,
  LegacyPlugin.BeforePrintInstructionsFn, LegacyPlugin.AddRuntimeExportsFn
], [
  BasePlugin.AppToolsModuleType, BasePlugin.AppToolsHookRunners,
  BasePlugin.BffCompilation, BasePlugin.BffGeneration,
  BasePlugin.BffClientArtifact, BasePlugin.BffClientArtifacts,
  BasePlugin.BffGeneratedModule, BasePlugin.BffGeneratedEntries,
  BasePlugin.BeforeBffCompileFn, BasePlugin.AfterBffCompileFn,
  BasePlugin.ModifyBffClientArtifactsFn, BasePlugin.ModifyBffGeneratedEntriesFn,
  BasePlugin.AfterPrepareFn, BasePlugin.CheckEntryPointFn,
  BasePlugin.ModifyEntrypointsFn, BasePlugin.ModifyBuilderEnvironmentsFn,
  BasePlugin.ModifyFileSystemRoutesFn<ReactRoutes>, BasePlugin.DeplpoyFn,
  BasePlugin.GenerateEntryCodeFn, BasePlugin.BeforeGenerateRoutesFn,
  BasePlugin.BeforePrintInstructionsFn, BasePlugin.AddRuntimeExportsFn
]>>;

declare const element: React.ReactElement;
const nativeCliNested: NestedRouteForCli = {
  type: 'nested', origin: 'file-system', component: './page.tsx', element: 123,
  children: [{ type: 'nested', origin: 'config', element }],
};
const defaultReactComponent: NonNullable<NestedRoute['component']> = () => element;
const page: PageRoute = { type: 'page', component: './page.tsx', _component: './page.tsx', errorElement: element };
declare const api: CLIPluginAPI<LegacyConfig.AppTools>;
api.modifyFileSystemRoutes(event => {
  event.routes = [nativeCliNested, page];
  return event;
});
// @ts-expect-error CLI routes still use filenames, while runtime NestedRoute admits React components.
nativeCliNested.component = () => element;
const bad: LegacyConfig.AppToolsUserConfig = { source: {
  // @ts-expect-error Source options retain the canonical string contract.
  mainEntryName: 123,
} };
declare const legacyContext: LegacyPlugin.AppToolsContext;
declare const legacyNormalized: LegacyConfig.AppToolsNormalizedConfig;
declare const eagerRouteComponentFilesByEntry: EagerRouteComponentFilesByEntry;
const legacyOptions: BuilderOptions = {
  appContext: legacyContext,
  normalizedConfig: legacyNormalized,
  eagerRouteComponentFilesByEntry,
};
const legacyBasic: RsbuildPlugin = builderPluginAdapterBasic(legacyOptions);
const legacyHooks: RsbuildPlugin = builderPluginAdapterHooks(legacyOptions);
builderPluginAdapterBasic({ appContext: legacyContext, normalizedConfig: legacyNormalized, eagerRouteComponentFilesByEntry });
builderPluginAdapterHooks({ appContext: legacyContext, normalizedConfig: legacyNormalized, eagerRouteComponentFilesByEntry });
builderPluginAdapterBasic({ appContext: legacyContext, normalizedConfig: legacyNormalized, extraBuilderMetadata: 'retained' });
builderPluginAdapterHooks({ appContext: legacyContext, normalizedConfig: legacyNormalized, extraBuilderMetadata: 'retained' });
const invalidLegacyOptions: BuilderOptions = {
  appContext: legacyContext,
  normalizedConfig: legacyNormalized,
  // @ts-expect-error The full legacy BuilderOptions declaration remains closed to unknown fields.
  unsupportedLegacyOption: true,
};
void legacyBasic; void legacyHooks; void invalidLegacyOptions;
void defaultReactComponent; void bad;
`;

const legacyAugmentation = `
import type * as React from 'react';
import type { AsyncHook, CLIPluginAPI } from '@modern-js/plugin/cli';
import type { NestedRouteForCli, PageRoute, Route } from '@modern-js/types/cli';
import type { AppTools, AppToolsUserConfig } from '../../src/types/config';
import type { AppToolsContext, AppToolsExtendAPI, AppToolsExtendHooks } from '../../src/types/plugin';

declare module '../../src/types/config' {
  interface AppToolsUserConfig { owningConfig?: 'config-owner' }
}
declare module '../../src/types/plugin' {
  interface AppToolsExtendAPI { owningApi(value: string): number }
  interface AppToolsExtendContext { owningContext?: 'context-owner' }
  interface AppToolsExtendHooks { owningHook: AsyncHook<(value: number) => number> }
}
declare module '@modern-js/types/cli' {
  interface Route { owningRoute?: 'route-owner' }
  interface NestedRoute<T> { owningNested?: 'nested-owner' }
  interface PageRoute { owningPage?: 'page-owner' }
}

type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
type NestedChild = NonNullable<NestedRouteForCli['children']>[number];
type NestedGrandchild = NonNullable<NestedChild['children']>[number];
type PageChild = NonNullable<PageRoute['children']>[number];
type PageParent = NonNullable<PageChild['parent']>;
export type NestedRecursion = Assert<Same<NestedGrandchild['owningRoute'], 'route-owner' | undefined>>;
export type NestedOwnRecursion = Assert<Same<NestedGrandchild['owningNested'], 'nested-owner' | undefined>>;
export type PageRecursion = Assert<Same<PageParent['owningRoute'], 'route-owner' | undefined>>;
export type PageOwnRecursion = Assert<Same<PageParent['owningPage'], 'page-owner' | undefined>>;
export type RouteRecursion = Assert<Same<NonNullable<Route['children']>[number]['owningRoute'], 'route-owner' | undefined>>;
export type ContextAugmentation = Assert<Same<AppToolsContext['owningContext'], 'context-owner' | undefined>>;
export type APIAugmentation = Assert<Same<AppToolsExtendAPI['owningApi'], (value: string) => number>>;
export type HookAugmentation = Assert<Same<AppToolsExtendHooks['owningHook'], AsyncHook<(value: number) => number>>>;

declare const api: CLIPluginAPI<AppTools>;
const config: 'config-owner' | undefined = api.useConfigContext().owningConfig;
const normalized: 'config-owner' | undefined = api.useResolvedConfigContext().owningConfig;
const raw: 'config-owner' | undefined = api.useResolvedConfigContext()._raw.owningConfig;
const context: 'context-owner' | undefined = api.useAppContext().owningContext;
const modernContext: 'context-owner' | undefined = api.getAppContext().owningContext;
const addedApi: number = api.owningApi('typed');
const addedHook: Promise<number> = api.getHooks().owningHook.call(1);
api.owningHook(value => value + 1);
api.useConfigContext().plugins?.[0].setup?.(api);
api.useAppContext()._internalContext.pluginAPI?.owningApi('nested');
api.modifyFileSystemRoutes(event => {
  for (const route of event.routes) {
    if ('type' in route && route.type === 'nested') {
      const routeOwner: 'route-owner' | undefined = route.owningRoute;
      const nestedOwner: 'nested-owner' | undefined = route.children?.[0].owningNested;
      const element: React.ReactNode = route.element;
      void routeOwner; void nestedOwner; void element;
    }
  }
  return event;
});
// @ts-expect-error Augmented APIs keep their parameter contract through the recursive AppTools type.
api.owningApi(123);
// @ts-expect-error Augmented hooks keep their return contract.
api.owningHook(value => 'wrong');
const authored: AppToolsUserConfig = { owningConfig: 'config-owner', plugins: [{
  name: 'augmented-plugin',
  setup(pluginApi) {
    const owner: 'config-owner' | undefined = pluginApi.useConfigContext().owningConfig;
    const nestedContext: 'context-owner' | undefined = pluginApi.useAppContext().owningContext;
    pluginApi.owningHook(value => value + pluginApi.owningApi('owning'));
    void owner; void nestedContext;
  },
}] };
void config; void normalized; void raw; void context; void modernContext;
void addedApi; void addedHook; void authored;
`;

const neutralMetadata = `
import type { CLIPluginAPI } from '@modern-js/plugin/cli';
import type { NestedRoute, PageRoute } from '@modern-js/types/cli/base';
import type {
  AppTools, AppToolsUserConfig, CLIElement, CLIElementTypes, CLIFileSystemRoute,
} from '../../src/types/config/base';
import { builderPluginAdapterBasic } from '../../src/builder/shared/builderPlugins/adapterBasic';
import { builderPluginAdapterHooks } from '../../src/builder/shared/builderPlugins/builderHooks';
import type { RsbuildPlugin } from '@rsbuild/core';

type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
type NeutralRoutes = CLIFileSystemRoute<CLIElement>;
export type EmptyRegistry = Assert<Same<keyof CLIElementTypes, never>>;
export type NoRendererElement = Assert<Same<CLIElement, never>>;
export type NoNeutralTestingOption = Assert<Same<
  Extract<'testing', keyof AppToolsUserConfig>, never
>>;
export type NoNeutralJestOption = Assert<Same<
  Extract<'jest', keyof NonNullable<AppToolsUserConfig['tools']>>, never
>>;
export type NoElementSlot = Assert<Same<NonNullable<NeutralRoutes['element']>, never>>;
export type NoErrorElementSlot = Assert<Same<NonNullable<NeutralRoutes['errorElement']>, never>>;
export type NoRecursiveElementSlot = Assert<Same<
  NonNullable<NonNullable<NeutralRoutes['children']>[number]['element']>, never
>>;
export type NoParentElementSlot = Assert<Same<NonNullable<NonNullable<PageRoute<CLIElement>['parent']>['element']>, never>>;

const nested: NestedRoute<string, CLIElement> = {
  type: 'nested', origin: 'file-system', component: './page.ts', data: './page.data.ts',
  children: [{ type: 'nested', origin: 'config', component: './child.ts' }],
};
const page: PageRoute<CLIElement> = { type: 'page', component: './page.ts', _component: './page.ts' };
// @ts-expect-error Renderer values do not enter neutral CLI metadata without an owned registry augmentation.
nested.element = 123;
// @ts-expect-error Even text children require an admitted renderer element type.
page.errorElement = 'text';
// @ts-expect-error CLI metadata keeps component filenames instead of React component functions.
nested.component = () => ({ type: 'div', props: {}, key: null });

declare const api: CLIPluginAPI<AppTools>;
const sdkOptions = {
  appContext: api.getAppContext(),
  normalizedConfig: api.getNormalizedConfig(),
  nativeBuilderMetadata: 'retained',
};
const nativeBasic: RsbuildPlugin = builderPluginAdapterBasic(sdkOptions);
const nativeHooks: RsbuildPlugin = builderPluginAdapterHooks(sdkOptions);
builderPluginAdapterBasic({ appContext: api.getAppContext(), normalizedConfig: api.getNormalizedConfig(), nativeBuilderMetadata: 'retained' });
builderPluginAdapterHooks({ appContext: api.getAppContext(), normalizedConfig: api.getNormalizedConfig(), nativeBuilderMetadata: 'retained' });
builderPluginAdapterBasic({ appContext: { metaName: 'native-owning-host' } });
builderPluginAdapterHooks({ appContext: { _internalContext: {} } });
builderPluginAdapterHooks({ appContext: { _internalContext: { pluginAPI: undefined } } });
// @ts-expect-error Basic adapter consumes the required metaName, not an untyped context.
builderPluginAdapterBasic({ appContext: {} });
// @ts-expect-error The hook adapter consumes an internal context even when its plugin API is absent.
builderPluginAdapterHooks({ appContext: {} });
// @ts-expect-error A provided plugin API must return all three actual builder hooks.
builderPluginAdapterHooks({ appContext: { _internalContext: { pluginAPI: { getHooks: () => ({}) } } } });
api.modifyFileSystemRoutes(event => {
  event.routes = [nested, page];
  for (const route of event.routes) {
    if ('type' in route) {
      const slot: null | undefined = route.element;
      const childSlot: null | undefined = route.children?.[0].element;
      void slot; void childSlot;
    }
  }
  return event;
});
const config: AppToolsUserConfig = {
  source: { entries: { main: { entry: './src/main.ts', disableMount: true } } },
  output: { svgDefaultExport: 'url' },
  plugins: [{ name: 'native-metadata-owner', setup(pluginApi) {
    pluginApi.modifyFileSystemRoutes(event => ({ ...event, routes: [nested, page] }));
  } }],
};
void config;
void nativeBasic; void nativeHooks;
`;

describe('canonical app-tools neutral source backing', () => {
  it.each(compilers)(
    'preserves all legacy config, plugin, API, context and hook structures with $name',
    compiler => {
      checkSourceContract(compiler, structuralParity, true);
    },
    40_000,
  );

  it.each(compilers)(
    'preserves open legacy and recursive route augmentations with $name',
    compiler => {
      checkSourceContract(compiler, legacyAugmentation, true);
    },
    40_000,
  );

  it.each(compilers)(
    'keeps neutral metadata renderer-free in its own $name source program',
    compiler => {
      const graph = checkSourceContract(compiler, neutralMetadata, false);
      expect(
        graph.some(file => file.endsWith('/src/types/config/base.ts')),
      ).toBe(true);
      expect(
        graph.some(file => file.endsWith('/src/types/plugin-base.ts')),
      ).toBe(true);
      const legacyCli = fs
        .realpathSync(requireFromTest.resolve('@modern-js/types/cli'))
        .replaceAll('\\', '/');
      expect(
        graph.filter(
          file =>
            file.endsWith('/src/renderers/react/composition.ts') ||
            file === legacyCli ||
            /(?:\/@types\/react(?:-dom)?\/|\/react(?:-dom)?\/.*\.d\.[cm]?ts$)/u.test(
              file,
            ),
        ),
        'React declarations or legacy React routes in the neutral source program',
      ).toEqual([]);
    },
    40_000,
  );
});
