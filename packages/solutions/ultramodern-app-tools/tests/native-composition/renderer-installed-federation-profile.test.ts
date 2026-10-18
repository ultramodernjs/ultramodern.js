import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertRendererFederationCompatibility,
  readRendererFederationCompatibility,
} from '@modern-js/federation-runtime/renderer-contract';
import type { RendererBuildProfile } from '@modern-js/renderer-core/adapter';
import { afterEach, describe, expect, it, rstest } from '@rstest/core';
import { resolveRendererFederationCompatibility } from '../../src/native-composition/module-federation-renderer-plugin';
import {
  projectInstalledFederationProfile,
  type RendererFrameworkPackageBinding,
} from '../../src/native-composition/renderer-installed-profile';
import * as rendererProfiles from '../../src/native-composition/renderer-profile';

rstest.mock('../../src/native-composition/renderer-profile', { spy: true });

const roots: string[] = [];
afterEach(() => {
  rstest.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'native-federation-profile-')),
  );
  roots.push(root);
  let nextOwner = 0;
  const install = (from: string, specifier: string, version: string) => {
    const directory = path.join(root, 'owners', String(nextOwner++));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: specifier, version, exports: './index.js' }),
    );
    fs.writeFileSync(
      path.join(directory, 'index.js'),
      'throw new Error("Native package must not be evaluated");',
    );
    const link = path.join(from, 'node_modules', specifier);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(directory, link);
    return directory;
  };
  const directory = install(root, '@modern-js/renderer-octane', '3.8.3');
  const bootstrap: RendererFrameworkPackageBinding = {
    specifier: '@modern-js/renderer-octane',
    name: '@modern-js/renderer-octane',
    version: '3.8.3',
    directory,
  };
  install(directory, '@octanejs/rspack-plugin', '0.2.4');
  install(directory, 'octane', '0.13.8');
  const router = install(directory, '@octanejs/tanstack-router', '0.2.10');
  const core = install(router, '@tanstack/router-core', '1.171.38');
  const profile: RendererBuildProfile<'octane'> = {
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
      coreVersion: '1.171.34',
    },
    sourceExtensions: ['.tsx'],
    jsxImportSource: 'octane',
    dependencies: { '@tanstack/router-core': '1.171.34' },
    capabilities: {
      worker: true,
      moduleFederation: true,
      rsc: false,
      ssg: true,
      i18n: true,
      svgComponent: true,
    },
  };
  return { root, install, bootstrap, router, core, profile };
}

describe('installed native federation tuple', () => {
  it('uses installed versions in the actual compatibility resolver', () => {
    const { bootstrap, profile } = fixture();
    rstest
      .spyOn(rendererProfiles, 'resolveRendererProfileMetadata')
      .mockReturnValue({
        profile,
        frameworkPackages: [bootstrap],
      });
    const compatibility = resolveRendererFederationCompatibility('octane');
    expect(compatibility.profile.router.coreVersion).toBe('1.171.38');
    expect(compatibility.runtime).toEqual({
      name: 'octane',
      version: '0.13.8',
    });
    expect(compatibility.bootstrap).toEqual({
      name: '@modern-js/renderer-octane',
      version: '3.8.3',
    });
  });

  it('emits the exact router-owned core without changing scaffold pins', () => {
    const { root, install, bootstrap, profile } = fixture();
    install(root, '@tanstack/router-core', '99.0.0');
    const installed = projectInstalledFederationProfile(profile, bootstrap);
    expect(installed.router.coreVersion).toBe('1.171.38');
    expect(installed.compiler.version).toBe('0.2.4');
    expect(installed.hydration.version).toBe('0.13.8');
    expect(profile.router.coreVersion).toBe('1.171.34');
    expect(installed.dependencies['@tanstack/router-core']).toBe('1.171.34');
  });

  it('preserves canonical profile names for stamped npm-aliased owners', () => {
    const { bootstrap, install, profile } = fixture();
    const name = '@bleedingdev/modern-js-renderer-octane';
    const manifestPath = path.join(bootstrap.directory, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        ...manifest,
        name,
        ultramodern: { sourceName: bootstrap.specifier },
      }),
    );
    const aliases: readonly (readonly [string, string])[] = [
      [profile.compiler.name, '@bleedingdev/octane-compiler'],
      [profile.hydration.name, '@bleedingdev/octane-runtime'],
    ];
    for (const [specifier, name] of aliases) {
      const filename = path.join(
        bootstrap.directory,
        'node_modules',
        specifier,
        'package.json',
      );
      const nativeManifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
      fs.writeFileSync(
        filename,
        JSON.stringify({
          ...nativeManifest,
          name,
          ultramodern: { sourceName: specifier },
        }),
      );
    }
    install(bootstrap.directory, '@tanstack/router-core', '1.171.38');
    const installed = projectInstalledFederationProfile(
      { ...profile, router: { ...profile.router, name: bootstrap.specifier } },
      { ...bootstrap, name },
    );
    expect(installed.router.name).toBe(bootstrap.specifier);
    expect(installed.router.version).toBe(bootstrap.version);
    expect(installed.router.coreVersion).toBe('1.171.38');
    expect(installed.compiler.name).toBe('@octanejs/rspack-plugin');
    expect(installed.hydration.name).toBe('octane');
  });

  it('accepts an identical installed tuple and rejects a stale remote core', () => {
    const { bootstrap, profile } = fixture();
    const installed = projectInstalledFederationProfile(profile, bootstrap);
    const compatibility = readRendererFederationCompatibility({
      profile: {
        renderer: installed.renderer,
        protocolVersion: installed.protocolVersion,
        compiler: installed.compiler,
        hydration: installed.hydration,
        router: installed.router,
      },
      runtime: { name: 'octane', version: '0.13.8' },
      bootstrap: { name: bootstrap.name, version: bootstrap.version },
    });
    expect(() =>
      assertRendererFederationCompatibility(compatibility, compatibility),
    ).not.toThrow();
    expect(() =>
      assertRendererFederationCompatibility(compatibility, {
        ...compatibility,
        profile: {
          ...compatibility.profile,
          router: { ...compatibility.profile.router, coreVersion: '1.171.34' },
        },
      }),
    ).toThrow('router.coreVersion');
  });

  it('rejects missing native owners instead of using source versions', () => {
    const { bootstrap, profile } = fixture();
    fs.unlinkSync(
      path.join(bootstrap.directory, 'node_modules/@octanejs/rspack-plugin'),
    );
    expect(() =>
      projectInstalledFederationProfile(profile, bootstrap),
    ).toThrow();
  });

  it('rejects a different package behind the selected core specifier', () => {
    const { bootstrap, core, profile } = fixture();
    fs.writeFileSync(
      path.join(core, 'package.json'),
      JSON.stringify({
        name: 'foreign-router-core',
        version: '1.171.38',
        exports: './index.js',
      }),
    );
    expect(() => projectInstalledFederationProfile(profile, bootstrap)).toThrow(
      'is not a publication of @tanstack/router-core',
    );
  });
});
