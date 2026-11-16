import {
  nativeRendererDependencies,
  type RendererBuildProfile,
} from '../src/adapter';

// Synthetic adapter inputs: this suite proves dependency projection, not a
// release cohort. Real pins are owned by each renderer's native descriptor.
const coreVersion = '1.0.0-fixture';
const coreArchive = `https://artifacts.invalid/router-core-${coreVersion}.tgz`;

function profile(dependencies: Record<string, string>): RendererBuildProfile {
  return {
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
    compiler: { name: '@octanejs/rspack-plugin', version: '1.0.0-fixture' },
    hydration: { name: 'octane', version: '1.0.0-fixture' },
    router: {
      name: '@octanejs/tanstack-router',
      version: '1.0.0-fixture',
      coreName: '@tanstack/router-core',
      coreVersion,
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
        octane: '1.0.0-fixture',
      }),
    ),
  ).toEqual({
    '@tanstack/router-core': coreArchive,
    octane: '1.0.0-fixture',
  });
});

test('a profile without a core source request uses its declared core version', () => {
  expect(nativeRendererDependencies(profile({}))).toEqual({
    '@tanstack/router-core': coreVersion,
  });
});
