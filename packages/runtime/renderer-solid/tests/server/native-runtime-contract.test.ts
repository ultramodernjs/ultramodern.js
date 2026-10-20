import { readFileSync } from 'node:fs';
import { SOLID_RENDERER_PROFILE } from '../../src';
import { rendererAdapter } from '../../src/plugin';

describe('Solid 2 native dependency ownership', () => {
  test('generates the same accepted router core that the renderer installs', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    const coreRequest = manifest.dependencies['@tanstack/router-core'];
    expect(coreRequest).toBe(
      'https://github.com/BleedingDev/router/releases/download/ultramodern-router-core-585d3233f7f5/tanstack-router-core-1.171.38.tgz',
    );
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
    expect(rendererAdapter.profile.compiler.version).toBe('2.0.0-rc.15');
    expect(rendererAdapter.profile.hydration.version).toBe('2.0.0-rc.15');
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
