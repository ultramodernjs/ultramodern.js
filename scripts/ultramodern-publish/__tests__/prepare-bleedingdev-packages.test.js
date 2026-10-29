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

test('verifyRegistryTarball rejects missing, unpinned, and byte-mismatched registry bodies', async () => {
  const { verifyRegistryTarball } = await import(
    '../prepare-bleedingdev-packages.mjs'
  );
  const fixture = await createArtifactFixture();
  const artifact = fixture.releaseArtifacts.packages[0];
  const bytes = fs.readFileSync(artifact.artifactPath);
  const tampered = Buffer.from(bytes);
  tampered[0] ^= 0xff;

  try {
    await assert.rejects(
      () =>
        verifyRegistryTarball(
          artifact,
          registryDistFor(artifact),
          async () => ({ ok: false, status: 404 }),
          async () => {},
        ),
      /returned HTTP 404/,
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
          async () => {
            throw new Error('must not fetch an unpinned registry URL');
          },
        ),
      /not the pinned npm endpoint/,
    );
    await assert.rejects(
      () =>
        verifyRegistryTarball(
          artifact,
          registryDistFor(artifact),
          async () => tarballResponse(tampered),
          async () => {
            throw new Error('a byte mismatch must not be retried');
          },
        ),
      /Registry tarball byte mismatch.*sha256.*shasum.*integrity/,
    );
  } finally {
    removeDir(fixture.root);
  }
});

test('verifyRegistryTarball waits for a listed tarball that npm has not served yet', async () => {
  const { verifyRegistryTarball } = await import(
    '../prepare-bleedingdev-packages.mjs'
  );
  const fixture = await createArtifactFixture();
  const artifact = fixture.releaseArtifacts.packages[0];
  const bytes = fs.readFileSync(artifact.artifactPath);
  try {
    const statuses = [404, 503, 429];
    const waits = [];
    const verified = await verifyRegistryTarball(
      artifact,
      registryDistFor(artifact),
      async () => {
        const status = statuses.shift();
        return status ? { ok: false, status } : tarballResponse(bytes);
      },
      async delay => waits.push(delay),
    );
    assert.equal(verified.integrity, artifact.integrity);
    assert.deepEqual(waits, [15_000, 15_000, 15_000]);

    let requests = 0;
    await assert.rejects(
      () =>
        verifyRegistryTarball(
          artifact,
          registryDistFor(artifact),
          async () => {
            requests += 1;
            return { ok: false, status: 404 };
          },
          async () => {},
        ),
      /returned HTTP 404/,
    );
    assert.equal(requests, 8);

    requests = 0;
    await assert.rejects(
      () =>
        verifyRegistryTarball(
          artifact,
          registryDistFor(artifact),
          async () => {
            requests += 1;
            return { ok: false, status: 403 };
          },
          async () => {},
        ),
      /returned HTTP 403/,
    );
    assert.equal(requests, 1);
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

test('full-cohort publish runs each dependency level concurrently and never starts a consumer before its dependencies return', async t => {
  mockTrustedWorkflowEnvironment(t);
  const { publishManifestPackages } = await import(
    '../prepare-bleedingdev-packages.mjs'
  );
  // plugin-a depends on runtime -> utils; plugin-b and utils share level 0.
  const fixture = await createArtifactFixture([
    {
      sourceName: '@modern-js/plugin-a',
      targetName: '@bleedingdev/modern-js-plugin-a',
      dependencies: {
        '@modern-js/runtime':
          'npm:@bleedingdev/modern-js-runtime@3.2.0-ultramodern.1',
      },
    },
    {
      sourceName: '@modern-js/plugin-b',
      targetName: '@bleedingdev/modern-js-plugin-b',
      dependencies: {},
    },
  ]);
  const { manifest } = fixture.releaseArtifacts;
  const events = [];
  const inFlight = new Set();
  let maxInFlight = 0;

  try {
    await publishManifestPackages(
      fixture.releaseArtifacts,
      {
        dryRun: true,
        publishConcurrency: 8,
        tag: 'latest',
        version: '3.2.0-ultramodern.1',
      },
      {
        lookupRegistryDistTag: async () => '3.1.0-ultramodern.previous',
        lookupRegistryPackageDist: async () => null,
        publishPackage: async artifact => {
          events.push(['start', artifact.targetName]);
          inFlight.add(artifact.targetName);
          maxInFlight = Math.max(maxInFlight, inFlight.size);
          await new Promise(resolve => setTimeout(resolve, 10));
          inFlight.delete(artifact.targetName);
          events.push(['end', artifact.targetName]);
          return artifact.targetName;
        },
      },
    );

    const indexOf = (kind, targetName) =>
      events.findIndex(
        ([eventKind, eventTarget]) =>
          eventKind === kind && eventTarget === targetName,
      );
    for (const targetName of manifest.publishOrder) {
      for (const dependency of manifest.dependencyGraph[targetName]) {
        assert.ok(
          indexOf('end', dependency) < indexOf('start', targetName),
          `${targetName} started before ${dependency} returned`,
        );
      }
    }
    // utils and plugin-b share the first level and publish together.
    assert.equal(maxInFlight, 2);
    // create keeps its publish-last contract as a level of its own.
    assert.deepEqual(events.slice(-2), [
      ['start', '@bleedingdev/modern-js-ultramodern-create'],
      ['end', '@bleedingdev/modern-js-ultramodern-create'],
    ]);
    assert.equal(events.length, manifest.publishOrder.length * 2);
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
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
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
        verifyRegistryTarball: (item, metadata) =>
          api.verifyRegistryTarball(item, metadata, async () =>
            tarballResponse(bytes),
          ),
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
