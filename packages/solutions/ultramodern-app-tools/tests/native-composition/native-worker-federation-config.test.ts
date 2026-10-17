import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RendererBuildIdentities } from '@modern-js/app-tools-extensions/renderer-build-identity';
import { distributedSsrFragmentRoute } from '@modern-js/app-tools-extensions/workspace-topology';
import { afterEach, describe, expect, it } from '@rstest/core';
import type { NativeI18nConfig } from '../../src/native-composition/native-i18n';
import {
  concreteNativeWorkerFederationPaths,
  resolveNativeWorkerFederationConfig,
} from '../../src/native-composition/native-worker-federation-config';

function i18n(languages = ['en', 'cs']): NativeI18nConfig {
  return {
    languages,
    fallbackLanguage: languages[0],
    detect: true,
    detection: {},
    ignoreRedirectRoutes: [],
    backend: { enabled: false },
    initOptions: {},
  };
}

function identities(): RendererBuildIdentities {
  return {
    buildId: 'a'.repeat(64),
    profileKey: 'b'.repeat(64),
    sourceRevision: 'workspace',
    identities: {
      main: {
        renderer: 'octane',
        protocolVersion: 1,
        appId: 'catalog-canonical-app',
        entryName: 'main',
        buildId: 'a'.repeat(64),
      },
    },
    routerBindings: {},
  };
}

function options(appDirectory = '/fixture/catalog') {
  return {
    authored: {
      name: 'catalog_remote',
      exposes: {
        './Widget': './src/Widget.tsx',
        './Route': { import: './src/Route.tsx' },
      },
      remotes: {
        billing: 'billing_remote@https://billing.example/mf-manifest.json',
      },
    },
    appDirectory,
    identities: identities(),
    i18n: i18n(),
    basePath: '/catalog',
    services: [
      {
        binding: 'BILLING_WORKER',
        service: 'billing-native-worker',
        fragments: [
          {
            remote: 'vertical-billing',
            expose: './Totals',
            boundaryId: 'billing_remote',
            path: distributedSsrFragmentRoute('./Totals'),
          },
          {
            remote: 'vertical-billing',
            expose: './Route',
            boundaryId: 'billing_remote',
            path: distributedSsrFragmentRoute('./Route'),
          },
        ],
      },
    ],
    remoteI18n: {
      'vertical-billing': {
        i18n: i18n(['en', 'de']),
        basePath: '/billing',
      },
    },
  };
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function workspace(topology?: unknown) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'native-worker-mf-config-'),
  );
  directories.push(root);
  const appDirectory = path.join(root, 'apps/catalog');
  fs.mkdirSync(appDirectory, { recursive: true });
  fs.mkdirSync(path.join(root, 'topology'));
  fs.writeFileSync(
    path.join(root, 'topology/reference-topology.json'),
    JSON.stringify(
      topology ?? {
        schemaVersion: 1,
        verticals: [
          {
            id: 'vertical-catalog',
            path: 'apps/catalog',
            moduleFederation: { name: 'catalog_remote' },
          },
        ],
      },
    ),
  );
  return appDirectory;
}

describe('native Worker federation resolved configuration', () => {
  it('removes the existing canonical locale segment for an unlocalized endpoint', () => {
    expect(
      concreteNativeWorkerFederationPaths(
        distributedSsrFragmentRoute('./Widget'),
      ),
    ).toEqual({ default: '/_mf/fragment/widget' });
    expect(
      concreteNativeWorkerFederationPaths(
        '/_mf/fragment/widget',
        undefined,
        '/catalog/',
      ),
    ).toEqual({ default: '/catalog/_mf/fragment/widget' });
    expect(
      concreteNativeWorkerFederationPaths('/fragment', undefined, '/'),
    ).toEqual({
      default: '/fragment',
    });
  });

  it('uses native URL mappings with the entry base path outside the locale segment', () => {
    const policy = {
      ...i18n(),
      localisedUrls: {
        '/_mf/fragment/widget': {
          en: '/_mf/fragment/widget',
          cs: '/_mf/fragment/komponenta',
        },
      },
    };
    expect(
      concreteNativeWorkerFederationPaths(
        distributedSsrFragmentRoute('./Widget'),
        policy,
        '/catalog',
      ),
    ).toEqual({
      cs: '/catalog/cs/_mf/fragment/komponenta',
      en: '/catalog/en/_mf/fragment/widget',
    });
    const paths = concreteNativeWorkerFederationPaths('/fragment', i18n());
    expect(Object.isFrozen(paths)).toBe(true);
  });

  it.each([
    '/{locale}/fragment/{other}',
    '/fragment/{locale}',
    'https://untrusted.example/fragment',
    '//untrusted.example/fragment',
    '/fragment?locale=en',
    '/fragment#other',
    '/fragment/../widget',
    '/fragment/%2e%2e/widget',
    '/fragment/%252e%252e/widget',
    '/fragment\\widget',
  ])('rejects unresolved or unsafe fragment paths: %s', template => {
    expect(() =>
      concreteNativeWorkerFederationPaths(template, i18n()),
    ).toThrow();
  });

  it('rejects unsafe resolved native URL mappings and base paths', () => {
    expect(() =>
      concreteNativeWorkerFederationPaths('/fragment', {
        ...i18n(),
        localisedUrls: {
          '/fragment': { en: '/fragment?other', cs: '/fragment' },
        },
      }),
    ).toThrow();
    for (const basePath of [
      '//host',
      '/base?other',
      '/base/../other',
      '/{base}',
    ])
      expect(() =>
        concreteNativeWorkerFederationPaths('/fragment', i18n(), basePath),
      ).toThrow();
  });

  it('selects the actual topology remote rather than the generic renderer app id', () => {
    const config = resolveNativeWorkerFederationConfig(options(workspace()));
    expect(config.publication?.remote).toBe('vertical-catalog');
    expect(config.publication?.exposeEntryNames).toEqual({
      './Route': 'main',
      './Widget': 'main',
    });
    expect(config.publication?.fragments).toEqual([
      {
        remote: 'vertical-catalog',
        expose: './Route',
        boundaryId: 'catalog_remote',
        paths: {
          cs: '/catalog/cs/_mf/fragment/route',
          en: '/catalog/en/_mf/fragment/route',
        },
      },
      {
        remote: 'vertical-catalog',
        expose: './Widget',
        boundaryId: 'catalog_remote',
        paths: {
          cs: '/catalog/cs/_mf/fragment/widget',
          en: '/catalog/en/_mf/fragment/widget',
        },
      },
    ]);
    expect(Object.isFrozen(config.publication?.fragments)).toBe(true);
  });

  it('uses the finalized canonical app id only when reference topology is absent', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'native-worker-mf-standalone-'),
    );
    directories.push(directory);
    const config = resolveNativeWorkerFederationConfig(options(directory));
    expect(config.publication?.remote).toBe('catalog-canonical-app');
  });

  it('fails on existing topology disagreement instead of selecting a fallback owner', () => {
    for (const topology of [
      { schemaVersion: 2, verticals: [] },
      { schemaVersion: 1, verticals: [] },
      {
        schemaVersion: 1,
        verticals: [{ id: 'foreign', path: '../elsewhere' }],
      },
      {
        schemaVersion: 1,
        verticals: [
          {
            id: 'vertical-catalog',
            path: 'apps/catalog',
            moduleFederation: { name: 'other' },
          },
        ],
      },
      {
        schemaVersion: 1,
        verticals: [
          { id: 'catalog', path: 'apps/catalog' },
          { id: 'catalog', path: 'apps/other' },
        ],
      },
      {
        schemaVersion: 1,
        verticals: [
          { id: 'catalog', path: 'apps/catalog' },
          { id: 'other', path: 'apps/catalog' },
        ],
      },
    ])
      expect(() =>
        resolveNativeWorkerFederationConfig(options(workspace(topology))),
      ).toThrow();
  });

  it('requires one compiler-owned entry and ignores authored entry assignments', () => {
    const source = options();
    expect(() =>
      resolveNativeWorkerFederationConfig({
        ...source,
        identities: {
          ...source.identities,
          identities: {
            ...source.identities.identities,
            checkout: {
              ...source.identities.identities.main,
              entryName: 'checkout',
            },
          },
        },
      }),
    ).toThrow('one finalized compiler entry');
    const config = resolveNativeWorkerFederationConfig({
      ...source,
      authored: {
        ...source.authored,
        exposeEntryNames: { './Widget': 'foreign' },
      },
    });
    expect(config.publication?.exposeEntryNames['./Widget']).toBe('main');
  });

  it('retains authored alias and binding while selecting the remote locale policy', () => {
    const source = options();
    const config = resolveNativeWorkerFederationConfig(source);
    expect(config.services).toEqual([
      {
        alias: 'billing',
        name: 'billing_remote',
        remote: 'vertical-billing',
        binding: 'BILLING_WORKER',
        manifestUrl: 'https://billing.example/mf-manifest.json',
        fragments: [
          {
            expose: './Route',
            boundaryId: 'billing_remote',
            paths: {
              de: '/billing/de/_mf/fragment/route',
              en: '/billing/en/_mf/fragment/route',
            },
          },
          {
            expose: './Totals',
            boundaryId: 'billing_remote',
            paths: {
              de: '/billing/de/_mf/fragment/totals',
              en: '/billing/en/_mf/fragment/totals',
            },
          },
        ],
      },
    ]);
    source.services[0].fragments[0].remote = 'changed';
    source.remoteI18n['vertical-billing'].i18n.languages.push('changed');
    expect(config.services[0].remote).toBe('vertical-billing');
    expect(config.services[0].fragments[1].paths).not.toHaveProperty('changed');
    expect(Object.isFrozen(config.services[0].fragments[0].paths)).toBe(true);
    expect(Object.isFrozen(config.services[0])).toBe(true);
  });

  it('requires a remote policy and accepts explicit unlocalized remote configuration', () => {
    const source = options();
    expect(() =>
      resolveNativeWorkerFederationConfig({ ...source, remoteI18n: {} }),
    ).toThrow('compiler-resolved i18n/base-path policy');
    expect(() =>
      resolveNativeWorkerFederationConfig({ ...source, remoteI18n: undefined }),
    ).toThrow('compiler-resolved i18n/base-path policy');
    const config = resolveNativeWorkerFederationConfig({
      ...source,
      remoteI18n: { 'vertical-billing': {} },
    });
    expect(config.services[0].fragments[0].paths).toEqual({
      default: '/_mf/fragment/route',
    });
  });

  it('requires exactly one authored remote container for every Worker fragment', () => {
    const source = options();
    for (const remotes of [
      {},
      { billing: 'wrong_container@https://billing.example/mf-manifest.json' },
      {
        ...source.authored.remotes,
        otherAlias: 'billing_remote@https://other.example/mf-manifest.json',
      },
    ])
      expect(() =>
        resolveNativeWorkerFederationConfig({
          ...source,
          authored: { ...source.authored, remotes },
        }),
      ).toThrow('exactly one authored MF remote');
    const config = resolveNativeWorkerFederationConfig({
      ...source,
      authored: {
        ...source.authored,
        remotes: {
          billing: {
            name: 'billing_remote',
            entry: 'https://billing.example/mf-manifest.json',
          },
          browserOnly: 'other_remote@https://other.example/mf-manifest.json',
        },
      },
    });
    expect(config.services).toHaveLength(1);
  });

  it('rejects relative or credentialed Worker manifest authority', () => {
    const source = options();
    for (const url of [
      '/mf-manifest.json',
      '//billing.example/mf-manifest.json',
      'https://user:secret@billing.example/mf-manifest.json',
      'https://billing.example/mf-manifest.json#other',
    ])
      expect(() =>
        resolveNativeWorkerFederationConfig({
          ...source,
          authored: {
            ...source.authored,
            remotes: { billing: `billing_remote@${url}` },
          },
        }),
      ).toThrow();
  });

  it('rejects conflicting bindings, remote owners, exposes and paths', () => {
    const source = options();
    const service = source.services[0];
    const [totals, route] = service.fragments;
    for (const services of [
      [service, service],
      [service, { ...service, binding: 'OTHER_WORKER' }],
      [{ ...service, fragments: [totals, totals] }],
      [
        {
          ...service,
          fragments: [totals, { ...route, remote: 'other-remote' }],
        },
      ],
      [{ ...service, fragments: [totals, { ...route, path: totals.path }] }],
    ])
      expect(() =>
        resolveNativeWorkerFederationConfig({ ...source, services }),
      ).toThrow();
  });

  it('omits self publication for a host and ignores API-only service bindings', () => {
    const source = options();
    const config = resolveNativeWorkerFederationConfig({
      ...source,
      authored: { ...source.authored, exposes: {} },
      services: [
        ...source.services,
        { binding: 'API_WORKER', service: 'api-worker' },
      ],
    });
    expect(config.publication).toBeUndefined();
    expect(config.services).toHaveLength(1);
  });
});
