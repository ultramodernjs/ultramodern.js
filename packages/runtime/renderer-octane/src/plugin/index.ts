import path from 'node:path';
import {
  defineRendererAdapter,
  type NativeRendererAdapter,
  nativeRendererDependencies,
} from '@modern-js/renderer-core/adapter';
import { compilerArtifacts } from '../manifest';
import { createOctaneCompilerPlugin, pluginSourceDirectory } from './compiler';
import { generateOctaneAppSources } from './create';
import { octaneProfile } from './profile';
import { assertOctaneEntrySource } from './source';

/** The build-side Octane renderer adapter UltraModern loads for `renderer: 'octane'`. */
export const rendererAdapter: NativeRendererAdapter<'octane'> =
  defineRendererAdapter({
    name: 'octane',
    kind: 'native',
    profile: octaneProfile,
    routerFrameworks: ['octane'],
    runtime: {
      package: 'octane',
      bootstrap: '@modern-js/renderer-octane',
      entryClient: '@modern-js/renderer-octane/entry-client',
      entryServer: '@modern-js/renderer-octane/entry-server',
      router: '@modern-js/renderer-octane/router',
      i18n: '@modern-js/renderer-octane/i18n',
      manifest: '@modern-js/renderer-octane/manifest',
    },
    federation: {
      library: 'module',
      ssr: true,
      shared: [
        'octane',
        'octane/',
        'octane/internal/context',
        'octane/internal/signal-read',
        'octane/signals',
        '@octanejs/tanstack-router',
        '@octanejs/tanstack-router/',
        '@modern-js/renderer-octane',
        '@modern-js/renderer-octane/',
        '@modern-js/renderer-octane/router',
        '@modern-js/renderer-octane/federation',
        '@modern-js/renderer-core',
        '@modern-js/renderer-core/',
        '@tanstack/router-core',
        '@tanstack/history',
        'seroval',
        'seroval-plugins',
      ],
      // A remote can use a native API the local app never imports. Publish
      // these providers from the host so their private hook state stays local.
      sharedByEnvironment: {
        client: {
          'octane/internal/client': 'octane/internal/client',
          'octane/signals/client': 'octane/signals/client',
          'octane/profiling': 'octane/profiling',
          'octane/hydration/streamed-signals':
            'octane/hydration/streamed-signals',
          '@modern-js/renderer-octane/client':
            '@modern-js/renderer-octane/client',
        },
        server: {
          octane: 'octane/server',
          'octane/server': 'octane/server',
          'octane/internal/server': 'octane/internal/server',
          'octane/signals/server': 'octane/signals/server',
        },
      },
    },
    worker: { nativeDocuments: true, rsc: false },
    lazyStyles: 'document',
    // Hydration bytes belong to this exact native client compilation.
    entryClient: {
      declarations: 'declare const __webpack_hash__: string;\n',
      fields: { nativeHydrationBuildId: '__webpack_hash__' },
    },
    svgComponentTemplate: () =>
      path.join(pluginSourceDirectory(), 'svg-component-template.cjs'),
    compiler: createOctaneCompilerPlugin,
    artifacts: compilerArtifacts,
    assertSupportedSource: assertOctaneEntrySource,
    create: {
      templates: { federation: true, workers: true },
      dependencies: (profile, { typescriptVersion }) => ({
        frameworkDependencies: [
          '@modern-js/renderer-core',
          '@modern-js/renderer-octane',
        ],
        dependencies: nativeRendererDependencies(profile),
        devDependencies: {
          [profile.compiler.name]:
            profile.dependencies[profile.compiler.name] ??
            profile.compiler.version,
          typescript: typescriptVersion,
        },
        typecheckCommand: 'octane-tsc --noEmit --project tsconfig.json',
        tsconfig: {
          tsrx: {
            compiler: 'octane/compiler/volar',
            platform: 'web',
          },
        },
      }),
      generateAppSources: generateOctaneAppSources,
    },
  });
