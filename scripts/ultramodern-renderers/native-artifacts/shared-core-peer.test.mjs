import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assertSharedCoreManifest } from '../octane-corrections/shared-core-peer.mjs';
import { completedRecipes } from './recipes.mjs';
import { applyExactPatch } from './reconstruct.mjs';

test('actual reconstructed production adapter requires one exact application core before admission', t => {
  assert(process.env.OWNED_TEMP_DIR, 'Use owned-temp-dir');
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'adapter-manifest-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Apply the selected production manifest hunk to the exact npm manifest.
  // Regeneration authenticates this fixture against the pinned upstream archive;
  // it is not inferred from the correction's desired output.
  // JSON string preserves the raw upstream bytes through normal formatting.
  const manifest = JSON.parse(
    fs.readFileSync(
      new URL(
        '../octane-corrections/upstream-adapter-package.json',
        import.meta.url,
      ),
    ),
  );
  fs.writeFileSync(path.join(root, 'package.json'), manifest);
  const patch = fs.readFileSync(
    completedRecipes().packages['@octanejs/tanstack-router'].patchPath,
    'utf8',
  );
  applyExactPatch(
    Buffer.from(patch.slice(0, patch.indexOf('diff --git a/src/'))),
    root,
  );
  const actual = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  assertSharedCoreManifest(actual);
  for (const mutate of [
    m => {
      m.dependencies['@tanstack/router-core'] = '1.171.39';
    },
    m => {
      m.peerDependencies['@tanstack/router-core'] = '^1.171.39';
    },
    m => {
      m.peerDependenciesMeta = { '@tanstack/router-core': { optional: true } };
    },
    m => {
      m.dependencies['@tanstack/history'] = '1.162.4';
    },
    m => {
      m.dependencies['@tanstack/store'] = '^0.9.3';
    },
    m => {
      delete m.dependencies.isbot;
    },
    m => {
      m.peerDependencies.octane = '*';
    },
  ]) {
    const wrong = structuredClone(actual);
    mutate(wrong);
    assert.throws(() => assertSharedCoreManifest(wrong));
  }
});

test('reviewed canonical patches and immutable adapter payload match their exact handoffs', async () => {
  const { sha256 } = await import('./protocol.mjs');
  const files = {
    'patches/@octanejs__tanstack-router@0.3.4.patch':
      'c82cc89c373d23b42b24cb9eb5d748940170b76895bd94139d538ceeebe6af9b',
    'patches/@tanstack__router-core@1.171.39.patch':
      '6a2ebee5cc73df367ba768b9a950dee2a57ec0c93122ded77e5342ca8640df24',
    'patches/octane@0.18.0.patch':
      'c005016a3c6a15a76cbb52ecf0c80f409878f13d68894fa67c50daf490f8c9d8',
    'patches/@octanejs__rspack-plugin@0.2.10.patch':
      '930795abefa05ae08954654b99b4f5a1442f50d89aa58900c164a0200cb7e3f0',
    'scripts/ultramodern-renderers/octane-corrections/routerRenderSnapshot.ts.txt':
      'a7d410186d5d571562c0e908ed877a0f8223189b09226ed01366e88f10a27168',
  };
  for (const [file, hash] of Object.entries(files))
    assert.equal(
      sha256(fs.readFileSync(new URL(`../../../${file}`, import.meta.url))),
      hash,
      file,
    );
});

test('new full npm-layout patch preserves every historical source hunk', () => {
  const historical = fs.readFileSync(
    new URL(
      '../../../patches/@octanejs__tanstack-router@0.3.4.patch',
      import.meta.url,
    ),
    'utf8',
  );
  const selected = fs.readFileSync(
    completedRecipes().packages['@octanejs/tanstack-router'].patchPath,
    'utf8',
  );
  const sourceHunks = patch => patch.slice(patch.indexOf('diff --git a/src/'));
  assert.deepEqual(sourceHunks(selected), sourceHunks(historical));
});
