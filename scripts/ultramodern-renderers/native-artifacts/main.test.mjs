import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './fixtures.test-support.mjs';
import { main } from './main.mjs';
import {
  manifestFilename,
  repository,
  repositoryId,
  sha256,
  workflow,
} from './protocol.mjs';

assert(process.env.OWNED_TEMP_DIR, 'Use owned-temp-dir');
function control(t) {
  const f = fixture();
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'native-main-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    GITHUB_REPOSITORY: repository,
    GITHUB_REPOSITORY_ID: String(repositoryId),
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main-ultramodern',
    GITHUB_ACTOR: 'BleedingDev',
    GITHUB_TRIGGERING_ACTOR: 'BleedingDev',
    GITHUB_WORKFLOW_REF: `${repository}/${workflow}@refs/heads/main-ultramodern`,
    GITHUB_SHA: f.producer.source,
    GITHUB_RUN_ID: String(f.producer.runId),
    GITHUB_RUN_ATTEMPT: String(f.producer.runAttempt),
    RUNNER_TEMP: root,
    GH_TOKEN: 'unit-not-real',
  };
  return { ...f, root, env };
}
test('produce cannot reconstruct or publish before actual owning source byte proofs pass', async t => {
  const f = control(t);
  const calls = [];
  const patchPath = path.join(f.root, 'unit.patch');
  fs.writeFileSync(patchPath, 'unit patch');
  const recipe = {
    packages: Object.fromEntries(
      Object.entries(f.manifest.packages).map(([name, item]) => [
        name,
        {
          upstream: item.upstream,
          patchPath,
          patchSha256: sha256(Buffer.from('unit patch')),
        },
      ]),
    ),
    async qualifySource(options) {
      calls.push('source');
      assert.equal(options.workDirectory, f.root);
      assert(!('GH_TOKEN' in options));
      return Object.fromEntries(
        Object.keys(f.manifest.packages).map(name => [
          name,
          {
            sourceArchiveBytes: Buffer.from('unit source'),
            builtPatchBytes: Buffer.from('unit patch'),
            licenseBytes: Buffer.from('unit control license'),
          },
        ]),
      );
    },
    async qualifyPacked() {
      calls.push('packed');
    },
  };
  const output = path.join(f.root, 'output');
  const reconstructArtifacts = async ({ directory }) => {
    calls.push('reconstruct');
    assert.equal(directory, output);
  };
  await main(['produce', output], {
    env: f.env,
    recipeFactory: () => recipe,
    reconstructArtifacts,
  });
  assert.deepEqual(calls, ['source', 'reconstruct']);
  calls.length = 0;
  recipe.qualifySource = async () => {
    calls.push('tampered-source');
    return {};
  };
  await assert.rejects(
    main(['produce', output], {
      env: f.env,
      recipeFactory: () => recipe,
      reconstructArtifacts,
    }),
    /cohort/u,
  );
  assert.deepEqual(calls, ['tampered-source']);
});
test('qualification rejects substituted downloaded bytes before any owning suite can pass', async t => {
  const f = control(t);
  const directory = path.join(f.root, 'transport');
  fs.mkdirSync(directory);
  for (const [filename, bytes] of f.payloads)
    fs.writeFileSync(path.join(directory, filename), bytes);
  fs.writeFileSync(path.join(directory, 'octane-0.18.0.tgz'), 'substituted');
  await assert.rejects(
    main(['qualify', directory], {
      env: f.env,
      recipeFactory: () => assert.fail('must reject before qualification'),
    }),
    /payload integrity/u,
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, manifestFilename)),
  );
  manifest.producer.runAttempt++;
  fs.writeFileSync(
    path.join(directory, manifestFilename),
    JSON.stringify(manifest),
  );
  await assert.rejects(
    main(['qualify', directory], { env: f.env }),
    /strictly equal|run/u,
  );
});
