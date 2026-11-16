// Consumer: publish-bleedingdev.yml qualify-source and prepare-release jobs.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const scriptPath = path.join(__dirname, '..', 'source-qualification.mjs');

// The helper is ESM; every sibling test in this directory is CommonJS because
// `pnpm test:scripts` globs `__tests__/*.test.js`.
const loadHelper = () => import(pathToFileURL(scriptPath).href);

const repository = 'BleedingDev/ultramodern.js';
const qualifiedCommit = 'a'.repeat(40);
const otherCommit = 'b'.repeat(40);

const withTempDir = async body => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-qualification-'));
  try {
    return await body(root);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
};

const writeReceipt = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const acceptedReceipt = () => ({
  schema: 'bleedingdev.ultramodern.source-qualification',
  schemaVersion: 1,
  source: { repository, commit: qualifiedCommit },
  runId: '77',
  runAttempt: '2',
  runIdentity: `github:${repository}:run:77:attempt:2`,
});

const verifyArgs = {
  receiptPath: '',
  repository,
  runAttempt: '2',
  runId: '77',
};

test('source registry accepts the compiler cohort npm publish envelope with a finite limit', async () => {
  const { createVerdaccioConfig } = await import(
    '../lib/source-create-proof/runtime-proof/registry.mjs'
  );
  const config = createVerdaccioConfig({
    storageDir: '/fixture/storage',
    htpasswdPath: '/fixture/htpasswd',
    scope: 'bleedingdev',
  });
  const limit = /^max_body_size: (\d+)mb$/m.exec(config);
  assert.ok(limit, 'source registry must retain a finite request limit');
  // Exact packed app-tools-extensions size from native run 43710636493.
  // npm PUT carries the tarball as Base64 plus package metadata.
  const compilerTarballBytes = 57_004_915;
  const encodedTarballBytes = 4 * Math.ceil(compilerTarballBytes / 3);
  const metadataHeadroom = 1024 * 1024;
  assert.ok(
    Number(limit[1]) * 1024 * 1024 >= encodedTarballBytes + metadataHeadroom,
    'the accepted compiler tarball must fit its npm publish envelope',
  );
});

test('a qualification receipt binds the qualified commit to its own run', async () => {
  const { createSourceQualification, sourceQualificationArtifactName } =
    await loadHelper();
  await withTempDir(async root => {
    const outPath = path.join(root, 'nested', 'source-qualification.json');
    const receipt = createSourceQualification({
      commit: qualifiedCommit,
      outPath,
      repository,
      runAttempt: '2',
      runId: '77',
    });

    assert.deepEqual(JSON.parse(fs.readFileSync(outPath, 'utf8')), receipt);
    assert.deepEqual(receipt.source, {
      repository,
      commit: qualifiedCommit,
    });
    assert.equal(
      receipt.runIdentity,
      'github:BleedingDev/ultramodern.js:run:77:attempt:2',
    );
    assert.equal(
      sourceQualificationArtifactName({ runAttempt: '2', runId: '77' }),
      'bleedingdev-source-qualification-run-77-attempt-2',
    );
  });
});

test('a qualification receipt cannot be minted for an unresolved source', async () => {
  const { createSourceQualification } = await loadHelper();
  await withTempDir(async root => {
    const outPath = path.join(root, 'source-qualification.json');
    for (const invalid of [
      { commit: 'HEAD' },
      { commit: qualifiedCommit.toUpperCase() },
      { repository: 'ultramodern.js' },
      { runId: '0' },
      { runAttempt: 'latest' },
    ]) {
      assert.throws(
        () =>
          createSourceQualification({
            commit: qualifiedCommit,
            outPath,
            repository,
            runAttempt: '2',
            runId: '77',
            ...invalid,
          }),
        /is not a valid/u,
      );
    }
    assert.equal(fs.existsSync(outPath), false);
  });
});

test('verification accepts only the recovered run own passing receipt', async () => {
  const { verifySourceQualification } = await loadHelper();
  await withTempDir(async root => {
    const receiptPath = path.join(root, 'source-qualification.json');
    writeReceipt(receiptPath, acceptedReceipt());

    assert.deepEqual(
      verifySourceQualification({ ...verifyArgs, receiptPath }),
      acceptedReceipt(),
    );
  });
});

test('an ancestral bundle cannot promote another commit qualification', async () => {
  const { verifySourceQualification } = await loadHelper();
  await withTempDir(async root => {
    const receiptPath = path.join(root, 'source-qualification.json');
    writeReceipt(receiptPath, acceptedReceipt());

    assert.throws(
      () =>
        verifySourceQualification({
          ...verifyArgs,
          expectedCommit: otherCommit,
          receiptPath,
        }),
      /was not qualified at its own source commit/u,
    );
  });
});

test('verification rejects a receipt from another run, attempt, or repository', async () => {
  const { verifySourceQualification } = await loadHelper();
  await withTempDir(async root => {
    const receiptPath = path.join(root, 'source-qualification.json');

    for (const forged of [
      { runId: '78', runIdentity: `github:${repository}:run:78:attempt:2` },
      { runAttempt: '1', runIdentity: `github:${repository}:run:77:attempt:1` },
      {
        source: { repository: 'BleedingDev/other', commit: qualifiedCommit },
        runIdentity: 'github:BleedingDev/other:run:77:attempt:2',
      },
      // Self-consistent fields, forged identity string: the receipt claims a
      // run that never qualified anything.
      { runIdentity: `github:${repository}:run:99:attempt:9` },
    ]) {
      writeReceipt(receiptPath, { ...acceptedReceipt(), ...forged });
      assert.throws(
        () => verifySourceQualification({ ...verifyArgs, receiptPath }),
        /was not produced by the recovered run/u,
      );
    }
  });
});

test('verification rejects a receipt that is not the strict schema', async () => {
  const { verifySourceQualification } = await loadHelper();
  await withTempDir(async root => {
    const receiptPath = path.join(root, 'source-qualification.json');

    writeReceipt(receiptPath, { ...acceptedReceipt(), extra: true });
    assert.throws(
      () => verifySourceQualification({ ...verifyArgs, receiptPath }),
      /strict receipt shape/u,
    );
  });
});

test('the CLI fails closed on an unknown command', async () => {
  await withTempDir(async root => {
    const receiptPath = path.join(root, 'source-qualification.json');
    writeReceipt(receiptPath, acceptedReceipt());

    const unknown = spawnSync(process.execPath, [scriptPath, 'promote'], {
      encoding: 'utf8',
    });
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /Unknown source qualification command/u);
  });
});

// Consumer: `pnpm ultramodern:source-create-proof` root release gate.
test('source-create-proof gate runs erp-10 source acceptance and refuses weaker modes', async () => {
  const entrypoint = await import(
    pathToFileURL(
      path.join(__dirname, '..', 'validate-source-create-proof.mjs'),
    ).href
  );
  const calls = [];
  const exitCode = await entrypoint.main([], {}, async argv => {
    calls.push(argv);
    return 0;
  });

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].join(' '), /--scale-profile erp-10/u);
  assert.ok(calls[0].includes(entrypoint.defaultManifestPath));
  assert.ok(calls[0].includes(entrypoint.defaultReceiptPath));

  for (const weaker of [['--verify-receipt'], ['--mode', 'published']]) {
    assert.throws(
      () => entrypoint.sourceCreateProofArgs(weaker, {}),
      /always executes source acceptance/u,
    );
  }
});

test('an optional acceptance store preserves release bindings in every mode', async () => {
  const { parseArgs } = await import(
    pathToFileURL(path.join(__dirname, '..', 'run-release-acceptance.mjs')).href
  );
  const manifest = path.resolve('release', 'manifest.json');
  const receipt = path.resolve('release', 'acceptance-receipt.json');
  const storeInput =
    path.join(path.parse(manifest).root, 'pnpm', 'cache') +
    `${path.sep}..${path.sep}store`;
  for (const mode of ['prepublish', 'published', 'verify']) {
    const argv = [
      '--mode',
      mode,
      '--manifest',
      manifest,
      '--receipt',
      receipt,
      '--expected-source-revision',
      qualifiedCommit,
      '--expected-version',
      '3.9.0-ultramodern.2026100301',
      '--run-identity',
      'local:renderer-C2-erp10-20261003',
      '--scale-profile',
      'erp-10',
      ...(mode === 'verify' ? ['--expected-mode', 'source'] : []),
      ...(mode === 'published'
        ? ['--source-receipt', path.resolve('release', 'source-receipt.json')]
        : []),
    ];
    const defaults = parseArgs(argv);
    assert.equal(defaults.storeDir, undefined);
    const withStore = parseArgs([...argv, '--store-dir', storeInput]);
    assert.equal(withStore.storeDir, path.resolve(storeInput));
    assert.deepEqual({ ...withStore, storeDir: undefined }, defaults);
    assert.equal(withStore.mode, mode);
    assert.equal(withStore.manifestPath, manifest);
    assert.equal(withStore.receiptPath, receipt);
    assert.equal(withStore.expectedSourceRevision, qualifiedCommit);
  }
});

test('acceptance rejects relative, empty, duplicate, and invalid store arguments', async () => {
  const { parseArgs } = await import(
    pathToFileURL(path.join(__dirname, '..', 'run-release-acceptance.mjs')).href
  );
  const base = [
    '--manifest',
    path.resolve('release', 'manifest.json'),
    '--receipt',
    path.resolve('release', 'acceptance-receipt.json'),
  ];
  for (const store of [
    'store',
    '../store',
    ' ',
    `${path.parse(process.cwd()).root}bad\0store`,
  ]) {
    assert.throws(
      () => parseArgs([...base, '--store-dir', store]),
      /must be an absolute path/u,
    );
  }
  for (const suffix of [
    ['--store-dir'],
    ['--store-dir', ''],
    ['--store-dir', '--mode'],
  ]) {
    assert.throws(() => parseArgs([...base, ...suffix]), /requires a value/u);
  }
  const store = path.resolve('store');
  assert.throws(
    () => parseArgs([...base, '--store-dir', store, '--store-dir', store]),
    /Duplicate argument/u,
  );
});

test('an optional prepublish work directory preserves release, run, scale, and store bindings', async () => {
  const { parseArgs } = await import(
    pathToFileURL(path.join(__dirname, '..', 'run-release-acceptance.mjs')).href
  );
  const manifest = path.resolve('release', 'manifest.json');
  const receipt = path.resolve('release', 'acceptance-receipt.json');
  const store = path.resolve('shared-pnpm-store');
  const workInput =
    path.join(path.parse(manifest).root, 'acceptance', 'previous') +
    `${path.sep}..${path.sep}retained`;
  const base = [
    '--manifest',
    manifest,
    '--receipt',
    receipt,
    '--expected-source-revision',
    qualifiedCommit,
    '--expected-version',
    '3.9.0-ultramodern.2026100301',
    '--run-identity',
    'local:renderer-C2-erp10-20261003',
    '--scale-profile',
    'erp-10',
    '--store-dir',
    store,
  ];
  for (const modeArgs of [[], ['--mode', 'prepublish']]) {
    const argv = [...base, ...modeArgs];
    const defaults = parseArgs(argv);
    assert.equal(defaults.workDir, undefined);
    const withWorkDir = parseArgs([...argv, '--work-dir', workInput]);
    assert.equal(withWorkDir.workDir, path.resolve(workInput));
    assert.deepEqual({ ...withWorkDir, workDir: undefined }, defaults);
    assert.equal(withWorkDir.mode, 'prepublish');
    assert.equal(withWorkDir.manifestPath, manifest);
    assert.equal(withWorkDir.receiptPath, receipt);
    assert.equal(withWorkDir.expectedSourceRevision, qualifiedCommit);
    assert.equal(withWorkDir.expectedVersion, '3.9.0-ultramodern.2026100301');
    assert.equal(withWorkDir.runIdentity, 'local:renderer-C2-erp10-20261003');
    assert.equal(withWorkDir.scaleProfile, 'erp-10');
    assert.equal(withWorkDir.storeDir, store);
  }
});

test('prepublish rejects relative, empty, duplicate, and invalid work directories', async () => {
  const { parseArgs } = await import(
    pathToFileURL(path.join(__dirname, '..', 'run-release-acceptance.mjs')).href
  );
  const base = [
    '--manifest',
    path.resolve('release', 'manifest.json'),
    '--receipt',
    path.resolve('release', 'acceptance-receipt.json'),
  ];
  for (const workDir of [
    'retained',
    '../retained',
    ' ',
    `${path.parse(process.cwd()).root}bad\0work-dir`,
  ]) {
    assert.throws(
      () => parseArgs([...base, '--work-dir', workDir]),
      /must be an absolute path/u,
    );
  }
  for (const suffix of [
    ['--work-dir'],
    ['--work-dir', ''],
    ['--work-dir', '--mode'],
  ]) {
    assert.throws(() => parseArgs([...base, ...suffix]), /requires a value/u);
  }
  const workDir = path.resolve('retained');
  assert.throws(
    () => parseArgs([...base, '--work-dir', workDir, '--work-dir', workDir]),
    /Duplicate argument/u,
  );
});

test('a caller-owned work directory is rejected for published and verify modes', async () => {
  const { parseArgs } = await import(
    pathToFileURL(path.join(__dirname, '..', 'run-release-acceptance.mjs')).href
  );
  const base = [
    '--manifest',
    path.resolve('release', 'manifest.json'),
    '--receipt',
    path.resolve('release', 'acceptance-receipt.json'),
    '--work-dir',
    path.resolve('retained'),
  ];
  for (const modeArgs of [
    [
      '--mode',
      'published',
      '--source-receipt',
      path.resolve('release', 'source-receipt.json'),
    ],
    ['--mode', 'verify'],
    ['--verify-receipt'],
  ]) {
    assert.throws(() => parseArgs([...base, ...modeArgs]), /prepublish/u);
  }
});

test('source-create-proof forwards the optional store without weakening ERP acceptance', async () => {
  const entrypoint = await import(
    pathToFileURL(
      path.join(__dirname, '..', 'validate-source-create-proof.mjs'),
    ).href
  );
  const acceptance = await import(
    pathToFileURL(path.join(__dirname, '..', 'run-release-acceptance.mjs')).href
  );
  const store = path.resolve('shared-pnpm-store');
  const manifest = path.resolve('release', 'manifest.json');
  const receipt = path.resolve('release', 'acceptance-receipt.json');
  const calls = [];
  const exitCode = await entrypoint.main(
    [
      '--',
      '--store-dir',
      store,
      '--manifest',
      manifest,
      '--receipt',
      receipt,
      '--expected-source-revision',
      qualifiedCommit,
      '--expected-version',
      '3.9.0-ultramodern.2026100301',
      '--run-identity',
      'local:renderer-C2-erp10-20261003',
    ],
    {},
    async argv => {
      calls.push(acceptance.parseArgs(argv));
      return 0;
    },
  );
  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].storeDir, store);
  assert.equal(calls[0].mode, 'prepublish');
  assert.equal(calls[0].scaleProfile, 'erp-10');
  assert.equal(calls[0].manifestPath, manifest);
  assert.equal(calls[0].receiptPath, receipt);
  assert.equal(calls[0].expectedSourceRevision, qualifiedCommit);
  assert.equal(calls[0].expectedVersion, '3.9.0-ultramodern.2026100301');
  assert.equal(calls[0].runIdentity, 'local:renderer-C2-erp10-20261003');
});

test('the source registry uses the same explicit external store for its integrity probe and dlx process', async () => {
  const { startEphemeralRegistry, VERDACCIO_INTEGRITY } = await import(
    '../lib/source-create-proof/runtime-proof/registry.mjs'
  );
  await withTempDir(async root => {
    const rootDir = path.join(root, 'registry');
    const storeDir = path.join(root, 'external-store');
    const calls = [];
    const stopped = new Error('stop before creating a registry child');
    await assert.rejects(
      startEphemeralRegistry({
        release: { targetScope: 'bleedingdev' },
        rootDir,
        storeDir,
        runImpl: (command, args, options) => {
          assert.equal(command, 'npm');
          assert.ok(args.includes('dist.integrity'));
          calls.push({ stage: 'integrity', env: options.env });
          return JSON.stringify(VERDACCIO_INTEGRITY);
        },
        leasePortImpl: async () => ({
          port: 12345,
          release: async () => 12345,
        }),
        spawnImpl: (command, args, options) => {
          assert.equal(command, 'pnpm');
          assert.equal(args[0], 'dlx');
          calls.push({ stage: 'dlx', env: options.env });
          throw stopped;
        },
      }),
      error => error === stopped,
    );
    assert.deepEqual(
      calls.map(call => call.stage),
      ['integrity', 'dlx'],
    );
    for (const { env } of calls) {
      assert.equal(env.npm_config_store_dir, storeDir);
      assert.equal(env.pnpm_config_store_dir, storeDir);
      assert.equal(env.npm_config_package_import_method, 'clone-or-copy');
      assert.equal(env.pnpm_config_package_import_method, 'clone-or-copy');
      assert.equal(env.npm_config_ignore_scripts, undefined);
      assert.equal(env.pnpm_config_ignore_scripts, undefined);
    }
  });
});

test('invalid source-registry stores fail before integrity, allocation, or child startup', async () => {
  const { startEphemeralRegistry } = await import(
    '../lib/source-create-proof/runtime-proof/registry.mjs'
  );
  await withTempDir(async rootDir => {
    const unexpected = () => {
      throw new Error('invalid stores must not start work');
    };
    for (const storeDir of [
      'relative-store',
      rootDir,
      path.join(rootDir, 'store'),
    ]) {
      await assert.rejects(
        startEphemeralRegistry({
          rootDir,
          storeDir,
          runImpl: unexpected,
          leasePortImpl: unexpected,
          spawnImpl: unexpected,
        }),
        /must be an absolute path|must be outside/u,
      );
    }
  });
});

function registryPhaseFixture(
  rootDir,
  { failSeed = false, failRestart = false } = {},
) {
  const { EventEmitter } = require('node:events');
  const events = [];
  const configs = [];
  const children = [];
  let seedVerified = false;
  const spawnImpl = () => {
    const phase = children.length;
    configs.push(fs.readFileSync(path.join(rootDir, 'verdaccio.yaml'), 'utf8'));
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = signal => {
      events.push(`stop:${phase}`);
      queueMicrotask(() => {
        child.signalCode = signal;
        child.emit('exit', null, signal);
      });
    };
    children.push(child);
    events.push(`start:${phase}`);
    if (phase === 1) {
      assert.equal(seedVerified, true);
      if (failRestart)
        queueMicrotask(() => child.emit('error', new Error('restart failed')));
    }
    return child;
  };
  const fetchImpl = async url => {
    if (String(url).includes('/-/user/')) {
      events.push('authenticate');
      return {
        ok: true,
        text: async () => JSON.stringify({ token: 'fixture-token' }),
      };
    }
    return { ok: true };
  };
  const publishReleaseTarballsImpl = async (release, registry, token) => {
    events.push('verify-seed');
    assert.equal(token, 'fixture-token');
    assert.equal(registry.registryUrl, 'http://127.0.0.1:12345/');
    const config = configs[0];
    const exactRule = config
      .split('"@bleedingdev/cohort":')[1]
      .split('"@bleedingdev/*":')[0];
    // Simulate npm already holding this exact version: a proxy during PUT conflicts.
    assert.equal(exactRule.includes('proxy:'), false);
    if (failSeed) throw new Error('seed integrity mismatch');
    seedVerified = true;
    fs.mkdirSync(path.join(rootDir, 'storage'), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, 'storage', 'accepted'),
      'verified artifact',
    );
    return [{ targetName: release.packages[0].targetName }];
  };
  return {
    events,
    configs,
    children,
    spawnImpl,
    fetchImpl,
    publishReleaseTarballsImpl,
  };
}

for (const failure of [undefined, 'seed', 'restart']) {
  test(`source registry isolates seed publication and restores consumer history${failure ? `; ${failure} failure stops the active child` : ''}`, async () => {
    const { startEphemeralRegistry, VERDACCIO_INTEGRITY } = await import(
      '../lib/source-create-proof/runtime-proof/registry.mjs'
    );
    await withTempDir(async rootDir => {
      const fixture = registryPhaseFixture(rootDir, {
        failSeed: failure === 'seed',
        failRestart: failure === 'restart',
      });
      const operation = startEphemeralRegistry({
        release: {
          targetScope: 'bleedingdev',
          packages: [{ targetName: '@bleedingdev/cohort', version: '1.0.0' }],
        },
        rootDir,
        runImpl: () => JSON.stringify(VERDACCIO_INTEGRITY),
        leasePortImpl: async () => ({
          port: 12345,
          release: async () => 12345,
        }),
        ...fixture,
      });
      if (failure) {
        await assert.rejects(
          operation,
          failure === 'seed' ? /seed integrity mismatch/ : /restart failed/,
        );
      } else {
        const registry = await operation;
        assert.deepEqual(fixture.events, [
          'start:0',
          'authenticate',
          'verify-seed',
          'stop:0',
          'start:1',
        ]);
        assert.equal(
          fs.readFileSync(path.join(rootDir, 'storage', 'accepted'), 'utf8'),
          'verified artifact',
        );
        assert.equal(
          fixture.configs[1].includes('"@bleedingdev/cohort":'),
          false,
        );
        assert.match(
          fixture.configs[1],
          /"@bleedingdev\/\*":\n {4}access: \$all\n {4}publish: \$authenticated\n {4}unpublish: \$authenticated\n {4}proxy: npmjs/,
        );
        const paths = config =>
          config
            .split('\n')
            .filter(
              line =>
                line.startsWith('storage:') || line.trim().startsWith('file:'),
            );
        assert.deepEqual(paths(fixture.configs[0]), paths(fixture.configs[1]));
        assert.equal(fixture.children[0].listenerCount('exit'), 0);
        await registry.stop();
      }
      assert.ok(
        fixture.children.every(child => child.signalCode === 'SIGTERM'),
      );
      assert.equal(fixture.children.length, failure === 'seed' ? 1 : 2);
    });
  });
}
