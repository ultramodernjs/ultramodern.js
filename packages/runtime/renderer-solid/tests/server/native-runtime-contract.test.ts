import { readFileSync } from 'node:fs';
import { SOLID_RENDERER_PROFILE } from '../../src';
import { rendererAdapter } from '../../src/plugin';

describe('Solid 2 native dependency ownership', () => {
  test('preserves the selected runtime install request instead of replacing it with a version', () => {
    // Synthetic transport identity: this does not claim a published release.
    const request = 'https://unit.invalid/qualified-solid-control.tgz';
    const profile = {
      ...rendererAdapter.profile,
      dependencies: {
        ...rendererAdapter.profile.dependencies,
        'solid-js': request,
      },
    };
    expect(
      rendererAdapter.create?.dependencies(profile, {
        typescriptVersion: '7.0.2',
      }).dependencies['solid-js'],
    ).toBe(request);
  });

  test('generates the same accepted router core that the renderer installs', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    // The authenticated native producer descriptor owns the Core archive.
    const nativeArtifacts = manifest.ultramodern.nativeArtifacts;
    expect(nativeArtifacts.protocol).toBe('ultramodern.native-artifacts.v1');
    const core = nativeArtifacts.packages['@tanstack/router-core'];
    const coreRequest = core.request;
    expect(manifest.devDependencies['@tanstack/router-core']).toBe(coreRequest);
    // Published consumers cannot install archive subdependencies, so the
    // renderer peers on the exact Core version and the generator installs it.
    expect(manifest.dependencies['@tanstack/router-core']).toBeUndefined();
    expect(manifest.peerDependencies['@tanstack/router-core']).toBe(
      core.version,
    );
    expect(rendererAdapter.profile.router.coreVersion).toBe(core.version);
    expect(
      rendererAdapter.create?.dependencies(rendererAdapter.profile, {
        typescriptVersion: '7.0.2',
      }).dependencies['@tanstack/router-core'],
    ).toBe(coreRequest);
    expect(rendererAdapter.profile.router.coreVersion).toBe(
      SOLID_RENDERER_PROFILE.routerCore,
    );
    expect(SOLID_RENDERER_PROFILE.history).toBe(
      manifest.dependencies['@tanstack/history'],
    );
  });

  test('shares native runtime owners without replacing the independent HTTP codec', () => {
    expect(rendererAdapter.profile.compiler.version).toBe('2.0.1');
    expect(rendererAdapter.profile.hydration.version).toBe('2.0.1');
    expect(rendererAdapter.federation.shared).toEqual(
      expect.arrayContaining(['solid-js', '@solidjs/web', '@solidjs/signals']),
    );
    expect(rendererAdapter.profile.dependencies).not.toHaveProperty('seroval');
    expect(rendererAdapter.profile.dependencies).not.toHaveProperty(
      'seroval-plugins',
    );
    expect(rendererAdapter.federation.shared).not.toContain('seroval');
    expect(rendererAdapter.federation.shared).not.toContain('seroval-plugins');
  });
});
