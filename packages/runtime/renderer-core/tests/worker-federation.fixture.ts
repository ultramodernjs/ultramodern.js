import {
  assertRendererFederationCompatibility,
  readRendererFederationContract,
} from '../../federation-runtime/src/module-federation/renderer-contract';
import { octaneProfile } from '../../renderer-octane/src/plugin/profile';

export const compatibility = {
  profile: {
    renderer: octaneProfile.renderer,
    protocolVersion: octaneProfile.protocolVersion,
    compiler: octaneProfile.compiler,
    hydration: octaneProfile.hydration,
    router: octaneProfile.router,
  },
  runtime: { name: 'octane', version: octaneProfile.hydration.version },
  bootstrap: { name: '@modern-js/renderer-octane', version: '3.8.3' },
};

export function admitRendererContract(value: unknown) {
  const publication = readRendererFederationContract(value);
  assertRendererFederationCompatibility(compatibility, publication);
  return publication;
}

export function manifestFixture() {
  return {
    exposes: [{ path: './Widget', assets: { css: { sync: [], async: [] } } }],
    metaData: {
      publicPath: 'https://tractor.example/assets/',
      ultramodernRenderer: {
        schema: 'ultramodern.renderer-federation',
        schemaVersion: 1,
        ...structuredClone(compatibility),
        identities: {
          index: {
            renderer: 'octane',
            appId: 'tractor',
            entryName: 'index',
            protocolVersion: 1,
            buildId: 'built-remote',
          },
        },
      },
      ultramodernWorkerFederation: {
        schema: 'ultramodern.worker-federation',
        schemaVersion: 1,
        remote: 'tractor',
        exposes: {
          './Widget': {
            entryName: 'index',
            boundaryId: 'tractorContainer',
            paths: {
              en: '/en/_mf/fragment/widget',
              fr: '/fr/_mf/fragment/widget',
            },
            native: { publisherBuildId: 'native-client-build', runtimeABI: 1 },
          },
        },
      },
    },
  };
}

export const requestCoordinate = {
  manifestUrl: 'https://tractor.example/assets/mf-manifest.json',
  remote: 'tractor',
  expose: './Widget',
  locale: 'en',
  admitRendererContract,
};
