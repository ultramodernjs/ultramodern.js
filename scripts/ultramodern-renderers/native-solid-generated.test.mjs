import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyGeneratedSolidResult } from './native-solid-generated.mjs';

const binding = {
  sourceRevision: 'a'.repeat(40),
  manifestSha256: 'b'.repeat(64),
  frameworkCohortDigest: 'c'.repeat(64),
};
const completed = () => ({
  gate: 'solid-generated-installed-consumer',
  sourceRevision: binding.sourceRevision,
  manifestSha256: binding.manifestSha256,
  cohortDigest: binding.frameworkCohortDigest,
  installedCopies: 12,
  // This is the complete installedTuple() output from generated-consumer.mjs.
  tuple: {
    'solid-js': '2.0.0-rc.15',
    '@solidjs/web': '2.0.0-rc.15',
    '@solidjs/signals': '2.0.0-rc.15',
    '@solidjs/compiler': '2.0.0-rc.15',
    '@babel/core': '7.29.7',
    typescript: '7.0.2',
    seroval: '1.6.7',
    'seroval-plugins': '1.6.7',
  },
  types: {
    entries: ['node_modules/.modern-js/solid/index/index.ts'],
    generatedDigests: {
      'node_modules/.modern-js/solid/index/index.ts': 'd'.repeat(64),
    },
    bundle: {
      diagnostic: '/app/dist/solid-consumer-modules.json',
      owners: Object.fromEntries(
        ['solid-js', '@solidjs/web', '@solidjs/signals'].map(name => [
          name,
          {
            root: `/app/node_modules/${name}`,
            resources: [`/app/node_modules/${name}/index.js`],
          },
        ]),
      ),
    },
  },
  browser: {
    retainedSsrNodes: true,
    nativeAction: true,
    nativeNavigation: true,
    deferredHydration: true,
    overlappingRequestIsolation: true,
    completion: { earlyChunk: 1, lateChunk: 2, gapMs: 300 },
    cancellation: { earlyChunk: 1 },
    serverAbortAndLoaderCleanup: true,
    documentReload: false,
    blockedEntryRequests: ['/static/app.js'],
    deliveredEntryRequests: ['/static/app.js'],
  },
});

test('the actual eight-package installed tuple qualifies and every version remains exact', () => {
  const result = completed();
  assert.equal(Object.keys(result.tuple).length, 8);
  assert.equal(
    verifyGeneratedSolidResult(result, binding).sameNativeOwner,
    true,
  );
  for (const name of Object.keys(result.tuple)) {
    const missing = completed();
    delete missing.tuple[name];
    assert.throws(
      () => verifyGeneratedSolidResult(missing, binding),
      /Solid 2 RC15 tuple/u,
    );
    const drifted = completed();
    drifted.tuple[name] = '0.0.0';
    assert.throws(
      () => verifyGeneratedSolidResult(drifted, binding),
      /Solid 2 RC15 tuple/u,
    );
  }
  const unexpected = completed();
  unexpected.tuple['unexpected-native-owner'] = '1.0.0';
  assert.throws(
    () => verifyGeneratedSolidResult(unexpected, binding),
    /Solid 2 RC15 tuple/u,
  );
});

test('the generated Solid row requires the completed strict/browser result', () => {
  assert(
    Object.values(verifyGeneratedSolidResult(completed(), binding)).every(
      value => value === true,
    ),
  );
  for (const field of [
    'retainedSsrNodes',
    'nativeAction',
    'nativeNavigation',
    'deferredHydration',
    'overlappingRequestIsolation',
    'serverAbortAndLoaderCleanup',
  ]) {
    const result = completed();
    result.browser[field] = false;
    assert.throws(() => verifyGeneratedSolidResult(result, binding));
  }
});

test('Solid 1, stale manifests and absent generated entry/type evidence cannot qualify', () => {
  for (const mutate of [
    result => {
      result.tuple['solid-js'] = '1.9.17';
    },
    result => {
      result.manifestSha256 = 'e'.repeat(64);
    },
    result => {
      result.installedCopies = 0;
    },
    result => {
      result.types.entries = [];
    },
    result => {
      result.types.generatedDigests = {};
    },
    result => {
      result.types.entries[0] = '../foreign.ts';
    },
  ]) {
    const result = completed();
    mutate(result);
    assert.throws(() => verifyGeneratedSolidResult(result, binding));
  }
});

test('buffered delivery, missing abort observations and document reload fail closed', () => {
  for (const mutate of [
    result => {
      result.browser.completion.lateChunk = 1;
    },
    result => {
      result.browser.completion.gapMs = 249;
    },
    result => {
      result.browser.cancellation.lateChunk = 2;
    },
    result => {
      result.browser.documentReload = true;
    },
    result => {
      result.browser.deliveredEntryRequests = [];
    },
  ]) {
    const result = completed();
    mutate(result);
    assert.throws(() => verifyGeneratedSolidResult(result, binding));
  }
});
