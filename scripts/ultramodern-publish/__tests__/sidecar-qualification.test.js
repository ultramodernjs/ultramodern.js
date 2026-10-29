// Consumer: standalone sidecar qualification, exact installation, and cleanup.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const load = () => import('../qualify-sidecar-bundle.mjs');

async function fixture(t, { sdk = false, redact = false } = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(
      path.join(
        process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
        'sidecar-qualification-test-',
      ),
    ),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { writeSidecarStagingManifest } = await import(
    '../lib/prepare-bleedingdev-packages/sidecars.mjs'
  );
  const { inspectNpmTarball, verifySidecarArtifacts } = await import(
    '../lib/prepare-bleedingdev-packages/release-artifacts.mjs'
  );
  const definitions = sdk
    ? [{ name: '@bleedingdev/mf-sdk', version: '2.9.2' }]
    : redact
      ? [{ name: '@bleedingdev/tanstack-redact', version: '0.2.1' }]
      : [
          { name: '@bleedingdev/braces', version: '3.0.4' },
          {
            name: '@bleedingdev/micromatch',
            version: '4.0.8',
            dependencies: { braces: 'npm:@bleedingdev/braces@3.0.4' },
          },
        ];
  const staged = definitions.map(definition => {
    const id = definition.name.split('/')[1];
    const stagedDir = path.join(root, id);
    fs.mkdirSync(stagedDir);
    const packageJson = {
      ...definition,
      main: 'index.js',
      license: 'MIT',
      publishConfig: { access: 'public' },
    };
    fs.writeFileSync(
      path.join(stagedDir, 'package.json'),
      `${JSON.stringify(packageJson)}\n`,
    );
    fs.writeFileSync(
      path.join(stagedDir, 'index.js'),
      `module.exports = ${JSON.stringify(id)};\n`,
    );
    return {
      ...definition,
      root: `packages/sidecar/${id}`,
      stagedDir,
      packageJson,
    };
  });
  const output = path.join(root, 'bundle');
  fs.mkdirSync(output);
  const { descriptor } = writeSidecarStagingManifest(output, staged, {
    publishBefore: '@bleedingdev/modern-js-utils',
  });
  const sidecars = verifySidecarArtifacts(output, descriptor);
  const registryUrl = 'http://127.0.0.1:12345/';
  const served = new Set(sidecars.packages.map(item => item.name));
  const install = workspace => {
    const lock = { lockfileVersion: 3, packages: {} };
    const copyPackage = (item, relative) => {
      const destination = path.join(workspace, relative);
      for (const [file, bytes] of inspectNpmTarball(item.bytes).fileContents) {
        fs.mkdirSync(path.dirname(path.join(destination, file)), {
          recursive: true,
        });
        fs.writeFileSync(path.join(destination, file), bytes);
      }
      lock.packages[relative] = {
        version: item.version,
        integrity: item.integrity,
        resolved: `${registryUrl}tarballs/${encodeURIComponent(item.name)}.tgz`,
      };
    };
    for (const item of sidecars.packages)
      copyPackage(item, `node_modules/${item.name}`);
    if (!sdk && !redact)
      copyPackage(sidecars.packages[0], 'node_modules/braces');
    fs.writeFileSync(
      path.join(workspace, 'package-lock.json'),
      JSON.stringify(lock),
    );
    return lock;
  };
  const workspace = path.join(root, 'consumer');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'package.json'), '{"private":true}\n');
  const lock = install(workspace);
  return { root, sidecars, registryUrl, served, workspace, lock, install };
}

test('read-only loopback registry serves only accepted metadata and snapshotted bytes', async t => {
  const f = await fixture(t);
  const { startSidecarRegistry } = await load();
  const item = f.sidecars.packages[0];
  const original = Buffer.from(item.bytes);
  const beforeStart = Date.now();
  const registry = await startSidecarRegistry(f.sidecars.packages);
  const afterStart = Date.now();
  t.after(() => registry.stop());
  const metadata = await fetch(
    new URL(encodeURIComponent(item.name), registry.registryUrl),
  ).then(response => response.json());
  assert.equal(metadata.versions[item.version].dist.integrity, item.integrity);
  assert.deepEqual(Object.keys(metadata.versions), [item.version]);
  const availableAt = metadata.time[item.version];
  assert.equal(new Date(availableAt).toISOString(), availableAt);
  assert.ok(Date.parse(availableAt) >= beforeStart);
  assert.ok(Date.parse(availableAt) <= afterStart);
  assert.deepEqual(metadata.time, {
    created: availableAt,
    modified: availableAt,
    [item.version]: availableAt,
  });
  item.bytes.fill(0);
  item.packageJson.version = '99.0.0';
  const response = await fetch(metadata.versions[item.version].dist.tarball);
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(original));
  assert.deepEqual([...registry.servedTarballs], [item.name]);
  const again = await fetch(
    new URL(encodeURIComponent(item.name), registry.registryUrl),
  ).then(value => value.json());
  assert.equal(again.versions[item.version].version, item.version);
  assert.deepEqual(again.time, metadata.time);
  for (const route of [
    'braces',
    '@bleedingdev/unknown',
    'tarballs/unknown.tgz',
  ]) {
    assert.equal(
      (await fetch(new URL(route, registry.registryUrl))).status,
      404,
    );
  }
  assert.equal(
    (await fetch(registry.registryUrl, { method: 'PUT', body: '{}' })).status,
    405,
  );
});

test('packed installation checks real roots, all corrected alias edges, and payload bytes', async t => {
  const f = await fixture(t);
  const { assertPackedSidecarInstall } = await load();
  assert.doesNotThrow(() =>
    assertPackedSidecarInstall(
      f.workspace,
      f.sidecars.packages,
      f.registryUrl,
      f.served,
    ),
  );
  fs.writeFileSync(
    path.join(f.workspace, 'node_modules/braces/index.js'),
    'module.exports = "different";\n',
  );
  assert.throws(
    () =>
      assertPackedSidecarInstall(
        f.workspace,
        f.sidecars.packages,
        f.registryUrl,
        f.served,
      ),
    /installed bytes drift/,
  );
});

test('lockfile cannot substitute npm history, a different version, or an unserved cache entry', async t => {
  const f = await fixture(t);
  const { assertPackedSidecarInstall } = await load();
  const relative = 'node_modules/@bleedingdev/braces';
  for (const replacement of [
    { resolved: 'https://registry.npmjs.org/braces/-/braces-3.0.3.tgz' },
    { version: '3.0.3' },
    { integrity: `sha512-${Buffer.alloc(64).toString('base64')}` },
    { link: true },
  ]) {
    const lock = structuredClone(f.lock);
    Object.assign(lock.packages[relative], replacement);
    fs.writeFileSync(
      path.join(f.workspace, 'package-lock.json'),
      JSON.stringify(lock),
    );
    assert.throws(
      () =>
        assertPackedSidecarInstall(
          f.workspace,
          f.sidecars.packages,
          f.registryUrl,
          f.served,
        ),
      /local tarball|version drift|integrity drift|linked instead/,
    );
  }
  fs.writeFileSync(
    path.join(f.workspace, 'package-lock.json'),
    JSON.stringify(f.lock),
  );
  assert.throws(
    () =>
      assertPackedSidecarInstall(
        f.workspace,
        f.sidecars.packages,
        f.registryUrl,
        new Set(),
      ),
    /not fetched/,
  );
});

test('a corrected dependency must resolve the installed fork identity', async t => {
  const f = await fixture(t);
  const { assertPackedSidecarInstall } = await load();
  const manifest = path.join(f.workspace, 'node_modules/braces/package.json');
  const value = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  value.name = 'braces';
  value.version = '3.0.3';
  fs.writeFileSync(manifest, JSON.stringify(value));
  assert.throws(
    () =>
      assertPackedSidecarInstall(
        f.workspace,
        f.sidecars.packages,
        f.registryUrl,
        f.served,
      ),
    /did not resolve to @bleedingdev\/braces/,
  );
});

test('external linked package trees cannot satisfy packed installation', async t => {
  const f = await fixture(t);
  const { assertPackedSidecarInstall } = await load();
  const source = path.join(f.workspace, 'node_modules/@bleedingdev/braces');
  const external = path.join(f.root, 'borrowed-braces');
  fs.renameSync(source, external);
  fs.symlinkSync(external, source, 'junction');
  assert.throws(
    () =>
      assertPackedSidecarInstall(
        f.workspace,
        f.sidecars.packages,
        f.registryUrl,
        f.served,
      ),
    /escaped the clean installation/,
  );
});

test('qualification checks accepted Node, npm, and pnpm before allocating a consumer', async () => {
  const { assertQualificationToolchain } = await load();
  const tools = { node: process.version, npm: '11.19.1', pnpm: '12.11.2' };
  const command = tool => Buffer.from(`${tools[tool]}\n`);
  assert.doesNotThrow(() => assertQualificationToolchain(tools, command));
  assert.throws(
    () => assertQualificationToolchain({ ...tools, node: 'v22.0.0' }, command),
    /Node.js drift/,
  );
  assert.throws(
    () => assertQualificationToolchain({ ...tools, npm: '0.0.0' }, command),
    /npm drift/,
  );
  assert.throws(
    () => assertQualificationToolchain({ ...tools, pnpm: '0.0.0' }, command),
    /pnpm drift/,
  );
});

test('early registry failure removes only the newly allocated consumer', async t => {
  const f = await fixture(t);
  const { qualifyPackedSidecars } = await load();
  const sentinel = path.join(f.root, 'caller-owned.txt');
  fs.writeFileSync(sentinel, 'keep');
  await assert.rejects(
    () =>
      qualifyPackedSidecars(
        { manifest: { profile: 'parser' }, sidecars: f.sidecars },
        {
          scratchRoot: f.root,
          startRegistry: async () => {
            throw new Error('registry failed');
          },
        },
      ),
    /registry failed/,
  );
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  assert.deepEqual(
    fs
      .readdirSync(f.root)
      .filter(name => name.startsWith('sidecar-qualification-')),
    [],
  );
});

test('install failure stops the registry and removes the partial consumer', async t => {
  const f = await fixture(t);
  const { qualifyPackedSidecars } = await load();
  let stopped = 0;
  await assert.rejects(
    () =>
      qualifyPackedSidecars(
        { manifest: { profile: 'parser' }, sidecars: f.sidecars },
        {
          scratchRoot: f.root,
          startRegistry: async () => ({
            registryUrl: f.registryUrl,
            servedTarballs: f.served,
            stop: async () => {
              stopped += 1;
            },
          }),
          run: async (command, args, options) => {
            assert.equal(command, 'npm');
            assert.ok(args.includes('--strict-peer-deps'));
            assert.ok(args.includes('--ignore-scripts'));
            assert.ok(!args.includes('--legacy-peer-deps'));
            assert.equal(options.env.NODE_PATH, undefined);
            fs.mkdirSync(path.join(options.cwd, 'node_modules'));
            throw new Error('install failed');
          },
        },
      ),
    /install failed/,
  );
  assert.equal(stopped, 1);
  assert.deepEqual(
    fs
      .readdirSync(f.root)
      .filter(name => name.startsWith('sidecar-qualification-')),
    [],
  );
});

test('mocked orchestration cleans a successful consumer without minting a receipt', async t => {
  const f = await fixture(t);
  const { qualifyPackedSidecars } = await load();
  let calls = 0;
  let stopped = 0;
  const probes = await qualifyPackedSidecars(
    { manifest: { profile: 'parser' }, sidecars: f.sidecars },
    {
      scratchRoot: f.root,
      startRegistry: async () => ({
        registryUrl: f.registryUrl,
        servedTarballs: f.served,
        stop: async () => {
          stopped += 1;
        },
      }),
      run: async (command, args, options) => {
        calls += 1;
        if (args[0] === 'install') f.install(options.cwd);
        if (command === process.execPath)
          assert.match(
            fs.readFileSync(args[0], 'utf8'),
            /getMonorepoSubProjects/,
          );
        return '';
      },
    },
  );
  assert.equal(calls, 3);
  assert.equal(stopped, 1);
  assert.ok(Object.values(probes).every(value => value === true));
  assert.deepEqual(
    fs
      .readdirSync(f.root)
      .filter(name => name.startsWith('sidecar-qualification-')),
    [],
  );
  assert.equal(fs.existsSync(path.join(f.root, 'qualification.json')), false);
});

test('SDK profile installs only its closed dependency and runs native VM probes', async t => {
  const f = await fixture(t, { sdk: true });
  const { qualifyPackedSidecars } = await load();
  const probes = await qualifyPackedSidecars(
    { manifest: { profile: 'mf-sdk' }, sidecars: f.sidecars },
    {
      scratchRoot: f.root,
      startRegistry: async () => ({
        registryUrl: f.registryUrl,
        servedTarballs: f.served,
        stop: async () => {},
      }),
      run: async (command, args, options) => {
        if (args[0] === 'install') {
          const manifest = JSON.parse(
            fs.readFileSync(path.join(options.cwd, 'package.json')),
          );
          assert.deepEqual(manifest.dependencies, {
            '@bleedingdev/mf-sdk': '2.9.2',
          });
          f.install(options.cwd);
        }
        if (command === process.execPath) {
          assert.equal(args[0], '--experimental-vm-modules');
          assert.match(
            fs.readFileSync(args[1], 'utf8'),
            /packedMfSdkProbeMain/,
          );
        }
        return '';
      },
    },
  );
  assert.deepEqual(probes, {
    'packed-install': true,
    'mf-sdk-cjs-api': true,
    'mf-sdk-esm-api': true,
  });
  for (const manifest of [undefined, { profile: 'unknown' }]) {
    await assert.rejects(
      () =>
        qualifyPackedSidecars(
          { manifest, sidecars: f.sidecars },
          { scratchRoot: f.root },
        ),
      /Unknown sidecar profile/,
    );
  }
  await assert.rejects(
    () =>
      qualifyPackedSidecars(
        {
          manifest: { profile: 'mf-sdk' },
          sidecars: {
            ...f.sidecars,
            packages: [{ name: '@bleedingdev/mf-sdk', version: '2.9.3' }],
          },
        },
        { scratchRoot: f.root },
      ),
    /closed profile/,
  );
});

test('Redact profile installs only its closed dependency and runs the Redact probe', async t => {
  const f = await fixture(t, { redact: true });
  const { qualifyPackedSidecars } = await load();
  let probed = false;
  const probes = await qualifyPackedSidecars(
    { manifest: { profile: 'tanstack-redact' }, sidecars: f.sidecars },
    {
      scratchRoot: f.root,
      startRegistry: async () => ({
        registryUrl: f.registryUrl,
        servedTarballs: f.served,
        stop: async () => {},
      }),
      run: async (command, args, options) => {
        if (args[0] === 'install') {
          const manifest = JSON.parse(
            fs.readFileSync(path.join(options.cwd, 'package.json')),
          );
          assert.deepEqual(manifest.dependencies, {
            '@bleedingdev/tanstack-redact': '0.2.1',
          });
          f.install(options.cwd);
        }
        if (command === process.execPath) {
          assert.equal(args.length, 1);
          assert.match(
            fs.readFileSync(args[0], 'utf8'),
            /packedRedactProbeMain/,
          );
          probed = true;
        }
        return '';
      },
    },
  );
  assert.equal(probed, true);
  assert.deepEqual(probes, {
    'packed-install': true,
    'redact-patch-marker': true,
    'redact-server-render': true,
  });
  await assert.rejects(
    () =>
      qualifyPackedSidecars(
        {
          manifest: { profile: 'tanstack-redact' },
          sidecars: {
            ...f.sidecars,
            packages: [{ name: '@tanstack/redact', version: '0.2.1' }],
          },
        },
        { scratchRoot: f.root },
      ),
    /closed profile/,
  );
});

test('unknown qualification flags cannot select a different registry or installation', async () => {
  const { runSidecarQualificationCli } = await load();
  for (const args of [
    ['--registry', 'https://example.test'],
    ['--skip-install'],
    ['--out'],
    ['--out=elsewhere'],
    ['--receipt=elsewhere'],
  ]) {
    await assert.rejects(
      () => runSidecarQualificationCli(args),
      /Unknown argument|requires a value/,
    );
  }
  await assert.rejects(
    () => runSidecarQualificationCli(['--out', os.tmpdir()]),
    /must be inside/,
  );
  await assert.rejects(
    () => runSidecarQualificationCli(['--receipt', os.tmpdir()]),
    /must be inside/,
  );
});

test('workspace lease covers the dependency directory and releases after registry closure', async t => {
  const f = await fixture(t);
  const { qualifyPackedSidecars } = await load();
  const events = [];
  await assert.rejects(
    () =>
      qualifyPackedSidecars(
        { manifest: { profile: 'parser' }, sidecars: f.sidecars },
        {
          scratchRoot: f.root,
          onWorkspace: (workspace, { dependenciesPath, ownerPid }) => {
            assert.equal(
              dependenciesPath,
              path.join(workspace, 'node_modules'),
            );
            assert.ok(fs.statSync(dependenciesPath).isDirectory());
            assert.equal(ownerPid, process.pid);
            events.push('registered');
            return () => {
              events.push('released');
            };
          },
          startRegistry: async () => ({
            registryUrl: f.registryUrl,
            servedTarballs: f.served,
            stop: async () => {
              events.push('closed');
            },
          }),
          run: async () => {
            events.push('install');
            throw new Error('finite install failure');
          },
        },
      ),
    /finite install failure/,
  );
  assert.deepEqual(events, ['registered', 'install', 'closed', 'released']);
  assert.deepEqual(
    fs
      .readdirSync(f.root)
      .filter(name => name.startsWith('sidecar-qualification-')),
    [],
  );
});

test('an already cancelled qualification allocates no workspace', async t => {
  const f = await fixture(t);
  const { qualifyPackedSidecars } = await load();
  const controller = new AbortController();
  controller.abort(new Error('cancelled before allocation'));
  await assert.rejects(
    () =>
      qualifyPackedSidecars(
        { manifest: { profile: 'parser' }, sidecars: f.sidecars },
        { scratchRoot: f.root, signal: controller.signal },
      ),
    /cancelled before allocation/,
  );
  assert.deepEqual(
    fs
      .readdirSync(f.root)
      .filter(name => name.startsWith('sidecar-qualification-')),
    [],
  );
});

test('Darwin zombie-only EPERM requires a complete owned process-group snapshot', async () => {
  const { qualificationGroupHasLiveMembers } = await load();
  const denied = Object.assign(new Error('not signalable'), { code: 'EPERM' });
  const options = snapshot => ({
    platform: 'darwin',
    uid: 501,
    kill: () => {
      throw denied;
    },
    readProcessTable: () => snapshot,
  });
  assert.equal(
    qualificationGroupHasLiveMembers(
      123,
      options('124 123 501 Z\n125 456 0 S'),
    ),
    false,
  );
  assert.throws(
    () => qualificationGroupHasLiveMembers(123, options('124 123 501 S')),
    error => error === denied,
  );
  assert.throws(
    () => qualificationGroupHasLiveMembers(123, options('124 123 0 Z')),
    /foreign owner/,
  );
  assert.throws(
    () => qualificationGroupHasLiveMembers(123, options('unreadable row')),
    /Cannot confirm/,
  );
  assert.throws(
    () =>
      qualificationGroupHasLiveMembers(123, {
        ...options('124 123 501 Z'),
        platform: 'linux',
      }),
    error => error === denied,
  );
});

for (const failure of ['timeout', 'cancellation']) {
  test(`${failure} terminates an ignoring grandchild before releasing and removing its workspace`, {
    skip: process.platform === 'win32',
    timeout: 20_000,
  }, async t => {
    const f = await fixture(t);
    const { qualifyPackedSidecars, runChild } = await load();
    const controller = new AbortController();
    const readyPath = path.join(f.root, 'child-ready.json');
    const terminatedPath = path.join(f.root, 'grandchild-term.json');
    const grandchildPath = path.join(f.root, 'grandchild.cjs');
    const childPath = path.join(f.root, 'child.cjs');
    fs.writeFileSync(
      grandchildPath,
      `const fs = require('node:fs');
process.on('SIGTERM', () => fs.writeFileSync(process.argv[2], JSON.stringify({ workspaceExists: fs.existsSync(process.cwd()) })));
setInterval(() => {}, 1000);
process.send('ready');
`,
    );
    fs.writeFileSync(
      childPath,
      `const fs = require('node:fs');
const { spawn } = require('node:child_process');
process.on('SIGTERM', () => process.exit(0));
const child = spawn(process.execPath, [process.argv[2], process.argv[4]], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
child.once('message', () => fs.writeFileSync(process.argv[3], JSON.stringify({ child: process.pid, grandchild: child.pid })));
setInterval(() => {}, 1000);
`,
    );
    const alive = pid => {
      try {
        return !execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .trim()
          .startsWith('Z');
      } catch (error) {
        if (error.status === 1) return false;
        throw error;
      }
    };
    const waitFor = async predicate => {
      const deadline = Date.now() + 8_000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, 'Owned child fixture did not settle');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    let childPids;
    let allocated;
    let released = false;
    let closed = false;
    const task = qualifyPackedSidecars(
      { manifest: { profile: 'parser' }, sidecars: f.sidecars },
      {
        scratchRoot: f.root,
        signal: controller.signal,
        startRegistry: async () => ({
          registryUrl: f.registryUrl,
          servedTarballs: f.served,
          stop: async () => {
            closed = true;
          },
        }),
        onWorkspace: workspace => {
          allocated = workspace;
          return () => {
            const pids = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
            assert.equal(alive(pids.child), false);
            assert.equal(alive(pids.grandchild), false);
            assert.equal(closed, true);
            assert.equal(fs.existsSync(workspace), true);
            assert.deepEqual(
              JSON.parse(fs.readFileSync(terminatedPath, 'utf8')),
              { workspaceExists: true },
            );
            released = true;
          };
        },
        run: (_command, _args, options) =>
          runChild(
            process.execPath,
            [childPath, grandchildPath, readyPath, terminatedPath],
            { ...options, timeoutMs: failure === 'timeout' ? 1_000 : 15_000 },
          ),
      },
    );
    // Attach the rejection assertion before waiting for subprocess readiness.
    const rejected = assert.rejects(task, error => {
      assert.ok(
        !(error instanceof AggregateError),
        require('node:util').inspect(error, { depth: 8 }),
      );
      if (failure === 'timeout') assert.match(error.message, /timeout/);
      else assert.equal(error.cause, controller.signal.reason);
      return true;
    });
    try {
      await waitFor(() => fs.existsSync(readyPath));
      childPids = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
      assert.equal(alive(childPids.grandchild), true);
      if (failure === 'cancellation')
        controller.abort(new Error('cancel the owned descendant proof'));
      await rejected;
      assert.equal(released, true);
      assert.equal(fs.existsSync(allocated), false);
    } finally {
      controller.abort();
      if (!childPids && fs.existsSync(readyPath))
        childPids = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
      if (childPids) {
        try {
          if (alive(childPids.child) || alive(childPids.grandchild))
            process.kill(-childPids.child, 'SIGKILL');
        } catch (error) {
          if (process.platform === 'darwin' && error.code === 'EPERM') {
            assert.equal(alive(childPids.child), false);
            assert.equal(alive(childPids.grandchild), false);
          } else assert.equal(error.code, 'ESRCH');
        }
        await waitFor(() => !alive(childPids.grandchild));
      }
      await rejected;
    }
  });
}

test('cleanup preserves the original error and removes scratch after confirmed closure', async t => {
  const f = await fixture(t);
  const { qualifyPackedSidecars } = await load();
  await assert.rejects(
    () =>
      qualifyPackedSidecars(
        { manifest: { profile: 'parser' }, sidecars: f.sidecars },
        {
          scratchRoot: f.root,
          startRegistry: async () => ({
            registryUrl: f.registryUrl,
            servedTarballs: f.served,
            isClosed: () => true,
            stop: async () => {
              throw new Error('closed registry diagnostic');
            },
          }),
          run: async () => {
            throw new Error('original install failure');
          },
        },
      ),
    error => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.errors[0].message, /original install failure/);
      assert.match(error.errors[1].message, /closed registry diagnostic/);
      return true;
    },
  );
  assert.deepEqual(
    fs
      .readdirSync(f.root)
      .filter(name => name.startsWith('sidecar-qualification-')),
    [],
  );
});

test('unconfirmed registry closure retains owned scratch and reports its exact path', async t => {
  const f = await fixture(t);
  const { qualifyPackedSidecars } = await load();
  let allocated;
  let released = false;
  await assert.rejects(
    () =>
      qualifyPackedSidecars(
        { manifest: { profile: 'parser' }, sidecars: f.sidecars },
        {
          scratchRoot: f.root,
          onWorkspace: workspace => {
            allocated = workspace;
            return () => {
              released = true;
            };
          },
          startRegistry: async () => ({
            registryUrl: f.registryUrl,
            servedTarballs: f.served,
            isClosed: () => false,
            stop: async () => {
              throw new Error('registry remains live');
            },
          }),
          run: async () => {
            throw new Error('original install failure');
          },
        },
      ),
    error => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.errors[0].message, /original install failure/);
      assert.ok(error.errors.some(item => item.message.includes(allocated)));
      return true;
    },
  );
  assert.equal(fs.existsSync(allocated), true);
  assert.equal(released, false);
});
