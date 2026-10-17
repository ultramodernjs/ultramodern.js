import {
  assertAbortDuringNativeRenderDoesNotReenterUnmount,
  assertActiveAbortDisposesNativeResources,
  assertCanceledImportsPreserveSharedResources,
  assertCleanupFailuresReleaseRoot,
  assertConsumerCallbacksPreserveInitialFailure,
  assertDocumentContainersFailBeforeImport,
  assertForeignDocumentFailsBeforeImport,
  assertHydrationFailuresReleaseNativeRoot,
  assertHydrationIdentityAndBootstrap,
  assertHydrationImportFailuresReleaseOwnership,
  assertInitialRenderFailureReleasesRoot,
  assertNativeCompilationMismatchBeforeImport,
  assertNativeMountLifecycle,
  assertPendingCSRImportCancellation,
  assertPendingHydrationImportCancellation,
  assertPreAbortedStartupDoesNotImport,
  assertRootClaimsAndImportFailures,
  assertScheduledRenderFailureReleasesRoot,
  assertStrictBootstrapIdentity,
  assertWorkerFactoryFailureReleasesOwnership,
  assertWorkerTransportDocumentLifetime,
} from './fixtures/client-lifecycle';

describe('native Octane application lifecycle', () => {
  it(
    'mounts a real native root, updates it and disposes resources once',
    assertNativeMountLifecycle,
  );
  it(
    'claims a root before importing and releases failed imports',
    assertRootClaimsAndImportFailures,
  );
  it(
    'releases the root even when a module disposer throws',
    assertCleanupFailuresReleaseRoot,
  );
  it(
    'releases a failed native initial render',
    assertInitialRenderFailureReleasesRoot,
  );
  it(
    'reports an initial render failure and still rejects mounting',
    assertConsumerCallbacksPreserveInitialFailure,
  );
  it(
    'cleans up a failed native scheduled update',
    assertScheduledRenderFailureReleasesRoot,
  );
  it(
    'rejects foreign document roots before import',
    assertForeignDocumentFailsBeforeImport,
  );
  it(
    'rejects document containers before import',
    assertDocumentContainersFailBeforeImport,
  );
  it(
    'reads exactly one strict hydration identity payload',
    assertStrictBootstrapIdentity,
  );
  it(
    'releases native ownership after a failed hydration',
    assertHydrationFailuresReleaseNativeRoot,
  );
  it(
    'releases hydration ownership after synchronous and rejected imports fail',
    assertHydrationImportFailuresReleaseOwnership,
  );
  it(
    'checks hydration identity and seeds native signals before import',
    assertHydrationIdentityAndBootstrap,
  );
  it(
    'rejects mismatched native compilation before bootstrap or import',
    assertNativeCompilationMismatchBeforeImport,
  );
  it(
    'rejects canceled CSR imports before they settle and preserves replacement ownership',
    assertPendingCSRImportCancellation,
  );
  it(
    'releases canceled hydration imports and preserves replacement bridge ownership',
    assertPendingHydrationImportCancellation,
  );
  it(
    'disposes active native applications once when aborted',
    assertActiveAbortDisposesNativeResources,
  );
  it(
    'rejects pre-aborted startup before import or bridge setup',
    assertPreAbortedStartupDoesNotImport,
  );
  it(
    'preserves shared cached module resources for active or pending replacement imports',
    assertCanceledImportsPreserveSharedResources,
  );
  it(
    'defers abort teardown until a native render finishes',
    assertAbortDuringNativeRenderDoesNotReenterUnmount,
  );
});

describe('Worker transport ownership', () => {
  it(
    'creates and disposes exactly one transport per document handle',
    assertWorkerTransportDocumentLifetime,
  );
  it(
    'releases application ownership when the transport factory throws',
    assertWorkerFactoryFailureReleasesOwnership,
  );
});
