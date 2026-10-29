// Consumer: the publish-sidecars CLI and its registry decision helpers.
//
// Each case here guards an unrecoverable registry outcome: npm versions are
// immutable, so publishing different bytes over an existing sidecar version,
// or moving the `latest` alias the cohort resolves through, cannot be undone.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../../..');
const cohortAliasConsumer = '@bleedingdev/modern-js-image';
const stagedSidecarRoots = ['packages/sidecar/mf-cli'];

const importPublication = () =>
  import('../lib/prepare-bleedingdev-packages/sidecar-publication.mjs');
const importCli = () => import('../publish-sidecars.mjs');
const importSidecars = () =>
  import('../lib/prepare-bleedingdev-packages/sidecars.mjs');

const makeTempDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'modern-sidecar-lane-'));

// A committed sidecar package, so staging never fetches a recipe's upstream
// tarball from the registry.
const sidecarFixtureRoot = () => {
  const root = makeTempDir();
  const dir = path.join(root, stagedSidecarRoots[0]);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: '@bleedingdev/mf-cli',
        version: '2.9.2',
        license: 'MIT',
        bin: { mf: './bin/mf.js' },
        files: ['bin', 'dist'],
        publishConfig: {
          registry: 'https://registry.npmjs.org/',
          access: 'public',
        },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(dir, 'bin/mf.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(dir, 'dist/index.js'), 'module.exports = {};\n');
  return root;
};

// Stage a sidecar into a release-bundle shape the CLI reads.
const stageRelease = async () => {
  const {
    collectSidecarPackages,
    stageSidecarPackage,
    writeSidecarStagingManifest,
  } = await importSidecars();
  const releaseDir = makeTempDir();
  const stageDir = path.join(releaseDir, 'sidecars');
  fs.mkdirSync(stageDir, { recursive: true });
  const staged = await Promise.all(
    collectSidecarPackages(sidecarFixtureRoot(), {
      roots: stagedSidecarRoots,
    }).map(sidecar =>
      stageSidecarPackage(sidecar, stageDir, { repoRoot: releaseDir }),
    ),
  );
  const { descriptor } = writeSidecarStagingManifest(releaseDir, staged, {
    publishBefore: cohortAliasConsumer,
  });
  return { descriptor, releaseDir };
};

const acceptedSidecarRelease = async releaseDir => {
  const { inspectNpmTarball } = await import(
    '../lib/prepare-bleedingdev-packages/release-artifacts.mjs'
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(releaseDir, 'sidecars.json'), 'utf8'),
  );
  const packages = manifest.packages.map(entry => {
    const bytes = fs.readFileSync(path.join(releaseDir, entry.tarballPath));
    const inspection = inspectNpmTarball(bytes);
    return {
      ...entry,
      artifactPath: path.join(releaseDir, entry.tarballPath),
      bytes,
      packageJson: inspection.packageJson,
    };
  });
  return {
    manifest: {
      tools: { node: process.version, npm: '11.10.1', pnpm: '11.24.0' },
    },
    sidecars: { manifest, packages },
  };
};

const stagedMfCli = () => ({
  name: '@bleedingdev/mf-cli',
  version: '3.2.0',
  integrity: `sha512-${Buffer.from('accepted-ipx').toString('base64')}`,
  shasum: 'a'.repeat(40),
  packageJson: {
    name: '@bleedingdev/mf-cli',
    version: '3.2.0',
    description: 'sidecar fork',
    license: 'MIT',
    repository: 'unjs/ipx',
    publishConfig: {
      registry: 'https://registry.npmjs.org/',
      access: 'public',
    },
    main: './dist/index.cjs',
    module: './dist/index.mjs',
    types: './dist/index.d.ts',
    bin: { mf: './bin/mf.js' },
    files: ['dist', 'bin'],
    scripts: { verify: 'node ./scripts/verify.mjs' },
    dependencies: { sharp: '^0.35.3' },
  },
});

const packumentFor = (sidecar, { tag = '3.2.0', overrides = {} } = {}) => ({
  name: sidecar.name,
  'dist-tags': { latest: tag },
  versions: {
    [sidecar.version]: {
      name: sidecar.name,
      version: sidecar.version,
      // npm normalizes a string bin to object form and rewrites repository.
      bin: { mf: 'bin/mf.js' },
      main: './dist/index.cjs',
      module: './dist/index.mjs',
      types: './dist/index.d.ts',
      dependencies: { sharp: '^0.35.3' },
      repository: { type: 'git', url: 'git+https://github.com/unjs/ipx.git' },
      gitHead: 'a'.repeat(40),
      dist: {
        integrity: sidecar.integrity,
        shasum: sidecar.shasum,
        tarball: 'https://example.invalid/x.tgz',
      },
      _id: `${sidecar.name}@${sidecar.version}`,
      ...overrides,
    },
  },
});

test('an unpublished sidecar version is published; a byte-identical one is reused', async () => {
  const { sidecarRegistryDecision } = await importPublication();
  const sidecar = stagedMfCli();

  assert.deepEqual(
    (await sidecarRegistryDecision(sidecar, null)).action,
    'publish',
    'a package that has never been published must publish',
  );

  // The re-run case: the exact version exists and resolves identically.
  const reuse = await sidecarRegistryDecision(sidecar, packumentFor(sidecar));
  assert.equal(reuse.action, 'reuse');
  assert.equal(reuse.currentTag, '3.2.0');
  assert.match(reuse.reason, /accepted tarball bytes/u);
});

test('registry content, version, and dist-tag mismatches fail closed', async () => {
  const { sidecarRegistryDecision } = await importPublication();
  const sidecar = stagedMfCli();

  // Matching manifest fields are insufficient: registry reuse must bind the
  // exact accepted tarball bytes.
  await assert.rejects(
    () =>
      sidecarRegistryDecision(
        sidecar,
        packumentFor(sidecar, {
          overrides: {
            dist: {
              integrity: `sha512-${Buffer.from('different').toString('base64')}`,
              shasum: 'b'.repeat(40),
            },
          },
        }),
      ),
    /already published from different tarball bytes/u,
  );

  // Content drift on an immutable version: the published package is not the
  // one this run staged, and no re-run can fix it.
  await assert.rejects(
    () =>
      sidecarRegistryDecision(
        sidecar,
        packumentFor(sidecar, {
          overrides: { dependencies: { sharp: '^0.34.0' } },
        }),
      ),
    /already published with different content[\s\S]*dependencies: staged .*0\.35\.3.*registry .*0\.34\.0/u,
  );

  // The dist-tag must land on the version the cohort aliases.
  await assert.rejects(
    () =>
      sidecarRegistryDecision(sidecar, packumentFor(sidecar, { tag: '3.3.0' })),
    /dist-tag latest points at 3\.3\.0, expected the already-published 3\.2\.0/u,
  );

  // A backwards republish would make the cohort alias resolve to older bytes.
  await assert.rejects(
    () =>
      sidecarRegistryDecision(sidecar, {
        name: sidecar.name,
        'dist-tags': { latest: '3.4.0' },
        versions: { '3.4.0': { name: sidecar.name, version: '3.4.0' } },
      }),
    /must be greater than the current latest 3\.4\.0/u,
  );

  // Uncertain registry shapes are never read as "not published yet".
  await assert.rejects(
    () =>
      sidecarRegistryDecision(sidecar, { name: sidecar.name, versions: {} }),
    /invalid registry dist-tags/u,
  );
});

test('immutable sidecar verification rejects manifest and archive tampering', async () => {
  const { verifySidecarArtifacts } = await import(
    '../lib/prepare-bleedingdev-packages/release-artifacts.mjs'
  );
  const { descriptor, releaseDir } = await stageRelease();
  const manifestPath = path.join(releaseDir, descriptor.manifestPath);
  const tarballsDir = path.join(releaseDir, 'sidecar-tarballs');
  const manifestBytes = fs.readFileSync(manifestPath);
  const tarballs = new Map(
    fs
      .readdirSync(tarballsDir)
      .map(fileName => [
        fileName,
        fs.readFileSync(path.join(tarballsDir, fileName)),
      ]),
  );
  const sha256 = bytes =>
    crypto.createHash('sha256').update(bytes).digest('hex');
  const restore = () => {
    fs.writeFileSync(manifestPath, manifestBytes);
    fs.rmSync(tarballsDir, { force: true, recursive: true });
    fs.mkdirSync(tarballsDir);
    for (const [fileName, bytes] of tarballs) {
      fs.writeFileSync(path.join(tarballsDir, fileName), bytes);
    }
  };

  try {
    assert.doesNotThrow(() => verifySidecarArtifacts(releaseDir, descriptor));

    fs.appendFileSync(manifestPath, ' ');
    assert.throws(
      () => verifySidecarArtifacts(releaseDir, descriptor),
      /Sidecar manifest SHA-256 mismatch/u,
    );
    restore();

    const [firstTarball] = tarballs.keys();
    fs.appendFileSync(path.join(tarballsDir, firstTarball), 'tampered');
    assert.throws(
      () => verifySidecarArtifacts(releaseDir, descriptor),
      /sidecar tarball size mismatch/u,
    );
    restore();

    fs.writeFileSync(path.join(tarballsDir, 'unexpected.tgz'), 'unexpected');
    assert.throws(
      () => verifySidecarArtifacts(releaseDir, descriptor),
      /Sidecar tarball set does not match the accepted release identity/u,
    );
    restore();

    // A re-signed manifest still cannot claim bytes the tarball does not hold.
    const identityDrift = JSON.parse(manifestBytes);
    identityDrift.packages[0].version = '9.9.9';
    const identityDriftBytes = Buffer.from(
      `${JSON.stringify(identityDrift, null, 2)}\n`,
    );
    fs.writeFileSync(manifestPath, identityDriftBytes);
    assert.throws(
      () =>
        verifySidecarArtifacts(releaseDir, {
          ...descriptor,
          sha256: sha256(identityDriftBytes),
        }),
      /sidecar tarball contains/u,
    );
  } finally {
    fs.rmSync(releaseDir, { force: true, recursive: true });
  }
});

test('the CLI reads the staged lane from the release bundle and fails closed on drift', async t => {
  const { readStagedSidecars } = await importCli();
  const { releaseDir } = await stageRelease();
  t.after(() => fs.rmSync(releaseDir, { recursive: true, force: true }));
  const accepted = await acceptedSidecarRelease(releaseDir);

  const read = readStagedSidecars(releaseDir, {
    verifyRelease: () => accepted,
  });
  assert.deepEqual(
    read.sidecars.map(item => item.name),
    read.manifest.publishOrder,
  );
  assert.ok(read.sidecars.every(item => Buffer.isBuffer(item.bytes)));

  const tampered = {
    ...accepted,
    sidecars: {
      ...accepted.sidecars,
      packages: accepted.sidecars.packages.map(item =>
        item.name === '@bleedingdev/mf-cli'
          ? {
              ...item,
              packageJson: { ...item.packageJson, version: '999.0.0' },
            }
          : item,
      ),
    },
  };
  assert.throws(
    () =>
      readStagedSidecars(releaseDir, {
        verifyRelease: () => tampered,
      }),
    /Accepted sidecar @bleedingdev\/mf-cli@[\d.]+ contains @bleedingdev\/mf-cli@999\.0\.0/u,
  );

  assert.throws(
    () =>
      readStagedSidecars(releaseDir, {
        verifyRelease: () => ({ ...accepted, sidecars: null }),
      }),
    /Missing accepted sidecars\.json/u,
  );
});

// ---------------------------------------------------------------------------
// Post-publish propagation: only a registry that has not caught up is retried
// ---------------------------------------------------------------------------

const untaggedPackument = sidecar => ({
  ...packumentFor(sidecar),
  'dist-tags': {},
});

const stubReads = reads => {
  const queue = [...reads];
  return async () => (queue.length > 1 ? queue.shift() : queue[0]);
};

test('a missing dist-tag and an unindexed version are retried until they settle', async () => {
  const {
    awaitPublishedSidecar,
    classifySidecarPropagation,
    propagationPendingStates,
  } = await importCli();
  const sidecar = stagedMfCli();
  const waits = [];

  // Exactly the sequence a fresh publish walks through: the packument is not
  // readable, then the version is readable but untagged, then both are there.
  const decision = await awaitPublishedSidecar(
    sidecar,
    { tag: 'latest' },
    {
      readPackument: stubReads([
        null,
        untaggedPackument(sidecar),
        packumentFor(sidecar),
      ]),
      wait: async ms => {
        waits.push(ms);
      },
    },
  );
  assert.equal(decision.action, 'reuse');
  assert.equal(decision.currentTag, '3.2.0');
  assert.ok(waits.length > 0, 'each pending read must wait');

  assert.equal(
    (
      await classifySidecarPropagation(sidecar, untaggedPackument(sidecar), {
        tag: 'latest',
      })
    ).state,
    propagationPendingStates.tagAbsent,
  );
  // Settled: both the version and the tag are readable, so the decision is
  // final and there is nothing left to wait for.
  assert.equal(
    await classifySidecarPropagation(sidecar, packumentFor(sidecar), {
      tag: 'latest',
    }),
    null,
  );
});

// Run 36137116871: @bleedingdev/rsbuild-image-core@0.1.4 published, stayed
// absent from the packument past the lane's 90s window, and became readable a
// few minutes later. The lane now waits on the shared post-publish schedule.
const priorReleaseOnly = sidecar => {
  const prior = packumentFor(sidecar).versions[sidecar.version];
  return {
    name: sidecar.name,
    'dist-tags': { latest: '3.1.0' },
    versions: {
      '3.1.0': {
        ...prior,
        version: '3.1.0',
        _id: `${sidecar.name}@3.1.0`,
        dist: {
          ...prior.dist,
          integrity: `sha512-${Buffer.from('prior-ipx').toString('base64')}`,
          shasum: 'b'.repeat(40),
        },
      },
    },
  };
};

test('a published version absent for minutes is still verified by exact integrity', async () => {
  const { awaitPublishedSidecar } = await importCli();
  const { registryPropagationDelaysMs } = await import(
    '../lib/prepare-bleedingdev-packages/registry-propagation.mjs'
  );
  const sidecar = stagedMfCli();
  const waits = [];
  let waitedMs = 0;
  // The version stays absent until more than five minutes of waiting have
  // passed, then appears byte-identical and tagged.
  const decision = await awaitPublishedSidecar(
    sidecar,
    { tag: 'latest' },
    {
      readPackument: async () =>
        waitedMs > 300_000 ? packumentFor(sidecar) : priorReleaseOnly(sidecar),
      wait: async ms => {
        waits.push(ms);
        waitedMs += ms;
      },
    },
  );
  assert.equal(decision.action, 'reuse');
  assert.equal(decision.currentTag, '3.2.0');
  assert.deepEqual(waits, registryPropagationDelaysMs.slice(0, waits.length));

  // Propagation that finally surfaces different bytes is terminal, not a pass.
  waitedMs = 0;
  await assert.rejects(
    awaitPublishedSidecar(
      sidecar,
      { tag: 'latest' },
      {
        readPackument: async () =>
          waitedMs > 300_000
            ? packumentFor({
                ...sidecar,
                integrity: `sha512-${Buffer.from('drift').toString('base64')}`,
              })
            : priorReleaseOnly(sidecar),
        wait: async ms => {
          waitedMs += ms;
        },
      },
    ),
    /integrity/u,
  );
});

test('a sidecar that never propagates fails after the whole shared schedule', async () => {
  const { awaitPublishedSidecar } = await importCli();
  const { registryPropagationDelaysMs } = await import(
    '../lib/prepare-bleedingdev-packages/registry-propagation.mjs'
  );
  const sidecar = stagedMfCli();
  const waits = [];
  await assert.rejects(
    awaitPublishedSidecar(
      sidecar,
      { tag: 'latest' },
      {
        readPackument: async () => priorReleaseOnly(sidecar),
        wait: async ms => {
          waits.push(ms);
        },
      },
    ),
    new RegExp(
      `did not become verifiable after ${registryPropagationDelaysMs.length + 1} registry reads: @bleedingdev/mf-cli@3\\.2\\.0 is still absent from the registry`,
      'u',
    ),
  );
  assert.deepEqual(waits, [...registryPropagationDelaysMs]);
});

const withTrustedPublishEnv = t => {
  const trustedEnv = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY_ID: '1151231350',
    GITHUB_REF: 'refs/heads/main-ultramodern',
    GITHUB_REPOSITORY: 'BleedingDev/ultramodern.js',
    GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '2',
  };
  const savedEnv = Object.fromEntries(
    Object.keys(trustedEnv).map(key => [key, process.env[key]]),
  );
  Object.assign(process.env, trustedEnv);
  t.after(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
};

const namedSidecar = (name, dependencies = { sharp: '^0.35.3' }) => {
  const base = stagedMfCli();
  return {
    ...base,
    name,
    packageJson: { ...base.packageJson, name, dependencies },
  };
};

const publishedPackumentFor = (sidecar, overrides = {}) =>
  packumentFor(sidecar, {
    overrides: {
      bin: sidecar.packageJson.bin,
      dependencies: sidecar.packageJson.dependencies,
      dist: {
        ...packumentFor(sidecar).versions[sidecar.version].dist,
        attestations: { provenance: {} },
      },
      ...overrides,
    },
  });

const sidecarLaneDependencies = ({
  sidecars,
  readPackument,
  onPublish,
  requestToken = async () => 'oidc-token',
}) => ({
  loadRuntime: () => ({
    npmVersion: '11.10.1',
    publish: async packageJson => onPublish(packageJson.name),
  }),
  readPackument,
  verifyFreshTarball: async () => {},
  verifyFreshProvenance: async () => {},
  verifyReuse: async () => {},
  readSidecars: () => ({
    manifest: { publishBefore: '@bleedingdev/modern-js-image' },
    release: {
      manifest: {
        source: {
          repository: 'BleedingDev/ultramodern.js',
          commit: 'a'.repeat(40),
        },
        tools: { node: process.version, npm: '11.10.1', pnpm: '11.24.0' },
      },
    },
    sidecars,
  }),
  requestToken,
  wait: async () => {},
});

const publishOptions = {
  checkStaging: false,
  dryRun: false,
  out: '/unused',
  tag: 'latest',
};

test('sidecars publish in alias order while their propagation waits overlap', async t => {
  const { publishSidecars } = await importCli();
  withTrustedPublishEnv(t);
  const first = namedSidecar('@bleedingdev/ipx-first');
  const independent = namedSidecar('@bleedingdev/ipx-independent');
  const aliasing = namedSidecar('@bleedingdev/ipx-aliasing', {
    sharp: '^0.35.3',
    ipx: 'npm:@bleedingdev/ipx-first@3.2.0',
  });
  const sidecars = [first, independent, aliasing];
  const byName = new Map(sidecars.map(sidecar => [sidecar.name, sidecar]));

  const events = [];
  const publishedNames = new Set();
  const verified = new Set();
  let releaseFirst;
  const firstMayPropagate = new Promise(resolve => {
    releaseFirst = resolve;
  });
  const result = await publishSidecars(
    publishOptions,
    sidecarLaneDependencies({
      sidecars,
      // The first sidecar only becomes readable once the last one has
      // published: a lane that waited per sidecar, or per alias level, would
      // never get there.
      readPackument: async name => {
        const sidecar = byName.get(name);
        if (!publishedNames.has(name)) return priorReleaseOnly(sidecar);
        if (name === first.name) await firstMayPropagate;
        verified.add(name);
        return publishedPackumentFor(sidecar);
      },
      onPublish: name => {
        events.push(`publish ${name}`);
        publishedNames.add(name);
        if (name === aliasing.name) releaseFirst();
      },
    }),
  );
  assert.deepEqual(
    events,
    sidecars.map(sidecar => `publish ${sidecar.name}`),
    'alias targets still publish before the sidecars that alias them',
  );
  assert.deepEqual(
    result.published,
    sidecars.map(sidecar => `${sidecar.name}@3.2.0`),
  );
  assert.deepEqual(
    [...verified].sort(),
    sidecars.map(sidecar => sidecar.name).sort(),
    'the lane resolves only after every published sidecar verified',
  );
});

const nextMacrotask = () => new Promise(resolve => setImmediate(resolve));

for (const settlesDuring of ['registry read', 'token exchange']) {
  test(`a verification failing during the next ${settlesDuring} stops that publish`, async t => {
    const { publishSidecars } = await importCli();
    withTrustedPublishEnv(t);
    const first = namedSidecar('@bleedingdev/ipx-first');
    const second = namedSidecar('@bleedingdev/ipx-second');
    const sidecars = [first, second];
    const byName = new Map(sidecars.map(sidecar => [sidecar.name, sidecar]));
    const publishedNames = [];
    await assert.rejects(
      publishSidecars(
        publishOptions,
        sidecarLaneDependencies({
          sidecars,
          readPackument: async name => {
            const sidecar = byName.get(name);
            if (!publishedNames.includes(name)) {
              // Real registry reads take I/O time, during which the first
              // sidecar's verification can settle.
              if (settlesDuring === 'registry read') await nextMacrotask();
              return priorReleaseOnly(sidecar);
            }
            // The first sidecar surfaces with different bytes: terminal.
            return publishedPackumentFor(sidecar, {
              dist: {
                integrity: `sha512-${Buffer.from('drift').toString('base64')}`,
                shasum: sidecar.shasum,
                tarball: 'https://example.invalid/x.tgz',
              },
            });
          },
          onPublish: name => {
            publishedNames.push(name);
          },
          requestToken: async () => {
            if (settlesDuring === 'token exchange') await nextMacrotask();
            return 'oidc-token';
          },
        }),
      ),
      /integrity/u,
    );
    assert.deepEqual(publishedNames, [first.name]);
  });
}

test('a dist-tag on a different real version is terminal, never retried', async () => {
  const { awaitPublishedSidecar, classifySidecarPropagation } =
    await importCli();
  const sidecar = stagedMfCli();
  const waits = [];
  const wait = async ms => {
    waits.push(ms);
  };

  // This is the regression: the message for this state names the missing tag,
  // and message-matching retried it. The tag points at a real, different
  // version - waiting cannot move it, so it must fail immediately.
  const elsewhere = packumentFor(sidecar, { tag: '3.3.0' });
  assert.equal(
    await classifySidecarPropagation(sidecar, elsewhere, { tag: 'latest' }),
    null,
    'a tag pointing at another version is settled, not pending',
  );
  await assert.rejects(
    awaitPublishedSidecar(
      sidecar,
      { tag: 'latest' },
      { readPackument: stubReads([elsewhere]), wait },
    ),
    /dist-tag latest points at 3\.3\.0, expected the already-published 3\.2\.0/u,
  );

  // Content drift hiding behind a missing dist-tag is still terminal: the
  // classifier proves the published bytes match before it reports "pending".
  const driftedUntagged = {
    ...packumentFor(sidecar, {
      overrides: { dependencies: { sharp: '^0.34.0' } },
    }),
    'dist-tags': {},
  };
  await assert.rejects(
    awaitPublishedSidecar(
      sidecar,
      { tag: 'latest' },
      { readPackument: stubReads([driftedUntagged]), wait },
    ),
    /already published with different content/u,
  );
  assert.deepEqual(waits, [], 'no terminal state may sleep');
});

test('the trusted-publishing lane refuses to bootstrap a package npm cannot create', async t => {
  const { publishSidecars } = await importCli();
  const { releaseDir } = await stageRelease();
  t.after(() => fs.rmSync(releaseDir, { recursive: true, force: true }));
  const accepted = await acceptedSidecarRelease(releaseDir);
  const unavailable = {
    readPackument: async () => null,
    readSidecars: () => ({
      manifest: accepted.sidecars.manifest,
      release: accepted,
      sidecars: accepted.sidecars.packages,
    }),
    wait: async () => {},
  };

  const options = {
    checkStaging: false,
    dryRun: false,
    out: releaseDir,
    tag: 'latest',
  };
  // npm trusted publishing publishes to an EXISTING package with a configured
  // trusted publisher; the OIDC exchange cannot create a package name. An
  // unattended lane must say so rather than fail deep inside npm.
  await assert.rejects(
    publishSidecars(options, unavailable),
    /does not exist on the registry after the bounded propagation wait[\s\S]*Bootstrap @bleedingdev\/[a-z-]+ interactively once, with explicit authorization, as a deprecated 0\.0\.0-bootstrap placeholder/u,
  );

  // Dry-run models the same trusted-publishing capability and must not claim a
  // package can be created when OIDC cannot bootstrap its name.
  await assert.rejects(
    publishSidecars({ ...options, dryRun: true }, unavailable),
    /fails closed in both dry-run and publication modes/u,
  );
});

test('--check-registry fails on a missing sidecar name before any bundle exists', async () => {
  const { checkSidecarRegistry, parseArgs } = await importCli();
  assert.equal(parseArgs(['--check-registry']).checkRegistry, true);
  assert.throws(
    () => parseArgs(['--check-registry', '--dry-run']),
    /mutually exclusive/u,
  );

  const reads = [];
  const recipes = () => [
    { name: '@bleedingdev/mf-cli', version: '3.2.2' },
    { name: '@bleedingdev/new-sidecar', version: '1.0.0' },
  ];
  const started = performance.now();
  // A null packument is the registry's 404: the name was never bootstrapped.
  // No propagation wait applies, so the gate answers on the first read.
  await assert.rejects(
    checkSidecarRegistry({
      readPackument: async name => {
        reads.push(name);
        return name === '@bleedingdev/mf-cli' ? { name } : null;
      },
      readRecipes: recipes,
    }),
    error =>
      /^@bleedingdev\/new-sidecar does not exist on the registry, so the trusted-publishing lane cannot create it\.$/mu.test(
        error.message,
      ) &&
      /Bootstrap @bleedingdev\/new-sidecar interactively once, with explicit authorization, as a deprecated 0\.0\.0-bootstrap placeholder/u.test(
        error.message,
      ) &&
      !error.message.includes('@bleedingdev/mf-cli'),
  );
  assert.ok(performance.now() - started < 1000);
  assert.deepEqual(reads, ['@bleedingdev/mf-cli', '@bleedingdev/new-sidecar']);

  // The default recipe source is the committed sidecars.json.
  const checked = [];
  const result = await checkSidecarRegistry({
    readPackument: async name => {
      checked.push(name);
      return { name };
    },
  });
  const committed = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, 'scripts/ultramodern-supply/sidecars.json'),
      'utf8',
    ),
  ).map(recipe => recipe.fork.name);
  assert.deepEqual(result.checked, committed);
  assert.deepEqual(checked, committed);
});

test('bundle-free sidecar registry checks read only their closed profile', async () => {
  const { checkSidecarRegistry, parseArgs } = await importCli();
  const parserNames = [
    '@bleedingdev/braces',
    '@bleedingdev/fast-glob',
    '@bleedingdev/find-workspaces',
    '@bleedingdev/micromatch',
    '@bleedingdev/rsbuild-plugin-source-build',
    '@bleedingdev/ultracite',
  ];
  for (const [profile, expected] of [
    ['mf-sdk', ['@bleedingdev/mf-sdk']],
    ['tanstack-redact', ['@bleedingdev/tanstack-redact']],
    ['parser', parserNames],
  ]) {
    const options = parseArgs([
      '--mode',
      'sidecars',
      '--profile',
      profile,
      '--check-registry',
    ]);
    const reads = [];
    const result = await checkSidecarRegistry(
      {
        readPackument: async name => {
          reads.push(name);
          // Every name outside this profile is uncreated on the registry.
          return expected.includes(name) ? { name } : null;
        },
        readRecipes: () => {
          throw new Error('Profile preflight must validate producer inputs');
        },
      },
      options,
    );
    assert.deepEqual(reads, expected);
    assert.deepEqual(result.checked, expected);
  }
});

test('registry preflight rejects mixed CLI inputs before output resolution', async () => {
  const { parseArgs } = await importCli();
  const preflight = [
    '--mode',
    'sidecars',
    '--profile',
    'mf-sdk',
    '--check-registry',
  ];
  assert.throws(
    () => parseArgs(['--mode', 'sidecars', '--check-registry']),
    /requires --profile/u,
  );
  assert.throws(
    () =>
      parseArgs([
        '--mode',
        'sidecars',
        '--profile',
        'other',
        '--check-registry',
      ]),
    /Unknown sidecar profile/u,
  );
  for (const [option, value] of [
    ['--out', '/outside-owned-output'],
    ['--qualification', '/outside-owned-receipt'],
    ['--tag', 'latest'],
  ])
    assert.throws(
      () => parseArgs([...preflight, option, value]),
      /--check-registry is bundle-free/u,
    );
  for (const argv of [
    ['--check-registry', '--profile', 'mf-sdk'],
    ['--mode', 'sidecars', '--profile', 'mf-sdk'],
    ['--mode', 'sidecars', '--profile', 'parser', '--check-staging'],
    [
      '--mode',
      'sidecars',
      '--profile',
      'mf-sdk',
      '--qualification',
      path.join(repoRoot, '.modern/bleedingdev-sidecars/qualification.json'),
      '--dry-run',
    ],
  ])
    assert.throws(
      () => parseArgs(argv),
      /--profile requires --mode sidecars --check-registry/u,
    );
  assert.throws(() => parseArgs(['--mode', 'sidecars']), /--qualification/u);
});

test('SDK registry preflight rejects recipe drift before any network read', async t => {
  const { checkSidecarRegistry } = await importCli();
  const recipesPath = path.join(
    repoRoot,
    'scripts/ultramodern-supply/sidecars.json',
  );
  const recipes = JSON.parse(fs.readFileSync(recipesPath, 'utf8'));
  const originalRead = fs.readFileSync;
  let selectedRecipes = recipes;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    const filePath =
      file instanceof URL ? require('node:url').fileURLToPath(file) : file;
    if (filePath === recipesPath) return JSON.stringify(selectedRecipes);
    return originalRead.call(fs, file, ...args);
  });
  let reads = 0;
  const dependencies = {
    readPackument: async () => {
      reads += 1;
      throw new Error('Invalid profile reached the network');
    },
  };
  for (const [mutate, expected] of [
    [
      values =>
        values.map(recipe =>
          recipe.id === 'mf-sdk'
            ? {
                ...recipe,
                fork: { ...recipe.fork, name: '@bleedingdev/other-sdk' },
              }
            : recipe,
        ),
      /dependencies differ from the closed profile/u,
    ],
    [
      values =>
        values.map(recipe =>
          recipe.id === 'mf-sdk'
            ? { ...recipe, fork: { ...recipe.fork, version: '2.9.3' } }
            : recipe,
        ),
      /dependencies differ from the closed profile/u,
    ],
    [
      values => values.filter(recipe => recipe.id !== 'mf-sdk'),
      /Expected exactly one reviewed sidecar recipe mf-sdk/u,
    ],
  ]) {
    selectedRecipes = mutate(structuredClone(recipes));
    await assert.rejects(
      checkSidecarRegistry(dependencies, {
        mode: 'sidecars',
        profile: 'mf-sdk',
      }),
      expected,
    );
    assert.equal(reads, 0);
  }
  for (const profile of [undefined, 'other']) {
    await assert.rejects(
      checkSidecarRegistry(dependencies, { mode: 'sidecars', profile }),
      /requires --profile|Unknown sidecar profile/u,
    );
    assert.equal(reads, 0);
  }
});

test('the packed-consumer proof publishes to loopback registries only', async () => {
  const { assertLocalRegistry } = await import(
    '../verify-sidecar-consumer.mjs'
  );

  assert.equal(
    assertLocalRegistry('http://127.0.0.1:4873').href,
    'http://127.0.0.1:4873/',
  );
  assert.throws(
    () => assertLocalRegistry('https://registry.npmjs.org/'),
    /Refusing to run the packed-consumer proof against the public registry/u,
  );
  assert.throws(
    () => assertLocalRegistry('https://npm.example.com/'),
    /is not a loopback address/u,
  );
});

// ---------------------------------------------------------------------------
// Reuse provenance: matching bytes are not enough to reuse a published version
// ---------------------------------------------------------------------------

const releaseSource = {
  commit: 'c'.repeat(40),
  repository: 'BleedingDev/ultramodern.js',
};
const slsaProvenanceV1 = 'https://slsa.dev/provenance/v1';

const chronologyPackument = (sidecar, { attested = false } = {}) => {
  const packument = packumentFor(sidecar);
  const publishedAt = '2026-09-25T11:17:45.181Z';
  if (attested) {
    packument.versions[sidecar.version].dist.attestations = {
      provenance: { predicateType: slsaProvenanceV1 },
      url: 'https://registry.npmjs.org/-/npm/v1/attestations/fixture',
    };
  }
  return {
    ...packument,
    time: {
      created: publishedAt,
      modified: publishedAt,
      [sidecar.version]: publishedAt,
    },
  };
};

const grandfatheredPolicy = (sidecar, overrides = {}) => ({
  grandfatheredVersions: [
    {
      version: sidecar.version,
      publishedAt: '2026-09-25T11:17:45.181Z',
      integrity: sidecar.integrity,
      ...overrides,
    },
  ],
});

// A signed statement for `repository`; the bundle signature itself is stubbed.
const attestationFetch = (sidecar, repository) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    attestations: [
      {
        predicateType: slsaProvenanceV1,
        bundle: {
          dsseEnvelope: {
            payloadType: 'application/vnd.in-toto+json',
            payload: Buffer.from(
              JSON.stringify({
                _type: 'https://in-toto.io/Statement/v1',
                predicateType: slsaProvenanceV1,
                subject: [
                  {
                    name: `pkg:npm/%40bleedingdev/mf-cli@${sidecar.version}`,
                    digest: {
                      sha512: Buffer.from(
                        sidecar.integrity.slice('sha512-'.length),
                        'base64',
                      ).toString('hex'),
                    },
                  },
                ],
                predicate: {
                  buildDefinition: {
                    buildType:
                      'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
                    externalParameters: {
                      workflow: {
                        path: '.github/workflows/publish-bleedingdev.yml',
                        ref: 'refs/heads/main-ultramodern',
                        repository: `https://github.com/${repository}`,
                      },
                    },
                    resolvedDependencies: [
                      {
                        uri: `git+https://github.com/${repository}@refs/heads/main-ultramodern`,
                        digest: { gitCommit: 'd'.repeat(40) },
                      },
                    ],
                  },
                },
              }),
            ).toString('base64'),
            signatures: [{ keyid: '', sig: 'fixture-signature' }],
          },
          verificationMaterial: {},
        },
      },
    ],
  }),
});

const acceptingBundleVerifier = async (_bundle, expectation) => ({
  certificateIdentity: expectation.certificateIdentity,
  issuer: expectation.issuer,
  verifierVersion: 'fixture-sigstore',
});

test('a byte-identical reuse without attestations that is not grandfathered fails closed', async () => {
  const { assertSidecarReuseProvenance } = await importPublication();
  const sidecar = stagedMfCli();
  await assert.rejects(
    assertSidecarReuseProvenance(sidecar, chronologyPackument(sidecar), {
      env: {},
      policy: { grandfatheredVersions: [] },
      source: releaseSource,
    }),
    /@bleedingdev\/mf-cli@3\.2\.0 is missing SLSA v1 provenance and is not a grandfathered version/u,
  );
});

test('a reuse grandfathered by exact version and integrity passes; any other integrity fails', async () => {
  const { assertSidecarReuseProvenance } = await importPublication();
  const sidecar = stagedMfCli();
  await assertSidecarReuseProvenance(sidecar, chronologyPackument(sidecar), {
    env: {},
    policy: grandfatheredPolicy(sidecar),
    source: releaseSource,
  });
  await assert.rejects(
    assertSidecarReuseProvenance(sidecar, chronologyPackument(sidecar), {
      env: {},
      policy: grandfatheredPolicy(sidecar, {
        integrity: `sha512-${Buffer.from('other').toString('base64')}`,
      }),
      source: releaseSource,
    }),
    /grandfathered version integrity does not match/u,
  );
});

test('reuse accepts this repository publish workflow provenance and rejects another repository', async () => {
  const { assertSidecarReuseProvenance } = await importPublication();
  const sidecar = {
    ...stagedMfCli(),
    integrity: `sha512-${crypto
      .createHash('sha512')
      .update('accepted-ipx')
      .digest('base64')}`,
  };
  const reuse = repository =>
    assertSidecarReuseProvenance(
      sidecar,
      chronologyPackument(sidecar, { attested: true }),
      { env: {}, policy: { grandfatheredVersions: [] }, source: releaseSource },
      {
        bundleVerifier: acceptingBundleVerifier,
        fetchImpl: attestationFetch(sidecar, repository),
      },
    );
  await reuse('BleedingDev/ultramodern.js');
  await assert.rejects(
    reuse('attacker/ultramodern.js'),
    /SLSA provenance must identify the accepted source repository exactly once/u,
  );
});

test('the cohort gate and sidecar reuse share one chronology verifier', async () => {
  const { assertSidecarReuseProvenance } = await importPublication();
  const { assertRegistrySourceCommitUnpublished } = await import(
    '../lib/prepare-bleedingdev-packages/registry.mjs'
  );
  const cohortName = '@bleedingdev/modern-js-ultramodern-create';
  const cohort = { ...stagedMfCli(), name: cohortName };
  const packument = chronologyPackument(cohort);
  packument.versions[cohort.version].name = cohortName;
  const missing =
    /3\.2\.0 is missing SLSA v1 provenance; this identity requires provenance from its first published version/u;
  await assert.rejects(
    assertRegistrySourceCommitUnpublished(
      {
        env: {},
        packageName: cohortName,
        requestedVersion: '3.2.1',
        sourceCommit: releaseSource.commit,
        sourceRepository: releaseSource.repository,
      },
      { fetchImpl: async () => ({ ok: true, json: async () => packument }) },
    ),
    missing,
  );
  await assert.rejects(
    assertSidecarReuseProvenance(cohort, packument, {
      env: {},
      policy: { provenanceRequiredFromFirstVersion: true },
      source: releaseSource,
    }),
    missing,
  );
});

test('publishSidecars verifies provenance before reusing a published version', async t => {
  const { publishSidecars } = await importCli();
  withTrustedPublishEnv(t);
  const sidecar = stagedMfCli();
  const verified = [];
  const dependencies = sidecarLaneDependencies({
    sidecars: [sidecar],
    readPackument: async () => packumentFor(sidecar),
    onPublish: () => assert.fail('a reusable version must not republish'),
  });
  dependencies.readSidecars = () => ({
    manifest: { publishBefore: '@bleedingdev/modern-js-image' },
    release: { manifest: { source: releaseSource, tools: {} } },
    sidecars: [sidecar],
  });
  dependencies.verifyReuse = async (candidate, _packument, { source }) => {
    verified.push([candidate.name, source]);
  };
  const result = await publishSidecars(publishOptions, dependencies);
  assert.deepEqual(result.reused, ['@bleedingdev/mf-cli@3.2.0']);
  assert.deepEqual(verified, [
    ['@bleedingdev/mf-cli', releaseSource],
    ['@bleedingdev/mf-cli', releaseSource],
  ]);

  dependencies.verifyReuse = async () => {
    throw new Error('not grandfathered');
  };
  await assert.rejects(
    publishSidecars(publishOptions, dependencies),
    /not grandfathered/u,
  );
});

test('a reuse resumed while npm indexes the tag still verifies provenance on the settled read', async t => {
  const { publishSidecars } = await importCli();
  withTrustedPublishEnv(t);
  const sidecar = stagedMfCli();
  const settled = packumentFor(sidecar);
  const verified = [];
  const dependencies = sidecarLaneDependencies({
    sidecars: [sidecar],
    readPackument: stubReads([untaggedPackument(sidecar), settled]),
    onPublish: () => assert.fail('a resumable version must not republish'),
  });
  dependencies.readSidecars = () => ({
    manifest: { publishBefore: '@bleedingdev/modern-js-image' },
    release: { manifest: { source: releaseSource, tools: {} } },
    sidecars: [sidecar],
  });
  dependencies.verifyReuse = async (_candidate, packument) => {
    verified.push(packument);
  };
  const result = await publishSidecars(publishOptions, dependencies);
  assert.deepEqual(result.reused, ['@bleedingdev/mf-cli@3.2.0']);
  assert.deepEqual(verified, [settled, settled]);

  dependencies.readPackument = stubReads([untaggedPackument(sidecar), settled]);
  dependencies.verifyReuse = async () => {
    throw new Error('not grandfathered');
  };
  await assert.rejects(
    publishSidecars(publishOptions, dependencies),
    /not grandfathered/u,
  );
});

test('reuse provenance re-reads a fresh version until it verifies, never an old one', async () => {
  const { awaitSidecarReuseProvenance } = await importCli();
  const sidecar = { ...stagedMfCli(), version: '9.9.9' };
  const withTime = (packument, publishedAt) => ({
    ...packument,
    time: { created: publishedAt, modified: publishedAt, '9.9.9': publishedAt },
  });
  const now = new Date().toISOString();
  const unattested = withTime(packumentFor(sidecar), now);
  const attested = withTime(packumentFor(sidecar), now);
  attested.versions['9.9.9'].dist.attestations = {
    provenance: { predicateType: slsaProvenanceV1 },
  };
  const verified = [];
  const waits = [];
  await awaitSidecarReuseProvenance(
    sidecar,
    unattested,
    { source: releaseSource },
    {
      readPackument: async () => attested,
      verifyReuse: async (_candidate, packument) => {
        verified.push(packument);
        // Missing declaration first, then a bundle endpoint still at 404.
        if (verified.length === 1) {
          throw new Error('missing SLSA v1 provenance');
        }
        if (verified.length === 2) {
          throw new Error('registry provenance returned HTTP 404');
        }
      },
      wait: async ms => waits.push(ms),
    },
  );
  assert.deepEqual(verified, [unattested, attested, attested]);
  assert.equal(waits.length, 2);

  const old = withTime(packumentFor(sidecar), '2026-01-01T00:00:00.000Z');
  await assert.rejects(
    awaitSidecarReuseProvenance(
      sidecar,
      old,
      { source: releaseSource },
      {
        verifyReuse: async () => {
          throw new Error('missing SLSA v1 provenance');
        },
        wait: async () => assert.fail('an old unattested version never waits'),
      },
    ),
    /missing SLSA v1 provenance/u,
  );
});

test('a stale registry read without the reused version never vouches for it', async () => {
  const { assertSidecarReuseProvenance } = await importPublication();
  const sidecar = stagedMfCli();
  const grandfatheredOnly = chronologyPackument({
    ...sidecar,
    version: '3.1.0',
  });
  await assert.rejects(
    assertSidecarReuseProvenance(sidecar, grandfatheredOnly, {
      env: {},
      policy: grandfatheredPolicy({ ...sidecar, version: '3.1.0' }),
      source: releaseSource,
    }),
    /does not contain the reused 3\.2\.0 with the accepted integrity/u,
  );
});

test('a reuse provenance read that briefly returns no packument keeps polling', async () => {
  const { awaitSidecarReuseProvenance } = await importCli();
  const sidecar = stagedMfCli();
  const settled = packumentFor(sidecar);
  const verified = [];
  await awaitSidecarReuseProvenance(
    sidecar,
    undefined,
    { source: releaseSource },
    {
      readPackument: stubReads([null, settled]),
      verifyReuse: async (_candidate, packument) => verified.push(packument),
      wait: async () => {},
    },
  );
  assert.deepEqual(verified, [settled]);
});

test('a resumed reuse finishes provenance before any later sidecar publishes', async t => {
  const { publishSidecars } = await importCli();
  withTrustedPublishEnv(t);
  const resumed = stagedMfCli();
  const later = namedSidecar('@bleedingdev/ipx-later');
  const events = [];
  const dependencies = sidecarLaneDependencies({
    sidecars: [resumed, later],
    readPackument: async name =>
      name === resumed.name ? packumentFor(resumed) : priorReleaseOnly(later),
    onPublish: name => events.push(`publish ${name}`),
  });
  dependencies.readSidecars = () => ({
    manifest: { publishBefore: '@bleedingdev/modern-js-image' },
    release: {
      manifest: {
        source: releaseSource,
        tools: { node: process.version, npm: '11.10.1', pnpm: '11.24.0' },
      },
    },
    sidecars: [resumed, later],
  });
  let firstRead = true;
  const readPackument = dependencies.readPackument;
  dependencies.readPackument = async name => {
    if (name === resumed.name && firstRead) {
      firstRead = false;
      return untaggedPackument(resumed);
    }
    return readPackument(name);
  };
  dependencies.verifyReuse = async () => {
    events.push(`verify ${resumed.name}`);
    throw new Error('not grandfathered');
  };
  await assert.rejects(
    publishSidecars(publishOptions, dependencies),
    /not grandfathered/u,
  );
  assert.deepEqual(events, [`verify ${resumed.name}`]);
});

test('all new-version authorizations pass before the first irreversible publication', async t => {
  const { publishSidecars } = await importCli();
  withTrustedPublishEnv(t);
  const first = namedSidecar('@bleedingdev/ipx-first');
  const second = namedSidecar('@bleedingdev/ipx-second');
  const events = [];
  const dependencies = sidecarLaneDependencies({
    sidecars: [first, second],
    readPackument: async name =>
      priorReleaseOnly(name === first.name ? first : second),
    onPublish: name => events.push(`publish:${name}`),
    requestToken: async name => {
      events.push(`authorize:${name}`);
      if (name === second.name)
        throw new Error('not authorized for second package');
      return 'opaque-test-token';
    },
  });
  await assert.rejects(
    publishSidecars(publishOptions, dependencies),
    /preflight failed[\s\S]*second package/,
  );
  assert.deepEqual(events, [
    `authorize:${first.name}`,
    `authorize:${second.name}`,
  ]);
});

test('a later missing package or unclassified manifest stops the entire lane before authorization', async t => {
  const { publishSidecars } = await importCli();
  withTrustedPublishEnv(t);
  const first = namedSidecar('@bleedingdev/ipx-first');
  const second = namedSidecar('@bleedingdev/ipx-second');
  const noPublish = () => assert.fail('must fail before publishing');
  const dependencies = sidecarLaneDependencies({
    sidecars: [first, second],
    readPackument: async name =>
      name === first.name ? priorReleaseOnly(first) : null,
    onPublish: noPublish,
    requestToken: async () => assert.fail('must fail before OIDC exchange'),
  });
  await assert.rejects(
    publishSidecars(publishOptions, dependencies),
    /Bootstrap @bleedingdev\/ipx-second/,
  );
  second.packageJson.unspecifiedConsumerField = true;
  await assert.rejects(
    publishSidecars(publishOptions, dependencies),
    /does not classify/,
  );
});

test('typings participates in immutable resolution comparison while explicit development metadata does not', async () => {
  const { sidecarRegistryDecision, sidecarContentProjection } =
    await importPublication();
  const sidecar = stagedMfCli();
  Object.assign(sidecar.packageJson, {
    typings: 'out/index.d.ts',
    packageManager: 'bun@1.4.2',
    verb: { tasks: ['readme'] },
    'simple-git-hooks': { 'pre-commit': 'lint' },
  });
  assert.equal(
    sidecarContentProjection(sidecar.packageJson, sidecar.name).typings,
    'out/index.d.ts',
  );
  await assert.rejects(
    sidecarRegistryDecision(sidecar, packumentFor(sidecar)),
    /typings/,
  );
  assert.equal(
    (
      await sidecarRegistryDecision(
        sidecar,
        packumentFor(sidecar, { overrides: { typings: 'out/index.d.ts' } }),
      )
    ).action,
    'reuse',
  );
});

test('fresh publication verifies exact source/run provenance and registry bytes before chronology', async t => {
  const { verifyFreshSidecar } = await importCli();
  withTrustedPublishEnv(t);
  const keys = ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'];
  const saved = keys.map(key => process.env[key]);
  process.env.GITHUB_RUN_ID = '12345';
  process.env.GITHUB_RUN_ATTEMPT = '2';
  t.after(() =>
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    }),
  );
  const sidecar = stagedMfCli();
  const events = [];
  await verifyFreshSidecar(
    sidecar,
    { source: releaseSource },
    {
      readPackument: async () => publishedPackumentFor(sidecar),
      verifyFreshTarball: async item => {
        assert.equal(item.targetName, sidecar.name);
        events.push('bytes');
      },
      verifyFreshProvenance: async (_item, _dist, expectation) => {
        assert.equal(expectation.source.commit, releaseSource.commit);
        assert.deepEqual(expectation.invocation, {
          repository: 'BleedingDev/ultramodern.js',
          runId: '12345',
          runAttempt: '2',
          exactAttempt: true,
        });
        events.push('exact provenance');
      },
      verifyReuse: async () => events.push('chronology'),
    },
  );
  assert.deepEqual(events, ['bytes', 'exact provenance', 'chronology']);
  await assert.rejects(
    verifyFreshSidecar(
      sidecar,
      { source: releaseSource },
      {
        readPackument: async () => publishedPackumentFor(sidecar),
        verifyFreshTarball: async () => {},
        verifyFreshProvenance: async () => {
          throw new Error('wrong source/run');
        },
        verifyReuse: async () =>
          assert.fail('chronology cannot replace exact provenance'),
      },
    ),
    /wrong source\/run/,
  );
});

test('settled fresh bytes wait only for absent provenance, never mismatched signed provenance', async t => {
  const { verifyFreshSidecar } = await importCli();
  const { RegistryProvenancePendingError } = await import(
    '../lib/prepare-bleedingdev-packages/provenance.mjs'
  );
  withTrustedPublishEnv(t);
  const sidecar = stagedMfCli();
  const visible = () =>
    packumentFor(sidecar, {
      overrides: {
        dist: {
          integrity: sidecar.integrity,
          shasum: sidecar.shasum,
          attestations: { provenance: {} },
        },
      },
    });
  let reads = 0;
  let provenanceReads = 0;
  let waits = 0;
  let chronology = 0;
  await verifyFreshSidecar(
    sidecar,
    { source: releaseSource },
    {
      readPackument: async () =>
        ++reads === 1 ? packumentFor(sidecar) : visible(),
      verifyFreshTarball: async () => {},
      verifyFreshProvenance: async () => {
        if (++provenanceReads === 1)
          throw new RegistryProvenancePendingError(
            'attestation endpoint returned HTTP 404',
          );
      },
      verifyReuse: async () => {
        chronology += 1;
      },
      wait: async () => {
        waits += 1;
      },
    },
  );
  assert.equal(reads, 3);
  assert.equal(provenanceReads, 2);
  assert.equal(waits, 2);
  assert.equal(chronology, 1);
  waits = 0;
  await assert.rejects(
    verifyFreshSidecar(
      sidecar,
      { source: releaseSource },
      {
        readPackument: async () => ({
          ...visible(),
          time: { [sidecar.version]: new Date().toISOString() },
        }),
        verifyFreshTarball: async () => {},
        verifyFreshProvenance: async () => {
          throw new Error('mismatched signed source and producer attempt');
        },
        verifyReuse: async () =>
          assert.fail(
            'untrusted signed provenance cannot authorize chronology',
          ),
        wait: async () => {
          waits += 1;
        },
      },
    ),
    /mismatched signed source/,
  );
  assert.equal(
    waits,
    0,
    'fresh timestamps cannot turn mismatched signed provenance into a propagation state',
  );
});

for (const state of ['missing tag', 'unindexed tagged version']) {
  test(`a later resumed reuse with ${state} must authenticate before any earlier package publishes`, async t => {
    const { publishSidecars } = await importCli();
    withTrustedPublishEnv(t);
    const first = namedSidecar('@bleedingdev/ipx-first');
    const second = namedSidecar('@bleedingdev/mf-cli');
    let secondReads = 0;
    const events = [];
    const dependencies = sidecarLaneDependencies({
      sidecars: [first, second],
      readPackument: async name => {
        if (name === first.name) return priorReleaseOnly(first);
        if (++secondReads === 1)
          return state === 'missing tag'
            ? untaggedPackument(second)
            : { ...packumentFor(second), versions: {} };
        return publishedPackumentFor(second);
      },
      onPublish: name => events.push(`publish:${name}`),
      requestToken: async name => {
        events.push(`authorize:${name}`);
        return 'opaque-test-token';
      },
    });
    dependencies.verifyReuse = async candidate => {
      if (candidate.name === second.name)
        throw new Error('resumed candidate has untrusted provenance');
    };
    await assert.rejects(
      publishSidecars(publishOptions, dependencies),
      /untrusted provenance/,
    );
    assert.deepEqual(
      events,
      [],
      'the complete existing registry set must be trusted before OIDC or publication',
    );
  });
}

test('organization-owned releases can reuse authenticated sidecars published before the transfer', async () => {
  const { assertSidecarReuseProvenance } = await importPublication();
  const sidecar = {
    ...stagedMfCli(),
    integrity: `sha512-${crypto.createHash('sha512').update('transfer-sidecar').digest('base64')}`,
  };
  const source = {
    ...releaseSource,
    repository: 'ultramodernjs/ultramodern.js',
  };
  const options = { env: {}, policy: { grandfatheredVersions: [] }, source };
  for (const repository of [source.repository, releaseSource.repository]) {
    await assertSidecarReuseProvenance(
      sidecar,
      chronologyPackument(sidecar, { attested: true }),
      options,
      {
        bundleVerifier: acceptingBundleVerifier,
        fetchImpl: attestationFetch(sidecar, repository),
      },
    );
  }
  await assert.rejects(
    assertSidecarReuseProvenance(
      sidecar,
      chronologyPackument(sidecar, { attested: true }),
      options,
      {
        bundleVerifier: acceptingBundleVerifier,
        fetchImpl: attestationFetch(sidecar, 'attacker/ultramodern.js'),
      },
    ),
    /accepted source repository exactly once/u,
  );
});
