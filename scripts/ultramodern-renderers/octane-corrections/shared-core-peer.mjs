import assert from 'node:assert/strict';

export const sharedCoreVersion = '1.171.39';
export const defaultOctaneCandidate = 'octane-0.18.0';
/**
 * Exact adapter/Octane tuple each owning candidate qualifies. Only the adapter
 * version and its octane peer range vary; the shared Core contract and every
 * independent dependency check are the same for every candidate.
 */
export const sharedCoreCandidates = Object.freeze({
  'octane-0.18.0': Object.freeze({
    adapterVersion: '0.3.4',
    octaneVersion: '0.18.0',
    octanePeer: '^0.18.0',
  }),
  'octane-0.20.0': Object.freeze({
    adapterVersion: '0.3.6',
    octaneVersion: '0.20.0',
    octanePeer: '^0.20.0',
  }),
});
export function sharedCoreCandidate(octaneCandidate = defaultOctaneCandidate) {
  assert(
    typeof octaneCandidate === 'string' &&
      Object.hasOwn(sharedCoreCandidates, octaneCandidate),
    `Unknown Octane adapter candidate: ${String(octaneCandidate)}`,
  );
  return sharedCoreCandidates[octaneCandidate];
}

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

export function assertSharedCoreManifest(
  manifest,
  octaneCandidate = defaultOctaneCandidate,
) {
  const candidate = sharedCoreCandidate(octaneCandidate);
  assert.equal(manifest.name, '@octanejs/tanstack-router');
  assert.equal(
    manifest.version,
    candidate.adapterVersion,
    `${octaneCandidate} qualifies exactly @octanejs/tanstack-router@${candidate.adapterVersion}`,
  );
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
  assert.equal(
    manifest.peerDependencies.octane,
    candidate.octanePeer,
    `${octaneCandidate} adapter must require octane ${candidate.octanePeer}`,
  );
}
