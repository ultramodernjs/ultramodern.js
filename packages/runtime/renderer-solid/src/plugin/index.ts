import path from 'node:path';
import {
  defineRendererAdapter,
  type NativeRendererAdapter,
  nativeRendererDependencies,
} from '@modern-js/renderer-core/adapter';
import { compilerArtifacts } from '../manifest';
import { pluginSolidRenderer, pluginSourceDirectory } from './compiler';
import { generateSolidAppSources } from './create';
import { solidProfile } from './profile';

/** The build-side Solid renderer adapter UltraModern loads for `renderer: 'solid'`. */
export const rendererAdapter: NativeRendererAdapter<'solid'> =
  defineRendererAdapter({
    name: 'solid',
    kind: 'native',
    profile: solidProfile,
    routerFrameworks: ['solid'],
    runtime: {
      package: 'solid-js',
      bootstrap: '@modern-js/renderer-solid',
      entryClient: '@modern-js/renderer-solid/entry-client',
      entryServer: '@modern-js/renderer-solid/entry-server',
      router: '@modern-js/renderer-solid/router',
      i18n: '@modern-js/renderer-solid/i18n',
      manifest: '@modern-js/renderer-solid/manifest',
    },
    federation: {
      library: 'module',
      ssr: true,
      shared: [
        'solid-js',
        '@solidjs/web',
        '@solidjs/signals',
        '@modern-js/renderer-solid',
        '@modern-js/renderer-solid/client',
        '@modern-js/renderer-solid/router',
        '@modern-js/renderer-solid/federation',
        '@modern-js/renderer-core',
        '@modern-js/renderer-core/',
        '@tanstack/router-core',
        '@tanstack/history',
      ],
    },
    worker: { nativeDocuments: true, rsc: false },
    lazyStyles: 'renderer',
    svgComponentTemplate: () =>
      path.join(pluginSourceDirectory(), 'svg-component-template.cjs'),
    compiler: pluginSolidRenderer,
    artifacts: compilerArtifacts,
    create: {
      templates: { federation: true, workers: false },
      dependencies: profile => ({
        frameworkDependencies: [
          '@modern-js/renderer-core',
          '@modern-js/renderer-solid',
        ],
        dependencies: {
          ...nativeRendererDependencies(profile),
          '@solidjs/signals': profile.hydration.version,
        },
        devDependencies: {
          [profile.compiler.name]: profile.compiler.version,
        },
      }),
      generateAppSources: generateSolidAppSources,
    },
  });
