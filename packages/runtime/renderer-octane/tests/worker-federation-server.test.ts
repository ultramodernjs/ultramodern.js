import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
import * as rendererDocument from '@modern-js/renderer-core/document';
import * as rendererFederation from '@modern-js/renderer-core/federation';
import * as rendererIdentity from '@modern-js/renderer-core/identity';
import type { NativeWorkerEntryResources } from '@modern-js/renderer-core/server';
import { createRequestSession } from '@modern-js/renderer-core/session';
import {
  createWorkerFederationHandler,
  createWorkerFederationTransport,
  readWorkerFederationPublication,
} from '@modern-js/renderer-core/worker-federation';
import { rspack } from '@rsbuild/core';
import { Window } from 'happy-dom';
import { JSDOM } from 'jsdom';
import { compile } from 'octane/compiler';
import * as serverInternals from 'octane/internal/server';
import * as serverNative from 'octane/server';
import { createElement, decodeExternalSnapshot } from 'octane/server';
import {
  admitRendererContract,
  manifestFixture,
} from '../../renderer-core/tests/worker-federation.fixture';
import type { OctaneApplicationHandle } from '../src/client';
import { federatedComponent } from '../src/federation';
import { I18nContext } from '../src/i18n/context';
import { renderOctaneApplication } from '../src/server';
import {
  createNativeWorkerFederationRuntime,
  type OctaneWorkerFederationRegistry,
} from '../src/worker-federation';

function publication(remote: string) {
  const manifest = manifestFixture();
  manifest.metaData.ultramodernRenderer.identities.index.appId = remote;
  manifest.metaData.ultramodernWorkerFederation.remote = remote;
  manifest.metaData.ultramodernWorkerFederation.exposes['./Widget'].boundaryId =
    `${remote}Container`;
  manifest.metaData.ultramodernWorkerFederation.exposes[
    './Widget'
  ].native.publisherBuildId = `${remote}-native-client`;
  const renderer = admitRendererContract(manifest.metaData.ultramodernRenderer);
  const worker = readWorkerFederationPublication(
    manifest.metaData.ultramodernWorkerFederation,
    renderer.identities,
  );
  const resources: NativeWorkerEntryResources = {
    assets: [],
    serverConfig: { ssr: true },
    workerFederation: { renderer, worker },
    workerFederationManifestUrl: `https://${remote}.test/mf-manifest.json`,
  };
  return { manifest, renderer, worker, resources };
}

test('a real native exposed component loads a native federated child through its own request transport', async () => {
  const parent = publication('parent');
  const child = publication('child');
  // Real completed MF expose assets, separate from native component styles.
  // The Worker imports modules directly and must not start a local server MF host.
  for (const owner of [parent, child]) {
    const name = owner.worker.remote;
    Object.assign(owner.manifest.metaData, {
      publicPath: `https://${name}.test/client/`,
    });
    Object.assign(owner.manifest, {
      exposes: [
        { path: './Other', assets: { css: { sync: ['unrelated.css'] } } },
        {
          path: './Widget',
          assets: {
            css: {
              sync: ['widget.css', 'https://cdn.example/shared.css'],
              async: ['widget.css', `https://cdn.example/${name}-lazy.css`],
            },
          },
        },
      ],
    });
  }
  const childRequests: string[] = [];
  const parentRequests: string[] = [];
  const childExecution: string[] = [];
  const parentExecution: string[] = [];
  const childSnapshots: string[] = [];
  const parentSnapshots: string[] = [];
  let capturedNativeRequest: Request | undefined;
  const registry = (
    owner: ReturnType<typeof publication>,
    load: () => Promise<unknown>,
    execution: string[],
    snapshots: string[],
  ): OctaneWorkerFederationRegistry => ({
    initialize(options) {
      return createWorkerFederationHandler({
        ...options,
        publication: {
          renderer: owner.renderer,
          worker: options.publication,
        },
        async admitNativeRequest(payload, requestExecution) {
          execution.push('admitting');
          const request = await options.admitNativeRequest(
            payload,
            requestExecution,
          );
          execution.push('admitted');
          return request;
        },
        async renderNativeSnapshot(module, request, requestExecution) {
          const payload = await options.renderNativeSnapshot(
            module,
            request,
            requestExecution,
          );
          snapshots.push(decodeExternalSnapshot(payload).html);
          return payload;
        },
        exposes: {
          './Widget': () => {
            execution.push('import');
            return load();
          },
        },
      });
    },
  });
  const childRuntime = createNativeWorkerFederationRuntime(
    {
      identity: child.renderer.identities.index,
      bundle: {},
      resources: child.resources,
      bindings: {},
    },
    {
      admitRendererContract,
      registry: registry(
        child,
        () => import('./fixtures/worker-federation-child'),
        childExecution,
        childSnapshots,
      ),
    },
  );
  const childBinding = {
    owner: 'child',
    async fetch(request: Request) {
      expect(this.owner).toBe('child');
      childRequests.push(`${request.method} ${request.url}`);
      if (request.method === 'GET') return Response.json(child.manifest);
      const response = await childRuntime.handleRequest(request);
      if (!response)
        throw new Error('The child snapshot endpoint was not selected');
      if (!response.ok)
        throw new Error(
          `Child native snapshot rejected (${response.status}): ${await response.text()}`,
        );
      return response;
    },
  };
  const parentRuntime = createNativeWorkerFederationRuntime(
    {
      identity: parent.renderer.identities.index,
      bundle: {},
      resources: {
        ...parent.resources,
        workerFederationServices: [
          {
            remote: 'child',
            manifestUrl: child.resources.workerFederationManifestUrl!,
            binding: 'CHILD_WORKER',
            fragments: [
              {
                expose: './Widget',
                boundaryId: 'childContainer',
                paths: child.worker.exposes['./Widget'].paths,
              },
            ],
          },
        ],
      },
      bindings: { CHILD_WORKER: childBinding },
    },
    {
      admitRendererContract,
      registry: registry(
        parent,
        () => import('./fixtures/worker-federation-parent'),
        parentExecution,
        parentSnapshots,
      ),
    },
  );
  const transportOptions: Parameters<
    typeof createWorkerFederationTransport
  >[0] = {
    admitRendererContract,
    services: [
      {
        remote: 'parent',
        manifestUrl: parent.resources.workerFederationManifestUrl!,
        fragments: [
          {
            expose: './Widget',
            boundaryId: 'parentContainer',
            paths: parent.worker.exposes['./Widget'].paths,
          },
        ],
        async fetch(request) {
          parentRequests.push(`${request.method} ${request.url}`);
          if (request.method === 'GET') return Response.json(parent.manifest);
          capturedNativeRequest = request.clone();
          const response = await parentRuntime.handleRequest(request);
          if (!response)
            throw new Error('The parent snapshot endpoint was not selected');
          if (!response.ok)
            throw new Error(
              `Parent native snapshot rejected (${response.status}): ${await response.text()}`,
            );
          return response;
        },
      },
    ],
  };
  const transport = createWorkerFederationTransport(transportOptions);
  const session = createRequestSession({
    identity: parent.renderer.identities.index,
    request: new Request('https://host.test/'),
    platform: { kind: 'worker', bindings: {} },
  });
  const Parent = federatedComponent<{ label: string }>('parent/Widget');
  const loadLocalRemote = rstest.fn(async () => {
    throw new Error(
      'Worker SSR must use its request transport, not the local MF host',
    );
  });
  const response = await renderOctaneApplication({
    session,
    document: {
      documentId: 'nested-worker-document',
      nativeHydrationBuildId: 'host-native-client',
      nonce: 'worker-css-nonce',
    },
    workerFederation: transport,
    workerFederationLocale: 'en',
    federation: { instance: () => ({ loadRemote: loadLocalRemote }) },
    App: () => createElement(Parent, { label: 'Nested native props' }),
  });
  const html = await response.text();
  expect(html).toContain('data-native-worker-parent');
  expect(html).toContain('data-native-worker-child');
  expect(html).toContain('Nested native props');
  const expectStyles = (html: string, nonce: string) => {
    for (const href of [
      'https://parent.test/client/widget.css',
      'https://cdn.example/parent-lazy.css',
      'https://child.test/client/widget.css',
      'https://cdn.example/child-lazy.css',
      'https://cdn.example/shared.css',
    ]) {
      const sheets = (html.match(/<link\b[^>]*>/gu) ?? []).filter(tag =>
        tag.includes(`href="${href}"`),
      );
      expect(sheets).toHaveLength(1);
      expect(sheets[0]).toContain(`nonce="${nonce}"`);
      expect(sheets[0]).toContain('data-precedence="federated"');
      expect(html.indexOf(href)).toBeLessThan(
        html.indexOf('data-native-worker-parent'),
      );
    }
  };
  expectStyles(html, 'worker-css-nonce');
  expect(html).not.toContain('unrelated.css');
  expect(
    html.match(/href="https:\/\/cdn\.example\/shared\.css"/gu),
  ).toHaveLength(1);
  expect(html).toContain('nonce="worker-css-nonce"');
  expect((await session.completion).fallback).toBe(false);
  expect(parentRequests).toEqual([
    'GET https://parent.test/mf-manifest.json',
    'POST https://parent.test/en/_mf/fragment/widget',
  ]);
  expect(childRequests).toEqual([
    'GET https://child.test/mf-manifest.json',
    'POST https://child.test/en/_mf/fragment/widget',
  ]);
  expect(parentExecution).toEqual(['admitting', 'admitted', 'import']);
  expect(childExecution).toEqual(['admitting', 'admitted', 'import']);
  expect(loadLocalRemote).not.toHaveBeenCalled();
  expect(parentSnapshots).toHaveLength(1);
  expect(childSnapshots).toHaveLength(1);
  const window = new Window();
  try {
    const document = new window.DOMParser().parseFromString(
      childSnapshots[0],
      'text/html',
    );
    const button = document.querySelector('[data-native-worker-child]');
    expect(button?.textContent).toBe('Nested native props: 3');
    expect(button?.getAttribute('id')).toBeTruthy();
  } finally {
    await window.happyDOM.close();
  }

  if (!capturedNativeRequest)
    throw new Error(
      'The native parent boundary did not issue a snapshot request',
    );
  const envelope: unknown = await capturedNativeRequest.json();
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
    throw new Error('The native request transport did not emit an envelope');
  const rejectedExecution: string[] = [];
  const freshRuntime = createNativeWorkerFederationRuntime(
    {
      identity: parent.renderer.identities.index,
      bundle: {},
      resources: parent.resources,
      bindings: {},
    },
    {
      admitRendererContract,
      registry: registry(
        parent,
        () => import('./fixtures/worker-federation-parent'),
        rejectedExecution,
        [],
      ),
    },
  );
  const rejectedResponse = await freshRuntime.handleRequest(
    new Request(capturedNativeRequest.url, {
      method: capturedNativeRequest.method,
      headers: capturedNativeRequest.headers,
      body: JSON.stringify({ ...envelope, payload: null }),
    }),
  );
  expect(rejectedResponse?.status).toBe(400);
  expect(rejectedExecution).toEqual(['admitting']);
  // A fresh document gets its own resource emission, not a process-wide cache.
  const freshTransport = createWorkerFederationTransport(transportOptions);
  try {
    const freshSession = createRequestSession({
      identity: parent.renderer.identities.index,
      request: new Request('https://host.test/second'),
      platform: { kind: 'worker', bindings: {} },
    });
    const second = await renderOctaneApplication({
      session: freshSession,
      document: {
        documentId: 'nested-worker-second-document',
        nativeHydrationBuildId: 'host-native-client',
        nonce: 'worker-second-nonce',
      },
      workerFederation: freshTransport,
      workerFederationLocale: 'en',
      federation: { instance: () => ({ loadRemote: loadLocalRemote }) },
      App: () =>
        createElement(Parent, { label: 'Second document native props' }),
    });
    const secondHtml = await second.text();
    expectStyles(secondHtml, 'worker-second-nonce');
    expect(secondHtml).not.toContain('nonce="worker-css-nonce"');
    expect((await freshSession.completion).fallback).toBe(false);
    expect(loadLocalRemote).not.toHaveBeenCalled();
  } finally {
    freshTransport.dispose();
  }
});

test('Worker SSR rejects a publisher without native metadata before requesting its expose', async () => {
  const remote = publication('missing-native');
  Reflect.deleteProperty(
    remote.manifest.metaData.ultramodernWorkerFederation.exposes['./Widget'],
    'native',
  );
  const methods: string[] = [];
  const transport = createWorkerFederationTransport({
    admitRendererContract,
    services: [
      {
        remote: 'missing-native',
        manifestUrl: remote.resources.workerFederationManifestUrl!,
        fragments: [
          {
            expose: './Widget',
            boundaryId: 'missing-nativeContainer',
            paths: remote.worker.exposes['./Widget'].paths,
          },
        ],
        async fetch(request) {
          methods.push(request.method);
          if (request.method !== 'GET')
            throw new Error('Unadmitted publisher reached its expose');
          return Response.json(remote.manifest);
        },
      },
    ],
  });
  const session = createRequestSession({
    identity: remote.renderer.identities.index,
    request: new Request('https://host.test/'),
    platform: { kind: 'worker', bindings: {} },
  });
  const Widget = federatedComponent('missing-native/Widget', {
    fallback: () =>
      createElement(
        'p',
        { 'data-native-admission-fallback': '' },
        'Publisher rejected',
      ),
  });
  const loadLocalRemote = rstest.fn(async () => {
    throw new Error(
      'Invalid native publishers must not fall back to the local MF host',
    );
  });
  const logged = rstest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await renderOctaneApplication({
      session,
      document: {
        documentId: 'missing-native-document',
        nativeHydrationBuildId: 'host-native-client',
      },
      workerFederation: transport,
      workerFederationLocale: 'en',
      federation: { instance: () => ({ loadRemote: loadLocalRemote }) },
      App: () => createElement(Widget),
    });
    expect(await response.text()).toContain('Publisher rejected');
    expect((await session.completion).fallback).toBe(true);
    expect(methods).toEqual(['GET']);
    expect(loadLocalRemote).not.toHaveBeenCalled();
  } finally {
    logged.mockRestore();
    transport.dispose();
  }
});

test.each([
  { serverFederation: false, clientFederation: true },
  { serverFederation: true, clientFederation: true },
  { serverFederation: false, clientFederation: false },
])(
  'Worker browser admission retains SSR with server federation=$serverFederation and client federation=$clientFederation',
  async ({ serverFederation, clientFederation }) => {
    // The server test compiler aliases `octane` to its server entry. Let Node
    // load this fixture through the package's public ESM exports, outside that
    // compilation, so every browser entry shares the actual client runtime.
    // Node 26 loads the ESM fixture synchronously without a VM import callback.
    const loadNative = createRequire(path.join(__dirname, '../package.json'));
    const {
      runtime: browserNative,
      internals: browserInternals,
      streamedSignals,
      runtimeGlobal,
    } = loadNative(
      path.join(__dirname, 'fixtures/worker-adoption-browser-runtime.mjs'),
    ) as {
      runtime: typeof import('octane');
      internals: typeof import('octane/internal/client');
      streamedSignals: typeof import('octane/hydration/streamed-signals');
      runtimeGlobal: typeof globalThis;
    };
    expect(runtimeGlobal).toBe(globalThis);
    expect(browserNative.hydrateRoot).toBeTypeOf('function');
    for (const name of ['clone', 'child', 'sibling'] as const)
      expect(browserNative[name]).toBe(browserInternals[name]);

    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>(done => {
        resolve = done;
      });
      return { promise, resolve };
    }
    let clientCommitCount = 0;
    const source = `import { useLayoutEffect, useState } from 'octane';
import { recordCommit } from 'worker-adoption-observer';
export default function Widget(props: { label: string }) {
  const [count, setCount] = useState(3);
  useLayoutEffect(() => { recordCommit(); }, []);
  return <section data-worker-adoption=""><input defaultValue="server draft" /><button data-counter="" onClick={() => setCount(value => value + 1)}>{props.label}: {count}</button></section>;
}`;
    async function evaluate<T>(
      code: string,
      modules: Readonly<Record<string, unknown>>,
    ): Promise<T> {
      const { code: outputText } = await rspack.experiments.swc.transform(
        code,
        {
          jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
          module: { type: 'commonjs' },
          configFile: false,
          swcrc: false,
        },
      );
      const exports = {};
      new Function('require', 'exports', outputText)((request: string) => {
        if (!Object.hasOwn(modules, request))
          throw new Error(`Unexpected native fixture import ${request}`);
        return modules[request];
      }, exports);
      return exports as T;
    }
    type RemoteModule = { default: (props: { label: string }) => unknown };
    const fixtureId = '/worker-adoption/Widget.tsx';
    const serverModule = await evaluate<RemoteModule>(
      compile(source, fixtureId, { mode: 'server' }).code,
      {
        octane: serverNative,
        'octane/server': serverNative,
        'octane/internal/server': serverInternals,
        'worker-adoption-observer': { recordCommit() {} },
      },
    );
    const browserCode = compile(source, fixtureId, { mode: 'client' }).code;
    const browserModule = await evaluate<RemoteModule>(browserCode, {
      octane: browserNative,
      'octane/internal/client': browserInternals,
      'worker-adoption-observer': {
        recordCommit() {
          clientCommitCount++;
        },
      },
    });
    // Published adapter modules are plain JS, not application compiler inputs.
    // Evaluate their real source together, with one browser context graph, while
    // the normal server project retains its own runtime and context instances.
    const adapter = <T>(
      file: string,
      modules: Readonly<Record<string, unknown>>,
    ) =>
      evaluate<T>(
        readFileSync(path.join(__dirname, '../src', file), 'utf8'),
        modules,
      );
    const bootstrap = await adapter<typeof import('../src/bootstrap')>(
      'bootstrap.ts',
      {
        '@modern-js/renderer-core/document': rendererDocument,
        '@modern-js/renderer-core/identity': rendererIdentity,
      },
    );
    const federationContext = await adapter<
      typeof import('../src/federation-context')
    >('federation-context.ts', {
      octane: browserNative,
      '@modern-js/renderer-core/federation': rendererFederation,
    });
    const workerContext = await adapter<
      typeof import('../src/worker-federation-context')
    >('worker-federation-context.ts', {
      octane: browserNative,
      './federation-context': federationContext,
    });
    const workerContexts = await adapter<
      typeof import('../src/worker-federation-contexts')
    >('worker-federation-contexts.ts', { octane: browserNative });
    const i18nContext = await adapter<typeof import('../src/i18n/context')>(
      'i18n/context.ts',
      { octane: browserNative },
    );
    const { hydrateOctaneApplication } = await adapter<
      typeof import('../src/client')
    >('client.ts', {
      octane: browserNative,
      'octane/hydration/streamed-signals': streamedSignals,
      '@modern-js/renderer-core/identity': rendererIdentity,
      './bootstrap': bootstrap,
      './federation-context': federationContext,
      './worker-federation-context': workerContext,
    });
    const browserFederation = await evaluate<{
      federatedComponent: typeof federatedComponent;
    }>(readFileSync(path.join(__dirname, '../src/federation.ts'), 'utf8'), {
      octane: browserNative,
      '@modern-js/renderer-core/federation': rendererFederation,
      './federation-context': federationContext,
      './i18n/context': i18nContext,
      './worker-federation-context': workerContext,
      './worker-federation-contexts': workerContexts,
    });
    const owner = publication('adoption');
    const hostIdentity = {
      ...owner.renderer.identities.index,
      appId: 'adoption-host',
      buildId: 'built-host',
    };
    expect(hostIdentity.appId).not.toBe(owner.renderer.identities.index.appId);
    expect(hostIdentity.buildId).not.toBe(
      owner.renderer.identities.index.buildId,
    );
    const runtime = createNativeWorkerFederationRuntime(
      {
        identity: owner.renderer.identities.index,
        bundle: {},
        resources: owner.resources,
        bindings: {},
      },
      {
        admitRendererContract,
        registry: {
          initialize(options) {
            return createWorkerFederationHandler({
              ...options,
              publication: {
                renderer: owner.renderer,
                worker: options.publication,
              },
              exposes: { './Widget': async () => serverModule },
            });
          },
        },
      },
    );
    const services = [
      {
        remote: 'adoption',
        manifestUrl: owner.resources.workerFederationManifestUrl!,
        fragments: [
          {
            expose: './Widget',
            boundaryId: 'adoptionContainer',
            paths: owner.worker.exposes['./Widget'].paths,
          },
        ],
        async fetch(request: Request) {
          if (request.method === 'GET') return Response.json(owner.manifest);
          const response = await runtime.handleRequest(request);
          if (!response)
            throw new Error(
              'Native adoption snapshot endpoint was not selected',
            );
          if (!response.ok) throw new Error(await response.text());
          return response;
        },
      },
    ];
    const serverTransport = createWorkerFederationTransport({
      services,
      admitRendererContract,
    });
    const ServerRemote = federatedComponent<{ label: string }>(
      'adoption/Widget',
    );
    const session = createRequestSession({
      identity: hostIdentity,
      request: new Request('https://host.test/'),
      platform: { kind: 'worker', bindings: {} },
    });
    const documentId = 'worker-adoption-document';
    const nativeHydrationBuildId = 'host-native-client';
    const response = await renderOctaneApplication({
      session,
      document: { documentId, nativeHydrationBuildId },
      workerFederation: serverTransport,
      workerFederationLocale: 'en',
      ...(serverFederation
        ? {
            federation: {
              instance: () => ({
                loadRemote: async <T>() => serverModule as T,
              }),
            },
          }
        : {}),
      App: () =>
        createElement(I18nContext, {
          value: {
            language: 'en',
            languages: ['en', 'fr'],
            instance: { language: 'en', t: (key: string) => key },
          },
          children: createElement(ServerRemote, { label: 'Native' }),
        }),
    });
    const html = await response.text();
    expect((await session.completion).fallback).toBe(false);
    const window = new JSDOM(html, {
      url: 'https://host.test/',
      pretendToBeVisual: true,
    }).window;
    const originals = new Map<string, PropertyDescriptor | undefined>();
    let handle: OctaneApplicationHandle | undefined;
    let browserTransport:
      | ReturnType<typeof createWorkerFederationTransport>
      | undefined;
    const admission = deferred<void>();
    const admissionStarted = deferred<void>();
    const moduleLoad = deferred<RemoteModule>();
    const moduleStarted = deferred<void>();
    let moduleLoadCount = 0;
    const errors: unknown[] = [];
    const uncaughtErrors: unknown[] = [];
    const recoverableErrors: unknown[] = [];
    const rendererFailure = Promise.withResolvers<never>();
    // A renderer error can arrive between awaited phases. Keep its rejection
    // observed, then race every pending admission/module phase against it.
    void rendererFailure.promise.catch(() => {});
    const collectRendererError = (error: unknown) => {
      errors.push(error);
      rendererFailure.reject(error);
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
        const value = key === 'window' ? window : Reflect.get(window, key);
        if (value === undefined)
          throw new Error(`The browser test window does not supply ${key}`);
        Object.defineProperty(globalThis, key, {
          configurable: true,
          writable: true,
          value,
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
          value: window[key].bind(window),
        });
      }
      // Document scripts and the adapter target document.defaultView. Native
      // early control hydration also uses globalThis. Both must see the same
      // Window mailboxes and callbacks, never copied or invented protocol data.
      const streamedGlobals = [
        '__octaneStreamedSignalSelections',
        '__octaneStreamedRenderer',
        '__octaneEarlySignalControls',
        '__octanePublishSignalControl',
      ];
      for (const key of [...streamedGlobals, '$OCTRC', '$OCTRH', '$OCTRX']) {
        originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, {
          configurable: true,
          get: () => Reflect.get(window, key),
          set: value => {
            Reflect.set(window, key, value);
          },
        });
      }
      for (const script of [...window.document.querySelectorAll('script')]) {
        if (
          script.src ||
          script.type === 'application/json' ||
          script.type === 'module'
        )
          continue;
        // Native protocol records require plain objects from the client realm.
        // Keep the unchanged inline script bytes in that realm, with their
        // browser globals forwarding to this one document's Window.
        runInThisContext(script.textContent ?? '');
      }
      expect(window.document.defaultView).toBe(window);
      for (const key of streamedGlobals)
        expect(Reflect.get(globalThis, key)).toBe(Reflect.get(window, key));
      expect(
        Reflect.get(window, '__octaneStreamedSignalSelections'),
      ).toBeDefined();
      expect(Reflect.get(window, '__octaneStreamedRenderer')).toBeDefined();
      const documentBootstrap = bootstrap.readOctaneDocumentBootstrap(
        window.document as unknown as Document,
        hostIdentity,
      );
      expect(documentBootstrap.hydrating).toBe(true);
      expect(documentBootstrap.identity).toEqual(hostIdentity);
      expect(documentBootstrap.documentId).toBe(documentId);
      expect(documentBootstrap.nativeHydrationBuildId).toBe(
        nativeHydrationBuildId,
      );
      const container = globalThis.document.getElementById('root');
      if (!container)
        throw new Error(
          'The public native server did not emit its application root',
        );
      const section = container.querySelector('[data-worker-adoption]');
      const input = section?.querySelector('input');
      const counter = section?.querySelector('button');
      expect(section).not.toBeNull();
      expect(input).not.toBeNull();
      expect(counter).not.toBeNull();
      if (!input) throw new Error('The real SSR input was absent');
      input.value = 'typed before hydration';
      const assertRetained = (phase: string) => {
        expect({
          phase,
          sectionRetained:
            container.querySelector('[data-worker-adoption]') === section,
          inputRetained: container.querySelector('input') === input,
          counterRetained: container.querySelector('button') === counter,
          inputValue: input.value,
        }).toEqual({
          phase,
          sectionRetained: true,
          inputRetained: true,
          counterRetained: true,
          inputValue: 'typed before hydration',
        });
      };
      const BrowserRemote = browserFederation.federatedComponent<{
        label: string;
      }>('adoption/Widget');
      const BrowserApp = (props: { label: string; language: string }) =>
        browserNative.createElement(i18nContext.I18nContext, {
          value: {
            language: props.language,
            languages: ['en', 'fr'],
            instance: { language: props.language, t: (key: string) => key },
          },
          children: browserNative.createElement(BrowserRemote, {
            label: props.label,
          }),
        });
      handle = await hydrateOctaneApplication({
        container,
        identity: hostIdentity,
        documentIdentity: documentBootstrap.identity,
        nativeHydrationBuildId: documentBootstrap.nativeHydrationBuildId,
        documentNativeHydrationBuildId:
          documentBootstrap.nativeHydrationBuildId,
        documentId: documentBootstrap.documentId,
        options: {
          onUncaughtError(error) {
            uncaughtErrors.push(error);
            collectRendererError(error);
          },
          onRecoverableError(error) {
            recoverableErrors.push(error);
            collectRendererError(error);
          },
        },
        ...(clientFederation
          ? {
              federation: {
                instance: () => ({
                  loadRemote: async <T>() => {
                    moduleLoadCount++;
                    moduleStarted.resolve();
                    return (await moduleLoad.promise) as T;
                  },
                }),
              },
            }
          : {}),
        workerFederation(signal) {
          browserTransport = createWorkerFederationTransport({
            services,
            admitRendererContract,
            signal,
            async fetchManifest() {
              admissionStarted.resolve();
              await admission.promise;
              return Response.json(owner.manifest);
            },
          });
          return { transport: browserTransport, locale: 'en', signal };
        },
        load: async () => ({
          default: BrowserApp,
          props: { label: 'Native', language: 'en' },
        }),
      });
      expect(Reflect.get(window, '__octanePublishSignalControl')).toBeTypeOf(
        'function',
      );
      for (const key of streamedGlobals)
        expect(Reflect.get(globalThis, key)).toBe(Reflect.get(window, key));
      await Promise.race([admissionStarted.promise, rendererFailure.promise]);
      browserNative.flushSync(() => {});
      assertRetained('before admission');
      expect(
        window.document.querySelectorAll('[data-worker-adoption]'),
      ).toHaveLength(1);
      expect(window.document.querySelectorAll('[data-counter]')).toHaveLength(
        1,
      );
      if (!clientFederation) {
        await browserNative.act(() => admission.resolve());
        const failure = await rendererFailure.promise.catch(error => error);
        expect(failure).toBeInstanceOf(Error);
        expect(failure).toMatchObject({
          message:
            'Cannot load adoption/Widget: this application has no Module Federation runtime. Add module-federation.config.ts with its remotes.',
        });
        expect(errors).toEqual([failure]);
        expect(uncaughtErrors).toEqual([failure]);
        expect(recoverableErrors).toEqual([]);
        expect(clientCommitCount).toBe(0);
        expect(moduleLoadCount).toBe(0);
        // The public error handler retires the failed root before reporting.
        // SSR retention is required above, before that fatal teardown.
        return;
      }
      await Promise.race([
        browserNative.act(async () => {
          admission.resolve();
          await Promise.race([moduleStarted.promise, rendererFailure.promise]);
        }),
        rendererFailure.promise,
      ]);
      assertRetained('after admission, before module load');
      await Promise.race([
        browserNative.act(async () => {
          moduleLoad.resolve(browserModule);
        }),
        rendererFailure.promise,
      ]);
      assertRetained('after module load');
      // The awaited native act must commit the real browser component before its
      // first interaction; retained SSR text alone cannot prove activation.
      expect(clientCommitCount).toBe(1);
      expect(counter?.textContent).toBe('Native: 3');
      expect(
        window.document.querySelectorAll('[data-worker-adoption]'),
      ).toHaveLength(1);
      expect(window.document.querySelectorAll('[data-counter]')).toHaveLength(
        1,
      );
      await Promise.race([
        browserNative.act(() => counter?.click()),
        rendererFailure.promise,
      ]);
      expect(container.querySelector('button')).toBe(counter);
      expect(counter?.textContent).toBe('Native: 4');
      expect(moduleLoadCount).toBe(1);
      for (const language of ['en', 'fr']) {
        await Promise.race([
          browserNative.act(() =>
            handle?.update({
              default: BrowserApp,
              props: { label: 'Updated', language },
            }),
          ),
          rendererFailure.promise,
        ]);
        assertRetained(`after ${language} host prop/context update`);
        expect(counter?.textContent).toBe('Updated: 4');
        expect(clientCommitCount).toBe(1);
        expect(moduleLoadCount).toBe(1);
      }
      expect(errors).toEqual([]);
    } finally {
      admission.resolve();
      moduleLoad.resolve(browserModule);
      try {
        handle?.dispose();
      } finally {
        try {
          try {
            browserTransport?.dispose();
          } finally {
            serverTransport.dispose();
          }
        } finally {
          for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
          }
          window.close();
        }
      }
    }
  },
);
