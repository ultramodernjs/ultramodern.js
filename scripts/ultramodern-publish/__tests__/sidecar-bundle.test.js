// Consumer: independent sidecar artifact and qualification acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const load = () => import('../sidecar-bundle.mjs');
const artifacts = () =>
  import('../lib/prepare-bleedingdev-packages/release-artifacts.mjs');

async function fixture(t, profile = 'parser', metadata = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = await load();
  const { canonicalJson, resolveSourceIdentity, resolveToolVersions } =
    await artifacts();
  const { writeSidecarStagingManifest } = await import(
    '../lib/prepare-bleedingdev-packages/sidecars.mjs'
  );
  const source = {
    ...resolveSourceIdentity(),
    ...(metadata.sourceRepository
      ? { repository: metadata.sourceRepository }
      : {}),
  };
  const tools = resolveToolVersions();
  // These are synthetic unit-test invocation IDs, never uploaded as production receipts.
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY_ID: '1151231350',
    GITHUB_REPOSITORY: source.repository,
    GITHUB_SHA: source.commit,
    GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '1',
  };
  const output = path.join(root, 'bundle');
  fs.mkdirSync(output);
  const selected = bundle.sidecarProfile(profile);
  const inputs = bundle.readSidecarBundleInputs(profile);
  const staged = inputs.map(input => {
    const stagedDir = path.join(root, input.id);
    fs.mkdirSync(stagedDir);
    fs.writeFileSync(
      path.join(stagedDir, 'index.js'),
      'module.exports = {};\n',
    );
    const packageJson = {
      name: input.name,
      version: input.version,
      main: 'index.js',
      license: 'MIT',
      repository: {
        type: 'git',
        url: `git+https://github.com/${metadata.packageRepository ?? source.repository}.git`,
      },
      publishConfig: {
        access: 'public',
        registry: 'https://registry.npmjs.org/',
      },
    };
    fs.writeFileSync(
      path.join(stagedDir, 'package.json'),
      `${JSON.stringify(packageJson)}\n`,
    );
    return {
      name: input.name,
      version: input.version,
      root: `packages/sidecar/${input.id}`,
      stagedDir,
      packageJson,
    };
  });
  const { descriptor } = writeSidecarStagingManifest(output, staged, {
    publishBefore: selected.publishBefore,
  });
  const accepted = bundle.writeSidecarBundle(output, {
    descriptor,
    source,
    tools,
    env,
    profile,
  });
  const options = { source, tools, env };
  const receiptPath = path.join(root, 'qualification.json');
  const probes = Object.fromEntries(selected.probeKeys.map(key => [key, true]));
  bundle.writeSidecarQualification(output, probes, { env, receiptPath });
  const rewrite = (file, transform) => {
    const before = fs.readFileSync(file);
    const next = transform(JSON.parse(before));
    fs.writeFileSync(file, `${canonicalJson(next, 2)}\n`);
    return () => fs.writeFileSync(file, before);
  };
  return { ...bundle, output, accepted, options, receiptPath, probes, rewrite };
}

test('independent bundle accepts only its unchanged v2 artifact and exact same-run qualification', async t => {
  const f = await fixture(t);
  assert.equal(f.accepted.sidecars.packages.length, 6);
  assert.equal(f.accepted.sidecars.manifest.schemaVersion, 2);
  assert.equal(
    f.accepted.sidecars.manifest.publishBefore,
    '@bleedingdev/modern-js-utils',
  );
  assert.equal(
    f.verifySidecarQualification(f.output, f.receiptPath, f.options)
      .bundleSha256,
    f.accepted.bundleSha256,
  );
  assert.throws(
    () =>
      f.verifySidecarBundle(f.output, {
        ...f.options,
        env: { ...f.options.env, GITHUB_RUN_ATTEMPT: '2' },
      }),
    /run and attempt/,
  );
  assert.throws(
    () =>
      f.verifySidecarBundle(f.output, {
        ...f.options,
        env: { ...f.options.env, GITHUB_RUN_ID: '98765' },
      }),
    /run and attempt/,
  );
  assert.throws(
    () =>
      f.verifySidecarBundle(f.output, {
        ...f.options,
        env: { ...f.options.env, GITHUB_SHA: 'f'.repeat(40) },
      }),
    /workflow source/,
  );
  assert.throws(
    () =>
      f.writeSidecarQualification(f.output, f.probes, {
        env: {},
        receiptPath: path.join(f.output, 'bad.json'),
      }),
    /GitHub workflow/,
  );
});

test('bundle rejects schema widening, checkout/tool/input drift, extra files and symlinks', async t => {
  const f = await fixture(t);
  const file = path.join(f.output, f.sidecarBundleFile);
  for (const [transform, message] of [
    [
      value => ({ ...value, cohortVersion: '3.8.2-ultramodern.29' }),
      /unknown or missing/,
    ],
    [value => ({ ...value, mode: 'cohort' }), /schema or mode/],
    [
      value => ({
        ...value,
        sidecars: { ...value.sidecars, manifestPath: '../sidecars.json' },
      }),
      /Unsafe/,
    ],
    [
      value => ({ ...value, tools: { ...value.tools, npm: '99.0.0' } }),
      /toolchain/,
    ],
    [value => ({ ...value, inputs: value.inputs.slice(1) }), /recipe or patch/],
    [
      value => ({
        ...value,
        source: { ...value.source, commit: 'f'.repeat(40) },
      }),
      /workflow source/,
    ],
  ]) {
    const restore = f.rewrite(file, transform);
    assert.throws(() => f.verifySidecarBundle(f.output, f.options), message);
    restore();
  }
  const extra = path.join(f.output, 'manifest.json');
  fs.writeFileSync(extra, '{}');
  assert.throws(() => f.verifySidecarBundle(f.output, f.options), /file set/);
  fs.rmSync(extra);
  const tarball = path.join(
    f.output,
    f.accepted.sidecars.manifest.packages[0].tarballPath,
  );
  const bytes = fs.readFileSync(tarball);
  fs.writeFileSync(tarball, Buffer.concat([bytes, Buffer.from('drift')]));
  assert.throws(
    () => f.verifySidecarBundle(f.output, f.options),
    /size mismatch/,
  );
  fs.writeFileSync(tarball, bytes);
  const renamed = `${tarball}.original`;
  fs.renameSync(tarball, renamed);
  fs.symlinkSync(renamed, tarball);
  assert.throws(
    () => f.verifySidecarBundle(f.output, f.options),
    /regular file/,
  );
});

test('qualification cannot substitute probes, producer, source or accepted packed digest', async t => {
  const f = await fixture(t);
  for (const transform of [
    value => ({
      ...value,
      probes: { ...value.probes, 'packed-install': false },
    }),
    value => ({ ...value, probes: { ...value.probes, extra: true } }),
    value => ({ ...value, producer: { ...value.producer, runAttempt: '2' } }),
    value => ({ ...value, bundleSha256: 'f'.repeat(64) }),
    value => ({
      ...value,
      source: { ...value.source, commit: 'f'.repeat(40) },
    }),
    value => ({
      ...value,
      sidecars: { ...value.sidecars, sha256: 'f'.repeat(64) },
    }),
  ]) {
    const restore = f.rewrite(f.receiptPath, transform);
    assert.throws(
      () => f.verifySidecarQualification(f.output, f.receiptPath, f.options),
      /does not bind/,
    );
    restore();
  }
  assert.throws(
    () =>
      f.writeSidecarQualification(
        f.output,
        { ...f.probes, 'packed-install': false },
        { env: f.options.env, receiptPath: path.join(f.output, 'bad.json') },
      ),
    /required probe/,
  );
});

test('independent CLI arguments fail closed on cross-mode inputs and unsafe output roots', async () => {
  const { parseArgs } = await import('../publish-sidecars.mjs');
  const { resolveSidecarOutput } = await load();
  assert.throws(() => parseArgs(['--mode', 'unknown']), /cohort or sidecars/);
  assert.throws(() => parseArgs(['--mode', 'sidecars']), /--qualification/);
  assert.throws(
    () => parseArgs(['--qualification', 'x']),
    /independent-sidecar-only/,
  );
  assert.throws(
    () => parseArgs(['--mode', 'sidecars', '--check-registry']),
    /requires --profile/,
  );
  assert.throws(
    () => resolveSidecarOutput('/tmp/sidecar-bundle'),
    /must be inside/,
  );
});

test('SDK profile admits only its exact package, canonical patch and installed API receipt', async t => {
  const f = await fixture(t, 'mf-sdk');
  assert.equal(f.accepted.manifest.profile, 'mf-sdk');
  assert.deepEqual(
    f.accepted.sidecars.packages.map(item => [item.name, item.version]),
    [['@bleedingdev/mf-sdk', '2.9.2']],
  );
  assert.equal(
    f.accepted.sidecars.manifest.publishBefore,
    '@bleedingdev/modern-js-federation-runtime',
  );
  assert.equal(
    f.accepted.manifest.inputs[0].patch.sha256,
    'fb4b0dfd33a0588ad3821f1d56e2316044ae0b721c515a69080d7d9d9de72e3e',
  );
  assert.deepEqual(f.probes, {
    'packed-install': true,
    'mf-sdk-cjs-api': true,
    'mf-sdk-esm-api': true,
  });
  assert.equal(
    f.verifySidecarQualification(f.output, f.receiptPath, f.options)
      .bundleSha256,
    f.accepted.bundleSha256,
  );
  assert.throws(
    () =>
      f.verifySidecarBundle(f.output, {
        ...f.options,
        env: { ...f.options.env, BLEEDINGDEV_SIDECAR_PROFILE: 'parser' },
      }),
    /workflow selection/,
  );
  for (const profile of ['unknown', '__proto__', 'constructor', null]) {
    assert.throws(() => f.sidecarProfile(profile), /Unknown sidecar profile/);
  }
  for (const transform of [
    value => ({ ...value, profile: 'parser' }),
    value => ({ ...value, profile: 'unknown' }),
  ]) {
    const restore = f.rewrite(
      path.join(f.output, f.sidecarBundleFile),
      transform,
    );
    assert.throws(
      () => f.verifySidecarBundle(f.output, f.options),
      /recipe or patch|Unknown sidecar profile/,
    );
    restore();
  }
  const restore = f.rewrite(f.receiptPath, value => ({
    ...value,
    profile: 'parser',
  }));
  assert.throws(
    () => f.verifySidecarQualification(f.output, f.receiptPath, f.options),
    /does not bind/,
  );
  restore();
  const { sidecarProvenancePolicy } = await import(
    '../lib/prepare-bleedingdev-packages/sidecars.mjs'
  );
  assert.deepEqual(sidecarProvenancePolicy('@bleedingdev/mf-sdk'), {
    grandfatheredVersions: [
      {
        version: '0.0.0-stage',
        publishedAt: '2026-10-11T22:50:37.736Z',
        integrity:
          'sha512-wU6deymL1rA/g7Bafhpi8Fapo2tv1LOvM0zF9Fv/XxGaTMrFQ4+CTdGwfa612Rav39snYxCfTN8PdZe8o4YN0Q==',
      },
      {
        version: '0.0.0-bootstrap',
        publishedAt: '2026-10-11T22:52:44.118Z',
        integrity:
          'sha512-w7s0htCV+el/sZYevmEMA+/JAhwTqYKR2l9FqWypcpW2yhhB6H7zaeIyg0o/55NUT0KmmCL+4Rf96N43p1lLSw==',
      },
    ],
  });
  const { assertSidecarProfileDependencies } = await import(
    '../sidecar-profiles.mjs'
  );
  for (const packages of [
    [],
    [{ name: '@bleedingdev/mf-sdk', version: '2.9.3' }],
    [{ name: '@module-federation/sdk', version: '2.9.2' }],
    [
      { name: '@bleedingdev/mf-sdk', version: '2.9.2' },
      { name: '@bleedingdev/braces', version: '3.0.4' },
    ],
  ]) {
    assert.throws(
      () => assertSidecarProfileDependencies('mf-sdk', packages),
      /closed profile/,
    );
  }
});

test('Redact profile admits only its exact package, canonical patch and placeholder receipts', async t => {
  const f = await fixture(t, 'tanstack-redact');
  assert.equal(f.accepted.manifest.profile, 'tanstack-redact');
  assert.deepEqual(
    f.accepted.sidecars.packages.map(item => [item.name, item.version]),
    [['@bleedingdev/tanstack-redact', '0.2.1']],
  );
  assert.equal(
    f.accepted.sidecars.manifest.publishBefore,
    '@bleedingdev/modern-js-ultramodern-app-tools',
  );
  assert.equal(
    f.accepted.manifest.inputs[0].patch.sha256,
    'ef5f95b9e5f01cd8130b5e523e33fa6a2ebd05004509952092305fc1174e6f8c',
  );
  assert.deepEqual(f.probes, {
    'packed-install': true,
    'redact-patch-marker': true,
    'redact-server-render': true,
  });
  assert.throws(
    () =>
      f.verifySidecarBundle(f.output, {
        ...f.options,
        env: { ...f.options.env, BLEEDINGDEV_SIDECAR_PROFILE: 'mf-sdk' },
      }),
    /workflow selection/,
  );
  const { sidecarProvenancePolicy } = await import(
    '../lib/prepare-bleedingdev-packages/sidecars.mjs'
  );
  assert.deepEqual(sidecarProvenancePolicy('@bleedingdev/tanstack-redact'), {
    grandfatheredVersions: [
      {
        version: '0.0.0-stage',
        publishedAt: '2026-10-28T23:44:23.507Z',
        integrity:
          'sha512-O2lJVu5WmLaAjC9njVTrbXkbywYKN1ScFVD4RGIV7iJra13PxmjgUv6i86OjuarGJIC4K0fS8AGBBIQDKBN9CA==',
      },
      {
        version: '0.0.0-bootstrap',
        publishedAt: '2026-10-28T23:44:58.304Z',
        integrity:
          'sha512-vXq2yWHar3WlXXvKF6ij7O2G+GZCsWmmxlsnBbeB8V/oWOUX+76T0cMgkGpQPgVm2wxZ4293s0Fq3PnAaYdptA==',
      },
    ],
  });
  const { assertSidecarProfileDependencies } = await import(
    '../sidecar-profiles.mjs'
  );
  for (const packages of [
    [],
    [{ name: '@tanstack/redact', version: '0.2.1' }],
    [{ name: '@bleedingdev/tanstack-redact', version: '0.2.2' }],
  ]) {
    assert.throws(
      () => assertSidecarProfileDependencies('tanstack-redact', packages),
      /closed profile/,
    );
  }
});

test('SDK placeholder exemptions pin both receipts and do not authorize unsigned releases', async () => {
  const { sidecarProvenancePolicy } = await import(
    '../lib/prepare-bleedingdev-packages/sidecars.mjs'
  );
  const { assertSidecarReuseProvenance } = await import(
    '../lib/prepare-bleedingdev-packages/sidecar-publication.mjs'
  );
  const { resolveSourceIdentity } = await artifacts();
  const name = '@bleedingdev/mf-sdk';
  const policy = sidecarProvenancePolicy(name);
  const [stage, bootstrap] = policy.grandfatheredVersions;
  const sidecar = {
    name,
    version: bootstrap.version,
    integrity: bootstrap.integrity,
  };
  const metadata = {
    name,
    versions: {
      [stage.version]: {
        name,
        version: stage.version,
        stub: true,
        dist: { integrity: stage.integrity },
      },
      [bootstrap.version]: {
        name,
        version: bootstrap.version,
        deprecated:
          'Bootstrap placeholder only. Do not install; use the signed stable release.',
        dist: { integrity: bootstrap.integrity },
      },
    },
    time: {
      created: stage.publishedAt,
      [stage.version]: stage.publishedAt,
      modified: '2026-10-12T00:00:00.000Z',
      [bootstrap.version]: bootstrap.publishedAt,
    },
  };
  const options = { env: {}, source: resolveSourceIdentity() };
  await assertSidecarReuseProvenance(sidecar, metadata, options);
  await assertSidecarReuseProvenance(
    { name, version: stage.version, integrity: stage.integrity },
    metadata,
    options,
  );

  const changedStage = structuredClone(metadata);
  changedStage.time[stage.version] = '2026-10-11T22:50:38.736Z';
  await assert.rejects(
    assertSidecarReuseProvenance(sidecar, changedStage, options),
    /grandfathered version publication time must be/u,
  );

  const changedTime = structuredClone(metadata);
  changedTime.time[bootstrap.version] = '2026-10-11T22:52:45.118Z';
  await assert.rejects(
    assertSidecarReuseProvenance(sidecar, changedTime, options),
    /grandfathered version publication time must be/u,
  );
  const changedIntegrity = structuredClone(metadata);
  const integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
  changedIntegrity.versions[bootstrap.version].dist.integrity = integrity;
  await assert.rejects(
    assertSidecarReuseProvenance(
      { ...sidecar, integrity },
      changedIntegrity,
      options,
    ),
    /grandfathered version integrity does not match/u,
  );

  const release = { name, version: '2.9.2-ultramodern.1', integrity };
  const unsignedRelease = structuredClone(metadata);
  unsignedRelease.versions[release.version] = {
    name,
    version: release.version,
    dist: { integrity },
  };
  unsignedRelease.time[release.version] = '2026-10-12T00:00:00.000Z';
  await assert.rejects(
    assertSidecarReuseProvenance(release, unsignedRelease, options),
    /missing SLSA v1 provenance and is not a grandfathered version/u,
  );
});

test('new bundles reject stale repository metadata even with authentic packed digests after transfer', async t => {
  await assert.rejects(
    fixture(t, 'parser', {
      sourceRepository: 'ultramodernjs/ultramodern.js',
      packageRepository: 'BleedingDev/ultramodern.js',
    }),
    /package repository does not match its producer source repository/,
  );
});
