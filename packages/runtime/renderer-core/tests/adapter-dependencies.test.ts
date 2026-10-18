import {
  nativeRendererDependencies,
  type RendererBuildProfile,
} from '../src/adapter';

const coreArchive =
  'https://github.com/BleedingDev/router/releases/download/ultramodern-router-core-0a4eed5ea37d/tanstack-router-core-1.171.38.tgz';

function profile(dependencies: Record<string, string>): RendererBuildProfile {
  return {
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
    hydration: { name: 'octane', version: '0.13.8' },
    router: {
      name: '@octanejs/tanstack-router',
      version: '0.2.10',
      coreName: '@tanstack/router-core',
      coreVersion: '1.171.38',
    },
    sourceExtensions: ['.tsx'],
    jsxImportSource: 'octane',
    dependencies,
    capabilities: {
      worker: true,
      moduleFederation: true,
      rsc: false,
      ssg: true,
      i18n: true,
      svgComponent: true,
    },
  };
}

test('generated dependencies preserve the declared router core archive', () => {
  expect(
    nativeRendererDependencies(
      profile({
        '@tanstack/router-core': coreArchive,
        '@modern-js/renderer-octane': '3.8.3',
        octane: '0.13.8',
      }),
    ),
  ).toEqual({ '@tanstack/router-core': coreArchive, octane: '0.13.8' });
});

test('a profile without a core source request uses its declared core version', () => {
  expect(nativeRendererDependencies(profile({}))).toEqual({
    '@tanstack/router-core': '1.171.38',
  });
});
