import type { RendererBuildProfile } from '@modern-js/renderer-core/adapter';

export const solidProfile: RendererBuildProfile<'solid'> = {
  renderer: 'solid',
  status: 'preview',
  protocolVersion: 1,
  minimumNode: '26.13.1',
  hmr: {
    editedBoundary: 'may-reset',
    unaffectedComponents: 'preserved',
    document: 'preserved',
    roots: 'single',
    cleanup: 'exactly-once',
  },
  compiler: { name: '@solidjs/compiler', version: '2.0.0' },
  hydration: { name: '@solidjs/web', version: '2.0.0' },
  router: {
    name: '@modern-js/renderer-solid',
    version: '3.8.3',
    coreName: '@tanstack/router-core',
    coreVersion: '1.171.39',
  },
  sourceExtensions: ['.tsx', '.ts', '.jsx', '.js'],
  jsxImportSource: '@solidjs/web',
  dependencies: {
    '@tanstack/router-core':
      'https://github.com/ultramodernjs/ultramodern.js/releases/download/native-renderers-9353b0cd3dc1fb73ebd1dc66f377e3356abeb178-44131025154-1/tanstack-router-core-1.171.39.tgz',
    'solid-js': '2.0.0',
    '@solidjs/web': '2.0.0',
    '@solidjs/signals': '2.0.0',
    '@solidjs/compiler': '2.0.0',
    '@modern-js/renderer-solid': '3.8.3',
  },
  capabilities: {
    worker: true,
    moduleFederation: true,
    rsc: false,
    ssg: true,
    i18n: true,
    svgComponent: true,
  },
};
