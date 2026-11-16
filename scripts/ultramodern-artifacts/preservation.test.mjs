import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fixture } from '../ultramodern-renderers/native-artifacts/fixtures.test-support.mjs';
import * as native from '../ultramodern-renderers/native-artifacts/protocol.mjs';
import { reconstruct } from '../ultramodern-renderers/native-artifacts/reconstruct.mjs';
import {
  canonicalTarSha256,
  packFiles as historicalPackFiles,
} from './native-pack.test-reference.mjs';
import { artifactPolicy, bindArtifactProtocol } from './protocol.mjs';
import { validateRecipe, verifySourceQualification } from './reconstruct.mjs';
import { verifyPayloads } from './release.mjs';
import { authenticateDescriptor } from './transport.mjs';

// These are fabricated control archives, not production release receipts.
// Gzip output varies between Node providers' zlib builds. Require exact old/new
// compressed bytes in the SAME runtime, and pin ALL uncompressed tar bytes across
// runtimes. Only the two proven archive-integrity fields may vary in the goldens.
function readGolden(kind) {
  const bytes = fs.readFileSync(
    new URL(`./native-${kind}.golden`, import.meta.url),
  );
  assert.equal(
    native.sha256(bytes),
    kind === 'manifest'
      ? '4d79ab61a7e046a1b4840aac86a48003501f1fadb0b2db690b176bfd137525c7'
      : '46518f5ffe91e66b63066e6bbca49b7e559752530e46ef40c9650f4d7c26935f',
    'Untouched historical golden bytes',
  );
  return bytes;
}

function controlFiles(golden, name, stage) {
  const pkg = {
    name,
    version: golden.packages[name].version,
    ...(name === '@octanejs/tanstack-router'
      ? {
          peerDependencies: {
            '@tanstack/router-core':
              golden.packages['@tanstack/router-core'].version,
          },
        }
      : {}),
  };
  return new Map([
    ['package.json', { bytes: Buffer.from(JSON.stringify(pkg)), mode: 0o644 }],
    ['LICENSE', { bytes: Buffer.from('unit control license'), mode: 0o644 }],
    [
      'index.js',
      {
        bytes: Buffer.from(`export const control = ${stage === 'fixture'};\n`),
        mode: 0o644,
      },
    ],
  ]);
}

function assertArchiveParity(bytes, golden, name, stage) {
  const reference = historicalPackFiles(controlFiles(golden, name, stage));
  const pinned = canonicalTarSha256[stage][name];
  assert.equal(
    native.sha256(gunzipSync(reference)),
    pinned,
    `${name}: historical tar pin`,
  );
  assert.equal(
    native.sha256(gunzipSync(bytes)),
    pinned,
    `${name}: actual tar pin`,
  );
  assert.deepEqual(
    bytes,
    reference,
    `${name}: pre/post extraction compressed bytes`,
  );
}

function assertGoldenParity(
  bytes,
  goldenBytes,
  archives,
  upstreamArchives,
  stage,
) {
  const expected = JSON.parse(goldenBytes);
  const names = Object.keys(expected.packages);
  assert.deepEqual([...archives.keys()].sort(), [...names].sort());
  assert.deepEqual([...upstreamArchives.keys()].sort(), [...names].sort());
  for (const name of names) {
    // Validate both actual archive byte streams BEFORE allowing either digest
    // substitution. No other fields are removed, replaced or ignored.
    const archive = archives.get(name);
    const upstream = upstreamArchives.get(name);
    assertArchiveParity(archive, expected, name, stage);
    assertArchiveParity(upstream, expected, name, 'fixture');
    expected.packages[name].integrity = native.integrity(archive);
    expected.packages[name].upstream.integrity = native.integrity(upstream);
  }
  // Serialize only the expected golden; compare actual bytes verbatim so key
  // ordering, whitespace and every non-archive field remain part of the contract.
  assert.deepEqual(
    bytes,
    Buffer.from(`${JSON.stringify(expected, null, 2)}\n`),
  );
}

function fixtureArchives(f) {
  return new Map(
    Object.entries(f.manifest.packages).map(([name, item]) => [
      name,
      f.payloads.get(native.assetFilename(name, item.version)),
    ]),
  );
}

test('historical packer source and canonical tar reference are pinned independently', () => {
  const reference = fs.readFileSync(
    new URL('./native-pack.test-reference.mjs', import.meta.url),
  );
  assert.equal(
    native.sha256(reference),
    'fe769019bffc82212abf6977d9b6be817a2d7de875af161114677784635d163c',
  );
  assert.equal(
    native.sha256(Buffer.from(`export ${historicalPackFiles.toString()}`)),
    '2c5f595e7776fb67e898a3b92c35dfe7a02d4ac4a2663b5f7ebb19caf6fb58d2',
  );
});

test('native manifest preserves historical bytes except proven provider-local archive pins', () => {
  const golden = readGolden('manifest');
  const f = fixture();
  const archives = fixtureArchives(f);
  const bytes = native.manifestBytes(f.manifest);
  assertGoldenParity(bytes, golden, archives, archives, 'fixture');
  assert.deepEqual(f.payloads.get(native.manifestFilename), bytes);
  assert.equal(f.descriptor.manifest.integrity, native.integrity(bytes));
  assert.equal(f.payloads.size, 5);
});

test('every native public export name stays unchanged', async () => {
  const expected = {
    protocol: [
      'protocol',
      'repository',
      'repositoryId',
      'workflow',
      'cohort',
      'manifestFilename',
      'sha256',
      'integrity',
      'exactKeys',
      'digest',
      'commit',
      'hash',
      'assetFilename',
      'releaseUrl',
      'validateProducer',
      'validateUpstream',
      'validatePackages',
      'validateManifest',
      'validateDescriptor',
      'manifestBytes',
      'descriptorFor',
    ],
    reconstruct: [
      'packFiles',
      'validateRecipe',
      'verifySourceQualification',
      'applyExactPatch',
      'reconstruct',
    ],
    transport: [
      'readBytes',
      'githubReader',
      'verifySource',
      'releaseBody',
      'verifyRelease',
      'authenticateDescriptor',
    ],
    release: ['verifyPayloads', 'publishRelease'],
    main: ['currentProducer', 'writerApi', 'main'],
  };
  for (const [name, exports] of Object.entries(expected)) {
    const module = await import(
      `../ultramodern-renderers/native-artifacts/${name}.mjs`
    );
    assert.deepEqual(Object.keys(module).sort(), exports.sort(), name);
  }
});

test('actual reconstruction preserves four historical archives and strict manifest parity', async t => {
  assert(process.env.OWNED_TEMP_DIR, 'Use owned-temp-dir');
  const root = fs.mkdtempSync(path.join(process.env.OWNED_TEMP_DIR, 'golden-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = fixture();
  const patch = Buffer.from(
    '--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-export const control = true;\n+export const control = false;\n',
  );
  const patchPath = path.join(root, 'control.patch');
  fs.writeFileSync(patchPath, patch);
  const recipe = {
    packages: Object.fromEntries(
      Object.entries(f.manifest.packages).map(([name, item]) => [
        name,
        {
          upstream: item.upstream,
          patchPath,
          patchSha256: native.sha256(patch),
        },
      ]),
    ),
    qualifySource() {},
    qualifyPacked() {},
  };
  const directory = path.join(root, 'out');
  await reconstruct({
    recipe,
    producer: f.producer,
    directory,
    fetchArtifact: url => {
      const name = Object.keys(recipe.packages).find(
        name => recipe.packages[name].upstream.request === url,
      );
      return f.fetchArtifact(f.manifest.packages[name].request);
    },
  });
  const golden = readGolden('reconstruction');
  const manifestBytes = fs.readFileSync(
    path.join(directory, native.manifestFilename),
  );
  const manifest = JSON.parse(manifestBytes);
  assert.equal(fs.readdirSync(directory).length, 5);
  const archives = new Map();
  for (const [name, item] of Object.entries(manifest.packages)) {
    const bytes = fs.readFileSync(
      path.join(directory, native.assetFilename(name, item.version)),
    );
    assert.equal(native.integrity(bytes), item.integrity);
    archives.set(name, bytes);
  }
  assertGoldenParity(
    manifestBytes,
    golden,
    archives,
    fixtureArchives(f),
    'reconstructed',
  );
});

test('golden parity rejects fabricated content, metadata, inventory and compressed-byte mutations', () => {
  const goldenBytes = readGolden('manifest');
  const golden = JSON.parse(goldenBytes);
  const f = fixture();
  const archives = fixtureArchives(f);
  const name = Object.keys(golden.packages)[0];
  const mutations = {
    content(files) {
      files.get('index.js').bytes = Buffer.from(
        'export const control = false;\n',
      );
    },
    mode(files) {
      files.get('index.js').mode = 0o755;
    },
    inventory(files) {
      files.set('extra.js', { bytes: Buffer.from('extra'), mode: 0o644 });
    },
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const files = controlFiles(golden, name, 'fixture');
    mutate(files);
    const altered = new Map(archives);
    altered.set(name, historicalPackFiles(files));
    const manifest = structuredClone(f.manifest);
    // Update the digest honestly: failure must be due to archive parity, not a
    // stale digest or corrupt gzip. These are deliberately fabricated controls.
    manifest.packages[name].integrity = native.integrity(altered.get(name));
    assert.throws(
      () =>
        assertGoldenParity(
          native.manifestBytes(manifest),
          goldenBytes,
          altered,
          archives,
          'fixture',
        ),
      /actual tar pin/u,
      label,
    );
  }
  const recompressed = new Map(archives);
  recompressed.set(
    name,
    gzipSync(gunzipSync(archives.get(name)), { level: 1 }),
  );
  const manifest = structuredClone(f.manifest);
  manifest.packages[name].integrity = native.integrity(recompressed.get(name));
  assert.throws(
    () =>
      assertGoldenParity(
        native.manifestBytes(manifest),
        goldenBytes,
        recompressed,
        archives,
        'fixture',
      ),
    /pre\/post extraction compressed bytes/u,
  );
  const changedUpstream = new Map(archives);
  changedUpstream.set(
    name,
    historicalPackFiles(controlFiles(golden, name, 'reconstructed')),
  );
  const upstreamManifest = structuredClone(f.manifest);
  upstreamManifest.packages[name].upstream.integrity = native.integrity(
    changedUpstream.get(name),
  );
  assert.throws(
    () =>
      assertGoldenParity(
        native.manifestBytes(upstreamManifest),
        goldenBytes,
        archives,
        changedUpstream,
        'fixture',
      ),
    /actual tar pin/u,
  );
  const changedProvenance = structuredClone(f.manifest);
  changedProvenance.packages[name].patchSha256 = 'd'.repeat(64);
  assert.throws(() =>
    assertGoldenParity(
      native.manifestBytes(changedProvenance),
      goldenBytes,
      archives,
      archives,
      'fixture',
    ),
  );
  assert.throws(() =>
    assertGoldenParity(
      Buffer.concat([native.manifestBytes(f.manifest), Buffer.from('\n')]),
      goldenBytes,
      archives,
      archives,
      'fixture',
    ),
  );
});

function otherProtocol(overrides = {}) {
  return bindArtifactProtocol({
    protocol: 'unit.other-artifacts.v1',
    repository: native.repository,
    repositoryId: native.repositoryId,
    workflow: '.github/workflows/unit-other.yml',
    cohort: { 'unit-control': '1.0.0' },
    manifestFilename: 'unit-other.json',
    tagPrefix: 'unit-other',
    releaseTitle: 'Unit other artifacts',
    reconstructionPrefix: 'unit-other-',
    validateUpstream(value) {
      native.exactKeys(value, ['authority', 'integrity'], 'unit npm authority');
      assert.equal(value.authority, 'authenticated-npm-source');
      native.digest(value.integrity);
    },
    ...overrides,
  });
}

test('bound protocols reject mixing, external policy input and substituted controls before transport', async () => {
  const f = fixture();
  const other = otherProtocol();
  await assert.rejects(
    authenticateDescriptor({
      protocol: other,
      descriptor: f.descriptor,
      readGithub: () => assert.fail('must not make a network request'),
    }),
  );
  assert.throws(() =>
    verifyPayloads({
      protocol: other,
      descriptor: f.descriptor,
      payloads: f.payloads,
    }),
  );
  assert.throws(() =>
    artifactPolicy(JSON.parse(JSON.stringify({ protocol: native.protocol }))),
  );
  assert.throws(() =>
    artifactPolicy({
      ...native,
      cohort: { ...native.cohort, 'unit-control': '1.0.0' },
    }),
  );
  assert.throws(() => artifactPolicy({ ...native, validateDescriptor() {} }));
  const recipe = {
    packages: f.manifest.packages,
    qualifySource() {},
    qualifyPacked() {},
  };
  assert.throws(() => validateRecipe({ protocol: other, recipe }));
});

test('trusted npm-source authority can omit Git commit without relaxing native upstream validation', async () => {
  const evidence = {
    'unit-control': { sourceBytes: Buffer.from('actual unit npm source') },
  };
  const other = otherProtocol({
    async verifySourceQualification(recipe, proof) {
      assert.equal(
        native.integrity(proof['unit-control'].sourceBytes),
        recipe.packages['unit-control'].upstream.integrity,
      );
    },
  });
  const upstream = {
    authority: 'authenticated-npm-source',
    integrity: native.integrity(evidence['unit-control'].sourceBytes),
  };
  other.validateUpstream(upstream, 'unit-control', '1.0.0');
  assert.throws(() =>
    native.validateUpstream(upstream, 'unit-control', '1.0.0'),
  );
  const recipe = {
    packages: {
      'unit-control': {
        upstream,
        patchPath: 'unit.patch',
        patchSha256: 'a'.repeat(64),
      },
    },
    qualifySource() {},
    qualifyPacked() {},
  };
  validateRecipe({ protocol: other, recipe });
  await verifySourceQualification({ protocol: other, recipe, evidence });
  await assert.rejects(
    verifySourceQualification({
      protocol: other,
      recipe,
      evidence: { 'unit-control': { sourceBytes: Buffer.from('tampered') } },
    }),
  );
  assert.throws(() =>
    verifySourceQualification({ protocol: other, recipe, evidence: {} }),
  );
});

test('native entry and shared engine load with every non-builtin bare import forbidden', () => {
  const entry = new URL(
    '../ultramodern-renderers/native-artifacts/main.mjs',
    import.meta.url,
  ).href;
  const script = `
    import { registerHooks, isBuiltin } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (!isBuiltin(specifier) && !specifier.startsWith('.') && !specifier.startsWith('file:') && !specifier.startsWith('/')) throw new Error('Forbidden bare dependency: ' + specifier);
      return next(specifier, context);
    }});
    await import(${JSON.stringify(entry)});
  `;
  assert(isBuiltin('node:module'));
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    stdio: 'pipe',
  });
});
