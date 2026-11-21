const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

async function api() {
  const [audit, parity] = await Promise.all([
    import('../published-create-proof/release-age-audit.mjs'),
    import('../published-create-proof/resolution-parity.mjs'),
  ]);
  return { ...audit, ...parity };
}

const integrity = label => `sha512-${Buffer.from(label).toString('base64')}`;

// A pnpm v9 lock whose single importer depends on `dependencies`, each
// { name, specifier, version } exactly as pnpm writes them, including npm:
// aliases whose lock `version` is `<target>@<exact>`.
function lock(dependencies) {
  const packages = {};
  const snapshots = {};
  const importer = {};
  for (const { alias, name, version, bytes = version } of dependencies) {
    const key = `${name}@${version}`;
    importer[alias ?? name] = alias
      ? { specifier: `npm:${name}@^${version}`, version: key }
      : { specifier: `^${version}`, version };
    packages[key] = { resolution: { integrity: integrity(`${key}:${bytes}`) } };
    snapshots[key] = {};
  }
  return {
    importers: { '.': { dependencies: importer } },
    lockfileVersion: '9.0',
    packages,
    snapshots,
  };
}

test('scaffold inventory records exact generated files without Git or installed packages', async t => {
  const { canonicalJson, scaffoldFiles, sha256 } = await api();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-inventory-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const write = (file, contents) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  };
  write('package.json', '{"name":"acc"}\n');
  write('verticals/inventory/src/index.ts', 'export {};\n');
  write('.git/HEAD', 'ignored\n');
  write('node_modules/x/index.js', 'ignored\n');
  const inventory = scaffoldFiles(root);
  assert.deepEqual(inventory.workspaceFiles, [
    { path: 'package.json', sha256: sha256('{"name":"acc"}\n') },
    {
      path: 'verticals/inventory/src/index.ts',
      sha256: sha256('export {};\n'),
    },
  ]);
  assert.equal(
    inventory.workspaceSha256,
    sha256(canonicalJson(inventory.workspaceFiles)),
  );
  write('verticals/inventory/src/index.ts', 'export const changed = true;\n');
  assert.notEqual(
    scaffoldFiles(root).workspaceSha256,
    inventory.workspaceSha256,
  );
});

test('release-age closure includes pnpm 12 toolchain and configuration dependencies', async () => {
  const { buildDependencyClosure } = await api();
  const fixture = lock([
    { name: 'pnpm', version: '12.11.2' },
    { name: 'config-plugin', version: '1.0.0' },
    { name: 'effect', version: '4.0.0' },
  ]);
  const importer = fixture.importers['.'];
  importer.packageManagerDependencies = { pnpm: importer.dependencies.pnpm };
  importer.configDependencies = {
    'config-plugin': importer.dependencies['config-plugin'],
  };
  delete importer.dependencies.pnpm;
  delete importer.dependencies['config-plugin'];
  const result = buildDependencyClosure(fixture);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.closure.map(item => item.name).sort(), [
    'config-plugin',
    'effect',
    'pnpm',
  ]);
});

test('unresolved lock locators remain serializable and retain every dependency path', async () => {
  const { buildDependencyClosure, canonicalJson } = await api();
  const fixture = lock([]);
  fixture.importers['.'].dependencies = {
    alpha: { specifier: '^1.0.0', version: 'unresolved-alpha' },
    beta: { specifier: '^2.0.0', version: 'unresolved-beta' },
  };
  const result = buildDependencyClosure(fixture);
  assert.deepEqual(result.closure, []);
  assert.deepEqual(
    result.unresolved.map(item => item.path),
    [
      ['importer:.', 'alpha'],
      ['importer:.', 'beta'],
    ],
  );
  assert(
    result.unresolved.every(item =>
      /non-exact dependency locator/u.test(item.reason),
    ),
  );
  assert.deepEqual(
    JSON.parse(canonicalJson(result.unresolved)),
    result.unresolved,
  );
});

test('missing SHA-512 integrity remains an unresolved closure candidate', async () => {
  const { buildDependencyClosure } = await api();
  const fixture = lock([
    { name: 'alpha', version: '1.0.0' },
    { name: 'beta', version: '2.0.0' },
  ]);
  delete fixture.packages['alpha@1.0.0'].resolution.integrity;
  fixture.packages['beta@2.0.0'].resolution.integrity = 'sha1-not-sha512';
  const result = buildDependencyClosure(fixture);
  assert.deepEqual(result.closure, []);
  assert.deepEqual(
    result.unresolved.map(item => item.package),
    ['alpha@1.0.0', 'beta@2.0.0'],
  );
  assert(
    result.unresolved.every(
      item => item.reason === 'missing exact SHA-512 lock integrity',
    ),
  );
});

test('a canonical HTTPS peer contributes its exact tarball integrity to the closure', async () => {
  const { buildDependencyClosure } = await api();
  const url = 'https://artifacts.example/releases/core-1.2.3.tgz';
  const peer = `core@${url}`;
  const tuple = `router@1.0.0(${peer})`;
  const fixture = lock([{ name: 'router', version: '1.0.0' }]);
  fixture.importers['.'].dependencies.router.version = tuple;
  fixture.packages[peer] = {
    version: '1.2.3',
    resolution: { tarball: url, integrity: integrity('core-archive') },
  };
  delete fixture.snapshots['router@1.0.0'];
  fixture.snapshots[tuple] = {};
  fixture.snapshots[peer] = {};
  const result = buildDependencyClosure(fixture);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(
    result.closure.map(item => item.name),
    ['router'],
  );
  assert.deepEqual(result.tarballs, [
    {
      name: 'core',
      version: '1.2.3',
      url,
      integrity: integrity('core-archive'),
      path: ['importer:.', 'router@1.0.0', peer],
    },
  ]);
  delete fixture.packages[peer].resolution.integrity;
  const missing = buildDependencyClosure(fixture);
  assert.deepEqual(missing.tarballs, []);
  assert(
    missing.unresolved.some(
      item =>
        item.package === peer &&
        item.reason === 'missing exact SHA-512 lock integrity',
    ),
  );
});

test('legacy registry package case is preserved in exact lock identities', async () => {
  const { buildDependencyClosure } = await api();
  const result = buildDependencyClosure(
    lock([{ name: 'Base64', version: '1.3.0' }]),
  );
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.closure, [
    {
      name: 'Base64',
      version: '1.3.0',
      integrity: integrity('Base64@1.3.0:1.3.0'),
      path: ['importer:.', 'Base64@1.3.0'],
    },
  ]);
});

test('HTTPS peer parsing still rejects noncanonical or credential-bearing locators', async () => {
  const { buildDependencyClosure } = await api();
  for (const url of [
    'http://artifacts.example/core.tgz',
    'https://user:secret@artifacts.example/core.tgz',
    'https://artifacts.example/core.tgz#changed',
  ]) {
    const fixture = lock([{ name: 'router', version: '1.0.0' }]);
    fixture.importers['.'].dependencies.router.version =
      `router@1.0.0(core@${url})`;
    const result = buildDependencyClosure(fixture);
    assert.deepEqual(result.tarballs, []);
    assert.equal(result.unresolved.length, 1);
    assert.match(result.unresolved[0].reason, /non-exact dependency locator/u);
  }
});
