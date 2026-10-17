import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RendererBuildIdentities } from '@modern-js/app-tools-extensions/renderer-build-identity';
import {
  type RendererFederationCompatibility,
  readRendererFederationContract,
} from '@modern-js/federation-runtime/renderer-contract';
import type { ValidatedNativeCompilerArtifact } from '@modern-js/renderer-core/adapter';
import type { WorkerFederationExecution } from '@modern-js/renderer-core/worker-federation';
import { type Rspack, rspack } from '@rsbuild/core';
import { afterEach, describe, expect, it } from '@rstest/core';
import { resolveNativeWorkerContextProfiles } from '../../src/native-composition/native-worker-context-profiles';
import {
  createNativeWorkerFederationPlan,
  finalizeNativeWorkerFederationPublication,
  nativeWorkerFederationRegistrySource,
  normalizeNativeWorkerFederationExposes,
} from '../../src/native-composition/native-worker-federation';

const compatibility: RendererFederationCompatibility = {
  profile: {
    renderer: 'octane',
    protocolVersion: 1,
    compiler: { name: '@octanejs/rspack-plugin', version: '0.2.4' },
    hydration: { name: 'octane', version: '0.13.8' },
    router: {
      name: '@octanejs/tanstack-router',
      version: '0.2.10',
      coreName: '@tanstack/router-core',
      coreVersion: '1.171.34',
    },
  },
  runtime: { name: 'octane', version: '0.13.8' },
  bootstrap: { name: '@modern-js/renderer-octane', version: '3.8.3' },
};

function completedIdentities(): RendererBuildIdentities {
  const buildId = 'a'.repeat(64);
  const provider = {
    ...compatibility.profile.router,
    framework: 'octane' as const,
  };
  return {
    buildId,
    profileKey: 'b'.repeat(64),
    sourceRevision: 'workspace',
    identities: {
      main: {
        renderer: 'octane',
        protocolVersion: 1,
        appId: 'catalog',
        entryName: 'main',
        buildId,
      },
    },
    routerBindings: {
      main: {
        owner: '@modern-js/renderer-octane',
        evidence: 'owned-default',
        defaultProvider: provider,
        providers: [provider],
      },
    },
  };
}

function planOptions(appDirectory = '/fixture/catalog') {
  return {
    authored: {
      name: 'catalog_remote',
      exposes: {
        './Widget': './src/Widget.mjs',
        './Totals': { import: ['./src/Totals.mjs'], name: 'totals' },
      },
    },
    appDirectory,
    remote: 'vertical-catalog',
    exposeEntryNames: { './Widget': 'main', './Totals': 'main' },
    fragments: [
      {
        remote: 'vertical-catalog',
        expose: './Widget',
        boundaryId: 'catalog_remote',
        paths: { en: '/en/_mf/fragment/widget', cs: '/cs/_mf/fragment/widget' },
      },
      {
        remote: 'vertical-catalog',
        expose: './Totals',
        boundaryId: 'catalog_remote',
        paths: { en: '/en/_mf/fragment/totals', cs: '/cs/_mf/fragment/totals' },
      },
    ],
    compatibility,
    identities: completedIdentities(),
  };
}

function validatedClientArtifacts(): Readonly<
  Record<string, ValidatedNativeCompilerArtifact>
> {
  return {
    main: {
      nativeManifest: { opaqueNativeArtifact: true },
      hydrationBuildId: 'native-client-compilation-hash',
    },
  };
}

const directories: string[] = [];
const invalidLocalePaths: Readonly<Record<string, string>>[] = [
  {},
  { 'en/other': '/en/_mf/fragment/widget' },
  { en: '/en/_mf/fragment/widget', EN: '/EN/_mf/fragment/widget' },
  { default: '/_mf/fragment/widget', en: '/en/_mf/fragment/widget' },
];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('native Worker federation build plan', () => {
  it('normalizes one local module per component in deterministic order', () => {
    expect(
      normalizeNativeWorkerFederationExposes(
        {
          './Widget': './src/Widget.tsrx',
          './Nested/Totals': { import: ['./src/Totals.ts'], name: 'totals' },
          './Counter': { import: './src/Counter.tsx' },
          './Route': './src/Route.tsx',
        },
        '/app',
      ),
    ).toEqual([
      { expose: './Counter', import: '/app/src/Counter.tsx' },
      { expose: './Nested/Totals', import: '/app/src/Totals.ts' },
      { expose: './Route', import: '/app/src/Route.tsx' },
      { expose: './Widget', import: '/app/src/Widget.tsrx' },
    ]);
    expect(normalizeNativeWorkerFederationExposes(undefined, '/app')).toEqual(
      [],
    );
    expect(() => normalizeNativeWorkerFederationExposes({}, 'app')).toThrow(
      'application directory must be absolute',
    );
  });

  it.each([
    '../Widget.mjs',
    './src/../Widget.mjs',
    './src/./Widget.mjs',
    './src//Widget.mjs',
    '/absolute/Widget.mjs',
    'widget-package',
    'node:fs',
    'https://remote.example/Widget.mjs',
    'data:text/javascript,export default 1',
    'loader!./src/Widget.mjs',
    './src/Widget.mjs?raw',
    './src/Widget.mjs#export',
    './src/%2e%2e/Widget.mjs',
    './src\\Widget.mjs',
    './src/Widget\n.mjs',
  ])('rejects unsafe or nonlocal imports: %s', request => {
    expect(() =>
      normalizeNativeWorkerFederationExposes({ './Widget': request }, '/app'),
    ).toThrow('plain local component import');
  });

  it.each([
    ['./src/Widget.mjs'],
    { import: ['./src/one.mjs', './src/two.mjs'] },
    { import: [] },
    { import: './src/Widget.mjs', runtime: 'node' },
    { import: './src/Widget.mjs', name: 1 },
    { import: './src/Widget.mjs', name: '' },
    { name: 'widget' },
  ])(
    'rejects unsupported or ambiguous expose declarations: %j',
    declaration => {
      expect(() =>
        normalizeNativeWorkerFederationExposes(
          { './Widget': declaration },
          '/app',
        ),
      ).toThrow();
    },
  );

  it.each(['../Widget', './Widget/../Counter', './'])(
    'rejects invalid component exposes: %s',
    expose => {
      expect(() =>
        normalizeNativeWorkerFederationExposes(
          { [expose]: './src/Widget.mjs' },
          '/app',
        ),
      ).toThrow();
    },
  );

  it('plans exact topology coordinates without claiming a native publisher hash', () => {
    const options = planOptions();
    const plan = createNativeWorkerFederationPlan(options);
    expect(plan.renderer).toEqual({
      schema: 'ultramodern.renderer-federation',
      schemaVersion: 1,
      ...compatibility,
      identities: options.identities.identities,
    });
    expect(plan.coordinateTemplate).toEqual({
      schema: 'ultramodern.worker-federation',
      schemaVersion: 1,
      remote: 'vertical-catalog',
      exposes: {
        './Totals': {
          entryName: 'main',
          boundaryId: 'catalog_remote',
          paths: {
            cs: '/cs/_mf/fragment/totals',
            en: '/en/_mf/fragment/totals',
          },
        },
        './Widget': {
          entryName: 'main',
          boundaryId: 'catalog_remote',
          paths: {
            cs: '/cs/_mf/fragment/widget',
            en: '/en/_mf/fragment/widget',
          },
        },
      },
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.renderer.identities.main)).toBe(true);
    expect(Object.isFrozen(plan.coordinateTemplate.exposes['./Widget'])).toBe(
      true,
    );
    expect(Object.isFrozen(plan.exposes[0])).toBe(true);
    expect(plan.coordinateTemplate.exposes['./Widget']).not.toHaveProperty(
      'native',
    );
    options.fragments[0].paths.en = '/changed';
    expect(plan.coordinateTemplate.exposes['./Widget'].paths.en).toBe(
      '/en/_mf/fragment/widget',
    );
    expect(
      Object.isFrozen(plan.coordinateTemplate.exposes['./Widget'].paths),
    ).toBe(true);
  });

  it('finalizes immutable publication from validated CLIENT artifacts rather than source identity hashes', () => {
    const plan = createNativeWorkerFederationPlan(planOptions());
    const artifacts = validatedClientArtifacts();
    const publication = finalizeNativeWorkerFederationPublication(
      plan,
      artifacts,
    );
    expect(publication).toEqual({
      ...plan.coordinateTemplate,
      exposes: Object.fromEntries(
        Object.entries(plan.coordinateTemplate.exposes).map(
          ([expose, coordinate]) => [
            expose,
            {
              ...coordinate,
              native: {
                publisherBuildId: artifacts.main.hydrationBuildId,
                runtimeABI: 1,
              },
            },
          ],
        ),
      ),
    });
    expect(publication.exposes['./Widget'].native.publisherBuildId).not.toBe(
      plan.renderer.identities.main.buildId,
    );
    expect(Object.isFrozen(publication)).toBe(true);
    expect(Object.isFrozen(publication.exposes['./Widget'].native)).toBe(true);
    expect(Object.isFrozen(publication.exposes['./Widget'].paths)).toBe(true);
  });

  it('requires validated native hydration ownership without source-hash fallback', () => {
    const plan = createNativeWorkerFederationPlan(planOptions());
    const nativeManifest = { opaqueNativeArtifact: true };
    const invalidArtifacts: Readonly<
      Record<string, ValidatedNativeCompilerArtifact>
    >[] = [
      {},
      { foreign: { nativeManifest, hydrationBuildId: 'foreign-client-hash' } },
      { main: { nativeManifest } },
      { main: { nativeManifest, hydrationBuildId: '' } },
      { main: { nativeManifest, hydrationBuildId: ' invalid ' } },
      { main: { nativeManifest, hydrationBuildId: 'invalid\n' } },
      { main: { nativeManifest: undefined, hydrationBuildId: 'client-hash' } },
      { main: { nativeManifest: null, hydrationBuildId: 'client-hash' } },
    ];
    for (const artifacts of invalidArtifacts)
      expect(() =>
        finalizeNativeWorkerFederationPublication(plan, artifacts),
      ).toThrow();
  });

  it('requires compiler ownership for the full expose set and exact finalized entries', () => {
    const options = planOptions();
    for (const exposeEntryNames of [
      { './Widget': 'main' },
      { ...options.exposeEntryNames, './Extra': 'main' },
      { ...options.exposeEntryNames, './Widget': 'absent' },
    ])
      expect(() =>
        createNativeWorkerFederationPlan({ ...options, exposeEntryNames }),
      ).toThrow();
    expect(() =>
      createNativeWorkerFederationPlan({
        ...options,
        identities: { ...options.identities, buildId: 'c'.repeat(64) },
      }),
    ).toThrow('identities differ from the finalized build');
  });

  it('uses only the compiler map when a publication has multiple entries', () => {
    const options = planOptions();
    const identities = {
      ...options.identities,
      identities: {
        ...options.identities.identities,
        checkout: {
          ...options.identities.identities.main,
          entryName: 'checkout',
        },
      },
    };
    const plan = createNativeWorkerFederationPlan({
      ...options,
      authored: {
        ...options.authored,
        exposeEntryNames: { './Totals': 'absent' },
      },
      identities,
      exposeEntryNames: { './Widget': 'main', './Totals': 'checkout' },
    });
    expect(plan.coordinateTemplate.exposes['./Totals'].entryName).toBe(
      'checkout',
    );
    expect(plan.renderer.identities.checkout).toEqual(
      identities.identities.checkout,
    );
    expect(() =>
      finalizeNativeWorkerFederationPublication(
        plan,
        validatedClientArtifacts(),
      ),
    ).toThrow('validated client artifact');
    const publication = finalizeNativeWorkerFederationPublication(plan, {
      ...validatedClientArtifacts(),
      checkout: {
        nativeManifest: { opaqueNativeArtifact: true },
        hydrationBuildId: 'checkout-client-compilation-hash',
      },
    });
    expect(publication.exposes['./Totals'].native.publisherBuildId).toBe(
      'checkout-client-compilation-hash',
    );
    expect(publication.exposes['./Widget'].native.publisherBuildId).toBe(
      'native-client-compilation-hash',
    );
  });

  it('delegates renderer identity admission to the canonical reader', () => {
    const options = planOptions();
    expect(() =>
      createNativeWorkerFederationPlan({
        ...options,
        identities: {
          ...options.identities,
          identities: {
            main: { ...options.identities.identities.main, entryName: 'other' },
          },
        },
      }),
    ).toThrow('incoherent publication identity');
  });

  it('rejects missing, duplicate and conflicting service coordinates', () => {
    const options = planOptions();
    const [widget, totals] = options.fragments;
    for (const fragments of [
      [widget],
      [widget, totals, widget],
      [widget, { ...totals, paths: widget.paths }],
      [widget, { ...totals, remote: 'other-remote' }],
      [widget, { ...totals, boundaryId: 'other_container' }],
      [widget, { ...totals, expose: './Extra' }],
    ])
      expect(() =>
        createNativeWorkerFederationPlan({ ...options, fragments }),
      ).toThrow();
  });

  it('admits an explicit default endpoint when localization is disabled', () => {
    const options = planOptions();
    const plan = createNativeWorkerFederationPlan({
      ...options,
      fragments: options.fragments.map(fragment => ({
        ...fragment,
        paths: {
          default: `/_mf/fragment/${fragment.expose.slice(2).toLowerCase()}`,
        },
      })),
    });
    expect(plan.coordinateTemplate.exposes['./Widget'].paths).toEqual({
      default: '/_mf/fragment/widget',
    });
  });

  it.each(invalidLocalePaths)(
    'rejects ambiguous or missing locale coordinates: %j',
    paths => {
      const options = planOptions();
      expect(() =>
        finalizeNativeWorkerFederationPublication(
          createNativeWorkerFederationPlan({
            ...options,
            fragments: options.fragments.map((fragment, index) =>
              index === 0 ? { ...fragment, paths } : fragment,
            ),
          }),
          validatedClientArtifacts(),
        ),
      ).toThrow();
    },
  );

  it('uses the portable publication reader for unique locale endpoint admission', () => {
    const options = planOptions();
    const plan = createNativeWorkerFederationPlan({
      ...options,
      fragments: options.fragments.map(fragment => ({
        ...fragment,
        paths: { en: fragment.paths.en, cs: fragment.paths.en },
      })),
    });
    expect(() =>
      finalizeNativeWorkerFederationPublication(
        plan,
        validatedClientArtifacts(),
      ),
    ).toThrow('conflicting endpoint paths');
  });

  it('admits the portable locale syntax without a second locale validator', () => {
    const options = planOptions();
    const plan = createNativeWorkerFederationPlan({
      ...options,
      fragments: options.fragments.map(fragment => ({
        ...fragment,
        paths: { pt_BR: `/pt_BR/fragment/${fragment.expose.slice(2)}` },
      })),
    });
    const publication = finalizeNativeWorkerFederationPublication(
      plan,
      validatedClientArtifacts(),
    );
    expect(publication.exposes['./Widget'].paths).toEqual({
      pt_BR: '/pt_BR/fragment/Widget',
    });
  });

  it.each([
    '/{locale}/_mf/fragment/widget',
    'https://remote.example/fragment/widget',
    '//remote.example/fragment/widget',
    '/fragment/widget?locale=en',
    '/fragment/widget#other',
    '/fragment/../widget',
    '/fragment/./widget',
    '/fragment/%2e%2e/widget',
    '/fragment/%252e%252e/widget',
    '/fragment/%2fwidget',
    '/fragment\\widget',
    '/fragment//widget',
    '/fragment/widget/',
  ])(
    'rejects fragment coordinates that are not exact endpoints: %s',
    fragmentPath => {
      const options = planOptions();
      expect(() =>
        createNativeWorkerFederationPlan({
          ...options,
          fragments: options.fragments.map(fragment => ({
            ...fragment,
            paths: { en: fragmentPath },
          })),
        }),
      ).toThrow('exact root endpoints');
    },
  );

  it('generates identical source regardless of authored expose and fragment order', () => {
    const options = planOptions();
    const source = nativeWorkerFederationRegistrySource(
      createNativeWorkerFederationPlan(options),
    );
    expect(
      nativeWorkerFederationRegistrySource(
        createNativeWorkerFederationPlan({
          ...options,
          authored: {
            ...options.authored,
            exposes: Object.fromEntries(
              Object.entries(options.authored.exposes).reverse(),
            ),
          },
          fragments: [...options.fragments].reverse().map(fragment => ({
            ...fragment,
            paths: Object.fromEntries(Object.entries(fragment.paths).reverse()),
          })),
        }),
      ),
    ).toBe(source);
    expect(source).not.toMatch(
      /__webpack_require__|\beval\b|node:|webpackIgnore|new Function/u,
    );
    expect(source).not.toContain('publisherBuildId');
    expect(source).not.toContain('workerFederationPublication =');
  });

  it('starts admitted profile modules before admission and keeps the compiled exposes lazy', async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'native-worker-federation-'),
    );
    directories.push(directory);
    const events: string[] = [];
    const eventKey = `native_worker_profile_${path.basename(directory)}`;
    fs.mkdirSync(path.join(directory, 'src'));
    fs.writeFileSync(
      path.join(directory, 'src/profile.mjs'),
      `globalThis[${JSON.stringify(eventKey)}].push("profile startup");`,
    );
    fs.writeFileSync(
      path.join(directory, 'src/Widget.mjs'),
      'throw new Error("widget was loaded");',
    );
    fs.writeFileSync(
      path.join(directory, 'src/Totals.mjs'),
      `globalThis[${JSON.stringify(eventKey)}].push("expose imported"); export const total = 42;`,
    );
    const plan = createNativeWorkerFederationPlan(planOptions(directory));
    const contextProfiles = await resolveNativeWorkerContextProfiles(
      ['./src/profile.mjs'],
      directory,
    );
    fs.writeFileSync(
      path.join(directory, 'registry.mjs'),
      nativeWorkerFederationRegistrySource(plan, { contextProfiles }),
    );
    const output = path.join(directory, 'dist');
    const compiler = rspack({
      context: directory,
      mode: 'none',
      target: 'webworker',
      entry: './registry.mjs',
      resolve: {
        alias: {
          '@modern-js/renderer-core/worker-federation$': path.resolve(
            __dirname,
            '../../../../runtime/renderer-core/src/worker-federation/index.ts',
          ),
        },
        extensions: ['.ts', '.mjs', '.js', '.json'],
      },
      module: {
        rules: [
          {
            test: /\.ts$/u,
            use: [{ loader: 'builtin:swc-loader' }],
          },
        ],
      },
      output: {
        path: output,
        filename: 'worker.mjs',
        chunkFilename: '[id].mjs',
        module: true,
        library: { type: 'module' },
        chunkFormat: 'module',
        chunkLoading: 'import',
      },
      optimization: { minimize: false },
    });
    try {
      Object.defineProperty(globalThis, eventKey, {
        value: events,
        configurable: true,
      });
      const stats = await new Promise<Rspack.Stats>((resolve, reject) =>
        compiler.run((error, result) => {
          if (error) reject(error);
          else if (!result)
            reject(new Error('Worker compilation returned no stats'));
          else resolve(result);
        }),
      );
      expect(stats.toJson({ all: false, errors: true }).errors).toEqual([]);
      const modules = [...stats.compilation.modules].map(module =>
        module.identifier(),
      );
      expect(modules).toEqual(
        expect.arrayContaining([
          expect.stringContaining(path.join(directory, 'src/Widget.mjs')),
          expect.stringContaining(path.join(directory, 'src/Totals.mjs')),
        ]),
      );
      expect(
        modules.some(module =>
          /node:|federation.*(?:node|runtime)/u.test(module),
        ),
      ).toBe(false);
      const worker = await import(
        pathToFileURL(path.join(output, 'worker.mjs')).href
      );
      expect(events).toEqual(['profile startup']);
      expect(worker.workerFederationCoordinateTemplate).toEqual(
        plan.coordinateTemplate,
      );
      expect(worker.rendererFederationPublication).toEqual(plan.renderer);
      expect(Object.isFrozen(worker.nativeWorkerFederationExposes)).toBe(true);
      expect(
        Object.isFrozen(
          worker.workerFederationCoordinateTemplate.exposes['./Widget'],
        ),
      ).toBe(true);
      expect(
        Object.isFrozen(worker.rendererFederationPublication.identities.main),
      ).toBe(true);
      const publication = finalizeNativeWorkerFederationPublication(
        plan,
        validatedClientArtifacts(),
      );
      const factoryOptions = {
        publication,
        manifestUrl: 'https://catalog.example/mf-manifest.json',
        admitRendererContract: readRendererFederationContract,
        admitNativeRequest: (payload: unknown) => {
          events.push('native admitted');
          return payload;
        },
        releaseNativeRequest: () => {
          events.push('native released');
        },
        renderNativeSnapshot: () => {
          throw new Error('unreached native rendering');
        },
      };
      const handler = worker.initializeNativeWorkerFederation(factoryOptions);
      await expect(
        handler(new Request('https://catalog.example/ordinary-route')),
      ).resolves.toBeUndefined();
      const requestHandler = worker.initializeNativeWorkerFederation({
        ...factoryOptions,
        // A wrapper cannot replace the graph compiled into this registry.
        exposes: {
          './Totals': () => {
            throw new Error('wrapper replaced the compiled loader');
          },
        },
        renderNativeSnapshot: (
          module: unknown,
          _request: unknown,
          execution: WorkerFederationExecution,
        ) => ({
          total:
            module && typeof module === 'object' && 'total' in module
              ? module.total
              : undefined,
          native: execution.admitted.coordinate.native,
        }),
      });
      const response = await requestHandler(
        new Request('https://catalog.example/en/_mf/fragment/totals', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            schema: 'ultramodern.worker-federation-request',
            schemaVersion: 1,
            authority: {
              origin: 'https://catalog.example',
              renderer: plan.renderer,
              worker: publication,
            },
            expose: './Totals',
            locale: 'en',
            payload: { opaqueNativeRequest: true },
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(events).toEqual([
        'profile startup',
        'native admitted',
        'expose imported',
        'native released',
      ]);
      expect((await response.json()).payload).toEqual({
        total: 42,
        native: {
          publisherBuildId: 'native-client-compilation-hash',
          runtimeABI: 1,
        },
      });
      for (const conflicting of [
        { ...publication, remote: 'other-remote' },
        {
          ...publication,
          exposes: {
            ...publication.exposes,
            './Widget': {
              ...publication.exposes['./Widget'],
              boundaryId: 'other_container',
            },
          },
        },
        {
          ...publication,
          exposes: {
            ...publication.exposes,
            './Widget': {
              ...publication.exposes['./Widget'],
              paths: { en: '/en/other', cs: '/cs/other' },
            },
          },
        },
      ])
        expect(() =>
          worker.initializeNativeWorkerFederation({
            ...factoryOptions,
            publication: conflicting,
          }),
        ).toThrow('conflicts with the compiled coordinates');
      await expect(
        worker.nativeWorkerFederationExposes['./Totals'](),
      ).resolves.toMatchObject({ total: 42 });
      await expect(
        worker.nativeWorkerFederationExposes['./Widget'](),
      ).rejects.toThrow('widget was loaded');
    } finally {
      try {
        await new Promise<void>((resolve, reject) =>
          compiler.close(error => (error ? reject(error) : resolve())),
        );
      } finally {
        Reflect.deleteProperty(globalThis, eventKey);
      }
    }
  });
});
