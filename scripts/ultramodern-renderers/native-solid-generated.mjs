import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { confinedPath } from '../lib/file-evidence.mjs';
import { digestFile, rendererFeatureBinding } from './feature-gates.mjs';
import { readCohort } from './installed-cohort.mjs';

const nativePackages = [
  'solid-js',
  '@solidjs/web',
  '@solidjs/signals',
  '@solidjs/compiler',
];
const installedTuple = Object.freeze({
  ...Object.fromEntries(nativePackages.map(name => [name, '2.0.0-rc.15'])),
  '@babel/core': '7.29.7',
  typescript: '7.0.2',
  seroval: '1.6.7',
  'seroval-plugins': '1.6.7',
});

/** Only the completed original strict-build/browser proof may supply this row. */
export function verifyGeneratedSolidResult(result, binding) {
  assert.equal(result.gate, 'solid-generated-installed-consumer');
  assert.equal(result.sourceRevision, binding.sourceRevision);
  assert.equal(result.manifestSha256, binding.manifestSha256);
  assert.equal(result.cohortDigest, binding.frameworkCohortDigest);
  assert(
    Number.isInteger(result.installedCopies) && result.installedCopies > 0,
  );
  assert.deepEqual(
    result.tuple,
    installedTuple,
    'The generated consumer must use the actual Solid 2 RC15 tuple',
  );
  const types = result.types;
  assert(Array.isArray(types?.entries) && types.entries.length > 0);
  assert.equal(new Set(types.entries).size, types.entries.length);
  assert.deepEqual(
    Object.keys(types.generatedDigests).sort(),
    [...types.entries].sort(),
  );
  for (const entry of types.entries) {
    assert(!path.isAbsolute(entry) && !entry.split(/[\\/]/u).includes('..'));
    assert.match(types.generatedDigests[entry], /^[a-f0-9]{64}$/u);
  }
  const bundle = types.bundle;
  assert.equal(typeof bundle?.diagnostic, 'string');
  for (const name of nativePackages.slice(0, 3)) {
    const owner = bundle.owners[name];
    assert(path.isAbsolute(owner?.root));
    assert(Array.isArray(owner.resources) && owner.resources.length > 0);
  }
  const browser = result.browser;
  const completion = browser?.completion;
  const cancellation = browser?.cancellation;
  const checks = {
    strictGeneratedTypes: types.entries.length > 0,
    sameNativeOwner: nativePackages.every(
      name => result.tuple[name] === '2.0.0-rc.15',
    ),
    retainedHydration:
      browser.retainedSsrNodes === true && browser.deferredHydration === true,
    nativeActions: browser.nativeAction === true,
    nativeNavigation: browser.nativeNavigation === true,
    requestIsolation: browser.overlappingRequestIsolation === true,
    incrementalStreaming:
      Number.isInteger(completion?.earlyChunk) &&
      completion.earlyChunk > 0 &&
      Number.isInteger(completion.lateChunk) &&
      completion.lateChunk > completion.earlyChunk &&
      Number.isFinite(completion.gapMs) &&
      completion.gapMs >= 250,
    cancellation:
      Number.isInteger(cancellation?.earlyChunk) &&
      cancellation.earlyChunk > 0 &&
      cancellation.lateChunk === undefined &&
      cancellation.gapMs === undefined &&
      browser.serverAbortAndLoaderCleanup === true,
    noDocumentReload: browser.documentReload === false,
    deliveredNativeEntry:
      Array.isArray(browser.blockedEntryRequests) &&
      browser.blockedEntryRequests.length > 0 &&
      Array.isArray(browser.deliveredEntryRequests) &&
      browser.deliveredEntryRequests.length > 0,
  };
  for (const [check, passed] of Object.entries(checks))
    assert.equal(
      passed,
      true,
      `Generated Solid consumer did not execute ${check}`,
    );
  return checks;
}

/** Rebuild and exercise the actual cohort-installed public Solid workspace. */
export async function runPackedGeneratedSolidProof(context) {
  assert.equal(context.renderer, 'solid');
  context.signal?.throwIfAborted();
  const cohort = readCohort(context.manifestPath);
  const binding = rendererFeatureBinding(cohort);
  assert.deepEqual(
    context.binding,
    binding,
    'Generated Solid proof used another cohort',
  );
  assert(
    process.env.OWNED_TEMP_DIR,
    'Generated Solid proof requires an owned release run',
  );
  const leaseRoot = fs.realpathSync(process.env.OWNED_TEMP_DIR);
  const appRoot = fs.realpathSync(context.consumerRoot);
  confinedPath(leaseRoot, path.relative(leaseRoot, appRoot));
  const receiptPath = path.resolve(context.receiptPath);
  const log = path.resolve(context.log);
  const observationsPath = `${receiptPath}.observations.json`;
  for (const filename of [receiptPath, log, observationsPath]) {
    confinedPath(leaseRoot, path.relative(leaseRoot, filename));
    assert(
      !fs.existsSync(filename),
      `Generated Solid evidence already exists: ${filename}`,
    );
  }
  assert.equal(new Set([receiptPath, log, observationsPath]).size, 3);
  fs.writeFileSync(
    log,
    'Running the actual installed Solid strict-build/browser consumer.\n',
    { flag: 'wx' },
  );
  try {
    const { runGeneratedSolidConsumer } = await import(
      '../../tests/ultramodern-renderers/solid-admission/generated-consumer.mjs'
    );
    const result = await runGeneratedSolidConsumer({
      appRoot,
      manifestPath: context.manifestPath,
      browserRoot: context.browserDependencyRoot,
      browserExecutable: context.browserExecutable,
      signal: context.signal,
    });
    context.signal?.throwIfAborted();
    const checks = verifyGeneratedSolidResult(result, binding);
    for (const [entry, expected] of Object.entries(
      result.types.generatedDigests,
    ))
      assert.equal(
        digestFile(confinedPath(appRoot, entry)),
        expected,
        'Generated Solid entry changed after its strict/browser proof',
      );
    fs.writeFileSync(observationsPath, `${JSON.stringify(result, null, 2)}\n`, {
      flag: 'wx',
    });
    fs.appendFileSync(
      log,
      `Completed original strict/browser assertions; observations: ${observationsPath}\n`,
    );
    const receipt = {
      status: 'passed',
      binding,
      checks,
      evidence: [log, observationsPath].map(filename => ({
        path: filename,
        sha256: digestFile(filename),
      })),
    };
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: 'wx',
    });
    return receipt;
  } catch (error) {
    fs.appendFileSync(log, `${error.stack ?? error}\n`);
    throw error;
  }
}
