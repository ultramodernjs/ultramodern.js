import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { inspectNpmTarball } from '../../ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import { fixture } from './fixtures.test-support.mjs';
import { assetFilename, cohort, sha256 } from './protocol.mjs';
import { applyExactPatch, packFiles, reconstruct } from './reconstruct.mjs';

assert(process.env.OWNED_TEMP_DIR, 'Use owned-temp-dir');
function root(t) {
  const directory = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'native-producer-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test('deterministically packs actual npm bytes and modes', () => {
  const files = new Map([
    [
      'package.json',
      {
        bytes: Buffer.from('{"name":"control","version":"1.0.0"}'),
        mode: 0o644,
      },
    ],
    ['cli.js', { bytes: Buffer.from('control'), mode: 0o755 }],
  ]);
  const bytes = packFiles(files);
  assert.deepEqual(bytes, packFiles(new Map([...files].reverse())));
  const inspected = inspectNpmTarball(bytes);
  assert.equal(
    inspected.files.find(file => file.path === 'cli.js').mode,
    0o755,
  );
});
test('zero fuzz rejects offsets, reversed patches, and traversal', t => {
  const directory = root(t);
  const patch = Buffer.from(
    '--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-old\n+new\n',
  );
  fs.writeFileSync(path.join(directory, 'index.js'), 'old\n');
  applyExactPatch(patch, directory);
  assert.equal(
    fs.readFileSync(path.join(directory, 'index.js'), 'utf8'),
    'new\n',
  );
  assert.throws(() => applyExactPatch(patch, directory));
  fs.writeFileSync(path.join(directory, 'index.js'), 'extra\nold\n');
  assert.throws(() => applyExactPatch(patch, directory), /Non-exact/u);
  assert.throws(
    () =>
      applyExactPatch(
        Buffer.from(patch.toString().replaceAll('index.js', '../outside')),
        directory,
      ),
    /traversal/u,
  );
});
test('reconstructs complete authenticated upstream archives using only exact canonical patch bytes', async t => {
  const f = fixture();
  const directory = root(t);
  const patch = Buffer.from(
    '--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-export const control = true;\n+export const control = false;\n',
  );
  const patchPath = path.join(directory, 'control.patch');
  fs.writeFileSync(patchPath, patch);
  const recipe = {
    packages: Object.fromEntries(
      Object.keys(cohort).map(name => [
        name,
        {
          upstream: f.manifest.packages[name].upstream,
          patchPath,
          patchSha256: sha256(patch),
        },
      ]),
    ),
    qualifySource() {},
    qualifyPacked() {},
  };
  const fetchArtifact = async url => {
    const name = Object.keys(cohort).find(
      name => recipe.packages[name].upstream.request === url,
    );
    return f.fetchArtifact(f.manifest.packages[name].request);
  };
  const output = path.join(directory, 'out');
  const manifest = await reconstruct({
    recipe,
    producer: f.producer,
    directory: output,
    fetchArtifact,
  });
  assert.deepEqual(fs.readdirSync(output).sort(), [
    'native-artifacts.json',
    'octane-0.20.0.tgz',
    'octanejs-rspack-plugin-0.2.12.tgz',
    'octanejs-tanstack-router-0.3.6.tgz',
    'tanstack-router-core-1.171.39.tgz',
  ]);
  for (const [name, { version }] of Object.entries(manifest.packages)) {
    const packed = inspectNpmTarball(
      fs.readFileSync(path.join(output, assetFilename(name, version))),
    );
    assert.equal(packed.packageJson.name, name);
    assert.equal(packed.packageJson.version, version);
    assert.equal(
      packed.fileContents.get('index.js').toString(),
      'export const control = false;\n',
    );
  }
  for (const fail of ['patch', 'integrity', 'license']) {
    const name = 'octane';
    const item = recipe.packages[name];
    const original = structuredClone(item);
    if (fail === 'patch') item.patchSha256 = 'f'.repeat(64);
    if (fail === 'integrity')
      item.upstream.integrity =
        f.manifest.packages['@tanstack/router-core'].integrity;
    if (fail === 'license') item.upstream.licenseSha256 = 'f'.repeat(64);
    await assert.rejects(
      reconstruct({
        recipe,
        producer: f.producer,
        directory: path.join(directory, fail),
        fetchArtifact,
      }),
    );
    recipe.packages[name] = original;
  }
});

test('source qualification binds actual source, built patch and source/npm license bytes', async () => {
  const { verifySourceQualification } = await import('./reconstruct.mjs');
  const f = fixture();
  const evidence = Object.fromEntries(
    Object.keys(cohort).map(name => [
      name,
      {
        sourceArchiveBytes: Buffer.from('unit source'),
        builtPatchBytes: Buffer.from('unit patch'),
        licenseBytes: Buffer.from('unit control license'),
      },
    ]),
  );
  const recipe = {
    packages: Object.fromEntries(
      Object.keys(cohort).map(name => [
        name,
        {
          upstream: f.manifest.packages[name].upstream,
          patchSha256: sha256(evidence[name].builtPatchBytes),
        },
      ]),
    ),
  };
  verifySourceQualification(recipe, evidence);
  for (const key of ['sourceArchiveBytes', 'builtPatchBytes', 'licenseBytes']) {
    const altered = Object.fromEntries(
      Object.entries(evidence).map(([name, proof]) => [name, { ...proof }]),
    );
    altered.octane[key] = Buffer.from('substituted');
    assert.throws(() => verifySourceQualification(recipe, altered));
  }
});
