import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertInstalledNavigationTuple,
  installedPackage,
} from './navigation-tuple.mjs';

function fixture() {
  const packages = new Map();
  const add = (owner, request, directory, version, name = request) => {
    const item = { directory, manifest: { name, version } };
    packages.set(`${owner}:${request}`, item);
    return item;
  };
  add('/app', '@modern-js/renderer-solid', '/solid-adapter', '3.9.3-test');
  add('/app', '@modern-js/renderer-octane', '/octane-adapter', '3.9.3-test');
  add(
    '/octane-adapter',
    '@octanejs/tanstack-router',
    '/octane-router',
    '0.2.10',
  );
  add('/solid-adapter', '@tanstack/router-core', '/solid-core', '1.171.37');
  const solidHistory = add(
    '/solid-core',
    '@tanstack/history',
    '/solid-history',
    '1.162.5',
  );
  packages.set('/solid-adapter:@tanstack/history', solidHistory);
  add('/octane-router', '@tanstack/router-core', '/octane-core', '1.171.34');
  const octaneHistory = add(
    '/octane-core',
    '@tanstack/history',
    '/octane-history',
    '1.162.4',
  );
  packages.set('/octane-router:@tanstack/history', octaneHistory);
  for (const name of ['solid-js', '@solidjs/web', '@solidjs/signals'])
    add('/solid-adapter', name, `/native/${name}`, '2.0.0-rc.15');
  add('/app', '@solidjs/compiler', '/compiler', '2.0.0-rc.15');
  packages.set(
    '/native/@solidjs/web:solid-js',
    packages.get('/solid-adapter:solid-js'),
  );
  packages.set(
    '/native/solid-js:@solidjs/signals',
    packages.get('/solid-adapter:@solidjs/signals'),
  );
  for (const name of ['seroval', 'seroval-plugins']) {
    const item = add('/native/solid-js', name, `/native/${name}`, '1.6.7');
    packages.set(`/native/@solidjs/web:${name}`, item);
  }
  const expected = {
    solid: {
      routerCore: { name: '@tanstack/router-core', version: '1.171.37' },
      history: { name: '@tanstack/history', version: '1.162.5' },
    },
    octane: {
      routerCore: { name: '@tanstack/router-core', version: '1.171.34' },
      history: { name: '@tanstack/history', version: '1.162.4' },
    },
  };
  const check = renderer =>
    assertInstalledNavigationTuple({
      appRoot: '/app',
      renderer,
      expected: expected[renderer],
      resolvePackage(owner, request) {
        const item = packages.get(`${owner}:${request}`);
        assert(item, `Unexpected package resolution ${owner}:${request}`);
        return item;
      },
    });
  return { packages, expected, check };
}

test('accepts the exact Solid2 RC15 native graph and separate Octane router graph', () => {
  const { check } = fixture();
  assert.equal(check('solid').solid, '2.0.0-rc.15');
  assert.equal(check('solid').nativeSerializer, '1.6.7');
  assert.equal(check('octane').routerCore.version, '1.171.34');
});

for (const version of ['1.9.17', '2.0.0-rc.13'])
  test(`rejects Solid ${version} as RC15 acceptance`, () => {
    const { packages, check } = fixture();
    packages.get('/solid-adapter:solid-js').manifest.version = version;
    assert.throws(() => check('solid'), /solid-js package version/);
  });

for (const name of ['@solidjs/web', '@solidjs/signals'])
  test(`rejects a mixed ${name} version`, () => {
    const { packages, check } = fixture();
    packages.get(`/solid-adapter:${name}`).manifest.version = '2.0.0-rc.13';
    assert.throws(() => check('solid'), /package version/);
  });

test('requires the generated app compiler to be RC15', () => {
  const { packages, check } = fixture();
  packages.get('/app:@solidjs/compiler').manifest.version = '2.0.0-rc.13';
  assert.throws(() => check('solid'), /@solidjs\/compiler package version/);
});

for (const name of ['seroval', 'seroval-plugins'])
  test(`rejects router HTTP serializer ${name} as the native Solid serializer`, () => {
    const { packages, check } = fixture();
    packages.get(`/native/solid-js:${name}`).manifest.version = '1.6.9';
    assert.throws(() => check('solid'), /package version/);
  });

test('rejects duplicate signals through their actual SolidJS owner', () => {
  const { packages, check } = fixture();
  const item = packages.get('/native/solid-js:@solidjs/signals');
  packages.set('/native/solid-js:@solidjs/signals', {
    ...item,
    directory: '/duplicate-signals',
  });
  assert.throws(() => check('solid'), /share the Solid runtime instance/);
});

test('rejects duplicate SolidJS instances through the web owner', () => {
  const { packages, check } = fixture();
  const item = packages.get('/native/@solidjs/web:solid-js');
  packages.set('/native/@solidjs/web:solid-js', {
    ...item,
    directory: '/duplicate-solid-js',
  });
  assert.throws(() => check('solid'), /share the web runtime instance/);
});

for (const [renderer, owner] of [
  ['solid', '/solid-adapter'],
  ['octane', '/octane-router'],
]) {
  test(`rejects a mismatched ${renderer} direct history version`, () => {
    const { packages, check } = fixture();
    const item = packages.get(`${owner}:@tanstack/history`);
    packages.set(`${owner}:@tanstack/history`, {
      ...item,
      manifest: { ...item.manifest, version: '0.0.0-wrong' },
    });
    assert.throws(() => check(renderer), /@tanstack\/history package version/);
  });
  test(`rejects a duplicate ${renderer} direct history instance`, () => {
    const { packages, check } = fixture();
    const item = packages.get(`${owner}:@tanstack/history`);
    packages.set(`${owner}:@tanstack/history`, {
      ...item,
      directory: '/duplicate-history',
    });
    assert.throws(() => check(renderer), /share the router history instance/);
  });
}

test('package owner resolution skips nameless dist package markers', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'navigation-tuple-owner-'),
  );
  try {
    const directory = path.join(root, 'node_modules/fixture-router');
    fs.mkdirSync(path.join(directory, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name: 'fixture-router',
        version: '1.0.0',
        exports: { '.': './dist/index.cjs' },
      }),
    );
    fs.writeFileSync(
      path.join(directory, 'dist/package.json'),
      '{"type":"commonjs"}',
    );
    fs.writeFileSync(
      path.join(directory, 'dist/index.cjs'),
      'module.exports = {};',
    );
    const item = installedPackage(root, 'fixture-router');
    assert.equal(item.manifest.name, 'fixture-router');
    assert.equal(item.directory, fs.realpathSync(directory));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects duplicate native serializer instances with matching versions', () => {
  const { packages, check } = fixture();
  const item = packages.get('/native/@solidjs/web:seroval');
  packages.set('/native/@solidjs/web:seroval', {
    ...item,
    directory: '/duplicate-seroval',
  });
  assert.throws(() => check('solid'), /share the native serializer instance/);
});

test('accepts explicitly supplied sidecar identities without inventing a version suffix', () => {
  const { packages, expected, check } = fixture();
  const identity = {
    name: '@bleedingdev/tanstack-router-core',
    version: '1.171.37-ultramodern.42',
  };
  expected.solid.routerCore = identity;
  packages.get('/solid-adapter:@tanstack/router-core').manifest = identity;
  assert.equal(check('solid').routerCore.version, identity.version);
});

test('keeps the Octane core separate from the Solid core', () => {
  const { packages, check } = fixture();
  packages.get('/octane-router:@tanstack/router-core').manifest.version =
    '1.171.37';
  assert.throws(
    () => check('octane'),
    /@tanstack\/router-core package version/,
  );
});

test('fails closed when the expected accepted-router tuple is missing', () => {
  const { expected, check } = fixture();
  delete expected.solid.history;
  assert.throws(() => check('solid'), /Missing history name/);
});
