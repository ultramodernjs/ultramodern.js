import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateNativeDevRefreshObservations } from './native-federation-dev.mjs';

// Receipt-validation controls only. These fabricated observations never stand
// in for the real browser/compiler/SSR execution required by the release runner.
function observations() {
  const digest = number => String(number).repeat(64);
  const document = {
    sentinel: 'document',
    timeOrigin: 1,
    location: 'http://host/',
    historyLength: 1,
    navigationCount: 1,
    routerPath: '/',
    routerKey: 'initial',
  };
  const lifecycle = {
    owners: 1,
    activations: 1,
    cleanups: 0,
    currentOwner: 1,
    effects: [{ id: 1, ownerId: 1, cleanups: 0 }],
  };
  const activate = (
    before,
    { newOwner = false, count = 1, unmount = false } = {},
  ) => {
    const next = structuredClone(before);
    for (let index = 0; index < count; index++) {
      if (next.currentOwner !== null) {
        next.effects.at(-1).cleanups++;
        next.cleanups++;
      }
      if (newOwner) next.owners++;
      next.currentOwner = next.owners;
      next.effects.push({
        id: ++next.activations,
        ownerId: next.currentOwner,
        cleanups: 0,
      });
    }
    if (unmount) {
      next.effects.at(-1).cleanups++;
      next.cleanups++;
      next.currentOwner = null;
    }
    return next;
  };
  const initialAfter = activate(lifecycle);
  const snapshot = (version, state = lifecycle) => ({
    version,
    remoteCount: 'Count 3',
    hostCount: 'Host count 2',
    label: 'relabelled',
    owner: 'host-owned',
    remoteRoots: 1,
    remoteFallbacks: 0,
    fallbackEverSeen: false,
    lifecycle: structuredClone(state),
  });
  const ssr = (version, before, after) => ({
    status: 200,
    expectedVersion: version,
    versions: [version],
    owners: ['host-owned'],
    fallbackCount: 0,
    shapes: [],
    publication: {
      previous: { revision: digest(before) },
      current: { revision: digest(after) },
    },
  });
  const data = {
    verdict: 'PASS',
    initialCompatibleUpdate: {
      before: structuredClone(lifecycle),
      after: initialAfter,
      remoteCountBefore: 'Count 2',
      remoteCountAfter: 'Count 2',
      documentBefore: document,
      documentAfter: structuredClone(document),
    },
    refreshes: {},
    freshSSR: ssr('Remote native v2', 1, 2),
    componentAndDependencyRefresh: ssr('Remote native v3', 2, 3),
    burstRefresh: ssr('Remote native v5', 3, 4),
    burstStableRefresh: ssr('Remote native v5', 4, 4),
    recoveredSsr: ssr('Remote native v5', 4, 4),
    restartedRefresh: ssr('Remote native v5', 4, 4),
    reconnectedRefresh: ssr('Remote native v6', 4, 5),
    incompatibleRefresh: ssr('Remote native v6', 5, 6),
    burstStability: {
      clientCompilationHash: 'abcd1234',
      clientAssetsSha256: digest(8),
      serverRevision: digest(4),
      compilerDebounceMs: 100,
      stableMs: 500,
      samples: 5,
    },
    navigation: {
      away: {
        ...document,
        location: 'http://host/away',
        routerPath: '/away',
        routerKey: 'away',
        historyLength: 2,
      },
      back: { ...document, routerKey: 'back', historyLength: 3 },
    },
    resourceCleanup: {
      errorCount: 0,
      processGroups: [1, 2, 3].map(pid => ({ pid, alive: false })),
      registeredArtifactCount: 6,
      releasedArtifactCount: 6,
    },
    hmr: {},
  };
  let previousLifecycle = initialAfter;
  let previousVersion = 'Remote native v2';
  for (const [name, version] of [
    ['componentAndDependencyRefresh', 'Remote native v3'],
    ['burstRefresh', 'Remote native v5'],
    ['burstStableRefresh', 'Remote native v5'],
    ['restartedRefresh', 'Remote native v5'],
    ['reconnectedRefresh', 'Remote native v6'],
  ]) {
    const nextLifecycle = activate(previousLifecycle, {
      count:
        name === 'burstStableRefresh' ? 0 : name === 'burstRefresh' ? 2 : 1,
    });
    data.refreshes[name] = {
      before: snapshot(previousVersion, previousLifecycle),
      after: snapshot(version, nextLifecycle),
      document: structuredClone(document),
    };
    previousLifecycle = nextLifecycle;
    previousVersion = version;
  }
  const shapeAfter = snapshot('Remote native v6');
  shapeAfter.remoteCount = 'Count 0';
  shapeAfter.lifecycle = activate(previousLifecycle, { newOwner: true });
  data.incompatibleUpdate = {
    before: snapshot('Remote native v6', previousLifecycle),
    after: shapeAfter,
    renderedShape: 'expanded',
    countAfterClick: 'Count 1',
    document: structuredClone(document),
  };
  data.incompatibleRefresh.shapes = ['expanded'];
  data.refreshes.incompatibleRefresh = {
    before: snapshot('Remote native v6', previousLifecycle),
    after: shapeAfter,
    document: structuredClone(document),
  };
  data.incompatibleRemoval = ssr('Remote native v6', 6, 7);
  const removalBefore = structuredClone(shapeAfter);
  removalBefore.remoteCount = 'Count 1';
  const removalAfter = structuredClone(removalBefore);
  removalAfter.remoteCount = 'Count 0';
  removalAfter.lifecycle = activate(removalBefore.lifecycle, {
    newOwner: true,
  });
  data.incompatibleRemovalUpdate = {
    before: removalBefore,
    after: removalAfter,
    renderedShape: null,
    countAfterClick: 'Count 1',
    document: structuredClone(document),
  };
  data.refreshes.incompatibleRemoval = {
    before: removalBefore,
    after: removalAfter,
    document: structuredClone(document),
  };
  const beforeOutage = snapshot(
    'Remote native v5',
    data.refreshes.burstStableRefresh.after.lifecycle,
  );
  data.outageRecovery = {
    before: beforeOutage,
    restarted: structuredClone(data.refreshes.restartedRefresh.after),
    server: {
      status: 200,
      hostDocuments: 1,
      fallbackCount: 1,
      staleRemoteCount: 0,
    },
    observedMs: 500,
    samples: [1, 2].map(() => ({
      observation: structuredClone(beforeOutage),
      document: structuredClone(document),
    })),
  };
  const removed = activate(removalAfter.lifecycle, { count: 0, unmount: true });
  const returned = activate(removed, { newOwner: true });
  data.hmr = {
    removedLifecycle: removed,
    beforeFinalCleanup: returned,
    nativeCleanup: activate(returned, { count: 0, unmount: true }),
  };
  return data;
}

test('derives checks from complete raw observations', () => {
  assert.ok(
    Object.values(validateNativeDevRefreshObservations(observations())).every(
      value => value === true,
    ),
  );
});

for (const [name, corrupt] of [
  [
    'missing restarted graph observation',
    data => {
      delete data.refreshes.restartedRefresh;
    },
  ],
  [
    'restart observation detached from outage state',
    data => {
      data.refreshes.restartedRefresh.before.remoteCount = 'Count 0';
    },
  ],
  [
    'duplicate activation within the restarted graph',
    data => {
      const lifecycle = data.refreshes.restartedRefresh.after.lifecycle;
      lifecycle.effects.at(-1).cleanups = 1;
      lifecycle.cleanups++;
      lifecycle.effects.push({
        id: ++lifecycle.activations,
        ownerId: lifecycle.currentOwner,
        cleanups: 0,
      });
    },
  ],
  [
    'declaration removal without cleanup',
    data => {
      data.incompatibleRemovalUpdate.after.lifecycle.cleanups--;
    },
  ],
  [
    'transient outage fallback',
    data => {
      data.outageRecovery.samples[0].observation.fallbackEverSeen = true;
    },
  ],
  [
    'compatible counter reset',
    data => {
      data.refreshes.burstRefresh.after.remoteCount = 'Count 0';
    },
  ],
  [
    'compatible remount',
    data => {
      data.refreshes.componentAndDependencyRefresh.after.lifecycle.owners++;
    },
  ],
  [
    'incompatible update without a remount',
    data => {
      data.incompatibleUpdate.after.lifecycle.currentOwner =
        data.incompatibleUpdate.before.lifecycle.currentOwner;
    },
  ],
  [
    'late stale burst',
    data => {
      data.refreshes.burstStableRefresh.after.version = 'Remote native v4';
    },
  ],
  [
    'recovered server fallback',
    data => {
      data.recoveredSsr.fallbackCount = 1;
    },
  ],
  [
    'outage browser fallback',
    data => {
      data.outageRecovery.samples[0].observation.remoteFallbacks = 1;
    },
  ],
  [
    'hidden in-app navigation',
    data => {
      data.refreshes.burstRefresh.document.historyLength++;
    },
  ],
  [
    'changed router owner key',
    data => {
      data.refreshes.burstRefresh.document.routerKey = 'foreign';
    },
  ],
  [
    'unchanged Node publication',
    data => {
      data.incompatibleRefresh.publication.current.revision =
        data.incompatibleRefresh.publication.previous.revision;
    },
  ],
  [
    'live process group',
    data => {
      data.resourceCleanup.processGroups[0].alive = true;
    },
  ],
  [
    'remote removal before its passive cleanup',
    data => {
      data.hmr.removedLifecycle = structuredClone(
        data.incompatibleRemovalUpdate.after.lifecycle,
      );
    },
  ],
  [
    'remote removal with a hidden live closure',
    data => {
      data.hmr.removedLifecycle = structuredClone(
        data.incompatibleRemovalUpdate.after.lifecycle,
      );
      data.hmr.removedLifecycle.currentOwner = null;
    },
  ],
  [
    'an extra activation during remote removal',
    data => {
      const lifecycle = data.hmr.removedLifecycle;
      lifecycle.effects.push({
        id: ++lifecycle.activations,
        ownerId: lifecycle.owners,
        cleanups: 1,
      });
      lifecycle.cleanups++;
    },
  ],
  [
    'duplicate cleanup during remote removal',
    data => {
      const lifecycle = data.hmr.removedLifecycle;
      lifecycle.effects.at(-1).cleanups++;
      lifecycle.cleanups++;
    },
  ],
  [
    'duplicate native cleanup',
    data => {
      data.hmr.nativeCleanup.effects[0].cleanups = 2;
    },
  ],
])
  test(`rejects ${name} despite a PASS flag`, () => {
    const data = observations();
    corrupt(data);
    assert.throws(() => validateNativeDevRefreshObservations(data));
  });

test('current source and published release workflow commands still reach cohort validation without future native inputs', () => {
  assert(
    process.env.OWNED_TEMP_DIR,
    'Run the CLI control through owned-temp-dir',
  );
  const work = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'native-dev-release-cli-'),
  );
  try {
    for (const mode of ['source', 'published']) {
      const commandRoot = path.join(work, mode);
      fs.mkdirSync(commandRoot);
      const args = [
        fileURLToPath(new URL('./release.mjs', import.meta.url)),
        '--cohort-dir',
        path.join(commandRoot, 'absent-cohort'),
        '--renderers',
        'solid,octane',
        '--with',
        '',
        '--work-dir',
        commandRoot,
        '--required-features',
        '--acceptance-receipt',
        path.join(commandRoot, 'acceptance.json'),
        '--feature-receipt',
        path.join(commandRoot, 'features.json'),
        '--run-identity',
        'workflow-cli-control',
      ];
      if (mode === 'published')
        args.push(
          '--acceptance-mode',
          'published',
          '--registry-url',
          'https://registry.npmjs.org/',
          '--source-feature-receipt',
          path.join(commandRoot, 'source-features.json'),
          '--source-acceptance-receipt',
          path.join(commandRoot, 'source-acceptance.json'),
        );
      const child = spawnSync(process.execPath, args, {
        env: { ...process.env, OWNED_TEMP_DIR: commandRoot },
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 1);
      const output = `${child.stdout}\n${child.stderr}`;
      assert.match(
        output,
        /Release manifest is missing or is not a regular file/u,
      );
      assert.doesNotMatch(
        output,
        /requires authenticated native archive inputs|needs --native-inputs/u,
      );
    }
  } finally {
    fs.rmSync(work, { recursive: true });
  }
});
