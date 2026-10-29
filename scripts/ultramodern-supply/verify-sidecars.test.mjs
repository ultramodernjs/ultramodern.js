import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertNoUpstreamedPatches,
  assertRecipeConsumers,
  assertRecipeGraph,
  findUpstreamedPatches,
  isUnpublishedForkEdge,
  verifySidecar,
} from './verify-sidecars.mjs';

test('a recipe consumed only through devDependencies or an unaliased edge is rejected', () => {
  const orphan = {
    id: 'orphan',
    upstream: { name: 'orphan', version: '1.0.0' },
    fork: { name: '@bleedingdev/orphan', version: '1.0.0' },
    manifestChanges: {},
  };
  const manifest = {
    name: '@bleedingdev/modern-js-fixture',
    devDependencies: { orphan: 'npm:@bleedingdev/orphan@1.0.0' },
    dependencies: { orphan: '1.0.0' },
  };
  const consumers = {
    generatorPins: [],
    publishedManifests: [manifest],
  };
  assert.throws(
    () => assertRecipeConsumers([orphan], consumers),
    /@bleedingdev\/modern-js-fixture dependencies\.orphan is 1\.0\.0; declare npm:@bleedingdev\/orphan@1\.0\.0 in source/,
  );
  delete manifest.dependencies;
  assert.throws(
    () => assertRecipeConsumers([orphan], consumers),
    /sidecar orphan has no runtime consumer; delete the recipe or wire a consumer/,
  );
  manifest.peerDependencies = { orphan: 'npm:@bleedingdev/orphan@1.0.0' };
  assertRecipeConsumers([orphan], consumers);
});

test('unpublished recipe roots require the exact consumer, dependency and upstream version', () => {
  const roots = [
    [
      'packages/runtime/federation-runtime',
      '@bleedingdev/modern-js-federation-runtime',
      '@module-federation/sdk',
      '2.9.2',
    ],
    [
      'packages/toolkit/utils',
      '@bleedingdev/modern-js-utils',
      'fast-glob',
      '3.3.3',
    ],
    [
      'packages/cli/builder',
      '@bleedingdev/modern-js-builder',
      '@rsbuild/plugin-source-build',
      '1.0.7',
    ],
    [
      'packages/cli/builder',
      '@bleedingdev/modern-js-builder',
      '@rsbuild/plugin-type-check',
      '1.6.0',
    ],
    [
      'packages/toolkit/ultramodern-create',
      '@bleedingdev/modern-js-ultramodern-create',
      'ultracite',
      '7.12.2',
    ],
  ];
  for (const [importer, published, dependency, version] of roots) {
    const recipe = {
      id: dependency,
      upstream: { name: dependency, version },
      fork: { name: `@bleedingdev/${dependency.split('/').pop()}`, version },
      manifestChanges: {},
    };
    for (const consumer of [importer, published]) {
      assert.equal(
        isUnpublishedForkEdge(consumer, dependency, version, recipe),
        true,
      );
      assert.equal(
        isUnpublishedForkEdge(
          consumer,
          dependency,
          `${version}(peer@1.0.0)`,
          recipe,
        ),
        true,
      );
      for (const specifier of [
        `^${version}`,
        `${version}0`,
        `${version}-next`,
        `${version}+local`,
      ])
        assert.equal(
          isUnpublishedForkEdge(consumer, dependency, specifier, recipe),
          false,
        );
      assert.equal(
        isUnpublishedForkEdge(consumer, `${dependency}-other`, version, recipe),
        false,
      );
    }
    const consumers = {
      generatorPins: [],
      publishedManifests: [
        { name: published, dependencies: { [dependency]: version } },
      ],
    };
    assertRecipeConsumers([recipe], consumers);
    consumers.publishedManifests[0].name = '@bleedingdev/modern-js-unlisted';
    assert.throws(
      () => assertRecipeConsumers([recipe], consumers),
      /declare npm:/u,
    );
    consumers.publishedManifests[0] = {
      name: published,
      devDependencies: { [dependency]: version },
    };
    assert.throws(
      () => assertRecipeConsumers([recipe], consumers),
      /has no runtime consumer/u,
    );
  }
});

test('a published Redact dependency must be the exact signed sidecar alias', () => {
  const recipe = {
    id: 'tanstack-redact',
    upstream: { name: '@tanstack/redact', version: '0.2.1' },
    fork: { name: '@bleedingdev/tanstack-redact', version: '0.2.1' },
    manifestChanges: {},
  };
  for (const block of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const manifest = {
      name: '@bleedingdev/modern-js-ultramodern-app-tools',
      [block]: {},
    };
    const consumers = { generatorPins: [], publishedManifests: [manifest] };
    for (const bad of [
      '0.2.1',
      '^0.2.1',
      '0.2.2',
      'npm:@bleedingdev/tanstack-redact@0.2.2',
    ]) {
      manifest[block]['@tanstack/redact'] = bad;
      assert.throws(
        () => assertRecipeConsumers([recipe], consumers),
        /declare npm:@bleedingdev\/tanstack-redact@0\.2\.1 in source/u,
      );
    }
    manifest[block]['@tanstack/redact'] =
      'npm:@bleedingdev/tanstack-redact@0.2.1';
    assertRecipeConsumers([recipe], consumers);
  }
});

test('recipes reached only through a reachable recipe alias edge are consumed', () => {
  const child = {
    id: 'child',
    upstream: { name: 'child', version: '1.0.0' },
    fork: { name: '@bleedingdev/child', version: '1.0.0' },
    manifestChanges: {},
  };
  const parent = {
    id: 'parent',
    upstream: { name: 'parent', version: '1.0.0' },
    fork: { name: '@bleedingdev/parent', version: '1.0.0' },
    manifestChanges: {
      devDependencies: { child: 'npm:@bleedingdev/child@1.0.0' },
    },
  };
  const consumers = {
    generatorPins: [{ parent: 'npm:@bleedingdev/parent@1.0.0' }],
    publishedManifests: [],
  };
  assert.throws(
    () => assertRecipeConsumers([parent, child], consumers),
    /sidecar child has no runtime consumer/,
  );
  parent.manifestChanges = {
    dependencies: { child: 'npm:@bleedingdev/child@1.0.0' },
  };
  assertRecipeConsumers([parent, child], consumers);
});

test('only exact generator runtime pins of the recipe fork version are consumers', () => {
  const recipe = {
    id: 'pinned',
    upstream: { name: 'pinned', version: '1.0.0' },
    fork: { name: '@bleedingdev/pinned', version: '1.0.1' },
    manifestChanges: {},
  };
  const consumers = generatorPins => ({
    generatorPins,
    publishedManifests: [],
  });
  for (const pins of [
    [{ pinned: 'npm:@bleedingdev/pinned@1.0.0' }],
    [{ pinned: 'npm:@bleedingdev/pinned@^1.0.1' }],
    [{ pinned: '// npm:@bleedingdev/pinned@1.0.1' }],
  ])
    assert.throws(
      () => assertRecipeConsumers([recipe], consumers(pins)),
      /sidecar pinned has no runtime consumer/,
    );
  assertRecipeConsumers(
    [recipe],
    consumers([{ pinned: 'npm:@bleedingdev/pinned@1.0.1' }]),
  );
});

test('closed SDK qualification consumes only its declared exact fork and leaves unrelated recipes rejected', async () => {
  const { sidecarProfile } = await import(
    '../ultramodern-publish/sidecar-profiles.mjs'
  );
  const profile = sidecarProfile('mf-sdk');
  const pins = Object.fromEntries(
    Object.entries(profile.dependencies).map(([name, version]) => [
      name,
      `npm:${name}@${version}`,
    ]),
  );
  const sdk = {
    id: 'mf-sdk',
    upstream: { name: '@module-federation/sdk', version: '2.9.2' },
    fork: { name: '@bleedingdev/mf-sdk', version: '2.9.2' },
    manifestChanges: {},
  };
  const consumers = { generatorPins: [pins], publishedManifests: [] };
  assertRecipeConsumers([sdk], consumers);
  for (const fork of [
    { name: '@bleedingdev/mf-sdk', version: '2.9.3' },
    { name: '@bleedingdev/mf-other', version: '2.9.2' },
  ]) {
    assert.throws(
      () => assertRecipeConsumers([{ ...sdk, fork }], consumers),
      /no runtime consumer/,
    );
  }
  assert.throws(
    () =>
      assertRecipeConsumers(
        [
          sdk,
          {
            ...sdk,
            id: 'unused',
            fork: { name: '@bleedingdev/unused', version: '2.9.2' },
          },
        ],
        consumers,
      ),
    /sidecar unused has no runtime consumer/,
  );
  assert.throws(
    () => assertRecipeGraph([], { generatorPins: [pins] }),
    /no sidecar recipe/,
  );
});

const graphRecipe = (id, { patch = null, manifestChanges = {} } = {}) => ({
  id,
  upstream: { name: id, version: '1.0.0' },
  fork: { name: `@bleedingdev/${id}`, version: '1.0.0' },
  patch,
  manifestChanges,
});
const aliasOf = id => ({
  dependencies: { [id]: `npm:@bleedingdev/${id}@1.0.0` },
});

test('a patch:null parent whose patched child was removed is rejected', () => {
  const child = graphRecipe('child', { patch: { path: 'child.patch' } });
  const parent = graphRecipe('parent', { manifestChanges: aliasOf('child') });
  assertRecipeGraph([parent, child]);
  assert.throws(
    () => assertRecipeGraph([parent]),
    /sidecar parent dependencies.child aliases npm:@bleedingdev\/child@1.0.0, which no sidecar recipe publishes; restore the recipe or drop the alias/,
  );
  assert.throws(
    () =>
      assertRecipeGraph([parent, child], {
        generatorPins: [{ gone: 'npm:@bleedingdev/gone@1.0.0' }],
      }),
    /generator pin gone aliases npm:@bleedingdev\/gone@1.0.0, which no sidecar recipe publishes/,
  );
  parent.manifestChanges = {};
  assert.throws(
    () => assertRecipeGraph([parent]),
    /sidecar parent has no patched descendant; delete recipe/,
  );
  // A dev-only alias does not rewire what consumers run.
  parent.manifestChanges = { devDependencies: aliasOf('child').dependencies };
  assert.throws(
    () => assertRecipeGraph([parent, child]),
    /sidecar parent has no patched descendant; delete recipe/,
  );
  // A non-alias manifest change is a correction the recipe carries itself.
  parent.manifestChanges = { dependencies: { child: '^2.0.3' } };
  assertRecipeGraph([parent]);
});

test('a patch already present upstream reports the recipe and its ancestors as retirable', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-retire-'));
  try {
    const patchBytes = Buffer.from(
      [
        '--- a/index.js',
        '+++ b/index.js',
        '@@ -1 +1 @@',
        '-export const fixed = false;',
        '+export const fixed = true;',
        '',
      ].join('\n'),
    );
    const patchPath = path.join(directory, 'child.patch');
    fs.writeFileSync(patchPath, patchBytes);
    const child = graphRecipe('child', {
      patch: {
        path: patchPath,
        sha256: createHash('sha256').update(patchBytes).digest('hex'),
      },
    });
    const parent = graphRecipe('parent', { manifestChanges: aliasOf('child') });
    const grandparent = graphRecipe('grandparent', {
      manifestChanges: aliasOf('parent'),
    });
    const sibling = graphRecipe('sibling', { patch: child.patch });
    const patchedParent = graphRecipe('patched-parent', {
      patch: { path: 'unused.patch' },
      manifestChanges: aliasOf('parent'),
    });
    const recipeList = [grandparent, parent, child, patchedParent];
    const release = source => {
      const packageDir = path.join(directory, 'package');
      fs.rmSync(packageDir, { recursive: true, force: true });
      fs.mkdirSync(packageDir);
      fs.writeFileSync(path.join(packageDir, 'index.js'), `${source}\n`);
      const tarball = path.join(directory, 'latest.tgz');
      execFileSync('tar', ['-czf', tarball, '-C', directory, 'package']);
      return { bytes: fs.readFileSync(tarball), version: '1.0.1' };
    };

    const unfixed = release('export const fixed = false;');
    assert.equal(
      (
        await findUpstreamedPatches([child], {
          latestTarball: async () => unfixed,
        })
      ).size,
      0,
    );

    const fixed = release('export const fixed = true;');
    const upstreamed = await findUpstreamedPatches([child, sibling], {
      latestTarball: async () => fixed,
    });
    assert.deepEqual(
      [...upstreamed],
      [
        [child, '1.0.1'],
        [sibling, '1.0.1'],
      ],
    );
    upstreamed.delete(sibling);
    assert.throws(
      () => assertNoUpstreamedPatches(recipeList, upstreamed),
      error => {
        assert.equal(
          error.message,
          [
            'sidecar child patch is already present in child@1.0.1',
            'retirable sidecars: grandparent, parent, child; delete these recipes and move their consumers to the upstream release',
            'sidecar patched-parent must drop dependencies.parent npm:@bleedingdev/parent@1.0.0 when parent is retired',
          ].join('\n'),
        );
        return true;
      },
    );
    assertNoUpstreamedPatches(recipeList, new Map());
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Redact reconstruction carries the reviewed marker and grandfathers only the bootstrap placeholders', async () => {
  const directory = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'sidecar-redact-'),
  );
  try {
    const recipe = JSON.parse(
      fs.readFileSync(new URL('./sidecars.json', import.meta.url), 'utf8'),
    ).find(item => item.id === 'tanstack-redact');
    // Only the authenticated bootstrap receipts; 0.2.1 must come from a
    // signed publication.
    assert.deepEqual(
      recipe.provenance.grandfatheredVersions.map(({ version }) => version),
      ['0.0.0-stage', '0.0.0-bootstrap'],
    );
    const packageDir = path.join(directory, 'reconstructed');
    await verifySidecar(recipe.id, { materializeTo: packageDir });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
    );
    assert.equal(manifest.name, '@bleedingdev/tanstack-redact');
    assert.equal(manifest.version, '0.2.1');
    assert.equal(manifest.license, 'MIT');
    assert.equal(
      fs
        .readFileSync(path.join(packageDir, 'dist/server/stream.js'), 'utf8')
        .split('\n')[0],
      '// ultramodern-redact-patch: v1',
    );
    for (const [tree, extension] of [
      ['src', 'ts'],
      ['dist', 'js'],
    ]) {
      const read = module =>
        fs.readFileSync(
          path.join(packageDir, tree, `${module}.${extension}`),
          'utf8',
        );
      assert.match(read('dom/document-metadata'), /container\?\.ownerDocument/);
      assert.match(
        read('dom/reconcile'),
        /if \(fiber\.su\) \{\s+scheduleUpdate\(fiber\);\s+continue;/,
      );
      assert.match(read('dom/features/hydration/full'), /queueHydrationEnd/);
      assert.match(read('dom/features/suspense/full'), /commitSynchronously/);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('explicit offline provenance fails closed on missing or tampered tarballs', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'sidecar-integrity-'),
  );
  try {
    for (const id of ['mf-cli', 'mf-sdk', 'tanstack-redact']) {
      await assert.rejects(
        verifySidecar(id, { artifactsDir: directory }),
        /ENOENT/,
      );
      fs.writeFileSync(path.join(directory, `${id}.tgz`), 'untrusted bytes');
      await assert.rejects(
        verifySidecar(id, { artifactsDir: directory }),
        /upstream tarball integrity/,
      );
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('transient upstream timeouts stop after three authenticated-input attempts', async t => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    attempts++;
    throw new DOMException('transport timed out', 'TimeoutError');
  });
  await assert.rejects(verifySidecar('mf-rspack'), error => {
    assert.match(error.message, /after 3 attempt\(s\)/);
    assert.equal(error.cause.name, 'TimeoutError');
    return true;
  });
  assert.equal(attempts, 3);
});

test('upstream HTTP errors and tampered tarballs are never retried', async t => {
  for (const response of [
    new Response('', { status: 404 }),
    new Response('untrusted bytes'),
  ]) {
    let attempts = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => {
      attempts++;
      return response;
    });
    try {
      await assert.rejects(
        verifySidecar('mf-rspack'),
        /upstream fetch failed: 404|upstream tarball integrity/,
      );
      assert.equal(attempts, 1);
    } finally {
      mock.mock.restore();
    }
  }
});

test('reconstruction retries a transient timeout and drops node_modules the authenticated upstream tarball shipped but pnpm never installs', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-node-'));
  try {
    const recipe = JSON.parse(
      fs.readFileSync(new URL('./sidecars.json', import.meta.url), 'utf8'),
    ).find(item => item.id === 'mf-node');
    const response = await fetch(recipe.upstream.tarball, {
      signal: AbortSignal.timeout(30_000),
    });
    assert.ok(response.ok);
    const tarball = path.join(directory, 'mf-node.tgz');
    const bytes = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(tarball, bytes);
    const shipped = execFileSync('tar', ['-tzf', tarball], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(entry => entry.split('/').includes('node_modules'));
    assert.ok(shipped.length > 0, 'upstream fixture still ships node_modules');
    const packageDir = path.join(directory, 'reconstructed');
    let attempts = 0;
    t.mock.method(globalThis, 'fetch', async url => {
      assert.equal(url, recipe.upstream.tarball);
      if (++attempts === 1)
        throw new DOMException('transport timed out', 'TimeoutError');
      return new Response(bytes);
    });
    await verifySidecar('mf-node', {
      materializeTo: packageDir,
    });
    assert.equal(attempts, 2);
    const stack = [packageDir];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        assert.notEqual(entry.name, 'node_modules', current);
        if (entry.isDirectory()) stack.push(path.join(current, entry.name));
      }
    }
    assert.ok(fs.statSync(path.join(packageDir, 'dist/src/index.js')).isFile());
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reconstructed sidecar tarballs bind repository metadata to their active provenance producer', async () => {
  const directory = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'sidecar-transfer-'),
  );
  const keys = ['GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_ID'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    const recipe = JSON.parse(
      fs.readFileSync(new URL('./sidecars.json', import.meta.url), 'utf8'),
    ).find(item => item.id === 'braces');
    const response = await fetch(recipe.upstream.tarball, {
      signal: AbortSignal.timeout(30_000),
    });
    assert.ok(response.ok);
    fs.writeFileSync(
      path.join(directory, `${recipe.id}.tgz`),
      Buffer.from(await response.arrayBuffer()),
    );
    const outputs = [];
    for (const [index, repository] of [
      'BleedingDev/ultramodern.js',
      'ultramodernjs/ultramodern.js',
    ].entries()) {
      process.env.GITHUB_REPOSITORY = repository;
      process.env.GITHUB_REPOSITORY_ID = '1151231350';
      const packageDir = path.join(directory, `package-${index}`);
      await verifySidecar(recipe.id, {
        artifactsDir: directory,
        materializeTo: packageDir,
      });
      const manifest = fs.readFileSync(path.join(packageDir, 'package.json'));
      const published = JSON.parse(manifest);
      assert.equal(published.name, recipe.fork.name);
      assert.equal(published.version, recipe.fork.version);
      assert.equal(
        published.repository.url,
        `git+https://github.com/${repository}.git`,
      );
      const packDir = path.join(directory, `packed-${index}`);
      fs.mkdirSync(packDir);
      const [packed] = JSON.parse(
        execFileSync(
          'npm',
          ['pack', '--ignore-scripts', '--json', '--pack-destination', packDir],
          {
            cwd: packageDir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ),
      );
      outputs.push({
        manifest,
        tarball: fs.readFileSync(path.join(packDir, packed.filename)),
        integrity: packed.integrity,
      });
    }
    assert.notDeepEqual(outputs[0].manifest, outputs[1].manifest);
    assert.notDeepEqual(outputs[0].tarball, outputs[1].tarball);
    assert.notEqual(outputs[0].integrity, outputs[1].integrity);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
