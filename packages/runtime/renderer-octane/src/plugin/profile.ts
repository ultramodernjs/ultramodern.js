import type { RendererBuildProfile } from '@modern-js/renderer-core/adapter';

export const octaneProfile: RendererBuildProfile<'octane'> = {
  renderer: 'octane',
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
  compiler: { name: '@octanejs/rspack-plugin', version: '0.2.4' },
  hydration: {
    name: 'octane',
    version: '0.13.8',
  },
  router: {
    name: '@octanejs/tanstack-router',
    version: '0.2.10',
    coreName: '@tanstack/router-core',
    coreVersion: '1.171.38',
  },
  sourceExtensions: ['.tsx', '.tsrx', '.ts', '.js'],
  jsxImportSource: 'octane',
  dependencies: {
    '@tsrx/oxc': '0.20.0',
    octane:
      'https://github.com/BleedingDev/octane/releases/download/ultramodern-octane-2383d2ab1e70/octane-0.13.8.tgz',
    '@octanejs/tanstack-router':
      'https://github.com/BleedingDev/octane/releases/download/ultramodern-octane-2383d2ab1e70/octanejs-tanstack-router-0.2.10.tgz',
    '@octanejs/rspack-plugin':
      'https://github.com/BleedingDev/octane/releases/download/ultramodern-octane-2383d2ab1e70/octanejs-rspack-plugin-0.2.4.tgz',
    '@tanstack/router-core':
      'https://github.com/BleedingDev/router/releases/download/ultramodern-router-core-585d3233f7f5/tanstack-router-core-1.171.38.tgz',
    '@modern-js/renderer-octane': '3.8.3',
    seroval: '1.6.9',
    'seroval-plugins': '1.6.9',
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
