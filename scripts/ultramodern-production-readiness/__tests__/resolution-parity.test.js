const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Guards promoting a published cohort whose consumer install resolves a
// closure the source lane never built or ran. The published lanes no longer
// rebuild anything; this comparison is the whole post-publish proof.

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

async function resolve(dependencies) {
  const { buildDependencyClosure, closureResolution } = await api();
  const closure = buildDependencyClosure(lock(dependencies));
  assert.deepEqual(closure.unresolved, []);
  return closureResolution(closure);
}

const acceptedDependencies = [
  {
    alias: '@module-federation/enhanced',
    name: '@bleedingdev/mf-enhanced',
    version: '2.9.1',
  },
  { name: 'effect', version: '3.19.0' },
  { name: 'react', version: '19.2.0' },
];

test('an identical published closure passes and reports it', async () => {
  const { assertResolutionParity } = await api();
  const accepted = await resolve(acceptedDependencies);
  const observed = await resolve(acceptedDependencies);
  assert.deepEqual(
    assertResolutionParity(accepted, observed, { lane: 'Published ERP-10' }),
    { closureSha256: accepted.closureSha256, packageCount: 3 },
  );
});

test('a changed integrity for an accepted version fails and names it', async () => {
  const { assertResolutionParity } = await api();
  const accepted = await resolve(acceptedDependencies);
  const observed = await resolve(
    acceptedDependencies.map(item =>
      item.name === 'react' ? { ...item, bytes: 'repacked' } : item,
    ),
  );
  assert.throws(
    () => assertResolutionParity(accepted, observed, { lane: 'Published' }),
    error =>
      /\(1 package\(s\)\)/u.test(error.message) &&
      /react@19\.2\.0: accepted integrity sha512-\S+, now sha512-\S+/u.test(
        error.message,
      ) &&
      /registry serves different bytes/u.test(error.message),
  );
});

test('an alias that resolves another target version fails and names the target', async () => {
  const { assertResolutionParity } = await api();
  const accepted = await resolve(acceptedDependencies);
  const observed = await resolve(
    acceptedDependencies.map(item =>
      item.alias ? { ...item, version: '2.9.2' } : item,
    ),
  );
  assert.throws(
    () => assertResolutionParity(accepted, observed, { lane: 'Published' }),
    /@bleedingdev\/mf-enhanced: accepted 2\.9\.1, now resolves 2\.9\.2/u,
  );
});

// The source lane resolved under minimumReleaseAge before effect 3.19.1 was a
// day old; by the published lane it had matured, so npm now picks it.
test('a third-party release that matured between the lanes fails with its name', async () => {
  const { assertResolutionParity } = await api();
  const accepted = await resolve(acceptedDependencies);
  const observed = await resolve(
    acceptedDependencies.map(item =>
      item.name === 'effect' ? { ...item, version: '3.19.1' } : item,
    ),
  );
  assert.throws(
    () => assertResolutionParity(accepted, observed, { lane: 'Published' }),
    error =>
      error.message.includes('effect: accepted 3.19.0, now resolves 3.19.1') &&
      !error.message.includes('react') &&
      /matured between the two lanes/u.test(error.message) &&
      /new reviewed source commit/u.test(error.message),
  );
});

test('added and dropped packages are both named', async () => {
  const { resolutionDrift } = await api();
  const accepted = await resolve(acceptedDependencies);
  const observed = await resolve([
    ...acceptedDependencies.filter(item => item.name !== 'react'),
    { name: 'scheduler', version: '0.27.0' },
  ]);
  assert.deepEqual(
    resolutionDrift(accepted.closureIdentities, observed.closureIdentities),
    [
      'react: accepted 19.2.0, no longer resolved',
      'scheduler: not in the accepted closure, now resolves 0.27.0',
    ],
  );
});

test('an accepted closure that does not hash to its digest is refused', async () => {
  const { assertResolutionParity } = await api();
  const accepted = await resolve(acceptedDependencies);
  const observed = await resolve(acceptedDependencies);
  accepted.closureIdentities[0].version = '0.0.0';
  assert.throws(
    () => assertResolutionParity(accepted, observed, { lane: 'Published' }),
    /Accepted source resolution closure identities do not match its closureSha256/u,
  );
});

test('published acceptance cannot run without the source receipt it must reproduce', async () => {
  const [{ parseArgs }, { runAcceptanceProfile }] = await Promise.all([
    import('../../ultramodern-publish/run-release-acceptance.mjs'),
    import('../published-create-proof/acceptance-profile.mjs'),
  ]);
  const base = ['--manifest', 'release/manifest.json', '--receipt', 'r.json'];
  assert.throws(
    () => parseArgs(['--mode', 'published', ...base]),
    /--source-receipt .* required with --mode published/u,
  );
  assert.throws(
    () => parseArgs([...base, '--source-receipt', 'source.json']),
    /valid only there/u,
  );
  assert.equal(
    parseArgs(['--mode', 'published', ...base, '--source-receipt', 's.json'])
      .sourceReceiptPath,
    path.resolve('s.json'),
  );
  await assert.rejects(
    runAcceptanceProfile({ mode: 'published', options: {}, release: {} }),
    /pass acceptedResolution in published mode and only there/u,
  );
  await assert.rejects(
    runAcceptanceProfile({
      acceptedResolution: { closureIdentities: [], closureSha256: '' },
      mode: 'source',
      options: {},
      release: {},
    }),
    /pass acceptedResolution in published mode and only there/u,
  );
});

// The create CLI runs under `pnpm dlx` with its own, unlocked dependencies. If
// one of them moves between the lanes and changes the generated source, the
// workspace lock can still match while the scaffold is one the source lane
// never built.
test('a scaffold the generator wrote differently fails and names the files', async t => {
  const { assertScaffoldParity, scaffoldFiles } = await api();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-parity-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const write = (lane, file, contents) => {
    fs.mkdirSync(path.dirname(path.join(root, lane, file)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(root, lane, file), contents);
  };
  for (const lane of ['source', 'published']) {
    write(lane, 'package.json', '{"name":"acc"}\n');
    write(lane, 'verticals/inventory/src/index.ts', 'export {};\n');
    write(lane, '.git/HEAD', `${lane}\n`);
    write(lane, 'node_modules/x/index.js', `${lane}\n`);
  }
  const accepted = scaffoldFiles(path.join(root, 'source'));
  assert.deepEqual(
    accepted.workspaceFiles.map(file => file.path),
    ['package.json', 'verticals/inventory/src/index.ts'],
  );
  assert.deepEqual(
    assertScaffoldParity(
      accepted,
      scaffoldFiles(path.join(root, 'published')),
      {
        lane: 'Published ERP-10',
      },
    ),
    { fileCount: 2, workspaceSha256: accepted.workspaceSha256 },
  );

  write('published', 'verticals/inventory/src/index.ts', 'export {};;\n');
  write('published', 'verticals/inventory/src/extra.ts', 'export {};\n');
  assert.throws(
    () =>
      assertScaffoldParity(
        accepted,
        scaffoldFiles(path.join(root, 'published')),
        { lane: 'Published ERP-10' },
      ),
    error =>
      error.message.includes('(2 file(s))') &&
      error.message.includes(
        'verticals/inventory/src/extra.ts: not in the accepted scaffold, now generated',
      ) &&
      error.message.includes(
        'verticals/inventory/src/index.ts: content differs',
      ) &&
      /resolves its own dependencies through pnpm dlx/u.test(error.message),
  );

  accepted.workspaceFiles[0].sha256 = '0'.repeat(64);
  assert.throws(
    () => assertScaffoldParity(accepted, accepted, { lane: 'Published' }),
    /Accepted source scaffold files do not match its workspaceSha256/u,
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
