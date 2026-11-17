import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildEnvironment } from '../ultramodern-dependencies/otel-corrections/portable.mjs';
import { currentProducer, main } from './main.mjs';
import {
  candidateSupportProtocol as candidate,
  inputs,
  supportProtocol as p,
} from './protocol.mjs';
import { readRecipes, releaseRecipe } from './recipes.mjs';
import { validateRecipe, verifySourceQualification } from './reconstruct.mjs';

const source = 'a'.repeat(40);
const producer = {
  repository: p.repository,
  repositoryId: p.repositoryId,
  workflow: p.workflow,
  source,
  runId: 1,
  runAttempt: 1,
  tag: `support-artifacts-${source}-1-1`,
};
function manifest(protocol = p) {
  return {
    protocol: protocol.protocol,
    producer: { ...producer },
    packages: Object.fromEntries(
      Object.entries(protocol.cohort).map(([name, version]) => [
        name,
        {
          version,
          request: protocol.releaseUrl(
            producer,
            protocol.assetFilename(name, version),
          ),
          integrity: protocol.integrity(Buffer.from(name)),
          upstream: structuredClone(inputs[name].upstream),
          patchSha256: inputs[name].patchSha256,
        },
      ]),
    ),
  };
}
const producerEnv = {
  GITHUB_REPOSITORY: p.repository,
  GITHUB_REPOSITORY_ID: String(p.repositoryId),
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main-ultramodern',
  GITHUB_ACTOR: 'BleedingDev',
  GITHUB_TRIGGERING_ACTOR: 'BleedingDev',
  GITHUB_WORKFLOW_REF: `${p.repository}/${p.workflow}@refs/heads/main-ultramodern`,
  GITHUB_SHA: source,
  GITHUB_RUN_ID: '1',
  GITHUB_RUN_ATTEMPT: '1',
};
test('closed v3 seven support identities and eight release assets', () => {
  const m = manifest();
  p.validateManifest(m);
  assert.equal(p.protocol, 'ultramodern.support-artifacts.v3');
  assert.deepEqual(m.packages && Object.keys(m.packages).sort(), [
    '@effect/opentelemetry',
    '@rstest/core',
    '@tanstack/react-router',
    '@types/ioredis-mock',
    'ioredis-mock',
    'rsbuild-plugin-dts',
    'solid-js',
  ]);
  assert.equal(Object.keys(m.packages).length + 1, 8);
  assert.equal(p.cohort['rsbuild-plugin-dts'], '1.0.7');
  assert.equal(p.manifestFilename, 'support-artifacts.json');
  assert.equal(
    p.descriptorFor(m).manifest.request,
    p.releaseUrl(producer, 'support-artifacts.json'),
  );
});
test('producer-only v4 candidate has six identities and seven release assets', () => {
  const m = manifest(candidate);
  candidate.validateManifest(m);
  assert.equal(candidate.protocol, 'ultramodern.support-artifacts.v4');
  assert.deepEqual(Object.keys(m.packages).sort(), [
    '@effect/opentelemetry',
    '@rstest/core',
    '@tanstack/react-router',
    '@types/ioredis-mock',
    'ioredis-mock',
    'rsbuild-plugin-dts',
  ]);
  assert.equal(Object.keys(m.packages).length + 1, 7);
  assert.deepEqual(
    candidate.descriptorFor(m).manifest.request,
    p.releaseUrl(producer, 'support-artifacts.json'),
  );
  // Consumers keep the active v3 authority and reject the candidate until admission.
  assert.throws(() => p.validateManifest(m));
  assert.throws(() => candidate.validateManifest(manifest()));
  const withSolid = manifest(candidate);
  withSolid.packages['solid-js'] = manifest().packages['solid-js'];
  assert.throws(() => candidate.validateManifest(withSolid));
  const recipe = releaseRecipe(candidate);
  assert.deepEqual(
    Object.keys(recipe.packages).sort(),
    Object.keys(m.packages).sort(),
  );
  assert.throws(() => validateRecipe(recipe));
  validateRecipe(releaseRecipe());
});
test('producer CLI binds the v4 candidate, never the active v3 consumer cohort', async t => {
  assert(process.env.OWNED_TEMP_DIR, 'Use owned-temp-dir');
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'support-cli-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = m =>
    fs.writeFileSync(
      path.join(root, 'support-artifacts.json'),
      JSON.stringify(m),
    );
  write(manifest());
  await assert.rejects(
    main(['qualify', root], producerEnv),
    /support-artifacts\.v4/,
  );
  // A v4 manifest passes protocol validation and fails only on missing archives.
  write(manifest(candidate));
  await assert.rejects(
    main(['qualify', root], producerEnv),
    /Exact release payload set required/,
  );
});
test('native/support mixing and missing identities fail closed', () => {
  for (const mutate of [
    m => (m.protocol = 'ultramodern.native-artifacts.v1'),
    m => (m.protocol = 'ultramodern.support-artifacts.v1'),
    m => (m.protocol = 'ultramodern.support-artifacts.v2'),
    m => delete m.packages['@tanstack/react-router'],
    m => delete m.packages['rsbuild-plugin-dts'],
    m => (m.packages.octane = m.packages['solid-js']),
    m => delete m.packages['solid-js'],
  ]) {
    const m = manifest();
    mutate(m);
    assert.throws(() => p.validateManifest(m));
  }
});
test('unknown fields and invented npm-source commit rejected', () => {
  for (const mutate of [
    m => (m.bypass = true),
    m => (m.producer.skip = true),
    m => (m.packages['@effect/opentelemetry'].upstream.commit = source),
    m => (m.packages['rsbuild-plugin-dts'].upstream.commit = source),
    m =>
      (m.packages['rsbuild-plugin-dts'].upstream.sourceArchiveIntegrity =
        m.packages['@effect/opentelemetry'].upstream.sourceArchiveIntegrity),
    m => (m.packages['solid-js'].upstream.licenseLocation = 'npm'),
    m =>
      (m.packages['@tanstack/react-router'].upstream.commit = 'b'.repeat(40)),
    m =>
      (m.packages['@tanstack/react-router'].upstream.sourceArchiveIntegrity =
        m.packages['solid-js'].upstream.sourceArchiveIntegrity),
    m =>
      (m.packages['@tanstack/react-router'].upstream.licenseSha256 = 'b'.repeat(
        64,
      )),
  ]) {
    const m = manifest();
    mutate(m);
    assert.throws(() => p.validateManifest(m));
  }
});
test('immutable source provenance and exact canonical patch handoff', () => {
  assert.throws(() => {
    inputs['solid-js'].upstream.commit = 'b'.repeat(40);
  });
  const recipe = {
    packages: readRecipes(),
    qualifySource: async () => {},
    qualifyPacked: async () => {},
  };
  validateRecipe(recipe);
  assert.throws(() => validateRecipe({ ...recipe, bypass: true }));
  assert.throws(() => validateRecipe({ ...recipe, qualifyPacked: undefined }));
  assert.throws(() => verifySourceQualification(recipe, {}));
  assert.throws(() =>
    verifySourceQualification(
      recipe,
      Object.fromEntries(
        Object.keys(p.cohort).map(name => [
          name,
          {
            sourceArchiveBytes: Buffer.from('wrong'),
            builtPatchBytes: Buffer.from('wrong'),
            licenseBytes: Buffer.from('wrong'),
          },
        ]),
      ),
    ),
  );
});
test('source/actor/workflow guards fail closed', () => {
  const env = producerEnv;
  assert.deepEqual(currentProducer(env), producer);
  for (const key of [
    'GITHUB_ACTOR',
    'GITHUB_TRIGGERING_ACTOR',
    'GITHUB_REPOSITORY',
    'GITHUB_WORKFLOW_REF',
    'GITHUB_EVENT_NAME',
  ])
    assert.throws(() => currentProducer({ ...env, [key]: 'untrusted' }));
});
test('owning command environment strips all credentials and policy controls', () => {
  assert.deepEqual(
    buildEnvironment({
      PATH: '/bin',
      HOME: '/home/user',
      GH_TOKEN: 'secret',
      GITHUB_TOKEN: 'secret',
      NPM_TOKEN: 'secret',
      NODE_OPTIONS: '--import=evil',
      PNPM_HOME: 'evil',
      npm_config_force: 'true',
      SUPPORT_SKIP_GATES: '1',
    }),
    { PATH: '/bin', HOME: '/home/user' },
  );
});
test('workflow only publish writes; no token reaches source/packed builds', () => {
  const text = fs.readFileSync(
    new URL('../../.github/workflows/support-artifacts.yml', import.meta.url),
    'utf8',
  );
  assert.equal((text.match(/contents: write/g) || []).length, 1);
  assert.equal((text.match(/GH_TOKEN:/g) || []).length, 1);
  assert.equal((text.match(/cache_save: false/g) || []).length, 2);
  assert(!text.includes('pnpm@11.'));
  assert(text.includes("node-version: '26.13.1'"));
  assert(text.includes('  publish:'));
  assert(text.indexOf('GH_TOKEN:') > text.indexOf('  publish:'));
  assert(!text.includes('persist-credentials: true'));
});

test('support receipt package versions and producer tag cannot drift', () => {
  const m = manifest();
  m.packages['@rstest/core'].version = '0.12.5';
  assert.throws(() => p.validateManifest(m));
  const dts = manifest();
  dts.packages['rsbuild-plugin-dts'].version = '1.0.3';
  assert.throws(() => p.validateManifest(dts));
  const other = manifest();
  other.producer.tag = 'native-renderers-' + source + '-1-1';
  assert.throws(() => p.validateManifest(other));
});
