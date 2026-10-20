import type { RendererBuildProfile } from '@modern-js/renderer-core/adapter';

export const solidProfile: RendererBuildProfile<'solid'> = {
  renderer: 'solid',
  status: 'preview',
  protocolVersion: 1,
  minimumNode: '26.12.0',
  hmr: {
    editedBoundary: 'may-reset',
    unaffectedComponents: 'preserved',
    document: 'preserved',
    roots: 'single',
    cleanup: 'exactly-once',
  },
  compiler: { name: '@solidjs/compiler', version: '2.0.0-rc.15' },
  hydration: { name: '@solidjs/web', version: '2.0.0-rc.15' },
  router: {
    name: '@modern-js/renderer-solid',
    version: '3.8.3',
    coreName: '@tanstack/router-core',
    coreVersion: '1.171.38',
  },
  sourceExtensions: ['.tsx', '.ts', '.jsx', '.js'],
  jsxImportSource: '@solidjs/web',
  dependencies: {
    '@tanstack/router-core':
      'https://github.com/BleedingDev/router/releases/download/ultramodern-router-core-585d3233f7f5/tanstack-router-core-1.171.38.tgz',
    'solid-js': '2.0.0-rc.15',
    '@solidjs/web': '2.0.0-rc.15',
    '@solidjs/signals': '2.0.0-rc.15',
    '@solidjs/compiler': '2.0.0-rc.15',
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
