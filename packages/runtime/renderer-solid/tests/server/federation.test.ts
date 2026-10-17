import type { NativeFederationBinding } from '@modern-js/renderer-core/federation';
import { renderToStream, ssr } from '@solidjs/web';
import { createComponent } from 'solid-js';
import type { RendererIdentity } from '../../../renderer-core/src/identity';
import { createRequestSession } from '../../../renderer-core/src/session/request';
import { federatedComponent } from '../../src/federation';
import {
  createFederationScope,
  provideFederation,
} from '../../src/federation-context';
import {
  captureFederatedServerAssets,
  withFederatedAssets,
} from '../../src/federation-ssr';
import { renderDocumentApplication } from '../../src/server';

function createHost(
  loadRemote: (id: string) => Promise<unknown>,
  name = 'host',
  publicPath = 'http://remote.test/',
) {
  const instance = {
    name,
    loadRemote: rstest.fn(loadRemote),
    remoteHandler: {
      idToRemoteMap: {
        'remote/Widget': { name: 'remote', expose: './Widget' },
      },
    },
    moduleCache: new Map([['remote', { remoteInfo: { name: 'remote' } }]]),
    snapshotHandler: {
      getGlobalRemoteInfo: () => ({
        remoteSnapshot: {
          publicPath,
          remoteEntry: 'remoteEntry.js',
          modules: [
            {
              modulePath: './Widget',
              assets: {
                js: { sync: ['static/js/widget.js'] },
                css: { sync: ['static/css/widget.css'], async: [] },
              },
            },
          ],
        },
      }),
    },
  };
  const binding: NativeFederationBinding = {
    instance: () => instance,
    hydrationModule: 'static/js/federation-hydration.test.js',
  };
  return { instance, binding };
}

const render = (view: () => unknown, binding?: NativeFederationBinding) => {
  const scope = createFederationScope(binding);
  return Promise.resolve(
    renderToStream(provideFederation(scope, view as never), {
      manifest: withFederatedAssets({ _base: '/' }, scope),
    }) as unknown as PromiseLike<string>,
  );
};

const fallback = () => ssr(['<span data-fallback="">loading</span>']);
const document = (child: () => unknown) => () =>
  ssr(['<html><head></head><body>', '</body></html>'], child() as never);

const identity: RendererIdentity = {
  renderer: 'solid',
  appId: 'shop',
  entryName: 'main',
  protocolVersion: 1,
  buildId: 'build-a',
};

/** A generated entry's response: its own session, document and host binding. */
async function renderResponse(
  view: () => unknown,
  binding: NativeFederationBinding,
) {
  const session = createRequestSession({
    request: new Request('https://shop.test/'),
    identity,
    platform: { kind: 'node', bindings: {} },
  });
  session.resolveResponse({
    kind: 'document',
    status: 200,
    headers: [['content-type', 'text/html; charset=utf-8']],
    cache: { mode: 'no-store' },
  });
  const response = await renderDocumentApplication({
    session,
    view: view as never,
    document: { manifest: { _base: '/' } },
    federation: binding,
  });
  return response.text();
}

describe('federated Solid components on the server', () => {
  test('render the remote with its stylesheet and hydration module', async () => {
    const host = createHost(async () => ({
      default: (props: { label: string }) =>
        ssr(['<b data-remote="">', '</b>'], props.label),
    }));
    const Widget = federatedComponent<{ label: string }>('remote/Widget', {
      fallback,
    });
    const html = await render(
      document(() => createComponent(Widget, { label: 'from host' })),
      host.binding,
    );
    expect(host.instance.loadRemote).toHaveBeenCalledWith('remote/Widget');
    // The shell waits for the remote: its markup is inline, not a deferred fragment.
    expect(html).toContain('<b data-remote="">from host</b>');
    expect(html).not.toContain('<template');
    expect(html).not.toContain('data-fallback');
    expect(html).toMatch(
      /<link[^>]+rel="stylesheet"[^>]+href="http:\/\/remote\.test\/static\/css\/widget\.css"|<link[^>]+href="http:\/\/remote\.test\/static\/css\/widget\.css"[^>]+rel="stylesheet"/u,
    );
    expect(html).toContain('http://remote.test/remoteEntry.js');
    expect(html).toContain('http://remote.test/static/js/widget.js');
    expect(html).toContain(
      '/static/js/federation-hydration.test.js?id=remote%2FWidget&host=host',
    );
  });

  test('render the fallback when the remote fails on the server', async () => {
    const host = createHost(() => Promise.reject(new Error('remote offline')));
    const Widget = federatedComponent('remote/Widget', { fallback });
    const html = await render(
      document(() => createComponent(Widget, {})),
      host.binding,
    );
    expect(host.instance.loadRemote).toHaveBeenCalledTimes(1);
    expect(html).toContain('data-fallback');
    expect(html).not.toContain('federation-hydration');
  });

  test('serializes the assets captured with its module after the native snapshot advances', async () => {
    const host = createHost(
      async () => ({ default: () => ssr('<b>captured remote</b>') }),
      'host',
      'http://admitted.test/',
    );
    Object.defineProperty(
      host.instance,
      Symbol.for('ultramodern.federation.load-with-capture'),
      {
        value: async (id: string, capture: (module: unknown) => unknown) => {
          const module = await host.instance.loadRemote(id);
          const captured = capture(module);
          host.instance.snapshotHandler.getGlobalRemoteInfo = createHost(
            async () => null,
            'host',
            'http://replacement.test/',
          ).instance.snapshotHandler.getGlobalRemoteInfo;
          return { module, captured };
        },
      },
    );
    const Widget = federatedComponent('remote/Widget', { fallback });
    const html = await renderResponse(
      () => createComponent(Widget, {}),
      host.binding,
    );
    expect(html).toContain('<b>captured remote</b>');
    expect(html).toContain('http://admitted.test/static/css/widget.css');
    expect(html).toContain('http://admitted.test/static/js/widget.js');
    expect(html).not.toContain('http://replacement.test/');
  });

  test('retains separate asset captures for repeated loads in one response and isolates other responses', () => {
    const host = createHost(async () => null);
    const scope = createFederationScope(host.binding)!;
    const otherScope = createFederationScope(host.binding)!;
    const firstAssets = { js: ['first.js'], css: ['first.css'] };
    const secondAssets = { js: ['second.js'], css: ['second.css'] };
    const first = captureFederatedServerAssets(
      scope,
      'remote/Widget',
      firstAssets,
    )!;
    const second = captureFederatedServerAssets(
      scope,
      'remote/Widget',
      secondAssets,
    )!;
    const manifest = withFederatedAssets<{
      _base: string;
      resolve?: (key: string) => unknown;
    }>({ _base: '/' }, scope);
    const otherManifest = withFederatedAssets<{
      _base: string;
      resolve?: (key: string) => unknown;
    }>({ _base: '/' }, otherScope);
    const hydration =
      '/static/js/federation-hydration.test.js?id=remote%2FWidget&host=host';
    expect(first).not.toBe(second);
    expect(manifest.resolve!(first)).toEqual({
      js: [hydration, 'first.js'],
      css: ['first.css'],
    });
    expect(manifest.resolve!(second)).toEqual({
      js: [hydration, 'second.js'],
      css: ['second.css'],
    });
    expect(otherManifest.resolve!(first)).toBeNull();
  });

  test('load the remote again on a later request after a failure', async () => {
    let attempts = 0;
    const host = createHost(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('remote offline');
      return { default: () => ssr(['<b data-remote="">back</b>']) };
    });
    const Widget = federatedComponent('remote/Widget', { fallback });
    const first = await render(
      document(() => createComponent(Widget, {})),
      host.binding,
    );
    expect(first).toContain('data-fallback');
    const second = await render(
      document(() => createComponent(Widget, {})),
      host.binding,
    );
    expect(attempts).toBe(2);
    expect(second).toContain('<b data-remote="">back</b>');
    expect(second).not.toContain('data-fallback');
  });

  test('a remote that exceeds its timeout renders the fallback in time', async () => {
    const host = createHost(() => new Promise(() => {}));
    const Widget = federatedComponent('remote/Widget', {
      fallback,
      timeout: 50,
    });
    const started = Date.now();
    const html = await render(
      document(() => createComponent(Widget, {})),
      host.binding,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(html).toContain('data-fallback');
  });

  test('custom loaders render in the browser only', async () => {
    const host = createHost(async () => ({ default: () => 'remote' }));
    const load = rstest.fn(() => Promise.resolve({ default: () => 'remote' }));
    const Widget = federatedComponent(load, { fallback });
    const html = await render(
      document(() => createComponent(Widget, {})),
      host.binding,
    );
    expect(html).toContain('data-fallback');
    expect(load).not.toHaveBeenCalled();
  });

  test('render nothing without a fallback when the remote fails', async () => {
    const Widget = federatedComponent('remote/Widget');
    const html = await render(document(() => createComponent(Widget, {})));
    expect(html).toMatch(/<body>(?:<!--[^>]*-->)*<\/body>/u);
  });

  test('co-located hosts render a remote through their own instances and assets', async () => {
    const [first, second] = ['first', 'second'].map(name =>
      createHost(
        async () => ({ default: () => ssr(`<b data-remote="">${name}</b>`) }),
        name,
        `http://${name}.test/`,
      ),
    );
    // One component definition, rendered by two applications in one process.
    const Widget = federatedComponent('remote/Widget', { fallback });
    const view = () => createComponent(Widget, {});
    const [firstHtml, secondHtml] = await Promise.all([
      renderResponse(view, first.binding),
      renderResponse(view, second.binding),
    ]);
    expect(first.instance.loadRemote).toHaveBeenCalledTimes(1);
    expect(second.instance.loadRemote).toHaveBeenCalledTimes(1);
    for (const [html, own, other] of [
      [firstHtml, 'first', 'second'],
      [secondHtml, 'second', 'first'],
    ]) {
      expect(html).toContain(`<b data-remote="">${own}</b>`);
      expect(html).toContain(`http://${own}.test/remoteEntry.js`);
      expect(html).toContain(
        `/static/js/federation-hydration.test.js?id=remote%2FWidget&host=${own}`,
      );
      expect(html).not.toContain(`${other}.test`);
      expect(html).not.toContain(`host=${other}`);
    }
  });
});
