// Explicit clean-room qualification; never installs into the repository.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

for (const profile of ['mf-cohort', 'tanstack-redact', 'parser']) {
  test(`${profile}: authenticated sidecars pass real packed strict installation and canonical API probes`, {
    timeout: 240_000,
  }, async t => {
    assert.ok(process.env.OWNED_TEMP_DIR, 'Run with owned-temp-dir --run');
    const root = fs.mkdtempSync(
      path.join(process.env.OWNED_TEMP_DIR, 'mf-cohort-proof-'),
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const {
      collectSidecarPackages,
      stageSidecarPackages,
      writeSidecarStagingManifest,
    } = await import('../lib/prepare-bleedingdev-packages/sidecars.mjs');
    const { verifySidecarArtifacts } = await import(
      '../lib/prepare-bleedingdev-packages/release-artifacts.mjs'
    );
    const { sidecarProfile, sidecarProfileRecipes } = await import(
      '../sidecar-profiles.mjs'
    );
    const { qualifyPackedSidecars } = await import(
      '../qualify-sidecar-bundle.mjs'
    );
    const selected = sidecarProfile(profile);
    const packages = collectSidecarPackages(undefined, {
      roots: selected.recipeIds.map(id => `packages/sidecar/${id}`),
      reviewedRecipes: sidecarProfileRecipes(profile),
    });
    const staged = await stageSidecarPackages(packages, root);
    const out = path.join(root, 'bundle');
    fs.mkdirSync(out);
    const { descriptor } = writeSidecarStagingManifest(out, staged, {
      publishBefore: selected.publishBefore,
    });
    const sidecars = verifySidecarArtifacts(out, descriptor);
    assert.equal(sidecars.packages.length, selected.recipeIds.length);
    const probes = await qualifyPackedSidecars(
      { manifest: { profile }, sidecars },
      { scratchRoot: root },
    );
    assert.deepEqual(
      probes,
      Object.fromEntries(selected.probeKeys.map(key => [key, true])),
    );
  });
}
