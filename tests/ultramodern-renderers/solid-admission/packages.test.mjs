import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseSync, traverse } from '@babel/core';
import { targets } from '../../../scripts/ultramodern-dependencies/snapshot.mjs';
import {
  acceptedRouter,
  admissionSerializerOverrides,
  admissionTuple,
  assertNativePackageGraph,
  assertNativeRendererManifest,
  prepareRendererPackages,
} from './packages.mjs';

const read = async relative =>
  JSON.parse(await fs.readFile(new URL(relative, import.meta.url), 'utf8'));
const require = createRequire(import.meta.url);

test('the live standalone consumer manifest follows the reviewed registry cohort and accepted native owner', async () => {
  const template = await read('./fixture/package.template.json');
  const owner = await read(
    '../../../packages/runtime/renderer-solid/package.json',
  );
  const root = await read('../../../package.json');
  for (const name of [
    'solid-js',
    '@solidjs/web',
    '@solidjs/signals',
    '@solidjs/compiler',
  ]) {
    assert.equal(template.dependencies[name], targets[name], name);
    assert.equal(
      template.dependencies[name],
      owner.dependencies[name] ?? owner.peerDependencies[name],
      name,
    );
  }
  for (const name of ['@babel/core', 'playwright', 'typescript'])
    assert.equal(template.devDependencies[name], targets[name], name);
  assert.equal(
    template.devDependencies['@rsbuild/core'],
    owner.peerDependencies['@rsbuild/core'],
  );
  assert.equal(
    template.dependencies['@tanstack/router-core'],
    owner.devDependencies['@tanstack/router-core'],
  );
  assert.equal(template.packageManager, root.packageManager);
  for (const [name, version] of Object.entries(admissionTuple)) {
    assert.equal(version, targets[name] ?? owner.peerDependencies[name], name);
  }
});

test('the actual packed-consumer workspace plan includes bounded generator serializer policy, not global native overrides', async t => {
  const directory = await fs.mkdtemp(
    path.join(
      process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
      'solid-admission-plan-',
    ),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const packages = {};
  for (const name of [
    '@modern-js/renderer-core',
    '@modern-js/renderer-solid',
  ]) {
    const tarball = path.join(
      directory,
      `${name.slice('@modern-js/'.length)}.tgz`,
    );
    const bytes = Buffer.from(`synthetic transport ${name}`);
    await fs.writeFile(tarball, bytes);
    packages[name] = {
      tarball,
      integrity: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  const filename = path.join(directory, 'packed.json');
  await fs.writeFile(filename, JSON.stringify({ packages }));
  const previous = process.env.MODERN_TEST_PACKAGE_MANIFEST;
  process.env.MODERN_TEST_PACKAGE_MANIFEST = filename;
  t.after(() => {
    if (previous === undefined) delete process.env.MODERN_TEST_PACKAGE_MANIFEST;
    else process.env.MODERN_TEST_PACKAGE_MANIFEST = previous;
  });
  const digests = await prepareRendererPackages(
    directory,
    'must-not-run-pnpm',
    () => {
      throw new Error('Planning must not install or build');
    },
  );
  assert.deepEqual(
    digests,
    Object.fromEntries(
      Object.entries(packages).map(([name, item]) => [name, item.integrity]),
    ),
  );
  const workspace = JSON.parse(
    await fs.readFile(path.join(directory, 'pnpm-workspace.yaml'), 'utf8'),
  );
  assert.deepEqual(workspace, {
    packages: [],
    overrides: {
      ...Object.fromEntries(
        Object.entries(packages).map(([name, item]) => [
          name,
          `file:${item.tarball}`,
        ]),
      ),
      'seroval@>=1.0.0 <1.8.1': '1.8.1',
      'seroval-plugins@>=1.0.0 <1.8.0': '1.8.0',
    },
  });
  await fs.appendFile(
    packages['@modern-js/renderer-solid'].tarball,
    'tampered',
  );
  await assert.rejects(
    prepareRendererPackages(directory, 'must-not-run-pnpm'),
    /Packed prerequisite changed/u,
  );
});

test('the live fixture preserves exactly one native URL import under the Babel 8 AST contract', () => {
  const loader = require('./fixture/preserve-import-loader.cjs');
  const context = {
    resourcePath: 'web.js',
    getOptions: () => ({ babelPath: require.resolve('@babel/core') }),
  };
  assert.match(
    loader.call(context, 'const entryUrl = "/lazy.js"; import(entryUrl);'),
    /webpackIgnore: true/u,
  );
  for (const source of [
    'import(otherUrl);',
    'import(entryUrl); import(entryUrl);',
  ])
    assert.throws(
      () => loader.call(context, source),
      /native URL import contract changed/u,
    );
});

test('live standalone, i18n and federation proof producers cannot retain the old Solid cohort', async () => {
  for (const filename of [
    './run.mjs',
    '../i18n/proof.mjs',
    '../solid-federation/proof.mjs',
  ]) {
    const source = await fs.readFile(
      new URL(filename, import.meta.url),
      'utf8',
    );
    assert.equal(source.includes('2.0.0-rc.15'), false, filename);
    if (filename !== './run.mjs') {
      const pins = [];
      const ast = parseSync(source, { babelrc: false, configFile: false });
      traverse(ast, {
        ObjectProperty(node) {
          const dependencyPlan = node.findParent(
            parent =>
              parent.isObjectProperty() &&
              (parent.node.key.name ?? parent.node.key.value) ===
                'dependencies',
          );
          if (!dependencyPlan) return;
          const name = node.node.key.value;
          if (['solid-js', '@solidjs/web', '@solidjs/signals'].includes(name)) {
            assert.equal(
              node.node.value.type,
              'StringLiteral',
              `${filename}: ${name}`,
            );
            pins.push([name, node.node.value.value]);
          }
        },
      });
      assert.deepEqual(
        pins.sort(),
        ['solid-js', '@solidjs/web', '@solidjs/signals']
          .map(name => [name, targets[name]])
          .sort(),
        filename,
      );
    }
  }
});

test('serializer planning rejects missing, broad, stale and computed generator corrections', async () => {
  const source = await fs.readFile(
    new URL(
      '../../../packages/toolkit/ultramodern-create/src/ultramodern-workspace/policy.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const expected = {
    'seroval@>=1.0.0 <1.8.1': '1.8.1',
    'seroval-plugins@>=1.0.0 <1.8.0': '1.8.0',
  };
  assert.deepEqual(admissionSerializerOverrides(source), expected);
  for (const [from, to] of [
    ["'seroval@>=1.0.0 <1.8.1'", "'seroval'"],
    ["'seroval-plugins@>=1.0.0 <1.8.0'", "'seroval-plugins'"],
    ["'seroval@>=1.0.0 <1.8.1': '1.8.1'", "'seroval@>=1.0.0 <1.8.1': '1.7.0'"],
    [
      "'seroval-plugins@>=1.0.0 <1.8.0': '1.8.0'",
      "'seroval-plugins@>=1.0.0 <1.8.0': unknownVersion",
    ],
    [
      "'seroval@>=1.0.0 <1.8.1': '1.8.1'",
      "'seroval@>=1.0.0 <1.8.1': '1.8.1', 'seroval@>=1.0.0 <1.8.1': '1.7.0'",
    ],
  ]) {
    assert(source.includes(from));
    assert.throws(
      () => admissionSerializerOverrides(source.replace(from, to)),
      /generator serializer policy|Generator serializer policy drift/u,
    );
  }
});

test('native owner metadata retains the accepted artifact and rejects stale declarations or identity', async () => {
  const manifest = await read(
    '../../../packages/runtime/renderer-solid/package.json',
  );
  assertNativeRendererManifest(manifest);
  for (const change of [
    value => {
      value.dependencies['solid-js'] = '2.0.0-rc.15';
    },
    value => {
      value.dependencies['@tanstack/router-core'] = '1.171.37';
    },
    value => {
      value.peerDependencies['@tanstack/router-core'] = '1.171.38';
    },
    value => {
      value.ultramodern.nativeArtifacts.packages[
        '@tanstack/router-core'
      ].request = 'https://example.test/unreviewed.tgz';
    },
    value => {
      value.ultramodern.nativeArtifacts.packages[
        '@tanstack/router-core'
      ].integrity = 'sha512-unreviewed';
    },
    value => {
      value.dependencies.seroval = '1.8.1';
    },
  ]) {
    const changed = structuredClone(manifest);
    change(changed);
    assert.throws(() => assertNativeRendererManifest(changed));
  }
});

test('the verifier enforces the latest tuple and obsolete-runtime rejection in a synthetic consumer graph', async t => {
  const directory = await fs.mkdtemp(
    path.join(
      process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
      'solid-admission-graph-',
    ),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'package.json'), '{}');
  const manifests = new Map();
  const add = async (name, manifest) => {
    const owner = path.join(directory, 'node_modules', name);
    await fs.mkdir(path.join(owner, 'dist'), { recursive: true });
    const filename = path.join(owner, 'package.json');
    await fs.writeFile(
      filename,
      JSON.stringify({ name, main: './dist/index.cjs', ...manifest }),
    );
    await fs.writeFile(
      path.join(owner, 'dist/index.cjs'),
      'module.exports = {};',
    );
    manifests.set(name, filename);
  };
  await add('@modern-js/renderer-solid', {
    ...(await read('../../../packages/runtime/renderer-solid/package.json')),
    exports: {
      './package.json': './package.json',
      './router': './dist/index.cjs',
    },
  });
  for (const [name, version] of Object.entries({
    ...admissionTuple,
    '@tanstack/router-core': acceptedRouter.version,
    '@tanstack/history': '1.162.5',
  }))
    await add(name, {
      version,
      ...(name === 'seroval-plugins'
        ? { exports: { '.': './dist/index.cjs', './web': './dist/index.cjs' } }
        : {}),
    });
  await fs.mkdir(path.join(directory, 'node_modules/.pnpm'));
  const graph = await assertNativePackageGraph(directory);
  for (const [name, version] of Object.entries(admissionTuple))
    assert.equal(graph.versions[name], version, name);
  for (const [name, stale] of [
    ['solid-js', '2.0.0-rc.15'],
    ['@babel/core', '7.29.7'],
    ['@rsbuild/core', '2.2.11'],
    ['@rspack/core', '2.2.8'],
    ['playwright', '1.64.1'],
    ['seroval', '1.6.7'],
    ['seroval-plugins', '1.6.7'],
  ]) {
    const filename = manifests.get(name);
    const original = await fs.readFile(filename, 'utf8');
    await fs.writeFile(
      filename,
      JSON.stringify({ ...JSON.parse(original), version: stale }),
    );
    await assert.rejects(assertNativePackageGraph(directory), /drift/u, name);
    await fs.writeFile(filename, original);
  }
  await fs.mkdir(path.join(directory, 'node_modules/.pnpm/solid-js@1.9.17'));
  await assert.rejects(
    assertNativePackageGraph(directory),
    /obsolete runtime/u,
  );
});
