// Closed inputs shared by the standalone producer, installer and consumer graph.
// This label records dependency ordering only; it is no cohort/version qualification.
export const sidecarPublishBefore = '@bleedingdev/modern-js-utils';
export const sidecarRecipeIds = Object.freeze([
  'braces',
  'fast-glob',
  'find-workspaces',
  'micromatch',
  'rsbuild-plugin-source-build',
  'ultracite',
]);
export const sidecarQualificationProbeKeys = Object.freeze([
  'packed-install',
  'braces-api',
  'braces-depth-guard',
  'glob-api',
  'ultracite-api',
]);
export const sidecarProfiles = Object.freeze({
  parser: Object.freeze({
    recipeIds: sidecarRecipeIds,
    probeKeys: sidecarQualificationProbeKeys,
    publishBefore: sidecarPublishBefore,
  }),
  'mf-sdk': Object.freeze({
    recipeIds: Object.freeze(['mf-sdk']),
    dependencies: Object.freeze({ '@bleedingdev/mf-sdk': '2.9.2' }),
    probeKeys: Object.freeze([
      'packed-install',
      'mf-sdk-cjs-api',
      'mf-sdk-esm-api',
    ]),
    publishBefore: '@bleedingdev/modern-js-federation-runtime',
  }),
  'tanstack-redact': Object.freeze({
    recipeIds: Object.freeze(['tanstack-redact']),
    dependencies: Object.freeze({ '@bleedingdev/tanstack-redact': '0.2.1' }),
    probeKeys: Object.freeze([
      'packed-install',
      'redact-patch-marker',
      'redact-server-render',
    ]),
    publishBefore: '@bleedingdev/modern-js-ultramodern-app-tools',
  }),
});

export function sidecarProfile(name) {
  if (typeof name !== 'string' || !Object.hasOwn(sidecarProfiles, name))
    throw new Error(
      'Unknown sidecar profile; expected parser, mf-sdk or tanstack-redact',
    );
  return sidecarProfiles[name];
}

export function assertSidecarProfileDependencies(name, packages) {
  const { dependencies } = sidecarProfile(name);
  if (!dependencies) return;
  const actual = packages
    .map(({ name, version }) => `${name}@${version}`)
    .sort();
  const expected = Object.entries(dependencies)
    .map(([name, version]) => `${name}@${version}`)
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      'Sidecar installed dependencies differ from the closed profile',
    );
}
