import type { RendererIdentity } from '@modern-js/renderer-core/identity';
import { createRequestSession } from '@modern-js/renderer-core/session';
import {
  createContext,
  createElement,
  ssrHtml,
  useContext,
} from 'octane/server';
import { federatedComponent } from '../src/federation';
import { renderOctaneApplication } from '../src/server';

const identity: RendererIdentity = {
  renderer: 'octane',
  appId: 'federation-test',
  entryName: 'main',
  protocolVersion: 1,
  buildId: 'federation-build',
};
const createSession = () =>
  createRequestSession({
    request: new Request('https://host.test/'),
    identity,
    platform: { kind: 'node', bindings: {} },
  });

const host = (
  loadRemote: (id: string) => Promise<unknown>,
  label = 'remote',
) => ({
  loadRemote,
  remoteHandler: {
    idToRemoteMap: { 'remote/Widget': { name: 'remote', expose: './Widget' } },
  },
  moduleCache: new Map([['remote', { remoteInfo: { name: 'remote' } }]]),
  snapshotHandler: {
    getGlobalRemoteInfo: () => ({
      remoteSnapshot: {
        publicPath: `https://${label}.test/`,
        remoteEntry: 'remoteEntry.js',
        modules: [
          {
            modulePath: './Widget',
            assets: {
              js: { sync: ['widget.js'] },
              css: { sync: ['widget.css'], async: ['widget.css'] },
            },
          },
        ],
      },
    }),
  },
});

const document = {
  documentId: 'federation-doc',
  nativeHydrationBuildId: 'host-native-build',
};
const fallback = () =>
  createElement('p', { 'data-fallback': '' }, 'Waiting for remote');

test('streams native remote HTML, props and provider context with styles before its segment', async () => {
  const Theme = createContext('missing');
  const instance = host(async () => ({
    default: (props: { label: string }) =>
      createElement('button', null, `${props.label}: ${useContext(Theme)}`),
  }));
  const Widget = federatedComponent<{ label: string }>('remote/Widget', {
    fallback,
  });
  const response = await renderOctaneApplication({
    session: createSession(),
    App: () =>
      createElement(Theme, {
        value: 'host theme',
        children: createElement(Widget, { label: 'host props' }),
      }),
    federation: { instance: () => instance },
    document: { ...document, nonce: 'mf-nonce' },
  });
  const html = await response.text();
  expect(html).toContain('host props: host theme');
  expect(html).toContain('https://remote.test/widget.css');
  expect(html.indexOf('https://remote.test/widget.css')).toBeLessThan(
    html.indexOf('host props: host theme'),
  );
  expect(html).toContain('nonce="mf-nonce"');
  expect(html).toMatch(/<\/body><\/html>$/);
});

test('concurrent requests using one component retain their own host and asset snapshots', async () => {
  const Widget = federatedComponent('remote/Widget', { fallback });
  const render = async (label: string) => {
    const session = createSession();
    const instance = host(async () => {
      await new Promise(resolve =>
        setTimeout(resolve, label === 'first' ? 20 : 0),
      );
      return { default: () => ssrHtml(`<b>${label}</b>`) };
    }, label);
    return (
      await renderOctaneApplication({
        session,
        App: () => createElement(Widget),
        federation: { instance: () => instance },
        document: { ...document, documentId: label },
      })
    ).text();
  };
  const [first, second] = await Promise.all([
    render('first'),
    render('second'),
  ]);
  expect(first).toContain('<b>first</b>');
  expect(first).toContain('https://first.test/widget.css');
  expect(first).not.toContain('https://second.test/');
  expect(second).toContain('<b>second</b>');
  expect(second).toContain('https://second.test/widget.css');
  expect(second).not.toContain('https://first.test/');
});

test('streams the assets captured with its module after the native snapshot advances', async () => {
  const instance = host(
    async () => ({
      default: () => ssrHtml('<b>captured remote</b>'),
    }),
    'admitted',
  );
  Object.defineProperty(
    instance,
    Symbol.for('ultramodern.federation.load-with-capture'),
    {
      value: async (id: string, capture: (module: unknown) => unknown) => {
        const module = await instance.loadRemote(id);
        const captured = capture(module);
        instance.snapshotHandler.getGlobalRemoteInfo = host(
          async () => null,
          'replacement',
        ).snapshotHandler.getGlobalRemoteInfo;
        return { module, captured };
      },
    },
  );
  const Widget = federatedComponent('remote/Widget', { fallback });
  const response = await renderOctaneApplication({
    session: createSession(),
    App: () => createElement(Widget),
    federation: { instance: () => instance },
    document,
  });
  const html = await response.text();
  expect(html).toContain('<b>captured remote</b>');
  expect(html).toContain('https://admitted.test/widget.css');
  expect(html).not.toContain('https://replacement.test/');
});

test('the native server applies a remote component default prop', async () => {
  const Widget = federatedComponent<{ label?: string }>('remote/Widget');
  const Remote = Object.assign(
    (props: { label?: string }) => createElement('b', null, props.label),
    {
      defaultProps: { label: 'native server default' },
    },
  );
  const response = await renderOctaneApplication({
    session: createSession(),
    App: () => createElement(Widget),
    federation: { instance: () => host(async () => ({ default: Remote })) },
    document,
  });
  expect(await response.text()).toContain('<b>native server default</b>');
});

test('a failed or timed-out remote renders the native fallback and makes the document uncacheable', async () => {
  const logged = rstest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const loadRemote of [
      () => Promise.reject(new Error('remote offline')),
      () => new Promise(() => {}),
    ]) {
      const session = createSession();
      const instance = host(loadRemote);
      const Widget = federatedComponent('remote/Widget', {
        fallback,
        timeout: 30,
      });
      const response = await renderOctaneApplication({
        session,
        App: () => createElement(Widget),
        federation: { instance: () => instance },
        document,
        responsePolicy: {
          kind: 'document',
          status: 200,
          headers: [['content-type', 'text/html; charset=utf-8']],
          cache: { mode: 'public', maxAgeSeconds: 30 },
        },
      });
      const html = await response.text();
      expect(html).toContain('Waiting for remote');
      expect(html).not.toContain('widget.css');
      expect(response.status).toBe(200);
      expect((await session.completion).fallback).toBe(true);
      expect((await session.completion).cacheEligible).toBe(false);
    }
  } finally {
    logged.mockRestore();
  }
});

test('browser loader functions never run on the server', async () => {
  const load = rstest.fn(async () => ({
    default: () => createElement('b', null, 'remote'),
  }));
  const Widget = federatedComponent(load, { fallback });
  const logged = rstest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await renderOctaneApplication({
      session: createSession(),
      App: () => createElement(Widget),
      document,
    });
    expect(await response.text()).toContain('Waiting for remote');
    expect(load).not.toHaveBeenCalled();
  } finally {
    logged.mockRestore();
  }
});

test('canceling a pending remote retires native rendering without leaking its late result into another request', async () => {
  const Widget = federatedComponent('remote/Widget', { fallback });
  let resolve!: (module: { default: () => unknown }) => void;
  const pending = new Promise<{ default: () => unknown }>(done => {
    resolve = done;
  });
  const session = createSession();
  const cleanup = rstest.fn();
  session.registerCleanup(cleanup);
  const response = await renderOctaneApplication({
    session,
    App: () => createElement(Widget),
    federation: { instance: () => host(() => pending, 'abandoned') },
    document,
  });
  const reader = response.body!.getReader();
  await reader.read();
  await reader.read();
  await reader.cancel('consumer disconnected');
  expect((await session.completion).state).toBe('aborted');
  expect(cleanup).toHaveBeenCalledTimes(1);
  resolve({ default: () => createElement('b', null, 'abandoned') });
  const replacement = await renderOctaneApplication({
    session: createSession(),
    App: () => createElement(Widget),
    federation: {
      instance: () =>
        host(
          async () => ({
            default: () => createElement('b', null, 'replacement'),
          }),
          'replacement',
        ),
    },
    document: { ...document, documentId: 'replacement' },
  });
  const html = await replacement.text();
  expect(html).toContain('replacement.test/widget.css');
  expect(html).toContain('<b>replacement</b>');
  expect(html).not.toContain('abandoned');
});

test('missing browser asset metadata fails the native boundary rather than sending an unstyled remote', async () => {
  const Widget = federatedComponent('remote/Widget', { fallback });
  const logged = rstest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await renderOctaneApplication({
      session: createSession(),
      App: () => createElement(Widget),
      federation: {
        instance: () => ({
          loadRemote: async () => ({
            default: () => createElement('b', null, 'unstyled'),
          }),
        }),
      },
      document,
    });
    const html = await response.text();
    expect(html).toContain('Waiting for remote');
    expect(html).not.toContain('unstyled');
    expect(logged).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        message: expect.stringContaining('browser assets'),
      }),
    );
  } finally {
    logged.mockRestore();
  }
});
