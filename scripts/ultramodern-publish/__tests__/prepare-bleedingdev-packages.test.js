// Consumer: publish-bleedingdev.yml staging, publication, and registry gates.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../../..');

const makeTempDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'modern-prepare-publish-'));

const removeDir = directory => {
  fs.rmSync(directory, { recursive: true, force: true });
};

const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const writeFile = (filePath, contents = 'fixture\n') => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
};

const releaseSource = {
  commit: 'a'.repeat(40),
  repository: 'BleedingDev/ultramodern.js',
};

const releaseTools = {
  node: process.version,
  npm: 'fixture-npm',
  pnpm: 'fixture-pnpm',
};

const slsaProvenanceV1 = 'https://slsa.dev/provenance/v1';
const trustedOidcIssuer = 'https://token.actions.githubusercontent.com';
const trustedWorkflow = {
  path: '.github/workflows/publish-bleedingdev.yml',
  ref: 'refs/heads/main-ultramodern',
  repository: 'https://github.com/BleedingDev/ultramodern.js',
};

// These mocked publications exercise registry behavior in a release context,
// independently of the pull-request workflow running this test file.
const mockTrustedWorkflowEnvironment = t => {
  t.mock.property(process, 'env', {
    ...process.env,
    GITHUB_ACTIONS: 'true',
    GITHUB_REF: trustedWorkflow.ref,
    GITHUB_REPOSITORY: releaseSource.repository,
    GITHUB_SHA: releaseSource.commit,
    GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKFLOW: 'Publish BleedingDev',
    GITHUB_WORKFLOW_REF: `${releaseSource.repository}/${trustedWorkflow.path}@${trustedWorkflow.ref}`,
    GITHUB_WORKFLOW_SHA: releaseSource.commit,
  });
};

const npmPurl = item => {
  const [scope, name] = item.targetName.slice(1).split('/');
  return `pkg:npm/%40${scope}/${name}@${item.version}`;
};

const provenanceStatement = item => ({
  _type: 'https://in-toto.io/Statement/v1',
  predicateType: slsaProvenanceV1,
  subject: [
    {
      name: npmPurl(item),
      digest: {
        sha512: Buffer.from(
          item.integrity.slice('sha512-'.length),
          'base64',
        ).toString('hex'),
      },
    },
  ],
  predicate: {
    buildDefinition: {
      buildType:
        'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
      externalParameters: { workflow: structuredClone(trustedWorkflow) },
      resolvedDependencies: [
        {
          uri: `git+https://github.com/BleedingDev/ultramodern.js@${trustedWorkflow.ref}`,
          digest: { gitCommit: releaseSource.commit },
        },
      ],
    },
  },
});

const provenanceDocument = statement => ({
  attestations: [
    {
      predicateType: slsaProvenanceV1,
      bundle: {
        mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
        dsseEnvelope: {
          payloadType: 'application/vnd.in-toto+json',
          payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
          signatures: [{ keyid: '', sig: 'fixture-signature' }],
        },
        verificationMaterial: {},
      },
    },
  ],
});

const provenanceResponse = document => ({
  ok: true,
  status: 200,
  json: async () => document,
});

const provenanceDist = {
  attestations: {
    provenance: { predicateType: slsaProvenanceV1 },
    url: 'https://registry.npmjs.org/-/npm/v1/attestations/@bleedingdev%2fmodern-js-runtime@3.2.0-ultramodern.1',
  },
};

const sigstoreVerificationResult = expectation => ({
  certificateIdentity: expectation.certificateIdentity,
  issuer: expectation.issuer,
  verifierVersion: 'fixture-sigstore',
});

const registryTarballUrl = item => {
  const packageBaseName = item.targetName.slice(
    item.targetName.lastIndexOf('/') + 1,
  );
  return `https://registry.npmjs.org/${item.targetName}/-/${packageBaseName}-${item.version}.tgz`;
};

const registryDistFor = item => ({
  ...structuredClone(provenanceDist),
  integrity: item.integrity,
  shasum: item.shasum,
  tarball: registryTarballUrl(item),
});

const tarballResponse = bytes => ({
  arrayBuffer: async () =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  ok: true,
  status: 200,
});

// `@modern-js/ultramodern-create` ships a template workspace the packer must
// keep; if staging drops these files consumers scaffold a broken project.
const createTemplateRequiredFiles = [
  'template-workspace/.agents/agent-reference-repos.json',
  'template-workspace/.codex/rstackjs-agent-skills-LICENSE',
  'template-workspace/.codex/skills-lock.json',
  'template-workspace/.codex/hooks.json',
  'template-workspace/.github/renovate.json',
  'template-workspace/.github/workflows/ultramodern-workspace-gates.yml.handlebars',
  'template-workspace/.gitignore.handlebars',
  'template-workspace/.mise.toml.handlebars',
];

// Builds a real staged cohort and packs it through the production
// `createReleaseArtifacts`, so the tests below verify real tarball bytes.
const createArtifactFixture = async (
  extraDefinitions = [],
  sidecarDefinitions = [],
) => {
  const { createReleaseArtifacts } = await import(
    '../prepare-bleedingdev-packages.mjs'
  );
  const root = makeTempDir();
  const aliases = {
    '@modern-js/ultramodern-create':
      '@bleedingdev/modern-js-ultramodern-create',
    '@modern-js/runtime': '@bleedingdev/modern-js-runtime',
    '@modern-js/utils': '@bleedingdev/modern-js-utils',
  };
  const definitions = [
    {
      sourceName: '@modern-js/runtime',
      targetName: aliases['@modern-js/runtime'],
      dependencies: {
        '@modern-js/utils':
          'npm:@bleedingdev/modern-js-utils@3.2.0-ultramodern.1',
      },
    },
    {
      sourceName: '@modern-js/utils',
      targetName: aliases['@modern-js/utils'],
      dependencies: {},
    },
    {
      sourceName: '@modern-js/ultramodern-create',
      targetName: aliases['@modern-js/ultramodern-create'],
      dependencies: {},
    },
    ...extraDefinitions,
  ];
  for (const definition of extraDefinitions) {
    aliases[definition.sourceName] = definition.targetName;
  }
  const packages = definitions.map(definition => {
    const packageDir = path.join(
      root,
      'staged',
      definition.targetName.replaceAll('/', '__'),
    );
    writeJson(path.join(packageDir, 'package.json'), {
      name: definition.targetName,
      version: '3.2.0-ultramodern.1',
      dependencies: definition.dependencies,
      publishConfig: { access: 'public' },
    });
    writeFile(
      path.join(packageDir, 'index.js'),
      `module.exports = ${JSON.stringify(definition.sourceName)};\n`,
    );
    if (definition.sourceName === '@modern-js/ultramodern-create') {
      for (const relativePath of createTemplateRequiredFiles) {
        writeFile(path.join(packageDir, relativePath));
      }
    }
    return {
      packageDir: path.relative(repoRoot, packageDir),
      sourceName: definition.sourceName,
      targetName: definition.targetName,
      version: '3.2.0-ultramodern.1',
    };
  });
  let releaseArtifacts;
  try {
    let sidecars = null;
    if (sidecarDefinitions.length > 0) {
      const { writeSidecarStagingManifest } = await import(
        '../lib/prepare-bleedingdev-packages/sidecars.mjs'
      );
      const stagedSidecars = sidecarDefinitions.map(
        ({
          name,
          version,
          dependencies = {},
          repository = releaseSource.repository,
        }) => {
          const stagedDir = path.join(
            root,
            'sidecars',
            name.replaceAll('/', '__'),
          );
          const packageJson = {
            name,
            version,
            main: 'index.js',
            license: 'MIT',
            repository: {
              type: 'git',
              url: `git+https://github.com/${repository}.git`,
            },
            dependencies,
          };
          writeJson(path.join(stagedDir, 'package.json'), packageJson);
          writeFile(path.join(stagedDir, 'index.js'), 'module.exports = {};\n');
          return {
            name,
            version,
            stagedDir,
            packageJson,
            root: `packages/sidecar/${name.slice('@bleedingdev/'.length)}`,
          };
        },
      );
      sidecars = writeSidecarStagingManifest(
        path.join(root, 'release'),
        stagedSidecars,
        { publishBefore: aliases['@modern-js/runtime'] },
      ).descriptor;
    }
    releaseArtifacts = createReleaseArtifacts({
      aliases,
      command: execFileSync,
      outDir: path.join(root, 'release'),
      packages,
      sidecars,
      source: releaseSource,
      tag: 'latest',
      tools: releaseTools,
      version: '3.2.0-ultramodern.1',
    });
  } catch (error) {
    removeDir(root);
    throw error;
  }

  return { aliases, packages, releaseArtifacts, root };
};

test('packed cohort projects every verified sidecar and rejects incomplete or altered records', async () => {
  const { validateReleaseCohortProjection, verifyReleaseArtifacts } =
    await import('../lib/prepare-bleedingdev-packages/release-artifacts.mjs');
  const fixture = await createArtifactFixture(
    [],
    [
      { name: '@bleedingdev/mf-sdk', version: '2.6.0' },
      { name: '@bleedingdev/braces', version: '3.0.3' },
    ],
  );
  try {
    const { manifest, sidecars, cohortProjection } = fixture.releaseArtifacts;
    assert.equal(cohortProjection.value.schemaVersion, 2);
    assert.deepEqual(cohortProjection.value.sidecars, [
      { name: '@bleedingdev/braces', version: '3.0.3' },
      { name: '@bleedingdev/mf-sdk', version: '2.6.0' },
    ]);
    for (const sidecarRecords of [
      [],
      cohortProjection.value.sidecars.slice(0, 1),
      [
        { name: '@bleedingdev/braces', version: '3.0.4' },
        { name: '@bleedingdev/mf-sdk', version: '2.6.0' },
      ],
    ]) {
      assert.throws(
        () =>
          validateReleaseCohortProjection(
            { ...cohortProjection.value, sidecars: sidecarRecords },
            manifest,
            sidecars,
          ),
        /Release cohort projection does not match/,
      );
    }
    const sidecar = sidecars.packages[0];
    fs.appendFileSync(sidecar.artifactPath, 'tampered');
    assert.throws(
      () => verifyReleaseArtifacts(fixture.releaseArtifacts.outDir),
      /sidecar tarball size mismatch/,
    );
  } finally {
    removeDir(fixture.root);
  }
});

test('verified artifacts reject incomplete or mismatched owned dependency closure', async () => {
  const leaf = { name: '@bleedingdev/leaf', version: '2.1.0' };
  for (const dependency of [
    { leaf: 'npm:@bleedingdev/missing@2.1.0' },
    { '@bleedingdev/missing': '2.1.0' },
    { leaf: 'npm:@bleedingdev/leaf@2.1.1' },
    { '@bleedingdev/leaf': '2.1.1' },
  ]) {
    await assert.rejects(
      () =>
        createArtifactFixture(
          [
            {
              sourceName: '@modern-js/tooling',
              targetName: '@bleedingdev/modern-js-tooling',
              dependencies: dependency,
            },
          ],
          [leaf],
        ),
      /neither a staged sidecar nor a cohort package|stages version/,
    );
  }
  for (const dependency of [
    { '@bleedingdev/missing': '2.1.0' },
    { leaf: 'npm:@bleedingdev/leaf@2.1.1' },
  ]) {
    await assert.rejects(
      () =>
        createArtifactFixture(
          [],
          [
            leaf,
            {
              name: '@bleedingdev/dependent',
              version: '1.0.0',
              dependencies: dependency,
            },
          ],
        ),
      /neither a staged sidecar nor a cohort package|stages version/,
    );
  }
  await assert.rejects(
    () =>
      createArtifactFixture(
        [],
        [
          {
            name: '@bleedingdev/modern-js-unlisted',
            version: '1.0.0',
          },
        ],
      ),
    /Invalid release cohort sidecar/,
  );
});

// A cohort where create depends on i18n-utils, which depends on utils.
const makePublishOrderFixture = () => {
  const root = makeTempDir();
  const aliases = {
    '@modern-js/ultramodern-create':
      '@bleedingdev/modern-js-ultramodern-create',
    '@modern-js/i18n-utils': '@bleedingdev/modern-js-i18n-utils',
    '@modern-js/runtime': '@bleedingdev/modern-js-runtime',
    '@modern-js/utils': '@bleedingdev/modern-js-utils',
  };
  const packages = [
    {
      sourceName: '@modern-js/ultramodern-create',
      dependencies: {
        '@modern-js/i18n-utils':
          'npm:@bleedingdev/modern-js-i18n-utils@3.2.0-ultramodern.1',
      },
    },
    {
      sourceName: '@modern-js/i18n-utils',
      dependencies: {
        '@modern-js/utils':
          'npm:@bleedingdev/modern-js-utils@3.2.0-ultramodern.1',
      },
    },
    { sourceName: '@modern-js/runtime', dependencies: {} },
    { sourceName: '@modern-js/utils', dependencies: {} },
  ].map(item => {
    const targetName = aliases[item.sourceName];
    const packageDir = path.join(
      root,
      targetName.replaceAll('/', '__'),
      'package',
    );
    writeJson(path.join(packageDir, 'package.json'), {
      name: targetName,
      version: '3.2.0-ultramodern.1',
      dependencies: item.dependencies,
      publishConfig: { access: 'public' },
    });
    return {
      sourceName: item.sourceName,
      targetName,
      version: '3.2.0-ultramodern.1',
      packageDir: path.relative(repoRoot, packageDir),
    };
  });

  return {
    root,
    manifest: {
      aliases,
      packages,
      release: { tag: 'latest', version: '3.2.0-ultramodern.1' },
      source: releaseSource,
    },
  };
};

test('parseArgs confines destructive preparation to its owned output tree', async () => {
  const { parseArgs } = await import('../prepare-bleedingdev-packages.mjs');
  const ownedOutput = path.join(repoRoot, '.modern', 'bleedingdev-publish');
  const unsafeOutputs = [
    path.parse(repoRoot).root,
    path.dirname(repoRoot),
    repoRoot,
    path.join(repoRoot, '.modern', 'another-tool'),
    path.join(os.tmpdir(), 'arbitrary-publish-output'),
  ];

  for (const output of unsafeOutputs) {
    assert.throws(
      () => parseArgs(['--version', '3.2.0-ultramodern.1', '--out', output]),
      /--out for package preparation must be inside/,
    );
  }

  assert.equal(
    parseArgs(['--version', '3.2.0-ultramodern.1']).out,
    ownedOutput,
  );
  assert.equal(
    parseArgs([
      '--version',
      '3.2.0-ultramodern.1',
      '--out',
      path.join(ownedOutput, 'candidate'),
    ]).out,
    path.join(ownedOutput, 'candidate'),
  );
});

test('rewritten manifests name their canonical source package', async () => {
  const { rewritePackageJson } = await import(
    '../lib/prepare-bleedingdev-packages/rewrite.mjs'
  );
  const options = {
    scope: 'bleedingdev',
    prefix: 'modern-js-',
    version: '3.2.0-ultramodern.1',
    dependencyVersion: '3.2.0-ultramodern.1',
    homepage: 'https://example.test',
    bugsUrl: 'https://example.test/issues',
    repositoryUrl: 'https://example.test/repo.git',
  };
  const renderer = { name: '@modern-js/renderer-solid', version: '0.0.0' };
  rewritePackageJson(
    renderer,
    renderer.name,
    options,
    new Set([renderer.name]),
  );
  assert.equal(renderer.name, '@bleedingdev/modern-js-renderer-solid');
  assert.deepEqual(renderer.ultramodern, {
    sourceName: '@modern-js/renderer-solid',
  });
  const create = { name: '@modern-js/ultramodern-create', version: '0.0.0' };
  rewritePackageJson(create, create.name, options, new Set([create.name]));
  assert.deepEqual(create.ultramodern, {
    sourceName: '@modern-js/ultramodern-create',
    frameworkVersion: '3.2.0-ultramodern.1',
  });
});

test('orderPublishItems publishes hard dependencies before consumers', async () => {
  const { orderPublishItems } = await import(
    '../prepare-bleedingdev-packages.mjs'
  );
  const fixture = makePublishOrderFixture();

  try {
    const orderedSourceNames = orderPublishItems(
      fixture.manifest.packages,
      fixture.manifest,
    ).map(item => item.sourceName);
    assert(
      orderedSourceNames.indexOf('@modern-js/utils') <
        orderedSourceNames.indexOf('@modern-js/i18n-utils'),
    );
    assert(
      orderedSourceNames.indexOf('@modern-js/i18n-utils') <
        orderedSourceNames.indexOf('@modern-js/ultramodern-create'),
    );
    assert.equal(
      orderedSourceNames.at(-1),
      '@modern-js/ultramodern-create',
      'create must still publish last',
    );
  } finally {
    removeDir(fixture.root);
  }
});

test('verifyRegistryTarball answers an unpinned, forbidden or mismatched body without waiting', async () => {
  const { verifyRegistryTarball } = await import(
    '../prepare-bleedingdev-packages.mjs'
  );
  const { createRegistryPropagationDeadline } = await import(
    '../lib/prepare-bleedingdev-packages/registry-propagation.mjs'
  );
  const fixture = await createArtifactFixture();
  const artifact = fixture.releaseArtifacts.packages[0];
  const bytes = fs.readFileSync(artifact.artifactPath);
  const tampered = Buffer.from(bytes);
  tampered[0] ^= 0xff;
  // Every case below is decisive on its first read. The deadline is deliberately
  // unexpired, so reaching the wait at all is the failure.
  const liveDeadline = () =>
    createRegistryPropagationDeadline({ now: () => 0 });
  const neverWaits = async () => {
    throw new Error('a decisive registry answer must never be retried');
  };

  try {
    // The wait belongs to the publish set, so there is no per-call window left
    // to fall back on when a caller forgets to pass the set's deadline.
    await assert.rejects(
      () =>
        verifyRegistryTarball(artifact, registryDistFor(artifact), {
          fetchImpl: async () => tarballResponse(bytes),
        }),
      /requires the publish set's propagation deadline/,
    );
    await assert.rejects(
      () =>
        verifyRegistryTarball(
          artifact,
          {
            ...registryDistFor(artifact),
            tarball: `https://evil.example/${path.basename(
              artifact.artifactPath,
            )}`,
          },
          {
            deadline: liveDeadline(),
            fetchImpl: async () => {
              throw new Error('must not fetch an unpinned registry URL');
            },
            wait: neverWaits,
          },
        ),
      /not the pinned npm endpoint/,
    );
    await assert.rejects(
      () =>
        verifyRegistryTarball(artifact, registryDistFor(artifact), {
          deadline: liveDeadline(),
          fetchImpl: async () => tarballResponse(tampered),
          wait: neverWaits,
        }),
      /Registry tarball byte mismatch.*sha256.*shasum.*integrity/,
    );
    // 403 is an answer about this artifact, not a propagation state.
    let forbiddenRequests = 0;
    await assert.rejects(
      () =>
        verifyRegistryTarball(artifact, registryDistFor(artifact), {
          deadline: liveDeadline(),
          fetchImpl: async () => {
            forbiddenRequests += 1;
            return { ok: false, status: 403 };
          },
          wait: neverWaits,
        }),
      /returned HTTP 403/,
    );
    assert.equal(forbiddenRequests, 1);
  } finally {
    removeDir(fixture.root);
  }
});

test('one propagation deadline bounds the tarball wait of a whole publish set', async () => {
  const { verifyRegistryTarball } = await import(
    '../prepare-bleedingdev-packages.mjs'
  );
  const {
    createRegistryPropagationDeadline,
    registryPropagationBudgetMs,
    registryPropagationDelaysMs,
  } = await import(
    '../lib/prepare-bleedingdev-packages/registry-propagation.mjs'
  );
  const fixture = await createArtifactFixture();
  const artifact = fixture.releaseArtifacts.packages[0];
  const bytes = fs.readFileSync(artifact.artifactPath);
  try {
    let clockMs = 0;
    const waits = [];
    const wait = async ms => {
      waits.push(ms);
      clockMs += ms;
    };
    const deadline = createRegistryPropagationDeadline({ now: () => clockMs });

    // npm lists a version before it serves the tarball; run 43780469169
    // measured 402.9s of that lag, far past the removed 8 x 15s window.
    const statuses = [404, 503, 429];
    const verified = await verifyRegistryTarball(
      artifact,
      registryDistFor(artifact),
      {
        deadline,
        fetchImpl: async () => {
          const status = statuses.shift();
          return status ? { ok: false, status } : tarballResponse(bytes);
        },
        wait,
      },
    );
    assert.equal(verified.integrity, artifact.integrity);
    assert.deepEqual(waits, registryPropagationDelaysMs.slice(0, 3));

    // The next member of the same set spends what is left of the one budget,
    // never a fresh window of its own.
    let requests = 0;
    await assert.rejects(
      () =>
        verifyRegistryTarball(artifact, registryDistFor(artifact), {
          deadline,
          fetchImpl: async () => {
            requests += 1;
            return { ok: false, status: 404 };
          },
          wait,
        }),
      /returned HTTP 404/,
    );
    assert.equal(
      waits.reduce((total, ms) => total + ms, 0),
      registryPropagationBudgetMs,
      'the whole set waits at most one propagation budget',
    );
    assert.equal(clockMs, registryPropagationBudgetMs);
    assert.ok(
      requests > 8,
      `a single member read the tarball ${requests} times; the removed per-call window stopped at 8`,
    );

    // A third member inherits the spent deadline and fails on its first read,
    // so 50 cohort members cannot multiply the window.
    let lateRequests = 0;
    await assert.rejects(
      () =>
        verifyRegistryTarball(artifact, registryDistFor(artifact), {
          deadline,
          fetchImpl: async () => {
            lateRequests += 1;
            return { ok: false, status: 404 };
          },
          wait: async () => {
            throw new Error('a spent set deadline must not wait again');
          },
        }),
      /returned HTTP 404/,
    );
    assert.equal(lateRequests, 1);
  } finally {
    removeDir(fixture.root);
  }
});

test('the published cohort verifies every member against one shared deadline', async () => {
  const { validateRegistryCohort } = await import(
    '../prepare-bleedingdev-packages.mjs'
  );
  const fixture = await createArtifactFixture();
  try {
    const deadlines = [];
    const expectations = new Set();
    const provenanceExpectation = { invocation: { exactAttempt: true } };
    const verified = await validateRegistryCohort(
      fixture.releaseArtifacts.manifest,
      { provenanceExpectation, publishConcurrency: 8, tag: 'latest' },
      {
        verifyRegistryDistTag: async () => {},
        verifyRegistryPackage: async (item, expectation, options) => {
          deadlines.push(options?.deadline);
          expectations.add(expectation);
          return { tarball: item.targetName };
        },
      },
    );
    assert.deepEqual(
      [...verified],
      fixture.releaseArtifacts.manifest.packages.map(item => [
        item.targetName,
        { tarball: item.targetName },
      ]),
    );
    assert.deepEqual(
      [...expectations],
      [provenanceExpectation],
      'the caller names the publishing run; the verifier never derives it',
    );
    await assert.rejects(
      validateRegistryCohort(
        fixture.releaseArtifacts.manifest,
        { publishConcurrency: 8, tag: 'latest' },
        {
          verifyRegistryDistTag: async () => {},
          verifyRegistryPackage: async () => ({}),
        },
      ),
      /provenance expectation/,
    );
    assert.equal(
      deadlines.length,
      fixture.releaseArtifacts.manifest.packages.length,
    );
    assert.ok(deadlines.length > 1);
    assert.equal(typeof deadlines[0]?.remainingMs, 'function');
    assert.equal(
      new Set(deadlines).size,
      1,
      'the cohort is one publish set and waits on one deadline',
    );
  } finally {
    removeDir(fixture.root);
  }
});

test('publishPackage outlasts a slow Rekor that answers 409 for its own retried entry', async () => {
  const { publishPackage } = await import(
    '../prepare-bleedingdev-packages.mjs'
  );
  const fixture = await createArtifactFixture();
  const artifact = fixture.releaseArtifacts.packages[0];
  const bytes = fs.readFileSync(artifact.artifactPath);
  const tlogConflict = () =>
    Object.assign(
      new Error(
        'error creating tlog entry - (409) an equivalent entry already exists in the transparency log',
      ),
      { code: 'TLOG_CREATE_ENTRY_ERROR' },
    );
  try {
    let calls = 0;
    const waits = [];
    const published = await publishPackage(
      artifact,
      { dryRun: false, tag: 'latest' },
      {
        artifactReader: () => bytes,
        publishAcceptedPackage: async () => {
          calls += 1;
          if (calls < 6) throw tlogConflict();
        },
        wait: async delay => waits.push(delay),
      },
    );
    assert.equal(published, artifact.targetName);
    assert.equal(calls, 6);
    assert.deepEqual(waits, [15_000, 30_000, 45_000, 60_000, 75_000]);

    calls = 0;
    await assert.rejects(
      () =>
        publishPackage(
          artifact,
          { dryRun: false, tag: 'latest' },
          {
            artifactReader: () => bytes,
            publishAcceptedPackage: async () => {
              calls += 1;
              throw tlogConflict();
            },
            wait: async () => {},
          },
        ),
      /equivalent entry already exists/,
    );
    assert.equal(calls, 6);

    calls = 0;
    await assert.rejects(
      () =>
        publishPackage(
          artifact,
          { dryRun: false, tag: 'latest' },
          {
            artifactReader: () => bytes,
            publishAcceptedPackage: async () => {
              calls += 1;
              throw new Error('E403 forbidden');
            },
            wait: async () => {},
          },
        ),
      /E403 forbidden/,
    );
    assert.equal(calls, 1);
  } finally {
    removeDir(fixture.root);
  }
});

test('publishPackageBuffer gives provenance signing the registry timeout, not the 5s Sigstore default', async () => {
  const { publishPackageBuffer } = await import(
    '../prepare-bleedingdev-packages.mjs'
  );
  const fixture = await createArtifactFixture();
  const artifact = fixture.releaseArtifacts.packages[0];
  const bytes = fs.readFileSync(artifact.artifactPath);
  try {
    const calls = [];
    const runtime = {
      npmVersion: '11.20.0',
      libnpmpublishVersion: '11.1.0',
      publish: async (manifest, data, options) =>
        calls.push({ manifest, data, options }),
    };
    await publishPackageBuffer(
      artifact,
      bytes,
      {
        acceptedTools: {
          node: process.version,
          npm: runtime.npmVersion,
          pnpm: '10.0.0',
        },
        authToken: 'token',
        provenance: true,
        registryUrl: 'https://registry.npmjs.org/',
        tag: 'latest',
      },
      { runtime },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.provenance, true);
    assert.equal(calls[0].options.timeout, 300_000);
  } finally {
    removeDir(fixture.root);
  }
});

test('verifyRegistryProvenance validates npm DSSE SLSA subject bytes and trusted source', async () => {
  const { createRegistryProvenanceExpectation, verifyRegistryProvenance } =
    await import('../prepare-bleedingdev-packages.mjs');
  const fixture = await createArtifactFixture();
  const artifact = fixture.releaseArtifacts.packages.find(
    item => item.sourceName === '@modern-js/runtime',
  );
  const expectation = createRegistryProvenanceExpectation(
    fixture.releaseArtifacts.manifest,
    {
      GITHUB_REF: trustedWorkflow.ref,
      GITHUB_REPOSITORY: 'BleedingDev/ultramodern.js',
    },
  );
  const document = provenanceDocument(provenanceStatement(artifact));
  const fetchCalls = [];
  const sigstoreCalls = [];

  try {
    const result = await verifyRegistryProvenance(
      artifact,
      provenanceDist,
      expectation,
      async (url, options) => {
        fetchCalls.push({ options, url });
        return provenanceResponse(document);
      },
      async (bundle, verifiedExpectation) => {
        sigstoreCalls.push({ bundle, expectation: verifiedExpectation });
        return sigstoreVerificationResult(verifiedExpectation);
      },
    );

    assert.equal(result.subject, npmPurl(artifact));
    assert.equal(result.sourceCommit, releaseSource.commit);
    assert.equal(
      result.subjectSha512,
      provenanceStatement(artifact).subject[0].digest.sha512,
    );
    assert.equal(fetchCalls.length, 1);
    assert.equal(sigstoreCalls.length, 1);
    assert.equal(sigstoreCalls[0].bundle, document.attestations[0].bundle);
    assert.equal(sigstoreCalls[0].expectation, expectation);
    assert.deepEqual(expectation, {
      certificateIdentity:
        'https://github.com/BleedingDev/ultramodern.js/.github/workflows/publish-bleedingdev.yml@refs/heads/main-ultramodern',
      issuer: trustedOidcIssuer,
      source: releaseSource,
      workflow: {
        path: trustedWorkflow.path,
        ref: trustedWorkflow.ref,
        repository: 'BleedingDev/ultramodern.js',
      },
    });
  } finally {
    removeDir(fixture.root);
  }
});

test('buffer publisher exchanges GitHub OIDC and sends only accepted bytes to libnpmpublish', async () => {
  const { publishAcceptedPackage } = await import(
    '../prepare-bleedingdev-packages.mjs'
  );
  const fixture = await createArtifactFixture();
  const artifact = fixture.releaseArtifacts.packages[0];
  const acceptedBytes = fs.readFileSync(artifact.artifactPath);
  const requests = [];
  let published;

  try {
    await publishAcceptedPackage(
      artifact,
      acceptedBytes,
      {
        acceptedTools: {
          node: process.version,
          npm: '11.17.0',
          pnpm: '10.28.2',
        },
        tag: 'latest',
      },
      {
        env: {
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'github-request-token',
          ACTIONS_ID_TOKEN_REQUEST_URL:
            'https://pipelines.actions.githubusercontent.com/example/oidc?api-version=2.0',
          GITHUB_ACTIONS: 'true',
        },
        fetchImpl: async (url, options) => {
          requests.push({ options, url: new URL(url).href });
          return requests.length === 1
            ? {
                ok: true,
                json: async () => ({ value: 'github.oidc.token' }),
              }
            : {
                ok: true,
                json: async () => ({ token: 'npm-publish-token' }),
              };
        },
        loadRuntime: () => ({
          libnpmpublishVersion: '11.2.0',
          npmVersion: '11.17.0',
          publish: async (manifest, bytes, options) => {
            published = {
              bytes: Buffer.from(bytes),
              manifest,
              options,
            };
          },
        }),
      },
    );

    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /audience=npm%3Aregistry\.npmjs\.org/u);
    assert.equal(
      requests[0].options.headers.authorization,
      'Bearer github-request-token',
    );
    assert.equal(requests[1].options.method, 'POST');
    assert.equal(
      new URL(requests[1].url).pathname,
      `/-/npm/v1/oidc/token/exchange/package/${artifact.targetName.replace('/', '%2f')}`,
    );
    assert.equal(
      requests[1].options.headers.authorization,
      'Bearer github.oidc.token',
    );
    assert.deepEqual(published.bytes, acceptedBytes);
    assert.notEqual(published.bytes, acceptedBytes);
    assert.equal(published.manifest.name, artifact.targetName);
    assert.equal(published.manifest.version, artifact.version);
    assert.equal(published.options.access, 'public');
    assert.equal(published.options.defaultTag, 'latest');
    assert.equal(published.options.provenance, true);
    assert.equal(
      published.options['//registry.npmjs.org/:_authToken'],
      'npm-publish-token',
    );
  } finally {
    removeDir(fixture.root);
  }
});

test('registry preflight rejects a non-forward candidate before publication', async () => {
  const { preflightRegistryPackages } = await import(
    '../prepare-bleedingdev-packages.mjs'
  );
  const targetName = '@bleedingdev/modern-js-create';
  const version = '3.5.0-ultramodern.102';

  await assert.rejects(
    () =>
      preflightRegistryPackages(
        [{ targetName, version }],
        { dryRun: false, tag: 'latest', version },
        {},
        {
          lookupRegistryDistTag: async () => '3.5.0-ultramodern.103',
          lookupRegistryPackageDist: async () => null,
          verifyRegistryPackageDist: async () => {
            throw new Error(
              'absent candidates have no registry bytes to verify',
            );
          },
        },
      ),
    /must be greater than current latest 3\.5\.0-ultramodern\.103/u,
  );
});

test('trusted publishing rejects the entire absent cohort before the first registry mutation', async t => {
  mockTrustedWorkflowEnvironment(t);
  const { publishManifestPackages } = await import(
    '../prepare-bleedingdev-packages.mjs'
  );
  const fixture = await createArtifactFixture();
  const exchangeRequests = [];
  const registryMutations = [];

  try {
    await assert.rejects(
      () =>
        publishManifestPackages(
          fixture.releaseArtifacts,
          {
            dryRun: false,
            publishConcurrency: 1,
            tag: 'latest',
            version: '3.2.0-ultramodern.1',
          },
          {
            lookupRegistryDistTag: async () => '3.1.0-ultramodern.previous',
            lookupRegistryPackageDist: async () => null,
            publishPackage: async artifact => {
              registryMutations.push(artifact.targetName);
              return artifact.targetName;
            },
            trustedPublishing: {
              env: {
                ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'github-request-token',
                ACTIONS_ID_TOKEN_REQUEST_URL:
                  'https://pipelines.actions.githubusercontent.com/example/oidc?api-version=2.0',
                GITHUB_ACTIONS: 'true',
              },
              fetchImpl: async url => {
                const requestUrl = new URL(url);
                if (
                  requestUrl.hostname.endsWith('.actions.githubusercontent.com')
                ) {
                  return {
                    ok: true,
                    json: async () => ({
                      value: `github.oidc.token.${exchangeRequests.length + 1}`,
                    }),
                  };
                }
                exchangeRequests.push(requestUrl.pathname);
                return exchangeRequests.length === 2
                  ? { ok: false, status: 403 }
                  : {
                      ok: true,
                      json: async () => ({
                        token: `discarded-preflight-token-${exchangeRequests.length}`,
                      }),
                    };
              },
            },
            verifyRegistryPackage: async () => {},
          },
        ),
      error => {
        assert.match(error.message, /returned HTTP 403/u);
        assert.match(
          error.message,
          new RegExp(
            `npm trusted publishing preflight failed for 1 of ${fixture.releaseArtifacts.manifest.publishOrder.length} package\\(s\\):`,
            'u',
          ),
        );
        return true;
      },
    );

    assert.deepEqual(
      exchangeRequests,
      fixture.releaseArtifacts.manifest.publishOrder.map(
        packageName =>
          `/-/npm/v1/oidc/token/exchange/package/${packageName.replace('/', '%2f')}`,
      ),
    );
    assert.deepEqual(registryMutations, []);
  } finally {
    removeDir(fixture.root);
  }
});

// utils <- runtime <- plugin-a, then eight independent plugins, then create.
const createPoolFixture = () =>
  createArtifactFixture([
    {
      sourceName: '@modern-js/plugin-a',
      targetName: '@bleedingdev/modern-js-plugin-a',
      dependencies: {
        '@modern-js/runtime':
          'npm:@bleedingdev/modern-js-runtime@3.2.0-ultramodern.1',
      },
    },
    ...'bcdefghi'.split('').map(letter => ({
      sourceName: `@modern-js/plugin-${letter}`,
      targetName: `@bleedingdev/modern-js-plugin-${letter}`,
      dependencies: {},
    })),
  ]);
const createTarget = '@bleedingdev/modern-js-ultramodern-create';
const poolOptions = (publishConcurrency, dryRun = true) => ({
  dryRun,
  publishConcurrency,
  tag: 'latest',
  version: '3.2.0-ultramodern.1',
});
// Records every upload's start and end; `behaviour[targetName]` replaces the
// default acceptance after 5 ms.
const recordUploads = (behaviour = {}) => {
  const events = [];
  const inFlight = new Set();
  let maxInFlight = 0;
  const publishPackage = async artifact => {
    events.push(['start', artifact.targetName]);
    inFlight.add(artifact.targetName);
    maxInFlight = Math.max(maxInFlight, inFlight.size);
    try {
      await (
        behaviour[artifact.targetName] ??
        (() => new Promise(resolve => setTimeout(resolve, 5)))
      )();
    } catch (error) {
      events.push(['fail', artifact.targetName]);
      throw error;
    } finally {
      inFlight.delete(artifact.targetName);
    }
    events.push(['end', artifact.targetName]);
    return artifact.targetName;
  };
  const indexOf = (kind, targetName) =>
    events.findIndex(
      ([eventKind, name]) => eventKind === kind && name === targetName,
    );
  const started = () =>
    events.filter(([kind]) => kind === 'start').map(([, name]) => name);
  return {
    events,
    indexOf,
    maxInFlight: () => maxInFlight,
    publishPackage,
    started,
  };
};
const absentRegistry = {
  lookupRegistryDistTag: async () => '3.1.0-ultramodern.previous',
  lookupRegistryPackageDist: async () => null,
};
// A promise the test settles by hand, so an upload ends exactly when asked.
const gate = () => {
  let open;
  let fail;
  const promise = new Promise((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { fail, open, wait: () => promise };
};
const utilsTarget = '@bleedingdev/modern-js-utils';
const runtimeTarget = '@bleedingdev/modern-js-runtime';
const pluginATarget = '@bleedingdev/modern-js-plugin-a';
// Every dependency edge: the dependency returned before its consumer started.
const assertDependenciesReturnedFirst = (uploads, manifest) => {
  for (const [targetName, dependencies] of Object.entries(
    manifest.dependencyGraph,
  )) {
    if (uploads.indexOf('start', targetName) === -1) {
      continue;
    }
    for (const dependency of dependencies) {
      const end = uploads.indexOf('end', dependency);
      assert.ok(
        end !== -1 && end < uploads.indexOf('start', targetName),
        `${targetName} started before npm accepted ${dependency}`,
      );
    }
  }
};

test('the cohort uploads each member once npm accepted its dependencies, at most N at a time, without level barriers, create last', async t => {
  mockTrustedWorkflowEnvironment(t);
  const { publishManifestPackages } = await import(
    '../prepare-bleedingdev-packages.mjs'
  );
  const fixture = await createPoolFixture();
  const { manifest } = fixture.releaseArtifacts;
  const members = manifest.publishOrder.filter(name => name !== createTarget);
  assert.equal(manifest.publishOrder.at(-1), createTarget);
  assert.equal(members.length, 11);

  try {
    for (const concurrency of [2, 8]) {
      // utils is slow, so the independent plugins overtake it.
      const slowUtils = gate();
      const uploads = recordUploads({ [utilsTarget]: slowUtils.wait });
      const published = publishManifestPackages(
        fixture.releaseArtifacts,
        poolOptions(concurrency),
        { ...absentRegistry, publishPackage: uploads.publishPackage },
      );
      // Every plugin that does not depend on utils finishes while it is held.
      const independent = members.filter(
        name => ![utilsTarget, runtimeTarget, pluginATarget].includes(name),
      );
      while (!independent.every(name => uploads.indexOf('end', name) !== -1)) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      // runtime and plugin-a wait for utils; nothing waits for a level.
      assert.equal(uploads.indexOf('start', runtimeTarget), -1);
      assert.equal(uploads.indexOf('start', pluginATarget), -1);
      slowUtils.open();
      await published;

      assertDependenciesReturnedFirst(uploads, manifest);
      // The pool is as wide as the cap and never wider.
      assert.equal(uploads.maxInFlight(), concurrency);
      // create starts only after every other member returned.
      for (const member of members) {
        assert.ok(
          uploads.indexOf('end', member) <
            uploads.indexOf('start', createTarget),
          `create started before ${member} returned at concurrency ${concurrency}`,
        );
      }
      assert.deepEqual(
        uploads.started().sort(),
        [...manifest.publishOrder].sort(),
      );
      assert.equal(uploads.events.length, manifest.publishOrder.length * 2);
    }
  } finally {
    removeDir(fixture.root);
  }
});

test('a failed upload leaves no consumer of it on npm: nothing starts after it, its dependents never do, create never does', async t => {
  mockTrustedWorkflowEnvironment(t);
  const { publishManifestPackages } = await import(
    '../prepare-bleedingdev-packages.mjs'
  );
  const fixture = await createPoolFixture();
  const { manifest } = fixture.releaseArtifacts;

  try {
    // utils fails while the independent plugins are still in flight: those
    // finish, its consumers (runtime, plugin-a) never start, nor does
    // anything else, and the failure surfaces.
    const failingUtils = gate();
    const held = gate();
    const behaviour = { [utilsTarget]: failingUtils.wait };
    for (const name of manifest.publishOrder) {
      if (name !== utilsTarget) {
        behaviour[name] = held.wait;
      }
    }
    const uploads = recordUploads(behaviour);
    const published = publishManifestPackages(
      fixture.releaseArtifacts,
      poolOptions(8),
      { ...absentRegistry, publishPackage: uploads.publishPackage },
    );
    while (uploads.started().length < 8) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    const inFlight = uploads.started();
    assert.ok(inFlight.includes(utilsTarget));
    assert.ok(!inFlight.includes(runtimeTarget));
    failingUtils.fail(new Error('fixture: npm publish failed for utils'));
    await new Promise(resolve => setTimeout(resolve, 5));
    held.open();
    await assert.rejects(published, /fixture: npm publish failed for utils/u);

    assert.deepEqual(uploads.started(), inFlight);
    assert.equal(uploads.indexOf('start', runtimeTarget), -1);
    assert.equal(uploads.indexOf('start', pluginATarget), -1);
    assert.equal(uploads.indexOf('start', createTarget), -1);
    assertDependenciesReturnedFirst(uploads, manifest);
    for (const name of inFlight.filter(name => name !== utilsTarget)) {
      assert.notEqual(uploads.indexOf('end', name), -1);
    }
  } finally {
    removeDir(fixture.root);
  }
});

test('a rerun after a failed upload reuses what npm accepted and uploads only the rest, create last', async t => {
  mockTrustedWorkflowEnvironment(t);
  const { publishManifestPackages } = await import(
    '../prepare-bleedingdev-packages.mjs'
  );
  const fixture = await createPoolFixture();
  const { manifest } = fixture.releaseArtifacts;
  const artifacts = new Map(
    fixture.releaseArtifacts.packages.map(item => [item.targetName, item]),
  );
  // The fake registry keeps the integrity npm accepted for each target.
  const npm = new Map();
  const registry = {
    lookupRegistryDistTag: async name =>
      npm.has(name) ? '3.2.0-ultramodern.1' : '3.1.0-ultramodern.previous',
    lookupRegistryPackageDist: async name =>
      npm.has(name)
        ? { ...registryDistFor(artifacts.get(name)), integrity: npm.get(name) }
        : null,
    preflightTrustedPublishingPackages: async () => {},
    verifyRegistryPackageDist: async (item, dist) => {
      assert.equal(
        dist.integrity,
        item.integrity,
        `${item.targetName} drifted`,
      );
    },
  };
  const accept = artifact => {
    npm.set(artifact.targetName, artifact.integrity);
    return artifact.targetName;
  };
  const failing = '@bleedingdev/modern-js-plugin-c';

  try {
    const first = [];
    await assert.rejects(
      publishManifestPackages(fixture.releaseArtifacts, poolOptions(2, false), {
        ...registry,
        publishPackage: async artifact => {
          first.push(artifact.targetName);
          await new Promise(resolve => setTimeout(resolve, 5));
          if (artifact.targetName === failing) {
            throw new Error('fixture: npm publish failed for plugin-c');
          }
          return accept(artifact);
        },
      }),
      /fixture: npm publish failed for plugin-c/u,
    );
    assert.equal(npm.has(failing), false);
    assert.equal(npm.has(createTarget), false);
    const placed = [...npm.keys()];
    assert.ok(placed.length > 0);
    // What the failed attempt left on npm is installable: every package it
    // placed has each of its cohort dependencies there too.
    for (const name of placed) {
      for (const dependency of manifest.dependencyGraph[name]) {
        assert.ok(
          npm.has(dependency),
          `${name} is on npm without ${dependency}`,
        );
      }
    }

    const second = [];
    await publishManifestPackages(
      fixture.releaseArtifacts,
      poolOptions(2, false),
      {
        ...registry,
        publishPackage: async artifact => {
          second.push(artifact.targetName);
          return accept(artifact);
        },
      },
    );
    assert.deepEqual(
      [...second].sort(),
      manifest.publishOrder.filter(name => !placed.includes(name)).sort(),
    );
    assert.equal(second.at(-1), createTarget);
    assert.deepEqual([...npm.keys()].sort(), [...manifest.publishOrder].sort());
  } finally {
    removeDir(fixture.root);
  }
});

test('a live publish returns once npm accepted the last tarball and never polls the registry back', async t => {
  mockTrustedWorkflowEnvironment(t);
  const { publishManifestPackages } = await import(
    '../prepare-bleedingdev-packages.mjs'
  );
  const fixture = await createArtifactFixture();
  const published = [];
  const readBack = () => {
    throw new Error(
      'registry read-back belongs to accept-bleedingdev-release.yml',
    );
  };
  try {
    await publishManifestPackages(
      fixture.releaseArtifacts,
      {
        dryRun: false,
        publishConcurrency: 8,
        tag: 'latest',
        version: '3.2.0-ultramodern.1',
      },
      {
        lookupRegistryDistTag: async () => '3.1.0-ultramodern.previous',
        lookupRegistryPackageDist: async () => null,
        preflightTrustedPublishingPackages: async () => {},
        publishPackage: async artifact => {
          published.push(artifact.targetName);
          return artifact.targetName;
        },
        validateRegistryCohort: readBack,
        verifyRegistryDistTag: readBack,
        verifyRegistryPackage: readBack,
      },
    );
    assert.deepEqual(
      [...published].sort(),
      [...fixture.releaseArtifacts.manifest.publishOrder].sort(),
    );
  } finally {
    removeDir(fixture.root);
  }
});

test('dry-run validation cannot publish or request credentials', async () => {
  const { validateAcceptedPackageDryRun } = await import(
    '../prepare-bleedingdev-packages.mjs'
  );
  const fixture = await createArtifactFixture();
  const artifact = fixture.releaseArtifacts.packages[0];
  const acceptedBytes = fs.readFileSync(artifact.artifactPath);
  let credentialRequests = 0;
  let publishCalls = 0;

  try {
    validateAcceptedPackageDryRun(
      artifact,
      acceptedBytes,
      { acceptedTools: releaseTools, tag: 'latest' },
      {
        loadRuntime: () => ({
          libnpmpublishVersion: 'fixture-libnpmpublish',
          npmVersion: releaseTools.npm,
          publish: async () => {
            publishCalls += 1;
          },
        }),
        requestToken: async () => {
          credentialRequests += 1;
          throw new Error('dry-run must not request credentials');
        },
      },
    );

    assert.equal(credentialRequests, 0);
    assert.equal(publishCalls, 0);
  } finally {
    removeDir(fixture.root);
  }
});

test('registry entrypoints fetch source state and accept an already coherent published package without retrying', async t => {
  const api = await import('../prepare-bleedingdev-packages.mjs');
  const packageName = '@bleedingdev/modern-js-ultramodern-create';
  const request = {
    packageName,
    requestedVersion: '3.2.0-ultramodern.1',
    sourceCommit: releaseSource.commit,
    sourceRepository: releaseSource.repository,
    env: {},
  };
  let fetchedUrl;
  const state = await api.assertRegistrySourceCommitUnpublished(request, {
    fetchImpl: async url => {
      fetchedUrl = url;
      return { ok: false, status: 404 };
    },
  });
  assert.equal(
    fetchedUrl,
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}?write=true`,
  );
  assert.equal(state.versionCount, 0);
  await assert.rejects(
    api.assertRegistrySourceCommitUnpublished(request, {
      fetchImpl: async () => ({ ok: false, status: 429 }),
    }),
    /HTTP 429/,
  );

  const fixture = await createArtifactFixture();
  try {
    const artifact = fixture.releaseArtifacts.packages[0];
    const dist = registryDistFor(artifact);
    const bytes = fs.readFileSync(artifact.artifactPath);
    let provenanceChecks = 0;
    t.mock.method(globalThis, 'setTimeout', () => {
      throw new Error(
        'A coherent package must not enter the propagation retry wait',
      );
    });
    const verified = await api.verifyRegistryPackage(
      artifact,
      api.createRegistryProvenanceExpectation(
        fixture.releaseArtifacts.manifest,
        {},
      ),
      {
        assertRegistryDistMatches: api.assertRegistryDistMatches,
        lookupRegistryPackageDist: async () => dist,
        verifyRegistryPackageDist: api.verifyRegistryPackageDist,
        verifyRegistryProvenance: async () => {
          provenanceChecks += 1;
        },
        verifyRegistryTarball: (item, metadata, options) =>
          api.verifyRegistryTarball(item, metadata, {
            ...options,
            fetchImpl: async () => tarballResponse(bytes),
          }),
      },
    );
    assert.equal(verified, dist);
    assert.equal(provenanceChecks, 1);
  } finally {
    removeDir(fixture.root);
  }
});

test('cohort preparation rejects sidecar repository metadata from a different trusted source path', async () => {
  await assert.rejects(
    createArtifactFixture(
      [],
      [
        {
          name: '@bleedingdev/braces',
          version: '3.0.3',
          repository: 'ultramodernjs/ultramodern.js',
        },
      ],
    ),
    /package repository does not match its producer source repository/,
  );
});
