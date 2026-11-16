import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire as createActualRequire } from 'node:module' with {
  rstest: 'importActual',
};
import * as nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { defineRendererAdapter } from '@modern-js/renderer-core/adapter';
import { afterEach, describe, expect, it, rstest } from '@rstest/core';
import {
  projectInstalledRendererProfile,
  readRendererFrameworkPackage,
} from '../../src/native-composition/renderer-installed-profile';
import {
  type RendererBuildProfile,
  resolveCandidateRendererProfile,
  resolveRendererProfile,
  resolveRendererProfileMetadata,
} from '../../src/native-composition/renderer-profile';
import { resolveRendererAdapter } from '../../src/native-composition/renderer-registration';

rstest.mock('node:module', { spy: true });

// These physical resolver fixtures qualify metadata projection, not release builds.
const installedVersion = '3.8.3-ultramodern.42';
const solidPackage = '@modern-js/renderer-solid';
const mappedSolidPackage = '@bleedingdev/modern-js-renderer-solid';

function withFixture(run: (directory: string) => void): void {
  const directory = fs.realpathSync(
    fs.mkdtempSync(
      path.join(
        process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
        'ultramodern-installed-profile-',
      ),
    ),
  );
  try {
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: 'isolated-profile-consumer', version: '1.0.0' }),
    );
    run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function installFramework(
  root: string,
  dependencyKey: string,
  actualName: string,
  manifest: Record<string, unknown> = {},
): string {
  const owner = path.join(root, 'physical-packages', actualName);
  const exported = path.join(owner, 'dist', 'entry.cjs');
  fs.mkdirSync(path.dirname(exported), { recursive: true });
  fs.writeFileSync(
    path.join(owner, 'package.json'),
    JSON.stringify({
      name: actualName,
      version: installedVersion,
      // Stand-in for the publish step's canonical source stamp.
      ...(actualName.startsWith('@bleedingdev/modern-js-')
        ? {
            ultramodern: {
              sourceName: actualName.replace(
                '@bleedingdev/modern-js-',
                '@modern-js/',
              ),
            },
          }
        : {}),
      exports: {
        '.': './dist/entry.cjs',
        './server': './dist/entry.cjs',
        './manifest': './dist/entry.cjs',
        './cli': './dist/entry.cjs',
      },
      ...manifest,
    }),
  );
  // Resolving a public module must not evaluate its implementation.
  fs.writeFileSync(exported, 'throw new Error("Framework module evaluated");');
  const alias = path.join(root, 'node_modules', dependencyKey);
  fs.mkdirSync(path.dirname(alias), { recursive: true });
  fs.symlinkSync(owner, alias, 'dir');
  const consumerManifestFile = path.join(root, 'package.json');
  const consumerManifest = JSON.parse(
    fs.readFileSync(consumerManifestFile, 'utf8'),
  );
  consumerManifest.dependencies = {
    ...consumerManifest.dependencies,
    [dependencyKey]:
      dependencyKey === actualName
        ? installedVersion
        : `npm:${actualName}@${installedVersion}`,
  };
  fs.writeFileSync(consumerManifestFile, JSON.stringify(consumerManifest));
  return fs.realpathSync(owner);
}

function requestFrom(directory: string): NodeJS.Require {
  return createActualRequire(path.join(directory, 'package.json'));
}

function resolveInPlainNode(directory: string, specifier: string): string {
  return execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { createRequire } from 'node:module'; process.stdout.write(createRequire(process.argv[1]).resolve(process.argv[2]));",
      path.join(directory, 'package.json'),
      specifier,
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    },
  );
}

function solidCandidate(): RendererBuildProfile {
  return {
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
    compiler: { name: '@solidjs/compiler', version: '2.0.0-rc.15' },
    hydration: { name: '@solidjs/web', version: '2.0.0-rc.15' },
    router: {
      name: solidPackage,
      version: '3.8.3',
      coreName: '@tanstack/router-core',
      coreVersion: '1.171.37',
    },
    sourceExtensions: ['.tsx', '.ts', '.jsx', '.js'],
    jsxImportSource: '@solidjs/web',
    dependencies: Object.freeze({
      [solidPackage]: '3.8.3',
      '@modern-js/renderer-core': '3.8.3',
      '@modern-js/builder': '3.9.0',
      '@solidjs/compiler': '2.0.0-rc.15',
      '@solidjs/web': '2.0.0-rc.15',
    }),
    capabilities: {
      worker: false,
      moduleFederation: false,
      rsc: false,
      ssg: true,
      i18n: false,
      svgComponent: true,
    },
  };
}

afterEach(() => {
  rstest.mocked(nodeModule.createRequire).mockReset();
  rstest
    .mocked(nodeModule.createRequire)
    .mockImplementation(createActualRequire);
});

describe('selected SDK profile admission', () => {
  it.each(['solid', 'octane'] as const)(
    'rejects a %s adapter whose profile names another renderer',
    renderer => {
      const adapter = resolveRendererAdapter(renderer);
      expect(() =>
        defineRendererAdapter({
          ...adapter,
          profile: { ...adapter.profile, renderer: 'foreign-profile-owner' },
        }),
      ).toThrow('profile names foreign-profile-owner');
    },
  );

  it.each(['solid', 'octane'] as const)(
    'requires the %s federation descriptor and profile to agree',
    renderer => {
      const adapter = resolveRendererAdapter(renderer);
      expect(adapter.profile.capabilities.moduleFederation).toBe(true);
      expect(adapter).toMatchObject({
        federation: { library: 'module', ssr: true },
      });
      expect(() =>
        defineRendererAdapter({
          ...adapter,
          federation: undefined,
        }),
      ).toThrow('federation support contradicts its profile');
      expect(() =>
        defineRendererAdapter({
          ...adapter,
          profile: {
            ...adapter.profile,
            capabilities: {
              ...adapter.profile.capabilities,
              moduleFederation: false,
            },
          },
        }),
      ).toThrow('federation support contradicts its profile');
    },
  );
});

describe('physical installed framework profile identities', () => {
  it.each([solidPackage, mappedSolidPackage])(
    'reads the physical mapped manifest through public key %s',
    dependencyKey =>
      withFixture(directory => {
        const physical = installFramework(
          directory,
          dependencyKey,
          mappedSolidPackage,
        );
        const filename = requestFrom(directory).resolve(
          `${dependencyKey}/manifest`,
        );
        const binding = readRendererFrameworkPackage({
          specifier: solidPackage,
          filename,
        });
        expect(binding).toEqual({
          specifier: solidPackage,
          name: mappedSolidPackage,
          version: installedVersion,
          directory: physical,
        });
        expect(Object.isFrozen(binding)).toBe(true);
      }),
  );

  it('projects actual owner versions while preserving canonical identities and native pins', () =>
    withFixture(directory => {
      const owner = installFramework(
        directory,
        solidPackage,
        mappedSolidPackage,
      );
      installFramework(
        directory,
        '@modern-js/renderer-core',
        '@bleedingdev/modern-js-renderer-core',
      );
      installFramework(
        directory,
        '@modern-js/builder',
        '@bleedingdev/modern-js-builder',
      );
      const request = requestFrom(directory);
      const candidate = solidCandidate();
      const before = JSON.stringify(candidate);
      const metadata = projectInstalledRendererProfile(candidate, [
        {
          specifier: solidPackage,
          filename: request.resolve(`${solidPackage}/manifest`),
        },
        {
          specifier: '@modern-js/renderer-core',
          filename: request.resolve('@modern-js/renderer-core/server'),
        },
        {
          specifier: '@modern-js/builder',
          filename: request.resolve('@modern-js/builder'),
        },
      ]);
      expect(metadata.profile.router).toEqual({
        name: solidPackage,
        version: installedVersion,
        coreName: '@tanstack/router-core',
        coreVersion: '1.171.37',
      });
      expect(metadata.profile.dependencies).toEqual({
        [solidPackage]: installedVersion,
        '@modern-js/renderer-core': installedVersion,
        '@modern-js/builder': installedVersion,
        '@solidjs/compiler': '2.0.0-rc.15',
        '@solidjs/web': '2.0.0-rc.15',
      });
      expect(
        Object.hasOwn(metadata.profile.dependencies, mappedSolidPackage),
      ).toBe(false);
      expect(metadata.profile.compiler).toEqual(candidate.compiler);
      expect(metadata.profile.hydration).toEqual(candidate.hydration);
      expect(metadata.profile.sourceExtensions).toEqual(
        candidate.sourceExtensions,
      );
      expect(metadata.profile.minimumNode).toBe(candidate.minimumNode);
      expect(metadata.frameworkPackages[0].directory).toBe(owner);
      expect(JSON.stringify(candidate)).toBe(before);
      expect(Object.isFrozen(metadata)).toBe(true);
      expect(Object.isFrozen(metadata.profile.dependencies)).toBe(true);
      expect(Object.isFrozen(metadata.profile.router)).toBe(true);
      expect(Object.isFrozen(metadata.frameworkPackages)).toBe(true);
      expect(metadata.frameworkPackages.every(Object.isFrozen)).toBe(true);
    }));

  // The generator authors the canonical router at the release version; the
  // build must project the same tuple whichever way the owner is installed.
  const capturedRouter = () => ({
    ...solidCandidate().router,
    version: installedVersion,
  });

  it.each([
    { form: 'workspace-linked canonical', actualName: solidPackage },
    { form: 'published npm alias', actualName: mappedSolidPackage },
  ])(
    'projects the generator router identity for a $form owner',
    ({ actualName }) =>
      withFixture(directory => {
        const owner = installFramework(directory, solidPackage, actualName);
        const metadata = projectInstalledRendererProfile(solidCandidate(), [
          {
            specifier: solidPackage,
            filename: requestFrom(directory).resolve(
              `${solidPackage}/manifest`,
            ),
          },
        ]);
        expect(metadata.profile.router).toEqual(capturedRouter());
        expect(metadata.profile.dependencies[solidPackage]).toBe(
          installedVersion,
        );
        expect(metadata.frameworkPackages).toEqual([
          {
            specifier: solidPackage,
            name: actualName,
            version: installedVersion,
            directory: owner,
          },
        ]);
      }),
  );

  it.each([
    {
      form: 'a renamed owner without a publication source',
      actualName: '@foreign/solid-router',
      manifest: {},
      error:
        /@foreign\/solid-router@.* is not a publication of @modern-js\/renderer-solid/,
    },
    {
      form: 'a published owner of a different canonical package',
      actualName: mappedSolidPackage,
      manifest: { ultramodern: { sourceName: '@modern-js/renderer-octane' } },
      error: /is not a publication of @modern-js\/renderer-solid/,
    },
  ])(
    'rejects $form behind the canonical specifier',
    ({ actualName, manifest, error }) =>
      withFixture(directory => {
        installFramework(directory, solidPackage, actualName, manifest);
        expect(() =>
          projectInstalledRendererProfile(solidCandidate(), [
            {
              specifier: solidPackage,
              filename: requestFrom(directory).resolve(
                `${solidPackage}/manifest`,
              ),
            },
          ]),
        ).toThrow(error);
      }),
  );

  it('keeps a different installed provider version distinct from the captured router', () =>
    withFixture(directory => {
      installFramework(directory, solidPackage, mappedSolidPackage, {
        version: '3.8.3-ultramodern.43',
      });
      const metadata = projectInstalledRendererProfile(solidCandidate(), [
        {
          specifier: solidPackage,
          filename: requestFrom(directory).resolve(`${solidPackage}/manifest`),
        },
      ]);
      expect(metadata.profile.router.name).toBe(solidPackage);
      expect(metadata.profile.router).not.toEqual(capturedRouter());
    }));

  it.each([
    { name: undefined, version: undefined },
    { name: undefined },
    { name: 42 },
    { name: '@Invalid/owner' },
    { name: 'bad package name' },
    { version: undefined },
    { version: 42 },
    { version: '^3.8.3' },
    { version: 'not-a-version' },
  ])('rejects an invalid installed package manifest: %o', invalid =>
    withFixture(directory => {
      const owner = installFramework(
        directory,
        solidPackage,
        mappedSolidPackage,
      );
      const module = {
        specifier: solidPackage,
        filename: requestFrom(directory).resolve(`${solidPackage}/manifest`),
      };
      const manifestFile = path.join(owner, 'package.json');
      fs.writeFileSync(
        manifestFile,
        JSON.stringify({
          ...JSON.parse(fs.readFileSync(manifestFile, 'utf8')),
          ...invalid,
        }),
      );
      expect(() => readRendererFrameworkPackage(module)).toThrow(
        /Invalid installed framework manifest/,
      );
      expect(() =>
        projectInstalledRendererProfile(solidCandidate(), [module]),
      ).toThrow(/Invalid installed framework manifest/);
    }),
  );

  it('rejects malformed manifest JSON without substituting candidate identities', () =>
    withFixture(directory => {
      const owner = installFramework(
        directory,
        solidPackage,
        mappedSolidPackage,
      );
      const filename = requestFrom(directory).resolve(
        `${solidPackage}/manifest`,
      );
      fs.writeFileSync(path.join(owner, 'package.json'), '{ invalid');
      expect(() =>
        readRendererFrameworkPackage({ specifier: solidPackage, filename }),
      ).toThrow(SyntaxError);
    }));

  it('cleans the operation-owned physical fixture after an early resolution failure', () => {
    let owned = '';
    expect(() =>
      withFixture(directory => {
        owned = directory;
        resolveInPlainNode(directory, `${solidPackage}/manifest`);
      }),
    ).toThrow();
    expect(owned).not.toBe('');
    expect(fs.existsSync(owned)).toBe(false);
  });

  it.each([
    {
      renderer: 'solid',
      selected: [solidPackage],
      exports: [`${solidPackage}/manifest`],
    },
    {
      renderer: 'octane',
      selected: ['@modern-js/renderer-octane'],
      exports: ['@modern-js/renderer-octane/manifest'],
    },
    {
      renderer: 'react',
      selected: [
        '@modern-js/runtime',
        '@modern-js/runtime-renderer-extensions',
        '@modern-js/i18n-integration',
      ],
      exports: [
        '@modern-js/runtime/cli',
        '@modern-js/runtime-renderer-extensions',
        '@modern-js/i18n-integration',
      ],
    },
  ] as const)(
    'resolves only the selected $renderer framework through actual public module exports',
    ({ renderer, selected, exports: selectedExports }) =>
      withFixture(directory => {
        const frameworkNames = [
          '@modern-js/renderer-core',
          '@modern-js/builder',
          ...selected,
        ];
        for (const specifier of frameworkNames) {
          installFramework(
            directory,
            specifier,
            specifier.replace('@modern-js/', '@bleedingdev/modern-js-'),
          );
        }
        const request = requestFrom(directory);
        const resolve = rstest
          .spyOn(request, 'resolve')
          .mockImplementation(specifier =>
            resolveInPlainNode(directory, specifier),
          );
        rstest.mocked(nodeModule.createRequire).mockReturnValue(request);
        const metadata = resolveRendererProfileMetadata(renderer);
        expect(resolve.mock.calls.map(call => call[0])).toEqual([
          '@modern-js/renderer-core/server',
          '@modern-js/builder',
          ...selectedExports,
        ]);
        expect(
          metadata.frameworkPackages.map(binding => binding.specifier),
        ).toEqual(['@modern-js/ultramodern-app-tools', ...frameworkNames]);
        for (const binding of metadata.frameworkPackages.slice(1)) {
          expect(binding.name).toBe(
            binding.specifier.replace('@modern-js/', '@bleedingdev/modern-js-'),
          );
          expect(binding.version).toBe(installedVersion);
          expect(binding.directory).toBe(
            path.join(directory, 'physical-packages', binding.name),
          );
        }
        expect(metadata.profile.renderer).toBe(renderer);
        if (renderer === 'solid') {
          expect(metadata.profile.router.name).toBe(solidPackage);
          expect(metadata.profile.router.version).toBe(installedVersion);
        }
      }),
  );

  it.each([
    { renderer: 'react', selected: '@modern-js/runtime/cli' },
    { renderer: 'solid', selected: '@modern-js/renderer-solid/manifest' },
    { renderer: 'octane', selected: '@modern-js/renderer-octane/manifest' },
  ] as const)(
    'returns $renderer generation metadata without an installed selected SDK or resolver call',
    ({ renderer, selected }) =>
      withFixture(directory => {
        expect(() => resolveInPlainNode(directory, selected)).toThrow();
        const request = requestFrom(directory);
        const resolve = rstest.spyOn(request, 'resolve');
        const createRequire = rstest.mocked(nodeModule.createRequire);
        createRequire.mockReturnValue(request);
        createRequire.mockClear();

        const candidate = resolveCandidateRendererProfile(renderer);

        expect(candidate.renderer).toBe(renderer);
        expect(candidate.protocolVersion).toBe(1);
        expect(candidate.status).toBe(
          renderer === 'react' ? 'stable' : 'preview',
        );
        expect(candidate.capabilities.moduleFederation).toBe(true);
        expect(createRequire).not.toHaveBeenCalled();
        expect(resolve).not.toHaveBeenCalled();
      }),
  );

  it.each([
    { renderer: 'react', selected: /@modern-js\/runtime/ },
    { renderer: 'solid', selected: /@modern-js\/renderer-solid/ },
    { renderer: 'octane', selected: /@modern-js\/renderer-octane/ },
  ] as const)(
    'propagates a missing selected $renderer public export before returning an installed profile',
    ({ renderer, selected }) =>
      withFixture(directory => {
        installFramework(
          directory,
          '@modern-js/renderer-core',
          '@bleedingdev/modern-js-renderer-core',
        );
        installFramework(
          directory,
          '@modern-js/builder',
          '@bleedingdev/modern-js-builder',
        );
        const request = requestFrom(directory);
        rstest
          .spyOn(request, 'resolve')
          .mockImplementation(specifier =>
            resolveInPlainNode(directory, specifier),
          );
        rstest.mocked(nodeModule.createRequire).mockReturnValue(request);
        expect(() => resolveRendererProfileMetadata(renderer)).toThrow(
          selected,
        );
        expect(() => resolveRendererProfile(renderer)).toThrow(selected);
      }),
  );
  it('rejects an installed selected owner whose public manifest export is absent', () =>
    withFixture(directory => {
      installFramework(
        directory,
        '@modern-js/renderer-core',
        '@bleedingdev/modern-js-renderer-core',
      );
      installFramework(
        directory,
        '@modern-js/builder',
        '@bleedingdev/modern-js-builder',
      );
      installFramework(directory, solidPackage, mappedSolidPackage, {
        exports: { '.': './dist/entry.cjs' },
      });
      const request = requestFrom(directory);
      rstest.mocked(nodeModule.createRequire).mockReturnValue(request);
      expect(() => resolveRendererProfileMetadata('solid')).toThrow(
        /Package subpath '.\/manifest' is not defined by "exports"/,
      );
    }));
});
