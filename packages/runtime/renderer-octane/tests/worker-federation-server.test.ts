import type { NativeWorkerEntryResources } from '@modern-js/renderer-core/server';
import { createRequestSession } from '@modern-js/renderer-core/session';
import {
  createWorkerFederationHandler,
  createWorkerFederationTransport,
  readWorkerFederationPublication,
} from '@modern-js/renderer-core/worker-federation';
import { Window } from 'happy-dom';
import { createElement, decodeExternalSnapshot } from 'octane/server';
import {
  admitRendererContract,
  manifestFixture,
} from '../../renderer-core/tests/worker-federation.fixture';
import { federatedComponent } from '../src/federation';
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
  const transport = createWorkerFederationTransport({
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
          return response;
        },
      },
    ],
  });
  const session = createRequestSession({
    identity: parent.renderer.identities.index,
    request: new Request('https://host.test/'),
    platform: { kind: 'worker', bindings: {} },
  });
  const Parent = federatedComponent<{ label: string }>('parent/Widget');
  const response = await renderOctaneApplication({
    session,
    document: {
      documentId: 'nested-worker-document',
      nativeHydrationBuildId: 'host-native-client',
    },
    workerFederation: transport,
    workerFederationLocale: 'en',
    App: () => createElement(Parent, { label: 'Nested native props' }),
  });
  const html = await response.text();
  expect(html).toContain('data-native-worker-parent');
  expect(html).toContain('data-native-worker-child');
  expect(html).toContain('Nested native props');
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
});
