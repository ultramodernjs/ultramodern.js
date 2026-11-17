import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MODULE_FEDERATION_NODE_VERSION,
  MODULE_FEDERATION_VERSION,
  ULTRAMODERN_PACKAGE_PINS,
} from '../../packages/toolkit/ultramodern-create/src/ultramodern-workspace/versions.ts';
import { parsePnpmLockfile as parse } from '../lib/parse-pnpm-lockfile.mjs';
import {
  assertModuleFederationRelease,
  assertRecipeConsumers,
  isUnpublishedForkEdge,
} from '../ultramodern-supply/verify-sidecars.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const recipes = JSON.parse(
  readFileSync(
    path.join(repoRoot, 'scripts/ultramodern-supply/sidecars.json'),
    'utf8',
  ),
);

test('Module Federation source releases stay aligned while fork versions remain independent', () => {
  assertModuleFederationRelease(recipes);
  const sdk = recipes.find(recipe => recipe.id === 'mf-sdk');
  assertModuleFederationRelease([
    { ...sdk, fork: { ...sdk.fork, version: '99.0.0' } },
  ]);
  for (const id of ['mf-sdk', 'mf-node']) {
    const recipe = recipes.find(item => item.id === id);
    assert.throws(
      () =>
        assertModuleFederationRelease([
          { ...recipe, upstream: { ...recipe.upstream, version: '99.0.0' } },
        ]),
      /source must use the generator release/u,
    );
  }
});

test('repository MF source pins, installed identities and patch selectors use the generator release', () => {
  const assertPin = (name, version, owner) => {
    if (!name.startsWith('@module-federation/')) return;
    const expected =
      name === '@module-federation/node'
        ? MODULE_FEDERATION_NODE_VERSION
        : MODULE_FEDERATION_VERSION;
    assert.equal(version, expected, `${owner} ${name} must use ${expected}`);
  };
  const files = execFileSync(
    'git',
    ['ls-files', '-z', 'packages/**/package.json'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  )
    .split('\0')
    .filter(Boolean);
  for (const file of files) {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, file), 'utf8'),
    );
    for (const block of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
      'devDependencies',
    ]) {
      for (const [name, version] of Object.entries(manifest[block] ?? {})) {
        if (!version.startsWith('npm:')) assertPin(name, version, file);
      }
    }
  }
  const lock = parse(
    readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8'),
  );
  // Check owned importers, not private transitive pins of third-party tools.
  // Independent packages such as error-codes can legitimately retain an older
  // exact dependency without selecting that release for framework consumers.
  for (const [importer, blocks] of Object.entries(lock.importers ?? {})) {
    for (const block of [
      'dependencies',
      'optionalDependencies',
      'devDependencies',
    ]) {
      for (const [name, { version }] of Object.entries(blocks[block] ?? {})) {
        if (!version.startsWith('@bleedingdev/'))
          assertPin(name, version.split('(')[0], importer);
      }
    }
  }
  const workspace = parse(
    readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'),
  );
  for (const selector of Object.keys(workspace.patchedDependencies ?? {})) {
    const match = /^(@module-federation\/[^@]+)@(.+)$/u.exec(selector);
    if (match) assertPin(match[1], match[2], 'patch selector');
  }
});

test('pnpm preserves the corrected generator dependency identity', () => {
  const { hooks } = createRequire(import.meta.url)(
    path.join(repoRoot, '.pnpmfile.cjs'),
  );
  const alias =
    ULTRAMODERN_PACKAGE_PINS.appDependencies['@module-federation/modern-js-v3'];
  assert.equal(alias, 'npm:@bleedingdev/mf-modern-js-v3@2.9.5');
  for (const name of ['@modern-js/ultramodern-create', '@fixture/consumer']) {
    const resolved = hooks.readPackage({
      name,
      dependencies: { '@module-federation/modern-js-v3': alias },
    });
    assert.equal(
      resolved.dependencies['@module-federation/modern-js-v3'],
      alias,
    );
  }
});

// Framework packages ship their source edges unchanged, so the graph the
// monorepo tests must already be the corrected sidecar graph: a runtime edge
// of a framework package may not resolve an upstream name that has a recipe.
function upstreamRecipeEdges(lockfileText, recipeList = recipes) {
  const byUpstream = Map.groupBy(recipeList, recipe => recipe.upstream.name);
  const edges = [];
  for (const [importer, blocks] of Object.entries(
    parse(lockfileText).importers ?? {},
  )) {
    if (!importer.startsWith('packages/')) continue;
    for (const block of ['dependencies', 'optionalDependencies']) {
      for (const [name, { version }] of Object.entries(blocks[block] ?? {})) {
        const candidates = byUpstream.get(name);
        if (!candidates) continue;
        const admitted = candidates.some(recipe => {
          const fork = `${recipe.fork.name}@${recipe.fork.version}`;
          return (
            version === fork ||
            version.startsWith(`${fork}(`) ||
            isUnpublishedForkEdge(importer, name, version, recipe)
          );
        });
        if (!admitted) edges.push(`${importer} ${block}.${name} -> ${version}`);
      }
    }
  }
  return edges;
}

test('no framework runtime edge resolves an upstream package that has a recipe', () => {
  assert.deepEqual(
    upstreamRecipeEdges(
      readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8'),
    ),
    [],
  );
});

test('app-tools resolves Redact only through the exact signed sidecar alias', () => {
  const recipe = recipes.find(item => item.id === 'tanstack-redact');
  const consumers = dependency => ({
    generatorPins: [],
    publishedManifests: [
      {
        name: '@bleedingdev/modern-js-ultramodern-app-tools',
        dependencies: { '@tanstack/redact': dependency },
      },
    ],
  });
  assert.throws(
    () => assertRecipeConsumers([recipe], consumers(recipe.upstream.version)),
    error =>
      error.message.includes(
        `declare npm:${recipe.fork.name}@${recipe.fork.version} in source`,
      ),
  );
  assertRecipeConsumers(
    [recipe],
    consumers(`npm:${recipe.fork.name}@${recipe.fork.version}`),
  );
  const lock = (importer, version) => `
lockfileVersion: '9.0'
importers:
  ${importer}:
    dependencies:
      '@tanstack/redact':
        specifier: npm:${recipe.fork.name}@${recipe.fork.version}
        version: '${version}'
`;
  const importer = 'packages/solutions/ultramodern-app-tools';
  for (const version of [
    `${recipe.fork.name}@${recipe.fork.version}`,
    `${recipe.fork.name}@${recipe.fork.version}(peer@1.0.0)`,
  ]) {
    assert.deepEqual(upstreamRecipeEdges(lock(importer, version)), []);
  }
  for (const version of [
    '0.2.1',
    '0.2.1(patch_hash=reviewed)',
    recipe.fork.version,
    '@bleedingdev/tanstack-redact@0.2.2',
    '@bleedingdev/tanstack-redact@0.2.0',
    '@bleedingdev/tanstack-redact@0.2.1',
  ]) {
    assert.deepEqual(upstreamRecipeEdges(lock(importer, version)), [
      `${importer} dependencies.@tanstack/redact -> ${version}`,
    ]);
  }
});

test('a framework package resolving an upstream MF package or another sidecar version fails', () => {
  assert.deepEqual(
    upstreamRecipeEdges(`
lockfileVersion: '9.0'
importers:
  packages/server/server:
    dependencies:
      '@module-federation/enhanced':
        specifier: 2.9.2
        version: 2.9.2
  packages/runtime/federation-runtime:
    dependencies:
      '@module-federation/enhanced':
        specifier: npm:@bleedingdev/mf-enhanced@2.9.20
        version: '@bleedingdev/mf-enhanced@2.9.20(@types/node@26.6.2)'
  tests/integration/mf:
    dependencies:
      '@module-federation/enhanced':
        specifier: 2.9.2
        version: 2.9.2
`),
    [
      'packages/server/server dependencies.@module-federation/enhanced -> 2.9.2',
      'packages/runtime/federation-runtime dependencies.@module-federation/enhanced -> @bleedingdev/mf-enhanced@2.9.20(@types/node@26.6.2)',
    ],
  );
});

test('a lock can use both reviewed fork identities for one upstream name', () => {
  const reviewed = [
    {
      upstream: { name: 'picomatch' },
      fork: { name: '@bleedingdev/picomatch', version: '2.3.3' },
    },
    {
      upstream: { name: 'picomatch' },
      fork: { name: '@bleedingdev/picomatch-v4', version: '4.0.8' },
    },
  ];
  const lock = `
lockfileVersion: '9.0'
importers:
  packages/toolkit/utils:
    dependencies:
      picomatch:
        specifier: npm:@bleedingdev/picomatch@2.3.3
        version: '@bleedingdev/picomatch@2.3.3'
  packages/cli/builder:
    dependencies:
      picomatch:
        specifier: npm:@bleedingdev/picomatch-v4@4.0.8
        version: '@bleedingdev/picomatch-v4@4.0.8'
`;
  assert.deepEqual(upstreamRecipeEdges(lock, reviewed), []);
});
