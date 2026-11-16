import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  qualifyReactSupport,
  readCoreArchive,
  sourceEvidence,
} from '../ultramodern-renderers/react-router-corrections/support-adapter.mjs';
import { inputs, supportProtocol as p } from './protocol.mjs';
import { releaseRecipe } from './recipes.mjs';

test('v2 React source, registry, license and patch bind the qualified owning inputs', () => {
  const owning = JSON.parse(
    fs.readFileSync(
      new URL(
        '../ultramodern-renderers/react-router-corrections/inputs.json',
        import.meta.url,
      ),
    ),
  );
  const react = inputs['@tanstack/react-router'];
  assert.equal(react.version, '1.170.46');
  assert.equal(react.upstream.request, owning.identities[0].tarball);
  assert.equal(react.upstream.integrity, owning.identities[0].integrity);
  assert.equal(react.upstream.repository, owning.source.repository);
  assert.equal(react.upstream.commit, owning.source.commit);
  assert.equal(
    react.upstream.sourceArchiveIntegrity,
    owning.source.archiveIntegrity,
  );
  assert.equal(
    react.upstream.licenseSha256,
    'a405ee70c632bb938acb7ac5f210e814409b3760ea9d2329d8ed8ffcfd11a0e7',
  );
  assert.equal(
    react.patchSha256,
    '186e54be20a0d481731091924921ec409a15968fa13de5bfc3888a0ddbaf18d9',
  );
  assert.equal(
    p.sha256(
      fs.readFileSync(new URL(`../../${react.patchPath}`, import.meta.url)),
    ),
    react.patchSha256,
  );
});

test('missing core fails before network, scratch allocation or qualification', async () => {
  assert.throws(() => readCoreArchive(''), /SUPPORT_REACT_CORE_ARCHIVE/);
  assert.throws(
    () => readCoreArchive('relative.tgz'),
    /SUPPORT_REACT_CORE_ARCHIVE/,
  );
  const saved = process.env.SUPPORT_REACT_CORE_ARCHIVE;
  delete process.env.SUPPORT_REACT_CORE_ARCHIVE;
  try {
    await assert.rejects(
      qualifyReactSupport({
        workDirectory: '/not-created',
        toolchain: {},
        reactArchiveBytes: Buffer.from('actual payload required'),
      }),
      /SUPPORT_REACT_CORE_ARCHIVE/,
    );
  } finally {
    if (saved !== undefined) process.env.SUPPORT_REACT_CORE_ARCHIVE = saved;
  }
});

test('a receipt without owning gates cannot become source evidence', () => {
  assert.throws(() => sourceEvidence({ correctionRequired: false }));
  assert.throws(() => sourceEvidence({ correctionRequired: true, gates: {} }));
});

test('production packed recipe requires an actual corrected core, not a registry fallback', async t => {
  assert(process.env.OWNED_TEMP_DIR, 'Use owned-temp-dir --run');
  const directory = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'packed-seam-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
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
  // Deliberately not real archives: missing core must stop before any owning
  // install or network operation. The separate real proof covers actual archives.
  const manifest = {
    protocol: p.protocol,
    producer,
    packages: Object.fromEntries(
      Object.entries(p.cohort).map(([name, version]) => {
        const bytes = Buffer.from(name);
        const filename = p.assetFilename(name, version);
        fs.writeFileSync(path.join(directory, filename), bytes);
        return [
          name,
          {
            version,
            request: p.releaseUrl(producer, filename),
            integrity: p.integrity(bytes),
            upstream: inputs[name].upstream,
            patchSha256: inputs[name].patchSha256,
          },
        ];
      }),
    ),
  };
  const saved = process.env.SUPPORT_REACT_CORE_ARCHIVE;
  delete process.env.SUPPORT_REACT_CORE_ARCHIVE;
  try {
    await assert.rejects(
      releaseRecipe().qualifyPacked({
        directory,
        manifest,
        workDirectory: process.env.OWNED_TEMP_DIR,
      }),
      /SUPPORT_REACT_CORE_ARCHIVE/,
    );
  } finally {
    if (saved !== undefined) process.env.SUPPORT_REACT_CORE_ARCHIVE = saved;
  }
});
