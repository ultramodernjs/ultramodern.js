import type { RendererBuildProfile } from '@modern-js/renderer-core/adapter';

export const octaneProfile: RendererBuildProfile<'octane'> = {
  renderer: 'octane',
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
  compiler: { name: '@octanejs/rspack-plugin', version: '0.2.12' },
  hydration: {
    name: 'octane',
    version: '0.20.0',
  },
  router: {
    name: '@octanejs/tanstack-router',
    version: '0.3.6',
    coreName: '@tanstack/router-core',
    coreVersion: '1.171.39',
  },
  sourceExtensions: ['.tsx', '.tsrx', '.ts', '.js'],
  jsxImportSource: 'octane',
  dependencies: {
    '@tsrx/oxc': '0.24.0',
    octane:
      'https://github.com/ultramodernjs/ultramodern.js/releases/download/native-renderers-7d4e7415b69a93439451cbcfbcbb4cc15d09edde-44303834194-1/octane-0.20.0.tgz',
    '@octanejs/tanstack-router':
      'https://github.com/ultramodernjs/ultramodern.js/releases/download/native-renderers-7d4e7415b69a93439451cbcfbcbb4cc15d09edde-44303834194-1/octanejs-tanstack-router-0.3.6.tgz',
    '@octanejs/rspack-plugin':
      'https://github.com/ultramodernjs/ultramodern.js/releases/download/native-renderers-7d4e7415b69a93439451cbcfbcbb4cc15d09edde-44303834194-1/octanejs-rspack-plugin-0.2.12.tgz',
    '@tanstack/router-core':
      'https://github.com/ultramodernjs/ultramodern.js/releases/download/native-renderers-7d4e7415b69a93439451cbcfbcbb4cc15d09edde-44303834194-1/tanstack-router-core-1.171.39.tgz',
    '@modern-js/renderer-octane': '3.8.3',
    seroval: '1.8.2',
    'seroval-plugins': '1.8.0',
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
