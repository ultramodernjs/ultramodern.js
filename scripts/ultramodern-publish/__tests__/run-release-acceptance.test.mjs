import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import fixtureApi from '../../ultramodern-production-readiness/__tests__/support/operational-acceptance-fixture.js';
import * as receiptApi from '../../ultramodern-production-readiness/published-create-proof/acceptance-receipt.mjs';
import {
  canonicalJson,
  sha256,
} from '../../ultramodern-production-readiness/published-create-proof/release-age-audit.mjs';

const { createOperationalAcceptanceReceiptFixture, fixtureClosureSha256 } =
  fixtureApi;

// Exercise the real CLI authentication and receipt verification without a
// registry, package install or ERP runtime. The profile process boundary only
// writes synthetic receipts; the runner itself has focused tests separately.
test('published CLI authenticates source acceptance and verifies full published runtime evidence independently', async t => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'published-acceptance-cli-'),
  );
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
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
    release: { tag: 'latest', version },
    targetScope: 'bleedingdev',
    source: {
      commit: 'a'.repeat(40),
      repository: 'BleedingDev/ultramodern.js',
    },
    manifestSha256: 'b'.repeat(64),
    cohortDigest: 'c'.repeat(64),
  };
  const runIdentity =
    'github:BleedingDev/ultramodern.js:run:44928844954:attempt:1';
  async function writeReceipt(mode, receiptPath) {
    const receipt = receiptApi.createAcceptanceReceipt({
      release,
      mode,
      profile: { id: 'erp-10', verticalCount: 10 },
      createPackage: {
        packageName: name,
        version,
        exactSpecifier: `${name}@${version}`,
      },
      runtime: {
        arch: 'x64',
        node: '26.13.1',
        npm: '11.0.0',
        pnpm: '12.11.2',
        platform: 'linux',
        playwright: '1.65.1',
        registry: { name: 'npm-registry', version: null, integrity: null },
        yaml: { name: 'yaml', version: '2.0.0', integrity: 'sha512-eWFtbA==' },
      },
      registry: {
        cohortPackages: 'registry-only-exact-name-and-version',
        externalDependencies: 'selected-registry',
        resolution: 'package-manager-registry',
        url: 'https://registry.npmjs.org/',
        sourceCandidateTrustPolicyExclude:
          mode === 'source' ? [`${name}@${version}`] : [],
      },
      runIdentity,
    });
    receiptApi.bindSupplyChainEvidence(receipt, {
      closureSha256: fixtureClosureSha256,
      exceptionPolicySha256: 'd'.repeat(64),
      lockSha256: 'e'.repeat(64),
      registryMetadataSha256: 'f'.repeat(64),
      releaseManifestSha256: release.manifestSha256,
    });
    await createOperationalAcceptanceReceiptFixture({
      receipt,
      receiptApi,
      evidencePath: receiptPath.replace(
        /\.json$/u,
        '.operational-independence.json',
      ),
    });
    if (mode === 'published') {
      const closure = receipt.results.find(
        result => result.id === 'dependency-closure-audit',
      ).details.closureIdentities;
      closure[0].version = '1.0.1';
      receipt.binding.supplyChain.closureSha256 = sha256(
        canonicalJson(closure),
      );
    }
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    return receipt;
  }
  const sourcePath = path.join(root, 'source.json');
  const publishedPath = path.join(root, 'published.json');
  const source = await writeReceipt('source', sourcePath);
  const sourceBytes = fs.readFileSync(sourcePath);
  let runnerCalls = 0;
  let producedFailure;
  globalThis.releaseAcceptanceCliRelease = release;
  globalThis.releaseAcceptanceCliProfile = async options => {
    runnerCalls += 1;
    assert.equal(options.mode, 'published');
    assert.equal(Object.hasOwn(options, 'acceptedResolution'), false);
    const published = await writeReceipt('published', options.outPath);
    assert.notEqual(
      published.binding.supplyChain.closureSha256,
      source.binding.supplyChain.closureSha256,
    );
    if (producedFailure === 'runtime') {
      published.results.find(
        result => result.id === 'workerd-browser-mf',
      ).details.assertionCount = 0;
      fs.writeFileSync(options.outPath, JSON.stringify(published));
    }
    if (producedFailure === 'operational') {
      fs.rmSync(
        options.outPath.replace(/\.json$/u, '.operational-independence.json'),
      );
    }
    return published;
  };
  t.after(() => {
    delete globalThis.releaseAcceptanceCliRelease;
    delete globalThis.releaseAcceptanceCliProfile;
  });
  const modules = new Map([
    [
      new URL(
        '../lib/source-create-proof/release-manifest.mjs',
        import.meta.url,
      ).href,
      'export const readReleaseManifest = () => globalThis.releaseAcceptanceCliRelease;',
    ],
    [
      new URL(
        '../../ultramodern-production-readiness/published-create-proof/acceptance-profile.mjs',
        import.meta.url,
      ).href,
      'export const runAcceptanceProfile = options => globalThis.releaseAcceptanceCliProfile(options);',
    ],
    [
      new URL('../lib/support-release-admission.mjs', import.meta.url).href,
      'export const supportAdmissionRun = run => run;',
    ],
  ]);
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      const source = modules.get(resolved.url);
      return source
        ? {
            url: `data:text/javascript,${encodeURIComponent(source)}`,
            shortCircuit: true,
          }
        : resolved;
    },
  });
  t.after(() => hook.deregister());
  const { main, parseArgs } = await import('../run-release-acceptance.mjs');
  const base = [
    '--mode',
    'published',
    '--manifest',
    path.join(root, 'manifest.json'),
    '--receipt',
    publishedPath,
    '--run-identity',
    runIdentity,
  ];
  assert.throws(() => parseArgs(base), /--source-receipt .*required/u);
  assert.throws(
    () =>
      parseArgs([
        '--manifest',
        path.join(root, 'manifest.json'),
        '--receipt',
        publishedPath,
        '--source-receipt',
        sourcePath,
      ]),
    /valid only there/u,
  );
  const argv = [...base, '--source-receipt', sourcePath];
  assert.equal(await main(argv), 0);
  assert.equal(runnerCalls, 1);
  for (const [mutate, error] of [
    [
      receipt => {
        receipt.binding.runIdentity = 'different-run';
      },
      /run identity/u,
    ],
    [
      receipt => {
        receipt.binding.manifest.cohortDigest = '0'.repeat(64);
      },
      /strict release manifest/u,
    ],
    [
      receipt => {
        receipt.results.find(result => result.id === 'node-ssr').status =
          'not-run';
      },
      /did not pass/u,
    ],
  ]) {
    const bad = structuredClone(source);
    mutate(bad);
    fs.writeFileSync(sourcePath, JSON.stringify(bad));
    await assert.rejects(main(argv), error);
    assert.equal(
      runnerCalls,
      1,
      'Source must authenticate before runtime acceptance starts',
    );
  }
  fs.writeFileSync(sourcePath, sourceBytes);
  const sourceEvidence = sourcePath.replace(
    /\.json$/u,
    '.operational-independence.json',
  );
  const operationalBytes = fs.readFileSync(sourceEvidence);
  fs.rmSync(sourceEvidence);
  await assert.rejects(
    main(argv),
    /Operational-independence evidence is missing/u,
  );
  assert.equal(runnerCalls, 1);
  fs.writeFileSync(sourceEvidence, operationalBytes);
  for (const [failure, error] of [
    ['runtime', /assertion count/u],
    ['operational', /Operational-independence evidence is missing/u],
  ]) {
    producedFailure = failure;
    await assert.rejects(main(argv), error);
  }
  assert.equal(runnerCalls, 3);
});
