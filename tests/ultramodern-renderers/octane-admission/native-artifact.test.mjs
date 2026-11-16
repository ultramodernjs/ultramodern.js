import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { targets } from '../../../scripts/ultramodern-dependencies/snapshot.mjs';
import { fixture } from '../../../scripts/ultramodern-renderers/native-artifacts/fixtures.test-support.mjs';
import { cohort } from '../../../scripts/ultramodern-renderers/native-artifacts/protocol.mjs';
import { cohort as octaneCohort } from '../../../scripts/ultramodern-renderers/octane-corrections/inputs.mjs';
import { createOctaneFederationFixtures } from '../octane-federation/fixtures.mjs';
import {
  admissionTuple,
  nativeAdmissionPlan,
  validateAdmissionPackages,
} from './native-artifact.mjs';

const workspacePath = fileURLToPath(new URL('../../../', import.meta.url));

test('live tuple agrees with owning native protocol and reviewed registry snapshot', () => {
  for (const [name, version] of Object.entries(cohort))
    assert.equal(admissionTuple[name], version);
  for (const name of ['@tsrx/oxc', 'typescript', '@types/react', '@types/node'])
    assert.equal(admissionTuple[name], targets[name]);
  for (const name of ['@tanstack/history', '@tanstack/store'])
    assert.equal(admissionTuple[name], octaneCohort[name]);
});

test('descriptor plan preserves supplied owning requests and rejects stale or incomplete descriptors', async () => {
  const { descriptor } = fixture(); // Fabricated protocol controls, not release evidence.
  const plan = await nativeAdmissionPlan({ descriptor, workspacePath });
  assert.deepEqual(
    plan.dependencies,
    Object.fromEntries(
      Object.entries(descriptor.packages).map(([name, artifact]) => [
        name,
        artifact.request,
      ]),
    ),
  );
  assert.deepEqual(plan.ultramodernAdmission.nativeArtifacts, descriptor);
  const liveTemplate = JSON.parse(
    fs.readFileSync(new URL('./package.json', import.meta.url)),
  );
  const selected = await nativeAdmissionPlan({
    descriptor,
    workspacePath,
    manifest: liveTemplate,
  });
  assert.equal(selected.name, liveTemplate.name);
  assert.equal(
    selected.devDependencies['@tsrx/oxc'],
    admissionTuple['@tsrx/oxc'],
  );
  assert.equal(
    selected.devDependencies['@types/node'],
    admissionTuple['@types/node'],
  );
  assert.equal(
    selected.dependencies.octane,
    descriptor.packages.octane.request,
  );
  assert.equal(
    selected.dependencies['@tanstack/router-core'],
    descriptor.packages['@tanstack/router-core'].request,
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url))),
    liveTemplate,
    'Plan selection never rewrites the authored manifest',
  );
  for (const value of [
    undefined,
    {
      octane: { version: '0.13.8', request: 'https://old.invalid/octane.tgz' },
    },
    {
      ...descriptor,
      packages: {
        ...descriptor.packages,
        octane: { ...descriptor.packages.octane, version: '0.13.8' },
      },
    },
    { ...descriptor, packages: { octane: descriptor.packages.octane } },
  ])
    await assert.rejects(
      nativeAdmissionPlan({ descriptor: value, workspacePath }),
    );
});

test('unpublished producer stops live admission before any package can be accepted', async () => {
  assert(process.env.OWNED_TEMP_DIR, 'Run inside owned-temp-dir');
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'unpublished-native-'),
  );
  try {
    const { descriptor } = fixture();
    const plan = await nativeAdmissionPlan({ descriptor, workspacePath });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(plan));
    let reads = 0;
    await assert.rejects(
      validateAdmissionPackages({
        root,
        readGithub: async () => {
          reads++;
          throw new Error('control: producer is not published');
        },
        fetchArtifact: () =>
          assert.fail(
            'No archive may be admitted before producer authentication',
          ),
      }),
      /producer is not published/,
    );
    assert.equal(reads, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live admission cannot accept bare latest registry versions without the owning descriptor', async () => {
  assert(process.env.OWNED_TEMP_DIR, 'Run inside owned-temp-dir');
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'native-admission-'),
  );
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: cohort }),
    );
    for (const [name, version] of Object.entries(cohort)) {
      const directory = path.join(root, 'node_modules', name);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, 'package.json'),
        JSON.stringify({ name, version, main: 'index.js' }),
      );
      fs.writeFileSync(path.join(directory, 'index.js'), '');
    }
    await assert.rejects(
      validateAdmissionPackages({ root }),
      /native.*descriptor/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live federation templates select the reviewed latest tuple, not historical positive pins', () => {
  const fixtures = createOctaneFederationFixtures({
    remoteUrl: 'http://127.0.0.1:3001',
  });
  for (const files of Object.values(fixtures)) {
    const { dependencies } = JSON.parse(files['package.json']);
    for (const [name, version] of Object.entries(cohort))
      assert.equal(dependencies[name], version, `Live fixture ${name}`);
    assert.equal(dependencies['@tsrx/oxc'], '0.24.0');
  }
});
