import type {
  NativeRendererAdapter,
  RendererBuildProfile,
} from '@modern-js/renderer-core/adapter';
import { createReplacementCompilerArtifacts } from './replacement-compiler-artifacts';

/**
 * A native renderer unlike Solid, installed in the Solid package's adapter
 * slot: its own compiler, router, runtime packages and artifact ABI.
 */
export function createFourthAdapter(): NativeRendererAdapter {
  const profile: RendererBuildProfile = {
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
    compiler: { name: 'fourth-compiler', version: '1.0.0' },
    hydration: { name: 'fourth-runtime', version: '1.0.0' },
    router: {
      name: '@fixture/fourth-router',
      version: '1.0.0',
      coreName: '@tanstack/router-core',
      coreVersion: '1.171.37',
    },
    sourceExtensions: ['.tsx', '.ts'],
    jsxImportSource: 'fourth-runtime',
    dependencies: {},
    capabilities: {
      worker: false,
      moduleFederation: false,
      rsc: false,
      ssg: false,
      i18n: true,
      svgComponent: false,
    },
  };
  return {
    name: 'solid',
    kind: 'native',
    profile,
    routerFrameworks: ['fourth-router'],
    runtime: {
      package: 'fourth-runtime',
      bootstrap: '@modern-js/renderer-solid',
      entryClient: '@fixture/fourth/entry-client',
      entryServer: '@fixture/fourth/entry-server',
      router: '@fixture/fourth/router',
      manifest: '@modern-js/renderer-solid/manifest',
    },
    worker: { nativeDocuments: true, rsc: false },
    compiler: () => ({ name: 'fixture:fourth:compiler', setup() {} }),
    artifacts: createReplacementCompilerArtifacts(),
  };
}
