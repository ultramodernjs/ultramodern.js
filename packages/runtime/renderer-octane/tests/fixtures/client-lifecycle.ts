import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { RENDERER_BOOTSTRAP_ID } from '@modern-js/renderer-core/document';
import type { RendererIdentity } from '@modern-js/renderer-core/identity';
import { flushSync } from 'octane';
import {
  createElement,
  earlySignalBootstrapScript,
  renderToString,
} from 'octane/server';
import {
  hydrateOctaneApplication,
  mountOctaneApplication,
  type OctaneApplicationHandle,
  type OctaneApplicationModule,
  readOctaneDocumentBootstrap,
} from '../../src/client';
import {
  ClientApplication,
  HydrationApplication,
  ThrowingApplication,
} from './client-app';

const identity: RendererIdentity = {
  renderer: 'octane',
  appId: 'native-client-contract',
  entryName: 'main',
  protocolVersion: 1,
  buildId: 'application-source-profile-build',
};

const nativeHydrationBuildId = 'octane-client-compiler-hash';

const flush = () => flushSync(() => {});

function container() {
  const element = document.createElement('div');
  document.body.append(element);
  return element;
}

// A native streamed authority is permanently retired for its Document. A new
// server response therefore needs a real new browser Document and Window.
function installHydrationBrowser() {
  const browser = new window.Window();
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const restore = () => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    browser.close();
  };
  try {
    for (const key of [
      'window',
      'document',
      'Document',
      'DocumentFragment',
      'Node',
      'NodeFilter',
      'Element',
      'HTMLElement',
      'HTMLTemplateElement',
      'Text',
      'Comment',
      'Event',
      'CustomEvent',
      'MouseEvent',
      'InputEvent',
      'MutationObserver',
    ]) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value: key === 'window' ? browser : Reflect.get(browser, key),
      });
    }
    for (const key of [
      'getComputedStyle',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ] as const) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value: browser[key].bind(browser),
      });
    }
    for (const key of [
      '__octaneStreamedSignalSelections',
      '__octaneStreamedRenderer',
      '__octaneEarlySignalControls',
      '__octanePublishSignalControl',
      '$OCTRC',
      '$OCTRH',
      '$OCTRX',
    ]) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        configurable: true,
        get: () => Reflect.get(browser, key),
        set: value => {
          Reflect.set(browser, key, value);
        },
      });
    }
    return restore;
  } catch (error) {
    restore();
    throw error;
  }
}

async function assertRetiredHydrationReleasesRoot(
  element: HTMLElement,
  documentId: string,
) {
  let imports = 0;
  await assert.rejects(
    hydrateOctaneApplication({
      container: element,
      identity,
      nativeHydrationBuildId,
      documentIdentity: identity,
      documentNativeHydrationBuildId: nativeHydrationBuildId,
      documentId,
      load: async () => {
        imports++;
        return { default: HydrationApplication };
      },
    }),
    /streamed signal hydration owner is already installed/,
  );
  assert.equal(imports, 0);
  const handle = await mountOctaneApplication({
    container: element,
    identity,
    nativeHydrationBuildId,
    load: async () => ({
      default: ClientApplication,
      props: { label: 'Released root' },
    }),
  });
  try {
    flush();
    assert.equal(element.querySelector('p')?.textContent, 'Released root');
  } finally {
    handle.dispose();
  }
}

function installServerMailbox() {
  const script = earlySignalBootstrapScript();
  assert.match(script, /^<script/);
  const source = script.slice(
    script.indexOf('>') + 1,
    script.lastIndexOf('</script>'),
  );
  runInNewContext(source, window);
}

function prepareHydrationRoot(element: HTMLElement) {
  element.innerHTML = renderToString(
    createElement('section', {
      'data-fixture': 'native-hydration',
      children: 'Native hydration',
    }),
  ).html;
  installServerMailbox();
}

async function assertStartupRejectedBeforeImport(
  startup: Promise<OctaneApplicationHandle>,
  reason: unknown,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      assert.rejects(startup, error => error === reason),
      new Promise<void>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              'Cancellation waited for the unresolved application import.',
            ),
          );
        }, 1000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function assertPendingImportCancellation(hydrating: boolean) {
  let restoreBrowser = hydrating ? installHydrationBrowser() : () => {};
  let element = container();
  const controller = new AbortController();
  const reason = new Error('Pending native application canceled');
  let resolveImport!: (application: OctaneApplicationModule) => void;
  let importResolved = false;
  let abandonedDisposals = 0;
  let replacementDisposals = 0;
  let nativeCleanups = 0;
  let replacement: OctaneApplicationHandle | undefined;
  const importing = new Promise<OctaneApplicationModule>(resolve => {
    resolveImport = application => {
      importResolved = true;
      resolve(application);
    };
  });
  const documentId = 'cancelable-native-document';
  try {
    if (hydrating) prepareHydrationRoot(element);
    const startupOptions = {
      container: element,
      identity,
      nativeHydrationBuildId,
      signal: controller.signal,
      load: () => importing,
    };
    const startup = hydrating
      ? hydrateOctaneApplication({
          ...startupOptions,
          documentIdentity: identity,
          documentNativeHydrationBuildId: nativeHydrationBuildId,
          documentId,
        })
      : mountOctaneApplication(startupOptions);
    const rejected = assertStartupRejectedBeforeImport(startup, reason);
    controller.abort(reason);
    await rejected;
    assert.equal(importResolved, false);
    if (hydrating) {
      await assertRetiredHydrationReleasesRoot(element, documentId);
      element.remove();
      restoreBrowser();
      restoreBrowser = installHydrationBrowser();
      element = container();
      prepareHydrationRoot(element);
    }

    const replacementOptions = {
      container: element,
      identity,
      nativeHydrationBuildId,
      load: async () => ({
        default: hydrating ? HydrationApplication : ClientApplication,
        props: {
          label: 'Replacement application',
          onCleanup: () => nativeCleanups++,
        },
        dispose: () => replacementDisposals++,
      }),
    };
    replacement = hydrating
      ? await hydrateOctaneApplication({
          ...replacementOptions,
          documentIdentity: identity,
          documentNativeHydrationBuildId: nativeHydrationBuildId,
          documentId,
        })
      : await mountOctaneApplication(replacementOptions);
    flush();
    const replacementNode = element.querySelector('section');
    assert.ok(replacementNode);

    resolveImport({
      default: ClientApplication,
      props: { label: 'Abandoned application' },
      dispose: () => abandonedDisposals++,
    });
    await importing;
    await Promise.resolve();
    assert.equal(abandonedDisposals, 1);
    assert.equal(replacementDisposals, 0);
    assert.equal(element.querySelector('section'), replacementNode);
    assert.equal(
      element.textContent,
      hydrating ? 'Native hydration' : 'Replacement applicationCount: 0',
    );
    controller.abort(reason);
    assert.equal(abandonedDisposals, 1);

    let competingImports = 0;
    await assert.rejects(
      mountOctaneApplication({
        container: element,
        identity,
        nativeHydrationBuildId,
        load: async () => {
          competingImports++;
          return { default: ClientApplication };
        },
      }),
      /already owns/,
    );
    if (hydrating) {
      const competingRoot = container();
      try {
        await assert.rejects(
          hydrateOctaneApplication({
            container: competingRoot,
            identity,
            nativeHydrationBuildId,
            documentIdentity: identity,
            documentNativeHydrationBuildId: nativeHydrationBuildId,
            documentId: 'competing-native-document',
            load: async () => {
              competingImports++;
              return { default: HydrationApplication };
            },
          }),
          /signal bridge already owns/,
        );
      } finally {
        competingRoot.remove();
      }
    } else {
      const button = element.querySelector('button');
      assert.ok(button);
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      flush();
      assert.equal(button.textContent, 'Count: 1');
    }
    assert.equal(competingImports, 0);
    replacement.dispose();
    replacement.dispose();
    assert.equal(replacementDisposals, 1);
    assert.equal(abandonedDisposals, 1);
    assert.equal(element.childNodes.length, 0);
    if (!hydrating) assert.equal(nativeCleanups, 1);
  } finally {
    controller.abort(reason);
    try {
      replacement?.dispose();
    } finally {
      element.remove();
      restoreBrowser();
    }
  }
}

export async function assertPendingCSRImportCancellation() {
  await assertPendingImportCancellation(false);
}

export async function assertPendingHydrationImportCancellation() {
  await assertPendingImportCancellation(true);
}

export async function assertActiveAbortDisposesNativeResources() {
  for (const hydrating of [false, true]) {
    const element = container();
    const controller = new AbortController();
    let disposals = 0;
    let nativeCleanups = 0;
    let handle: OctaneApplicationHandle | undefined;
    try {
      if (hydrating) prepareHydrationRoot(element);
      const options = {
        container: element,
        identity,
        nativeHydrationBuildId,
        signal: controller.signal,
        load: async () => ({
          default: hydrating ? HydrationApplication : ClientApplication,
          props: {
            label: 'Cancelable application',
            onCleanup: () => nativeCleanups++,
          },
          dispose: () => disposals++,
        }),
      };
      handle = hydrating
        ? await hydrateOctaneApplication({
            ...options,
            documentIdentity: identity,
            documentNativeHydrationBuildId: nativeHydrationBuildId,
            documentId: 'active-native-cancellation',
          })
        : await mountOctaneApplication(options);
      flush();
      assert.ok(element.querySelector('section'));
      controller.abort(new Error('Active native application canceled'));
      await Promise.resolve();
      assert.equal(disposals, 1);
      assert.equal(element.childNodes.length, 0);
      if (!hydrating) assert.equal(nativeCleanups, 1);
      handle.dispose();
      handle.dispose();
      assert.equal(disposals, 1);
      assert.throws(
        () => handle!.update({ default: ClientApplication }),
        /disposed/,
      );
    } finally {
      handle?.dispose();
      element.remove();
    }
  }
}

export async function assertPreAbortedStartupDoesNotImport() {
  const element = container();
  const controller = new AbortController();
  const reason = new Error('Application canceled before startup');
  let imports = 0;
  controller.abort(reason);
  try {
    for (const operation of [
      mountOctaneApplication,
      hydrateOctaneApplication,
    ]) {
      await assert.rejects(
        Reflect.apply(operation, undefined, [
          {
            container: element,
            identity,
            nativeHydrationBuildId,
            documentIdentity: identity,
            documentNativeHydrationBuildId: nativeHydrationBuildId,
            documentId: 'pre-aborted-native-application',
            signal: controller.signal,
            load: async () => {
              imports++;
              return { default: ClientApplication };
            },
          },
        ]),
        error => error === reason,
      );
    }
    assert.equal(imports, 0);
  } finally {
    element.remove();
  }
}

export async function assertCanceledImportsPreserveSharedResources() {
  for (const sharedPendingImport of [false, true]) {
    const element = container();
    const controller = new AbortController();
    const reason = new Error('Superseded cached application import');
    let resolveImport!: (application: OctaneApplicationModule) => void;
    let disposals = 0;
    let replacement: OctaneApplicationHandle | undefined;
    const importing = new Promise<OctaneApplicationModule>(resolve => {
      resolveImport = resolve;
    });
    const sharedModule = {
      default: ClientApplication,
      props: { label: 'Shared module replacement' },
      dispose: () => disposals++,
    };
    try {
      const startup = mountOctaneApplication({
        container: element,
        identity,
        nativeHydrationBuildId,
        signal: controller.signal,
        load: () => importing,
      });
      const rejected = assertStartupRejectedBeforeImport(startup, reason);
      controller.abort(reason);
      await rejected;

      const replacementStartup = mountOctaneApplication({
        container: element,
        identity,
        nativeHydrationBuildId,
        load: () =>
          sharedPendingImport ? importing : Promise.resolve(sharedModule),
      });
      if (sharedPendingImport) resolveImport(sharedModule);
      replacement = await replacementStartup;
      flush();
      if (!sharedPendingImport) resolveImport(sharedModule);
      await importing;
      await Promise.resolve();
      assert.equal(disposals, 0);
      assert.equal(
        element.querySelector('p')?.textContent,
        'Shared module replacement',
      );
      replacement.dispose();
      replacement.dispose();
      assert.equal(disposals, 1);
    } finally {
      replacement?.dispose();
      element.remove();
    }
  }
}

export async function assertAbortDuringNativeRenderDoesNotReenterUnmount() {
  const element = container();
  const controller = new AbortController();
  const reason = new Error('Native render canceled its application');
  let disposals = 0;
  let nativeCleanups = 0;
  let handle: OctaneApplicationHandle | undefined;
  const dispose = () => disposals++;
  const diagnostics: unknown[][] = [];
  const originalError = console.error;
  try {
    handle = await mountOctaneApplication({
      container: element,
      identity,
      nativeHydrationBuildId,
      signal: controller.signal,
      load: async () => ({
        default: ClientApplication,
        props: {
          label: 'Before native render abort',
          onCleanup: () => nativeCleanups++,
        },
        dispose,
      }),
    });
    flush();
    console.error = (...args: unknown[]) => {
      diagnostics.push(args);
    };
    handle.update({
      default: ClientApplication,
      props: {
        label: 'During native render abort',
        onRender: () => controller.abort(reason),
      },
      dispose,
    });
    flush();
    await Promise.resolve();
    assert.equal(disposals, 1);
    assert.equal(nativeCleanups, 1);
    assert.equal(element.childNodes.length, 0);
    assert.equal(
      diagnostics.some(args =>
        args.some(value => String(value).includes('synchronously unmount')),
      ),
      false,
    );
    handle.dispose();
    assert.equal(disposals, 1);
  } finally {
    console.error = originalError;
    handle?.dispose();
    element.remove();
  }
}

export async function assertNativeMountLifecycle() {
  const element = container();
  let firstDisposals = 0;
  let secondDisposals = 0;
  let nativeCleanups = 0;
  let handle: OctaneApplicationHandle | undefined;
  try {
    handle = await mountOctaneApplication({
      container: element,
      identity,
      nativeHydrationBuildId,
      load: async () => ({
        default: ClientApplication,
        props: { label: 'First module', onCleanup: () => nativeCleanups++ },
        dispose: () => firstDisposals++,
      }),
    });
    flush();
    assert.equal(element.querySelector('p')?.textContent, 'First module');
    assert.equal(element.querySelector('button')?.textContent, 'Count: 0');
    element
      .querySelector('button')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flush();
    assert.equal(element.querySelector('button')?.textContent, 'Count: 1');

    handle.update({
      default: ClientApplication,
      props: { label: 'Updated module', onCleanup: () => nativeCleanups++ },
      dispose: () => secondDisposals++,
    });
    flush();
    assert.equal(element.querySelector('p')?.textContent, 'Updated module');
    assert.equal(element.querySelector('button')?.textContent, 'Count: 1');
    assert.equal(firstDisposals, 1);
    assert.equal(secondDisposals, 0);
    assert.equal(nativeCleanups, 0);
    assert.equal(Object.isFrozen(handle.identity), true);

    handle.dispose();
    handle.dispose();
    assert.equal(element.childNodes.length, 0);
    assert.equal(firstDisposals, 1);
    assert.equal(secondDisposals, 1);
    assert.equal(nativeCleanups, 1);
    assert.throws(
      () => handle!.update({ default: ClientApplication }),
      /disposed/,
    );

    const replacement = await mountOctaneApplication({
      container: element,
      identity,
      nativeHydrationBuildId,
      load: async () => ({
        default: ClientApplication,
        props: { label: 'Remounted module' },
      }),
    });
    flush();
    assert.equal(element.querySelector('p')?.textContent, 'Remounted module');
    replacement.dispose();
  } finally {
    handle?.dispose();
    element.remove();
  }
}

export async function assertRootClaimsAndImportFailures() {
  const element = container();
  let loadCalls = 0;
  let resolveLoad!: (value: {
    default: typeof ClientApplication;
    props: { label: string };
  }) => void;
  const first = mountOctaneApplication({
    container: element,
    identity,
    nativeHydrationBuildId,
    load: () =>
      new Promise(resolve => {
        resolveLoad = resolve;
      }),
  });
  await assert.rejects(
    mountOctaneApplication({
      container: element,
      identity,
      nativeHydrationBuildId,
      load: async () => {
        loadCalls++;
        return { default: ClientApplication };
      },
    }),
    /already owns/,
  );
  assert.equal(loadCalls, 0);
  resolveLoad({ default: ClientApplication, props: { label: 'Claim holder' } });
  const firstHandle = await first;
  firstHandle.dispose();

  const importFailure = new Error('Application import failed');
  await assert.rejects(
    mountOctaneApplication({
      container: element,
      identity,
      nativeHydrationBuildId,
      load: async () => {
        throw importFailure;
      },
    }),
    error => error === importFailure,
  );
  await assert.rejects(
    mountOctaneApplication({
      container: element,
      identity: { ...identity, renderer: 'solid' },
      nativeHydrationBuildId,
      load: async () => {
        loadCalls++;
        return { default: ClientApplication };
      },
    }),
    /Octane renderer identity/,
  );
  assert.equal(loadCalls, 0);

  const recovered = await mountOctaneApplication({
    container: element,
    identity,
    nativeHydrationBuildId,
    load: async () => ({
      default: ClientApplication,
      props: { label: 'Recovered import' },
    }),
  });
  flush();
  assert.equal(element.querySelector('p')?.textContent, 'Recovered import');
  recovered.dispose();
  element.remove();
}

export async function assertCleanupFailuresReleaseRoot() {
  const element = container();
  let disposals = 0;
  const error = new Error('Application cleanup failed');
  const handle = await mountOctaneApplication({
    container: element,
    identity,
    nativeHydrationBuildId,
    load: async () => ({
      default: ClientApplication,
      props: { label: 'Throwing cleanup' },
      dispose: () => {
        disposals++;
        throw error;
      },
    }),
  });
  flush();
  assert.throws(
    () => handle.dispose(),
    (caught: unknown) =>
      caught instanceof AggregateError && caught.errors.includes(error),
  );
  handle.dispose();
  assert.equal(disposals, 1);
  assert.equal(element.childNodes.length, 0);
  const recovered = await mountOctaneApplication({
    container: element,
    identity,
    nativeHydrationBuildId,
    load: async () => ({
      default: ClientApplication,
      props: { label: 'Recovered cleanup' },
    }),
  });
  recovered.dispose();
  element.remove();
}

export async function assertInitialRenderFailureReleasesRoot() {
  const element = container();
  let disposals = 0;
  await assert.rejects(
    mountOctaneApplication({
      container: element,
      identity,
      nativeHydrationBuildId,
      load: async () => ({
        default: ThrowingApplication,
        dispose: () => disposals++,
      }),
    }),
    /Native component failed/,
  );
  assert.equal(disposals, 1);
  const recovered = await mountOctaneApplication({
    container: element,
    identity,
    nativeHydrationBuildId,
    load: async () => ({
      default: ClientApplication,
      props: { label: 'Recovered render' },
    }),
  });
  flush();
  assert.equal(element.querySelector('p')?.textContent, 'Recovered render');
  recovered.dispose();
  element.remove();
}

export async function assertConsumerCallbacksPreserveInitialFailure() {
  const element = container();
  const errors: unknown[] = [];
  let disposals = 0;
  await assert.rejects(
    mountOctaneApplication({
      container: element,
      identity,
      nativeHydrationBuildId,
      options: { onUncaughtError: error => errors.push(error) },
      load: async () => ({
        default: ThrowingApplication,
        dispose: () => disposals++,
      }),
    }),
    /Native component failed/,
  );
  assert.equal(disposals, 1);
  assert.equal(errors.length, 1);
  const recovered = await mountOctaneApplication({
    container: element,
    identity,
    nativeHydrationBuildId,
    load: async () => ({
      default: ClientApplication,
      props: { label: 'Recovered callback' },
    }),
  });
  recovered.dispose();
  element.remove();
}

export async function assertScheduledRenderFailureReleasesRoot() {
  const element = container();
  const errors: unknown[] = [];
  let firstDisposals = 0;
  let secondDisposals = 0;
  const handle = await mountOctaneApplication({
    container: element,
    identity,
    nativeHydrationBuildId,
    options: { onUncaughtError: error => errors.push(error) },
    load: async () => ({
      default: ClientApplication,
      props: { label: 'Before scheduled failure' },
      dispose: () => firstDisposals++,
    }),
  });
  flush();
  handle.update({
    default: ClientApplication,
    props: { label: 'After scheduled failure', shouldFail: true },
    dispose: () => secondDisposals++,
  });
  assert.equal(firstDisposals, 1);
  flush();
  await Promise.resolve();
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /Native scheduled render failed/);
  assert.equal(secondDisposals, 1);
  assert.equal(element.childNodes.length, 0);
  handle.dispose();
  assert.equal(secondDisposals, 1);
  assert.throws(
    () => handle.update({ default: ClientApplication }),
    /disposed/,
  );
  const recovered = await mountOctaneApplication({
    container: element,
    identity,
    nativeHydrationBuildId,
    load: async () => ({
      default: ClientApplication,
      props: { label: 'Recovered scheduled render' },
    }),
  });
  flush();
  assert.equal(
    element.querySelector('p')?.textContent,
    'Recovered scheduled render',
  );
  recovered.dispose();
  element.remove();
}

export function assertStrictBootstrapIdentity() {
  const script = document.createElement('script');
  script.id = RENDERER_BOOTSTRAP_ID;
  script.type = 'application/json';
  document.head.append(script);
  const payload = {
    identity,
    nativeHydrationBuildId,
    documentId: 'strict-native-document',
    hydrating: true,
  };
  try {
    script.textContent = JSON.stringify(payload);
    const result = readOctaneDocumentBootstrap(
      document,
      identity,
      nativeHydrationBuildId,
    );
    assert.equal(result.documentId, payload.documentId);
    assert.equal(result.hydrating, true);
    assert.equal(result.nativeHydrationBuildId, nativeHydrationBuildId);
    assert.notEqual(result.identity.buildId, result.nativeHydrationBuildId);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.identity), true);
    // Shared bootstrap validation is covered by renderer-core's document tests.
    for (const invalid of [
      { ...payload, identity: { ...identity, renderer: 'solid' } },
      { identity, documentId: payload.documentId, hydrating: true },
      { ...payload, nativeHydrationBuildId: '' },
      { ...payload, nativeHydrationBuildId: null },
      { ...payload, nativeHydrationBuildId: identity.buildId },
    ]) {
      script.textContent = JSON.stringify(invalid);
      assert.throws(() =>
        readOctaneDocumentBootstrap(document, identity, nativeHydrationBuildId),
      );
    }
  } finally {
    script.remove();
  }
}

export async function assertForeignDocumentFailsBeforeImport() {
  const foreignDocument =
    document.implementation.createHTMLDocument('Foreign document');
  const element = foreignDocument.createElement('div');
  foreignDocument.body.append(element);
  let imports = 0;
  await assert.rejects(
    hydrateOctaneApplication({
      container: element,
      identity,
      nativeHydrationBuildId,
      documentIdentity: identity,
      documentNativeHydrationBuildId: nativeHydrationBuildId,
      documentId: 'foreign-document',
      load: async () => {
        imports++;
        return { default: HydrationApplication };
      },
    }),
    /document/i,
  );
  assert.equal(imports, 0);
}

export async function assertDocumentContainersFailBeforeImport() {
  let imports = 0;
  for (const operation of [mountOctaneApplication, hydrateOctaneApplication]) {
    await assert.rejects(
      Reflect.apply(operation, undefined, [
        {
          container: document,
          identity,
          nativeHydrationBuildId,
          documentIdentity: identity,
          documentNativeHydrationBuildId: nativeHydrationBuildId,
          documentId: 'unsupported-document-root',
          load: async () => {
            imports++;
            return { default: HydrationApplication };
          },
        },
      ]),
      /document|container/i,
    );
  }
  assert.equal(imports, 0);
}

export async function assertNativeCompilationMismatchBeforeImport() {
  const element = container();
  let imports = 0;
  try {
    await assert.rejects(
      hydrateOctaneApplication({
        container: element,
        identity,
        nativeHydrationBuildId,
        documentIdentity: identity,
        documentNativeHydrationBuildId: identity.buildId,
        documentId: 'different-native-compilation',
        load: async () => {
          imports++;
          return { default: HydrationApplication };
        },
      }),
      /different native client compilation/,
    );
    assert.equal(imports, 0);
  } finally {
    element.remove();
  }
}

export async function assertHydrationImportFailuresReleaseOwnership() {
  for (const synchronous of [true, false]) {
    let restoreBrowser = installHydrationBrowser();
    let element = container();
    const importFailure = new Error('Hydration application import failed');
    let recovered: OctaneApplicationHandle | undefined;
    try {
      prepareHydrationRoot(element);
      const options = {
        container: element,
        identity,
        nativeHydrationBuildId,
        documentIdentity: identity,
        documentNativeHydrationBuildId: nativeHydrationBuildId,
        documentId: 'failed-hydration-import',
      };
      await assert.rejects(
        hydrateOctaneApplication({
          ...options,
          load: () => {
            if (synchronous) throw importFailure;
            return Promise.reject(importFailure);
          },
        }),
        error => error === importFailure,
      );

      await assertRetiredHydrationReleasesRoot(element, options.documentId);
      element.remove();
      restoreBrowser();
      restoreBrowser = installHydrationBrowser();
      element = container();
      prepareHydrationRoot(element);
      const existingNode = element.querySelector('section');
      assert.ok(existingNode);
      recovered = await hydrateOctaneApplication({
        ...options,
        container: element,
        load: async () => ({ default: HydrationApplication }),
      });
      flush();
      assert.equal(element.querySelector('section'), existingNode);
      assert.equal(element.textContent, 'Native hydration');
    } finally {
      try {
        recovered?.dispose();
      } finally {
        element.remove();
        restoreBrowser();
      }
    }
  }
}

export async function assertHydrationFailuresReleaseNativeRoot() {
  const element = container();
  let disposals = 0;
  const reported: unknown[] = [];
  installServerMailbox();
  element.innerHTML = renderToString(
    createElement('section', {
      'data-fixture': 'native-hydration',
      children: 'Native hydration',
    }),
  ).html;
  await assert.rejects(
    hydrateOctaneApplication({
      container: element,
      identity,
      nativeHydrationBuildId,
      documentIdentity: identity,
      documentNativeHydrationBuildId: nativeHydrationBuildId,
      documentId: 'failed-native-hydration',
      options: { onUncaughtError: error => reported.push(error) },
      load: async () => ({
        default: ThrowingApplication,
        dispose: () => disposals++,
      }),
    }),
    /Native component failed/,
  );
  assert.equal(reported.length, 1);
  assert.equal(disposals, 1);

  // Octane's native duplicate-root diagnostic catches ownership that would
  // survive if the adapter let hydrateRoot throw before receiving its Root.
  const diagnostics: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    diagnostics.push(args);
  };
  let recovered: OctaneApplicationHandle | undefined;
  try {
    installServerMailbox();
    element.innerHTML = renderToString(
      createElement('section', {
        'data-fixture': 'native-hydration',
        children: 'Native hydration',
      }),
    ).html;
    recovered = await hydrateOctaneApplication({
      container: element,
      identity,
      nativeHydrationBuildId,
      documentIdentity: identity,
      documentNativeHydrationBuildId: nativeHydrationBuildId,
      documentId: 'recovered-native-hydration',
      load: async () => ({ default: HydrationApplication }),
    });
    flush();
    assert.equal(element.textContent, 'Native hydration');
    assert.equal(
      diagnostics.some(args =>
        args.some(value =>
          String(value).includes('already been passed to createRoot'),
        ),
      ),
      false,
    );
  } finally {
    console.error = originalError;
    recovered?.dispose();
    element.remove();
  }
}

export async function assertHydrationIdentityAndBootstrap() {
  let restoreBrowser = installHydrationBrowser();
  let element = container();
  let imports = 0;
  let handle: OctaneApplicationHandle | undefined;
  try {
    for (const documentIdentity of [
      { ...identity, renderer: 'react' as const },
      { ...identity, buildId: 'another-build' },
      { ...identity, appId: 'another-application' },
    ]) {
      await assert.rejects(
        hydrateOctaneApplication({
          container: element,
          identity,
          nativeHydrationBuildId,
          documentIdentity,
          documentNativeHydrationBuildId: nativeHydrationBuildId,
          documentId: 'native-document',
          load: async () => {
            imports++;
            return { default: HydrationApplication };
          },
        }),
        /conflicts with the application build/,
      );
    }
    assert.equal(imports, 0);

    // The HTML and the pre-module mailbox both come from the published native
    // server APIs; this test does not manufacture the receiver's global state.
    element.innerHTML = renderToString(
      createElement('section', {
        'data-fixture': 'native-hydration',
        children: 'Native hydration',
      }),
    ).html;
    let existingNode = element.querySelector('section');
    installServerMailbox();
    const controller = new AbortController();
    const reason = new Error('Hydration canceled before its import');
    let resolveImport!: (application: OctaneApplicationModule) => void;
    let abandonedDisposals = 0;
    const importing = new Promise<OctaneApplicationModule>(resolve => {
      resolveImport = resolve;
    });
    const startup = hydrateOctaneApplication({
      container: element,
      identity,
      nativeHydrationBuildId,
      documentIdentity: { ...identity },
      documentNativeHydrationBuildId: nativeHydrationBuildId,
      documentId: 'native-document',
      signal: controller.signal,
      load: () => {
        imports++;
        return importing;
      },
    });
    const rejected = assertStartupRejectedBeforeImport(startup, reason);
    controller.abort(reason);
    await rejected;
    assert.equal(imports, 1);
    await assertRetiredHydrationReleasesRoot(element, 'native-document');
    element.remove();
    restoreBrowser();
    restoreBrowser = installHydrationBrowser();
    element = container();
    prepareHydrationRoot(element);
    existingNode = element.querySelector('section');
    handle = await hydrateOctaneApplication({
      container: element,
      identity,
      nativeHydrationBuildId,
      documentIdentity: { ...identity },
      documentNativeHydrationBuildId: nativeHydrationBuildId,
      documentId: 'native-document',
      load: async () => {
        imports++;
        return { default: HydrationApplication };
      },
    });
    flush();
    assert.equal(imports, 2);
    assert.equal(element.querySelector('section'), existingNode);
    assert.equal(element.textContent, 'Native hydration');

    const anotherRoot = container();
    try {
      for (const documentId of ['native-document', 'another-document-id']) {
        await assert.rejects(
          hydrateOctaneApplication({
            container: anotherRoot,
            identity,
            nativeHydrationBuildId,
            documentIdentity: identity,
            documentNativeHydrationBuildId: nativeHydrationBuildId,
            documentId,
            load: async () => {
              imports++;
              return { default: HydrationApplication };
            },
          }),
          /signal bridge already owns/,
        );
      }
      assert.equal(imports, 2);
    } finally {
      anotherRoot.remove();
    }

    resolveImport({
      default: HydrationApplication,
      dispose: () => abandonedDisposals++,
    });
    await importing;
    await Promise.resolve();
    assert.equal(abandonedDisposals, 1);
    assert.equal(element.querySelector('section'), existingNode);
    handle.dispose();
  } finally {
    try {
      handle?.dispose();
    } finally {
      element.remove();
      restoreBrowser();
    }
  }
}

export async function assertWorkerTransportDocumentLifetime() {
  const element = container();
  const signals: AbortSignal[] = [];
  const disposals: number[] = [];
  const workerFederation = (signal: AbortSignal) => {
    const document = signals.length;
    signals.push(signal);
    disposals.push(0);
    return {
      locale: 'en',
      signal,
      transport: {
        admit: async () => {
          throw new Error('No remote expected');
        },
        request: async () => {
          throw new Error('No remote expected');
        },
        dispose: () => {
          disposals[document] = disposals[document]! + 1;
        },
      },
    };
  };
  const options = {
    container: element,
    identity,
    nativeHydrationBuildId,
    documentId: 'worker-document-lifetime',
    workerFederation,
    load: async () => ({
      default: ClientApplication,
      props: { label: 'Worker owner' },
    }),
  };
  let first: OctaneApplicationHandle | undefined;
  let second: OctaneApplicationHandle | undefined;
  try {
    first = await mountOctaneApplication(options);
    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.aborted, false);
    first.dispose();
    first.dispose();
    assert.equal(signals[0]!.aborted, true);
    assert.deepEqual(disposals, [1]);
    second = await mountOctaneApplication(options);
    assert.equal(signals.length, 2);
    assert.notEqual(signals[0], signals[1]);
    assert.equal(signals[1]!.aborted, false);
    second.dispose();
    assert.deepEqual(disposals, [1, 1]);
  } finally {
    first?.dispose();
    second?.dispose();
    element.remove();
  }
}

export async function assertWorkerFactoryFailureReleasesOwnership() {
  const element = container();
  const reason = new Error('Worker factory failed');
  const options = {
    container: element,
    identity,
    nativeHydrationBuildId,
    documentId: 'worker-factory-failure',
    load: async () => ({
      default: ClientApplication,
      props: { label: 'Recovered' },
    }),
  };
  let replacement: OctaneApplicationHandle | undefined;
  try {
    await assert.rejects(
      mountOctaneApplication({
        ...options,
        workerFederation: () => {
          throw reason;
        },
      }),
      error => error === reason,
    );
    replacement = await mountOctaneApplication(options);
    assert.ok(element.querySelector('section'));
  } finally {
    replacement?.dispose();
    element.remove();
  }
}
