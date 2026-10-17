import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { fileEvidence } from '../lib/file-evidence.mjs';
import { readCohort } from './installed-cohort.mjs';
import { runPackedNativeFederationProof } from './native-federation-packed.mjs';

const outside = (directory, filename) => {
  const relative = path.relative(directory, filename);
  return (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
};

const same = isDeepStrictEqual;
const hash = value =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

/** Derive admission checks from recorded browser/server values, never PASS flags. */
export function validateNativeDevRefreshObservations(observations) {
  assert.equal(
    observations.verdict,
    'PASS',
    'The original native dev browser proof must pass.',
  );
  const initial = observations.initialCompatibleUpdate;
  const baseline = initial.documentBefore;
  const refreshes = observations.refreshes;
  const compatibleNames = [
    'componentAndDependencyRefresh',
    'burstRefresh',
    'burstStableRefresh',
    'reconnectedRefresh',
  ];
  const compatible = compatibleNames.map(name => refreshes[name]);
  const names = [
    'freshSSR',
    ...compatibleNames,
    'recoveredSsr',
    'incompatibleRefresh',
    'incompatibleRemoval',
  ];
  const ssr = names.map(name => observations[name]);
  const shape = observations.incompatibleUpdate;
  const removal = observations.incompatibleRemovalUpdate;
  const outage = observations.outageRecovery;
  const navigation = observations.navigation;
  const cleanup = observations.resourceCleanup;
  const nativeCleanup = observations.hmr.nativeCleanup;
  const allDocuments = [
    initial.documentAfter,
    ...Object.values(refreshes).map(value => value.document),
    ...outage.samples.map(value => value.document),
    shape.document,
  ];
  const shapeBefore = shape.before.lifecycle;
  const shapeAfter = shape.after.lifecycle;
  const nativeNavigation =
    navigation.away.sentinel === baseline.sentinel &&
    navigation.back.sentinel === baseline.sentinel &&
    navigation.away.timeOrigin === baseline.timeOrigin &&
    navigation.back.timeOrigin === baseline.timeOrigin &&
    navigation.away.routerPath === '/away' &&
    navigation.back.routerPath === '/' &&
    new URL(navigation.away.location).pathname === '/away' &&
    new URL(navigation.back.location).pathname === '/' &&
    navigation.away.historyLength === baseline.historyLength + 1 &&
    navigation.back.historyLength === baseline.historyLength + 2 &&
    typeof baseline.routerKey === 'string' &&
    baseline.routerKey.length > 0 &&
    typeof navigation.away.routerKey === 'string' &&
    navigation.away.routerKey.length > 0 &&
    typeof navigation.back.routerKey === 'string' &&
    navigation.back.routerKey.length > 0 &&
    navigation.away.routerKey !== baseline.routerKey &&
    navigation.back.routerKey !== navigation.away.routerKey;
  const currentSsr = ssr.every(
    value =>
      value.status === 200 &&
      value.fallbackCount === 0 &&
      value.versions.length > 0 &&
      value.versions.every(version => version === value.expectedVersion) &&
      hash(value.publication.current.revision) &&
      hash(value.publication.previous.revision),
  );
  const changedRevisions = [
    'freshSSR',
    'componentAndDependencyRefresh',
    'burstRefresh',
    'reconnectedRefresh',
    'incompatibleRefresh',
    'incompatibleRemoval',
  ].every(
    name =>
      observations[name].publication.current.revision !==
      observations[name].publication.previous.revision,
  );
  const checks = {
    noDocumentReload:
      allDocuments.every(value => same(value, baseline)) && nativeNavigation,
    retainedHostState:
      compatible.every(
        value =>
          value.before.hostCount === 'Host count 2' &&
          value.after.hostCount === value.before.hostCount,
      ) && shape.after.hostCount === shape.before.hostCount,
    retainedHostProps:
      compatible.every(
        value =>
          value.after.label === value.before.label &&
          value.after.label === 'relabelled',
      ) && shape.after.label === shape.before.label,
    retainedCompatibleRemoteState:
      initial.remoteCountAfter === initial.remoteCountBefore &&
      same(initial.before, initial.after) &&
      compatible.every(
        value =>
          value.after.remoteCount === value.before.remoteCount &&
          same(value.after.lifecycle, value.before.lifecycle),
      ),
    currentSameHostSsr: currentSsr && changedRevisions,
    nativeServerOwnership: ssr.every(
      value =>
        value.owners.length > 0 &&
        value.owners.every(owner => owner === 'host-owned'),
    ),
    singleRemoteRoot: Object.values(refreshes).every(
      value =>
        value.after.remoteRoots === 1 &&
        value.after.remoteFallbacks === 0 &&
        value.after.owner === 'host-owned',
    ),
    componentAndDependencyRefresh:
      refreshes.componentAndDependencyRefresh.after.version ===
      'Remote native v3',
    burstLatestWins:
      typeof observations.burstStability.clientCompilationHash === 'string' &&
      /^[a-f0-9]{8,}$/u.test(
        observations.burstStability.clientCompilationHash,
      ) &&
      hash(observations.burstStability.clientAssetsSha256) &&
      hash(observations.burstStability.serverRevision) &&
      observations.burstStability.compilerDebounceMs === 100 &&
      observations.burstStability.stableMs >=
        observations.burstStability.compilerDebounceMs * 5 &&
      observations.burstStability.samples > 1 &&
      refreshes.burstStableRefresh.after.version === 'Remote native v5' &&
      observations.burstStableRefresh.publication.current.revision ===
        observations.burstStability.serverRevision,
    outageRecovery:
      outage.server.status === 200 &&
      outage.server.hostDocuments === 1 &&
      outage.server.fallbackCount > 0 &&
      outage.server.staleRemoteCount === 0 &&
      outage.samples.length > 1 &&
      outage.observedMs >= 500 &&
      outage.samples.every(
        value =>
          same(value.observation, outage.before) &&
          value.observation.remoteFallbacks === 0 &&
          value.observation.fallbackEverSeen === false,
      ) &&
      observations.recoveredSsr.fallbackCount === 0 &&
      observations.recoveredSsr.versions.every(
        value => value === 'Remote native v5',
      ) &&
      refreshes.reconnectedRefresh.after.version === 'Remote native v6',
    incompatibleRemoteBoundaryUpdate:
      shape.renderedShape === 'expanded' &&
      observations.incompatibleRefresh.shapes.includes('expanded') &&
      shape.after.remoteCount === 'Count 0' &&
      shape.countAfterClick === 'Count 1' &&
      shapeAfter.mounts === shapeBefore.mounts + 1 &&
      shapeAfter.cleanups === shapeBefore.cleanups + 1 &&
      shapeAfter.instances.length === shapeBefore.instances.length + 1 &&
      shapeAfter.instances
        .slice(0, -1)
        .every(instance => instance.cleanups === 1) &&
      shapeAfter.instances.at(-1).cleanups === 0,
    incompatibleDeclarationRemoval:
      removal.renderedShape === null &&
      observations.incompatibleRemoval.shapes.length === 0 &&
      removal.after.remoteCount === 'Count 0' &&
      removal.countAfterClick === 'Count 1' &&
      removal.after.lifecycle.mounts === removal.before.lifecycle.mounts + 1 &&
      removal.after.lifecycle.cleanups ===
        removal.before.lifecycle.cleanups + 1 &&
      removal.after.lifecycle.instances.length ===
        removal.before.lifecycle.instances.length + 1 &&
      removal.after.lifecycle.instances
        .slice(0, -1)
        .every(instance => instance.cleanups === 1) &&
      removal.after.lifecycle.instances.at(-1).cleanups === 0,
    nativeRouterNavigationAfterRefresh: nativeNavigation,
    ownedResourcesRetired:
      cleanup.errorCount === 0 &&
      cleanup.processGroups.length >= 3 &&
      cleanup.processGroups.every(
        group => group.alive === false && group.inspectionError === undefined,
      ) &&
      cleanup.releasedArtifactCount > 0 &&
      cleanup.releasedArtifactCount === cleanup.registeredArtifactCount &&
      nativeCleanup.mounts === nativeCleanup.cleanups &&
      nativeCleanup.instances.length === nativeCleanup.mounts &&
      nativeCleanup.instances.every(instance => instance.cleanups === 1) &&
      new Set(nativeCleanup.instances.map(instance => instance.id)).size ===
        nativeCleanup.mounts,
  };
  for (const [name, passed] of Object.entries(checks))
    assert.equal(passed, true, `Native dev refresh failed ${name}`);
  assert.equal(observations.cleanupErrors, undefined);
  return checks;
}

/** Exercise real development servers from authenticated independently installed packs. */
export async function runPackedNativeFederationDevProof(context) {
  assert.equal(
    context.renderer,
    'octane',
    'Native dev refresh requires the Octane consumer.',
  );
  const cohort = readCohort(context.manifestPath);
  const binding = {
    sourceRevision: cohort.sourceRevision,
    releaseVersion: cohort.release.version,
    manifestSha256: cohort.manifestSha256,
    frameworkCohortDigest: cohort.cohortDigest,
  };
  assert.deepEqual(
    context.binding,
    binding,
    'Dev refresh must bind the accepted framework cohort.',
  );
  const receiptPath = path.resolve(context.receiptPath);
  const log = path.resolve(context.log);
  assert(
    process.env.OWNED_TEMP_DIR,
    'Dev refresh evidence requires an owned release run.',
  );
  const leaseRoot = fs.realpathSync(process.env.OWNED_TEMP_DIR);
  for (const filename of [receiptPath, log]) {
    assert(
      !outside(leaseRoot, filename),
      'Dev refresh evidence must belong to the owned release run.',
    );
    assert(
      outside(path.resolve(context.workDir), filename),
      'Dev refresh evidence must survive disposable app cleanup.',
    );
  }
  const observationsPath = `${receiptPath}.observations.json`;
  for (const filename of [receiptPath, observationsPath])
    assert(
      !fs.existsSync(filename),
      `Dev refresh evidence already exists: ${filename}`,
    );
  await runPackedNativeFederationProof({
    ...context,
    proofScript: fileURLToPath(
      new URL(
        '../../tests/ultramodern-renderers/octane-federation/dev.mjs',
        import.meta.url,
      ),
    ),
    processWitnessPaths: ['remote', 'host'].map(directory =>
      path.join(directory, 'packed-mf-install-process.json'),
    ),
    env: {
      ...process.env,
      ...context.env,
      ULTRAMODERN_MF_DEV_OBSERVATIONS: observationsPath,
    },
  });
  const observations = JSON.parse(fs.readFileSync(observationsPath, 'utf8'));
  const checks = validateNativeDevRefreshObservations(observations);
  const evidence = [log, observationsPath].map(filename => ({
    path: filename,
    sha256: fileEvidence(filename, path.dirname(filename)).sha256,
  }));
  const receipt = {
    status: 'passed',
    binding,
    evidence,
    checks,
  };
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
  });
  return receipt;
}
