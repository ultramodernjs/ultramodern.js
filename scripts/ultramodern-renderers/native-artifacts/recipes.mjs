import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  packages as octaneInputs,
  source as octaneSource,
} from '../octane-corrections/inputs.mjs';
import { cohort, exactKeys, sha256 } from './protocol.mjs';
import { validateRecipe, verifySourceQualification } from './reconstruct.mjs';
import {
  assertOwningLicense,
  runtimeSourceIntegrity as octaneArchiveIntegrity,
  owningLicenses,
  qualifyAdapterSource,
  qualifyRouterSource,
  qualifyRspackSource,
  qualifyRuntimeSource,
  runtimeHandoffFiles,
  verifyRuntimeHandoff,
} from './source-qualification.mjs';

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const routerProvenancePath = path.join(
  repo,
  'scripts/ultramodern-renderers/router-corrections/provenance.json',
);
const routerPatch =
  '546a4a8ecd4cc45419bff0c99c860ab2c9e2d1a8ffd4b1512cedd748e9b5cac8';
const adapterPatch =
  'c82cc89c373d23b42b24cb9eb5d748940170b76895bd94139d538ceeebe6af9b';

export function completedRecipes({ root = repo } = {}) {
  const provenance = JSON.parse(
    fs.readFileSync(
      root === repo
        ? routerProvenancePath
        : path.join(
            root,
            'scripts/ultramodern-renderers/router-corrections/provenance.json',
          ),
    ),
  );
  assert.equal(provenance.package, '@tanstack/router-core');
  assert.equal(provenance.version, cohort[provenance.package]);
  assert.equal(
    provenance.patchSha256,
    routerPatch,
    'Router provenance is not the reviewed owning build',
  );
  const adapter = octaneInputs.find(
    item => item.name === '@octanejs/tanstack-router',
  );
  assert.equal(adapter.version, cohort[adapter.name]);
  assert.equal(octaneSource.commit, '4c35afcdca0f4889921612fc462e6aabe507d78d');
  const packages = {
    '@tanstack/router-core': {
      patchPath: path.join(
        root,
        'patches/@tanstack__router-core@1.171.39.patch',
      ),
      patchSha256: routerPatch,
      upstream: {
        request:
          'https://registry.npmjs.org/@tanstack/router-core/-/router-core-1.171.39.tgz',
        integrity: provenance.upstreamNpmIntegrity,
        repository: 'TanStack/router',
        commit: provenance.upstreamCommit,
        sourceArchiveIntegrity: `sha512-${Buffer.from(provenance.sourceArchiveSha512, 'hex').toString('base64')}`,
        licenseSha256: provenance.licenseSha256,
      },
    },
    '@octanejs/tanstack-router': {
      patchPath: path.join(
        root,
        'patches/@octanejs__tanstack-router@0.3.4.patch',
      ),
      patchSha256: adapterPatch,
      upstream: {
        request: adapter.url,
        integrity: adapter.integrity,
        repository: 'octanejs/octane',
        commit: octaneSource.commit,
        sourceArchiveIntegrity: octaneArchiveIntegrity,
        licenseSha256: owningLicenses[adapter.name],
      },
    },
  };
  for (const [name, item] of Object.entries(packages))
    assert.equal(
      sha256(fs.readFileSync(item.patchPath)),
      item.patchSha256,
      `${name}: canonical patch differs from owning qualified recipe`,
    );
  return { packages, provenance };
}

/** Both runtime packages form a closed source-qualified pair, never a registry fallback. */
export function composeRecipe({
  completed,
  runtime,
  qualifyRouter = qualifyRouterSource,
  qualifyAdapter = qualifyAdapterSource,
}) {
  assert(
    runtime,
    'Native release recipe pending: missing exact octane/Rspack production pair and owning qualification hooks',
  );
  assert.deepEqual(Object.keys(runtime.packages).sort(), [
    '@octanejs/rspack-plugin',
    'octane',
  ]);
  assert.equal(typeof runtime.qualifySource, 'function');
  assert.equal(typeof runtime.qualifyPacked, 'function');
  for (const [name, item] of Object.entries(runtime.packages)) {
    const original = octaneInputs.find(input => input.name === name);
    assert.equal(
      item.upstream.request,
      original.url,
      `${name}: another upstream package request`,
    );
    assert.equal(
      item.upstream.integrity,
      original.integrity,
      `${name}: another upstream package archive`,
    );
    assert.equal(item.upstream.repository, 'octanejs/octane');
    assert.equal(
      item.upstream.commit,
      octaneSource.commit,
      'Runtime source differs from adapter/compiler source cohort',
    );
    assert.equal(item.upstream.sourceArchiveIntegrity, octaneArchiveIntegrity);
    assertOwningLicense(name, item.upstream.licenseSha256);
    assert.equal(
      sha256(fs.readFileSync(item.patchPath)),
      item.patchSha256,
      'Runtime canonical patch differs from handoff',
    );
  }
  const packages = { ...completed.packages, ...runtime.packages };
  for (const [name, item] of Object.entries(packages))
    assertOwningLicense(name, item.upstream.licenseSha256);
  const own = async ({ workDirectory, directory }) => {
    const router = await qualifyRouter({
      item: packages['@tanstack/router-core'],
      provenance: completed.provenance,
      workDirectory,
      packedDirectory: directory,
    });
    const adapter = await qualifyAdapter({
      item: packages['@octanejs/tanstack-router'],
      source: octaneSource,
      workDirectory,
      packedDirectory: directory,
    });
    return {
      '@tanstack/router-core': router,
      '@octanejs/tanstack-router': adapter,
    };
  };
  const recipe = {
    packages,
    async qualifySource(options) {
      const runtimeEvidence = await runtime.qualifySource(options);
      exactKeys(
        runtimeEvidence,
        ['octane', '@octanejs/rspack-plugin'],
        'runtime owning qualification cohort',
      );
      const evidence = { ...(await own(options)), ...runtimeEvidence };
      verifySourceQualification(recipe, evidence);
      return evidence;
    },
    async qualifyPacked(options) {
      // Qualification job rebuilds and runs owning suites against the actual
      // downloaded archives; reconstruct alone is not source qualification.
      await own(options);
      await runtime.qualifyPacked(options);
    },
  };
  validateRecipe(recipe);
  return recipe;
}
/** Production inputs from the explicit 53f0 handoff, not a successful-build receipt. */
export function runtimeRecipes(
  { root = repo } = {},
  {
    runtimeQualifier = qualifyRuntimeSource,
    rspackQualifier = qualifyRspackSource,
  } = {},
) {
  verifyRuntimeHandoff(root);
  const packages = Object.fromEntries(
    ['octane', '@octanejs/rspack-plugin'].map(name => {
      const input = octaneInputs.find(item => item.name === name);
      assert.equal(input.version, cohort[name]);
      const relative =
        name === 'octane'
          ? 'patches/octane@0.18.0.patch'
          : 'patches/@octanejs__rspack-plugin@0.2.10.patch';
      return [
        name,
        {
          patchPath: path.join(root, relative),
          patchSha256: runtimeHandoffFiles[relative],
          upstream: {
            request: input.url,
            integrity: input.integrity,
            repository: 'octanejs/octane',
            commit: octaneSource.commit,
            sourceArchiveIntegrity: octaneArchiveIntegrity,
            licenseSha256: owningLicenses[name],
          },
        },
      ];
    }),
  );
  const qualify = async ({ directory, workDirectory }) => {
    verifyRuntimeHandoff(root);
    const evidence = {};
    for (const [name, qualifier] of [
      ['octane', runtimeQualifier],
      ['@octanejs/rspack-plugin', rspackQualifier],
    ]) {
      evidence[name] = await qualifier({
        item: packages[name],
        workDirectory,
        packedDirectory: directory,
      });
      verifyRuntimeHandoff(root);
    }
    return evidence;
  };
  return { packages, qualifySource: qualify, qualifyPacked: qualify };
}
export function releaseRecipe({ root = repo } = {}) {
  return composeRecipe({
    completed: completedRecipes({ root }),
    runtime: runtimeRecipes({ root }),
  });
}
