// Explicit clean-room qualification; never installs into the repository.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const execute = promisify(execFile);

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
    if (profile === 'mf-cohort') {
      await assert.rejects(
        qualifyPackedSidecars(
          { manifest: { profile }, sidecars },
          {
            scratchRoot: root,
            async run(command, args, options) {
              assert.equal(command, 'npm');
              assert.equal(args[0], 'install');
              const filename = path.join(options.cwd, 'package.json');
              const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
              manifest.dependencies.webpack = '5.105.4';
              fs.writeFileSync(filename, JSON.stringify(manifest));
              // Real strict npm resolution must reject this advertised-unsupported
              // compiler, before any plugin application or accepted receipt.
              await execute(command, args, {
                cwd: options.cwd,
                env: options.env,
                timeout: 120_000,
                maxBuffer: 4 * 1024 * 1024,
              });
              assert.fail('Unsupported Webpack was admitted');
            },
          },
        ),
        error =>
          /ERESOLVE/u.test(error.stderr ?? '') &&
          /peerOptional webpack@"\^5\.112\.2"/u.test(error.stderr ?? '') &&
          /webpack@5\.105\.4/u.test(error.stderr ?? ''),
      );
    }
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
