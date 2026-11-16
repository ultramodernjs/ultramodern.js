import assert from 'node:assert/strict';

export const sharedCoreVersion = '1.171.39';
export function sharedCoreManifest(original) {
  const manifest = structuredClone(original);
  delete manifest.dependencies['@tanstack/router-core'];
  Object.assign(manifest.dependencies, {
    '@tanstack/history': '1.162.5',
    '@tanstack/store': '0.11.2',
  });
  manifest.peerDependencies['@tanstack/router-core'] = sharedCoreVersion;
  return manifest;
}

export function assertSharedCoreManifest(manifest) {
  assert.equal(manifest.name, '@octanejs/tanstack-router');
  assert.equal(manifest.version, '0.3.4');
  assert.equal(
    manifest.peerDependencies?.['@tanstack/router-core'],
    sharedCoreVersion,
    'Native router must require the selected exact shared core',
  );
  assert(
    !Object.hasOwn(manifest.dependencies ?? {}, '@tanstack/router-core'),
    'Native router must not install a private router-core',
  );
  assert(
    !manifest.peerDependenciesMeta?.['@tanstack/router-core']?.optional,
    'Native router shared core peer must be required',
  );
  assert.equal(manifest.dependencies['@tanstack/history'], '1.162.5');
  assert.equal(manifest.dependencies['@tanstack/store'], '0.11.2');
  assert.equal(manifest.dependencies.isbot, '^5.1.22');
  assert.equal(manifest.peerDependencies.octane, '^0.18.0');
}
