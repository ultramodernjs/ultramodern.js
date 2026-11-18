import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  artifactPolicy,
  bindArtifactProtocol,
} from '../../ultramodern-artifacts/protocol.mjs';
import {
  validateRecipe,
  verifySourceQualification,
} from '../../ultramodern-artifacts/reconstruct.mjs';
import {
  packages as octaneInputs,
  source as octaneSource,
} from '../octane-corrections/inputs.mjs';
import * as nativeProtocol from './protocol.mjs';
import { exactKeys, sha256 } from './protocol.mjs';
import {
  assertOwningLicense,
  runtimeSourceIntegrity as octaneArchiveIntegrity,
  owningLicenses,
  qualifyAdapterSource,
  qualifyRouterSource,
  qualifyRuntimePairSource,
  runtimeHandoffFiles,
  runtimePairNames,
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
  '6a2ebee5cc73df367ba768b9a950dee2a57ec0c93122ded77e5342ca8640df24';
const adapterPatch =
  'df6732ebcfc0af7cf274187c44596ac519abbc383ce30a796205b55c561bf688';
const adapterName = '@octanejs/tanstack-router';
const corrections = 'scripts/ultramodern-renderers/octane-corrections';
const candidateDirectory = `${corrections}/octane-0.20.0`;

// Only the producer selects this tuple before its archive is available.
export const octane20ArtifactProtocol = bindArtifactProtocol({
  ...artifactPolicy(nativeProtocol),
  cohort: {
    ...nativeProtocol.cohort,
    octane: '0.20.0',
    '@octanejs/tanstack-router': '0.3.6',
    '@octanejs/rspack-plugin': '0.2.12',
  },
});

function octaneRecipeInputs(root, octaneCandidate) {
  if (octaneCandidate === 'octane-0.18.0')
    return {
      protocol: nativeProtocol,
      inputs: octaneInputs,
      commit: octaneSource.commit,
      archiveIntegrity: octaneArchiveIntegrity,
      adapterPath:
        'patches/@octanejs__tanstack-router@0.3.4.shared-core-peer.patch',
      adapterPatch,
      runtimePaths: [
        'patches/octane@0.18.0.patch',
        'patches/@octanejs__rspack-plugin@0.2.10.patch',
      ],
    };
  assert.equal(octaneCandidate, 'octane-0.20.0', 'Unknown Octane recipe');
  const { upstream, candidates } = JSON.parse(
    fs.readFileSync(path.join(root, candidateDirectory, 'provenance.json')),
  );
  const protocol = octane20ArtifactProtocol;
  const inputs = [adapterName, ...runtimePairNames].map(name => {
    const pkg = upstream.packages[name];
    assert.equal(pkg.version, protocol.cohort[name]);
    assert.equal(upstream.tags[`${name}@${pkg.version}`], upstream.commit);
    assertOwningLicense(name, pkg.licenseSha256);
    return { ...pkg, name };
  });
  const [adapter, ...runtime] = inputs;
  const patchName = ({ name, version }) =>
    `${name.replace('/', '__')}@${version}`;
  const adapterFilename = `${patchName(adapter)}.shared-core-peer.patch`;
  return {
    protocol,
    inputs,
    commit: upstream.commit,
    archiveIntegrity: upstream.sourceArchive.integrity,
    adapterPath: `${candidateDirectory}/${adapterFilename}`,
    adapterPatch: candidates[adapterFilename].sha256,
    runtimePaths: runtime.map(input => `patches/${patchName(input)}.patch`),
  };
}

function verifyCandidateHandoff(root, runtimePaths) {
  const receiptPath = path.join(
    root,
    candidateDirectory,
    'runtime-handoff.json',
  );
  assert(
    fs.existsSync(receiptPath),
    'Octane 0.20.0 awaits the authenticated native compatibility handoff',
  );
  const receipt = JSON.parse(fs.readFileSync(receiptPath));
  assert.equal(receipt.schema, 'runtime-patch-handoff/v1');
  assert.equal(receipt.candidate, 'octane-0.20.0');
  assert.match(receipt.sourceSha, /^[a-f0-9]{40}$/u);
  assert.match(receipt.run?.id, /^[1-9][0-9]*$/u);
  assert.match(receipt.run?.attempt, /^[1-9][0-9]*$/u);
  assert.deepEqual(receipt.toolchain, {
    node: '26.13.1',
    pnpm: '12.21.0',
    mise: '2026.11.8',
  });
  const expectedInputs = [
    `${candidateDirectory}/runtime-source.patch`,
    `${candidateDirectory}/rspack-source.patch`,
    `${candidateDirectory}/rspack-tests.patch`,
    `${corrections}/runtime-tests.patch`,
    `${corrections}/typescript-compat/typescript-source.patch`,
    `${corrections}/typescript-compat/native-signals-source.patch`,
    `${corrections}/typescript-compat/volar-core-source.patch`,
    `${candidateDirectory}/provenance.json`,
    `${candidateDirectory}/runtime-build-package.json`,
    `${candidateDirectory}/runtime-build-pnpm-lock.yaml`,
  ];
  const verify = (entries, expected) => {
    assert.deepEqual(
      entries.map(entry => entry.path).sort(),
      [...expected].sort(),
      'Octane 0.20.0 handoff must bind the exact files',
    );
    for (const entry of entries) {
      const bytes = fs.readFileSync(path.join(root, entry.path));
      assert.equal(bytes.length, entry.bytes, `Handoff size: ${entry.path}`);
      assert.equal(
        sha256(bytes),
        entry.sha256,
        `Handoff digest: ${entry.path}`,
      );
    }
  };
  verify(receipt.inputs, expectedInputs);
  verify(receipt.patches, runtimePaths);
  return Object.fromEntries(
    receipt.patches.map(({ path, sha256 }) => [path, sha256]),
  );
}

export function completedRecipes({
  root = repo,
  octaneCandidate = 'octane-0.18.0',
} = {}) {
  const selected = octaneRecipeInputs(root, octaneCandidate);
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
  assert.equal(
    provenance.version,
    selected.protocol.cohort[provenance.package],
  );
  assert.equal(
    provenance.patchSha256,
    routerPatch,
    'Router provenance is not the reviewed owning build',
  );
  const adapter = selected.inputs.find(item => item.name === adapterName);
  assert.equal(adapter.version, selected.protocol.cohort[adapter.name]);
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
    [adapterName]: {
      patchPath: path.join(root, selected.adapterPath),
      patchSha256: selected.adapterPatch,
      upstream: {
        request: adapter.url,
        integrity: adapter.integrity,
        repository: 'octanejs/octane',
        commit: selected.commit,
        sourceArchiveIntegrity: selected.archiveIntegrity,
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
  root = repo,
  octaneCandidate = 'octane-0.18.0',
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
  const selected = octaneRecipeInputs(root, octaneCandidate);
  for (const [name, item] of Object.entries(runtime.packages)) {
    const original = selected.inputs.find(input => input.name === name);
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
      selected.commit,
      'Runtime source differs from adapter/compiler source cohort',
    );
    assert.equal(
      item.upstream.sourceArchiveIntegrity,
      selected.archiveIntegrity,
    );
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
      item: packages[adapterName],
      octaneCandidate,
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
      verifySourceQualification({
        protocol: selected.protocol,
        recipe,
        evidence,
      });
      return evidence;
    },
    async qualifyPacked(options) {
      // Qualification job rebuilds and runs owning suites against the actual
      // downloaded archives; reconstruct alone is not source qualification.
      await own(options);
      await runtime.qualifyPacked(options);
    },
  };
  validateRecipe({ protocol: selected.protocol, recipe });
  return recipe;
}
/** Production inputs from authenticated CI handoff 43988363275/1, not a native release receipt. */
export function runtimeRecipes(
  { root = repo, octaneCandidate = 'octane-0.18.0' } = {},
  { pairQualifier = qualifyRuntimePairSource } = {},
) {
  const selected = octaneRecipeInputs(root, octaneCandidate);
  const verify = () => {
    if (octaneCandidate !== 'octane-0.18.0')
      return verifyCandidateHandoff(root, selected.runtimePaths);
    verifyRuntimeHandoff(root);
    return runtimeHandoffFiles;
  };
  const patchDigests = verify();
  const packages = Object.fromEntries(
    runtimePairNames.map((name, index) => {
      const input = selected.inputs.find(item => item.name === name);
      assert.equal(input.version, selected.protocol.cohort[name]);
      const relative = selected.runtimePaths[index];
      return [
        name,
        {
          patchPath: path.join(root, relative),
          patchSha256: patchDigests[relative],
          upstream: {
            request: input.url,
            integrity: input.integrity,
            repository: 'octanejs/octane',
            commit: selected.commit,
            sourceArchiveIntegrity: selected.archiveIntegrity,
            licenseSha256: owningLicenses[name],
          },
        },
      ];
    }),
  );
  // One owning build qualifies both packages; running it per package repeated
  // the entire source, build, packed and reconstruction pipeline.
  const qualify = async ({ directory, workDirectory }) => {
    assert.deepEqual(verify(), patchDigests);
    const evidence = await pairQualifier({
      items: packages,
      workDirectory,
      packedDirectory: directory,
      ...(octaneCandidate !== 'octane-0.18.0' && { octaneCandidate }),
    });
    assert.deepEqual(verify(), patchDigests);
    return evidence;
  };
  return { packages, qualifySource: qualify, qualifyPacked: qualify };
}
export function releaseRecipe({
  root = repo,
  octaneCandidate = 'octane-0.18.0',
} = {}) {
  const runtime = runtimeRecipes({ root, octaneCandidate });
  return composeRecipe({
    root,
    octaneCandidate,
    completed: completedRecipes({ root, octaneCandidate }),
    runtime,
  });
}
