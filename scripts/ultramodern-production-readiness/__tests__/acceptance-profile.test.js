const assert = require('node:assert/strict');
const fs = require('node:fs');
const { registerHooks } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const {
  createOperationalAcceptanceReceiptFixture,
} = require('./support/operational-acceptance-fixture');

const proofRoot = path.resolve(__dirname, '../published-create-proof');
const profileUrl = pathToFileURL(
  path.join(proofRoot, 'acceptance-profile.mjs'),
).href;
const moduleUrl = relative =>
  pathToFileURL(path.resolve(proofRoot, relative)).href;

// Replace expensive process/artifact boundaries, not the acceptance runner or
// receipt/runtime contracts. No install, build, registry, Git or browser runs.
const replacements = new Map([
  [
    moduleUrl('./registry-cohort.mjs'),
    `export async function verifyRegistryCohort() { return { packageCount: 1 }; }`,
  ],
  [
    moduleUrl('./dependency-closure-audit.mjs'),
    `
    export * from ${JSON.stringify(moduleUrl('./dependency-closure-audit.mjs'))};
    import fs from 'node:fs';
    export const parseYamlFile = file => JSON.parse(fs.readFileSync(file, 'utf8'));
    export const verifyStrictInstallInputs = () => ({ verified: true });
  `,
  ],
  [
    moduleUrl('./package-cohort.mjs'),
    `
    export * from ${JSON.stringify(moduleUrl('./package-cohort.mjs'))};
    export const assertGeneratedCohort = () => ({ packageCount: 1 });
  `,
  ],
  [
    moduleUrl('../browser-smoke/contract.mjs'),
    `export const readSmokeContract = () => ({ contract: {} });`,
  ],
  [
    moduleUrl('../browser-smoke/targets.mjs'),
    `export const createSmokeTargets = () => ({ targets: [] });`,
  ],
  [
    moduleUrl('./acceptance-assertions.mjs'),
    `
    export const readWorkspaceAcceptanceArtifacts = () => ({});
    export const assertWorkspaceCheckContract = () => ({ checked: true });
    export const assertTopologyAcceptance = () => ({ checked: true });
    export const assertModuleFederationAcceptance = () => ({ checked: true });
    export const assertApiAcceptance = () => ({ checked: true });
    export const assertBackendAcceptance = () => ({ checked: true });
  `,
  ],
  [
    moduleUrl('../operational-independence.mjs'),
    `
    import fs from 'node:fs';
    export const captureOperationalBaseline = ({ target }) => ({ target });
    export const proveOperationalTarget = () => { throw new Error('Use test process boundary'); };
    export function assembleOperationalEvidence({ out }) {
      const evidence = globalThis.acceptanceOperationalEvidence;
      fs.writeFileSync(out, JSON.stringify(evidence));
      return evidence;
    }
  `,
  ],
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const replacement =
      context.parentURL === profileUrl && replacements.get(resolved.url);
    return replacement
      ? {
          url: `data:text/javascript,${encodeURIComponent(replacement)}`,
          shortCircuit: true,
        }
      : resolved;
  },
});

async function fixture(root, mode) {
  const receiptApi = await import(
    '../published-create-proof/acceptance-receipt.mjs'
  );
  const { readableErpVerticalNames } = await import(
    '../published-create-proof/constants.mjs'
  );
  const { canonicalJson, sha256 } = await import(
    '../published-create-proof/dependency-closure-audit.mjs'
  );
  const version = '3.11.3-ultramodern.10';
  const name = '@bleedingdev/modern-js-ultramodern-create';
  const createPackage = {
    sourceName: '@modern-js/ultramodern-create',
    targetName: name,
    version,
    integrity: 'sha512-Zml4dHVyZQ==',
    packageJson: {
      name,
      version,
      ultramodern: { frameworkVersion: version },
      dependencies: { '@module-federation/runtime': '2.8.0' },
    },
  };
  const release = {
    aliases: { [createPackage.sourceName]: name },
    createPackage,
    packages: [createPackage],
    publishOrder: [name],
    dependencyGraph: { [name]: [] },
    targetScope: 'bleedingdev',
    manifestSha256: 'a'.repeat(64),
    cohortDigest: 'b'.repeat(64),
    release: { version, tag: 'latest' },
    source: {
      commit: 'c'.repeat(40),
      repository: 'BleedingDev/ultramodern.js',
    },
    tools: { pnpm: '12.11.2' },
  };
  const seed = receiptApi.createAcceptanceReceipt({
    release,
    mode,
    profile: { id: 'erp-10', verticalCount: 10 },
    createPackage: {
      packageName: name,
      version,
      exactSpecifier: `${name}@${version}`,
    },
    runtime: {},
    registry: {},
    runIdentity: 'test:runtime-acceptance',
  });
  const { evidenceSource } = await createOperationalAcceptanceReceiptFixture({
    receipt: seed,
    receiptApi,
    evidencePath: path.join(root, 'seed.operational.json'),
  });
  globalThis.acceptanceOperationalEvidence = JSON.parse(evidenceSource);
  const closureIdentities = [
    {
      name: '@babel/core',
      version: mode === 'published' ? '8.1.3' : '8.1.2',
      integrity: `sha512-${Buffer.from(mode).toString('base64')}`,
    },
  ];
  const closureSha256 = sha256(canonicalJson(closureIdentities));
  return {
    release,
    receiptApi,
    verticals: readableErpVerticalNames,
    audit: {
      closureIdentities,
      digests: {
        closureSha256,
        lockSha256: 'e'.repeat(64),
        registryMetadataSha256: 'f'.repeat(64),
        releaseManifestSha256: release.manifestSha256,
      },
    },
  };
}

for (const mode of ['source', 'published']) {
  test(`${mode} executes full consumer checks and records both runtime platforms`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `erp-${mode}-runner-`));
    t.after(() => fs.rmSync(root, { force: true, recursive: true }));
    const previousBrowserPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(
      root,
      'provisioned-browsers',
    );
    t.after(() => {
      if (previousBrowserPath === undefined)
        delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = previousBrowserPath;
      delete globalThis.acceptanceOperationalEvidence;
    });
    const { release, audit, receiptApi, verticals } = await fixture(root, mode);
    const { runAcceptanceProfile } = await import(profileUrl);
    const workDir = path.join(root, 'work');
    fs.mkdirSync(workDir);
    const projectDir = path.join(workDir, 'consumer');
    const outPath = path.join(root, 'receipt.json');
    const commands = [];
    const browsers = [];
    const operational = [];
    let revision = '1'.repeat(40);
    let failCommand;
    let badBrowser;
    let badPlatform;
    let badOperational;
    function write(relative, source) {
      const file = path.join(projectDir, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        typeof source === 'string' ? source : JSON.stringify(source),
      );
    }
    const runImpl = (command, args, options = {}) => {
      if (args.length === 1 && args[0] === '--version')
        return command === 'npm' ? '11.0.0' : release.tools.pnpm;
      if (command === 'pnpm' && args[0] === 'exec') return '/test-tools/pnpm';
      if (command === 'pnpm' && args.includes('consumer')) {
        write('package.json', { name: 'consumer' });
        write('apps/shell/package.json', { name: 'shell' });
        write('apps/shell/node_modules/@modern-js/runtime/package.json', {
          name: '@modern-js/runtime',
          main: 'index.js',
        });
        write('apps/shell/node_modules/@modern-js/runtime/index.js', '');
        write('apps/shell/node_modules/@modern-js/render/client.js', '');
        write('verticals/inventory/locales/en/inventory.json', {
          inventory: { widgetBody: 'Owns a vertical route surface.' },
        });
        write(
          'verticals/inventory/api/index.ts',
          "export const item = { id: 'starter-inventory', title: 'Inventory' };\n",
        );
        write('pnpm-lock.yaml', {
          packages: {
            [`${release.createPackage.targetName}@${release.release.version}`]:
              { resolution: { integrity: release.createPackage.integrity } },
          },
        });
      }
      if (command === 'git') {
        if (args.join(' ') === 'rev-parse --show-toplevel') return projectDir;
        if (args.join(' ') === 'rev-parse HEAD') return revision;
        if (args[0] === 'diff')
          return 'verticals/inventory/api/index.ts\nverticals/inventory/locales/en/inventory.json';
        if (args.includes('test: rotate inventory operational identity'))
          revision = '2'.repeat(40);
        if (args[0] === 'rev-list') return `${revision} ${'1'.repeat(40)}`;
        if (args[0] === 'switch') revision = args.at(-1);
      }
      if (
        command === 'pnpm' &&
        ['install', 'check', 'build', 'cloudflare:build'].includes(args[0])
      ) {
        commands.push(args.join(' '));
        assert.equal(
          options.env.PLAYWRIGHT_BROWSERS_PATH,
          process.env.PLAYWRIGHT_BROWSERS_PATH,
        );
        assert.equal(
          options.env.pnpm_config_trust_policy_exclude,
          mode === 'source'
            ? JSON.stringify([
                `${release.createPackage.targetName}@${release.release.version}`,
              ])
            : undefined,
        );
        if (args[0] === failCommand)
          throw new Error(`Real ${failCommand} failed`);
      }
      return '';
    };
    const input = {
      mode,
      release,
      registryUrl: 'https://registry.npmjs.org/',
      registryEnv:
        mode === 'source'
          ? {
              PNPM_CONFIG_TRUST_POLICY_EXCLUDE: JSON.stringify([
                `${release.createPackage.targetName}@${release.release.version}`,
              ]),
            }
          : {},
      options: {
        selectedProfile: { id: 'erp-10', verticalCount: 10 },
        verticals,
        projectName: 'consumer',
        deployCloudflare: false,
      },
      outPath,
      runIdentity: 'test:runtime-acceptance',
      workDir,
      runImpl,
      auditDependencyClosureImpl: async () => audit,
      proveOperationalTargetImpl: async ({ baseline }) => {
        operational.push(baseline.target);
        if (badOperational) throw new Error('Operational proof failed');
        return {};
      },
      browserSmokeImpl: async (_projectDir, invocation) => {
        browsers.push(invocation);
        const { platform, artifactMode } = invocation;
        const failure = platform === badPlatform ? badBrowser : undefined;
        if (failure === 'missing') return undefined;
        const apps = verticals.map(appId => ({
          appId,
          surfaces: Object.fromEntries(
            ['frontend', 'ssr', 'api', 'backend'].map(surface => [
              surface,
              {
                buildMarker: `${platform}-${appId}`,
                releaseVersion: '0.1.0',
                sourceRevision: '1'.repeat(40),
                moduleFederation: [
                  {
                    packageName: '@module-federation/runtime',
                    version: '2.8.0',
                  },
                ],
              },
            ]),
          ),
        }));
        return {
          artifactMode,
          platform,
          shellRuntime: platform,
          status: 'pass',
          skipped: [],
          targetRuntimes: Object.fromEntries(
            verticals.map(id => [id, platform]),
          ),
          evidence: Object.fromEntries(
            [
              'ssr',
              'browser-mf',
              'api',
              'backend',
              'backend-driven-ui',
              'failure-isolation',
              'release-identity',
            ].map(dimension => [
              dimension,
              {
                artifactMode,
                platform,
                status: 'pass',
                verticalIds: verticals,
                assertions: [
                  { status: failure === 'failed' ? 'fail' : 'pass' },
                ],
                ...(dimension === 'release-identity' ? { apps } : {}),
              },
            ]),
          ),
        };
      },
    };
    const receipt = await runAcceptanceProfile(input);
    assert.equal(receipt.passed, true);
    assert.deepEqual(commands, [
      'install --lockfile-only --ignore-scripts',
      'install --frozen-lockfile',
      'check',
      'build',
      'cloudflare:build',
    ]);
    assert.deepEqual(
      browsers.map(({ artifactMode, platform }) => ({
        artifactMode,
        platform,
      })),
      [
        { artifactMode: mode, platform: 'node' },
        { artifactMode: mode, platform: 'workerd' },
      ],
    );
    assert.deepEqual(operational, ['node', 'cloudflare']);
    assert.equal(receipt.results.length, 28);
    assert(receipt.results.every(result => result.status === 'pass'));
    assert.equal(
      receipt.binding.supplyChain.closureSha256,
      audit.digests.closureSha256,
    );
    receiptApi.verifyAcceptanceReceiptOperationalEvidence(receipt, outPath);
    for (const command of ['install', 'check', 'build', 'cloudflare:build']) {
      failCommand = command;
      revision = '1'.repeat(40);
      await assert.rejects(
        runAcceptanceProfile(input),
        new RegExp(`Real ${command} failed`, 'u'),
      );
      const failed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      assert.equal(failed.passed, false);
      assert(failed.results.some(result => result.status === 'not-run'));
    }
    failCommand = undefined;
    for (const platform of ['node', 'workerd']) {
      for (const failure of ['missing', 'failed']) {
        badPlatform = platform;
        badBrowser = failure;
        revision = '1'.repeat(40);
        await assert.rejects(
          runAcceptanceProfile(input),
          /did not produce a report|runtime acceptance report is missing|non-passing assertion/u,
        );
        assert.equal(
          JSON.parse(fs.readFileSync(outPath, 'utf8')).passed,
          false,
        );
      }
    }
    badBrowser = undefined;
    badOperational = true;
    revision = '1'.repeat(40);
    await assert.rejects(
      runAcceptanceProfile(input),
      /Operational proof failed/u,
    );
    assert.equal(JSON.parse(fs.readFileSync(outPath, 'utf8')).passed, false);
  });
}
