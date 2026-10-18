import { createRequire } from 'node:module';
import type { FileSystemRouteIR } from '@modern-js/renderer-core/data';
import {
  createDataClient,
  createDataResponse,
  deferData,
  invokeRouteData,
} from '@modern-js/renderer-core/data';
import type { RendererIdentity } from '@modern-js/renderer-core/identity';
import type { JSX } from '@solidjs/web';
import * as web from '@solidjs/web';
import * as solid from 'solid-js';
import {
  hydrateApplication,
  readSolidDocumentBootstrap,
} from '../../src/client';
import * as nativeRouter from '../../src/router';
import type { AnyRouter } from '../../src/router-binding/index';

const requireServer = createRequire(import.meta.url);
const identity: RendererIdentity = {
  renderer: 'solid',
  appId: 'hydration-completion',
  entryName: 'main',
  protocolVersion: 1,
  buildId: 'hydration-completion-build',
};
const routes: FileSystemRouteIR[] = [
  {
    id: 'layout',
    isRoot: true,
    children: [
      {
        id: 'index_page',
        index: true,
        modules: { data: '/page.data.ts' },
        children: [],
      },
      { id: 'about', path: 'about', children: [] },
    ],
  },
];

// Both native compiler targets receive the same authored component tree. The
// server uses built public exports under Node conditions, as an installed app
// does; run the normal renderer-core/renderer-solid builds before this test.
const applicationSource = `
import { createSignal } from 'solid-js';
import {
  ActionForm, ApplicationRouter, Await, Link, Outlet, useLoaderData, useRouteAction,
} from '@modern-js/renderer-solid/router';
export function Application(props) {
  return <ApplicationRouter router={props.router} />;
}
export function Layout() {
  return <main data-testid="layout"><nav>
    <Link to="/about" data-testid="about-link">About</Link>
    <Link to="/" search={{ case: 'deferred' }} preload={false} data-testid="deferred-link">Deferred</Link>
  </nav><Outlet /></main>;
}
function Deferred() {
  const data = useLoaderData({ strict: false });
  const later = () => data()?.later instanceof Promise ? data().later : undefined;
  return <>{later() ? <Await promise={later()} fallback={<p data-testid="pending">pending</p>}>
    {value => <p data-testid="late">{String(value)}</p>}
  </Await> : null}</>;
}
export function Page() {
  const data = useLoaderData({ strict: false });
  const action = useRouteAction();
  const [count, setCount] = createSignal(0);
  return <section>
    <p data-testid="critical">{data().critical}</p>
    <button data-testid="increment" onClick={() => setCount(value => value + 1)}>{count()}</button>
    <Deferred />
    <ActionForm action={action}>
      <input name="name" value="Solid RC15 acceptance" />
      <button data-testid="submit" type="submit" disabled={action.pending()}>Save</button>
    </ActionForm>
    <p data-testid="outcome">{JSON.stringify(action.outcome())}</p>
  </section>;
}
export function About() { return <p data-testid="about">complete</p>; }
`;

interface Views {
  Application(props: { router: AnyRouter }): JSX.Element;
  Layout(): JSX.Element;
  Page(): JSX.Element;
  About(): JSX.Element;
}

function compileViews(server: boolean): Views {
  const compiler = requireServer('@solidjs/compiler');
  const babel = requireServer('@babel/core');
  const filename = 'hydration-completion-fixture.jsx';
  const lazy = compiler.transformLazy(applicationSource, {
    filename,
    sourceMap: false,
  });
  const native = compiler.transform(lazy.code, {
    filename,
    moduleName: '@solidjs/web',
    generate: server ? 'ssr' : 'dom',
    hydratable: true,
    dev: false,
    sourceMap: false,
  });
  const transformed = babel.transformSync(native.code, {
    filename,
    babelrc: false,
    configFile: false,
    plugins: [requireServer('@babel/plugin-transform-modules-commonjs')],
  });
  if (typeof transformed?.code !== 'string')
    throw new Error('The native fixture compiler emitted no module');
  const module = { exports: {} };
  new Function('require', 'exports', 'module', transformed.code)(
    server
      ? requireServer
      : (name: string) => {
          if (name === '@solidjs/web') return web;
          if (name === 'solid-js') return solid;
          if (name === '@modern-js/renderer-solid/router') return nativeRouter;
          throw new Error(`Unexpected native fixture import ${name}`);
        },
    module.exports,
    module,
  );
  return module.exports as Views;
}

async function renderServerDocument(): Promise<string> {
  const serverRouter = requireServer('@modern-js/renderer-solid/router');
  const serverWeb = requireServer('@solidjs/web');
  const { createRequestSession } = requireServer(
    '@modern-js/renderer-core/session',
  );
  const { invokeRouteData: invokeServerRouteData } = requireServer(
    '@modern-js/renderer-core/data',
  );
  const { renderDocumentApplication, runApplicationRequest } = requireServer(
    '@modern-js/renderer-solid/server',
  );
  expect(serverWeb.isServer).toBe(true);
  const views = compileViews(true);
  const session = createRequestSession({
    request: new Request('http://localhost/'),
    identity,
    platform: { kind: 'node', bindings: {} },
  });
  return runApplicationRequest(session, async () => {
    const router = serverRouter.createApplicationRouter({
      routeTree: serverRouter.createFileSystemRouteTree(
        routes,
        {
          layout: { component: views.Layout },
          index_page: { component: views.Page },
          about: { component: views.About },
        },
        {
          request: session.request,
          session,
          loadRoute: (
            _route: unknown,
            input: Parameters<typeof invokeRouteData>[1],
          ) =>
            invokeServerRouteData(() => ({ critical: 'server-index' }), input),
        },
      ),
      history: serverRouter.createMemoryHistory({ initialEntries: ['/'] }),
      origin: 'http://localhost',
      context: { ultramodern: { rendererIdentity: identity } },
      isServer: true,
    });
    await router.load();
    session.resolveResponse({
      kind: 'document',
      status: 200,
      headers: [['content-type', 'text/html; charset=utf-8']],
      cache: { mode: 'no-store' },
    });
    return (
      await renderDocumentApplication({
        session,
        view: () => views.Application({ router }),
        document: { renderId: 'hydration-completion:' },
      })
    ).text();
  });
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 800; attempt++) {
    solid.flush();
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('The hydrated native completion did not settle');
}

test('Solid SSR adoption and action cleanup retain the next deferred response through terminal EOF', async () => {
  expect(web.isServer).toBe(false);
  const html = await renderServerDocument();
  expect(html).toContain('tsr:');
  expect(html).toContain('server-index');
  const previousHydration = Object.getOwnPropertyDescriptor(globalThis, '_$HY');
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  const root = container.querySelector<HTMLElement>('#root');
  if (!root) throw new Error('The public server document emitted no root');
  const originalLayout = root.querySelector('[data-testid="layout"]');
  const originalCritical = root.querySelector('[data-testid="critical"]');
  const nativeListeners: Parameters<Document['addEventListener']>[] = [];
  let dispose: (() => void) | undefined;
  let releaseInvalidation!: (response: Response) => void;
  const invalidation = new Promise<Response>(resolve => {
    releaseInvalidation = resolve;
  });
  let laterTimer: ReturnType<typeof setTimeout> | undefined;
  let deferredStartedAt = 0;
  let terminal!: () => void;
  const terminalGate = new Promise<void>(resolve => {
    terminal = resolve;
  });
  const loaderSignals: AbortSignal[] = [];
  let actionRequests = 0;
  let deferredCancellations = 0;
  let completionSettled = false;
  const transport = rstest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const request = input as Request;
      if (request.method === 'POST') {
        actionRequests++;
        const outcome = await invokeRouteData(
          () => ({ saved: 'Solid RC15 acceptance' }),
          {
            request,
            routeId: 'index_page',
            params: {},
            context: {},
          },
        );
        return createDataResponse(outcome, identity, {
          routeId: 'index_page',
          operation: 'action',
        });
      }
      loaderSignals.push(init?.signal ?? request.signal);
      if (loaderSignals.length === 1) return invalidation;
      expect(new URL(request.url).searchParams.get('case')).toBe('deferred');
      deferredStartedAt = performance.now();
      const later = new Promise<string>(resolve => {
        laterTimer = setTimeout(() => resolve('hydrated-late-value'), 1500);
      });
      const outcome = await invokeRouteData(
        () => deferData({ critical: 'deferred-index' }, { later }),
        {
          request,
          routeId: 'index_page',
          params: {},
          context: {},
        },
      );
      const source = createDataResponse(outcome, identity, {
        routeId: 'index_page',
        operation: 'loader',
        signal: loaderSignals.at(-1),
      });
      // Preserve every real producer byte. Only its HTTP EOF is delayed, so a
      // rendered late value cannot stand in for terminal transport completion.
      const reader = source.body!.getReader();
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            const chunk = await reader.read();
            if (!chunk.done) controller.enqueue(chunk.value);
            else {
              await terminalGate;
              reader.releaseLock();
              completionSettled = true;
              controller.close();
            }
          },
          cancel(reason) {
            deferredCancellations++;
            return reader.cancel(reason);
          },
        }),
        { status: source.status, headers: source.headers },
      );
    });
  try {
    const listeners = rstest.spyOn(document, 'addEventListener');
    try {
      for (const script of container.querySelectorAll('script')) {
        if (script.textContent && !script.type)
          new Function(script.textContent)();
      }
      nativeListeners.push(...listeners.mock.calls);
    } finally {
      listeners.mockRestore();
    }
    const bootstrap = readSolidDocumentBootstrap(document, identity);
    const views = compileViews(false);
    const client = createDataClient('index_page', identity);
    const router = nativeRouter.createApplicationRouter({
      routeTree: nativeRouter.createFileSystemRouteTree(
        routes,
        {
          layout: { component: views.Layout },
          index_page: { component: views.Page },
          about: { component: views.About },
        },
        {
          request: new Request('http://localhost/'),
          loadRoute: (_route, input) => client.loader(input),
        },
      ),
      history: nativeRouter.createMemoryHistory({ initialEntries: ['/'] }),
      origin: 'http://localhost',
      context: { ultramodern: { rendererIdentity: identity } },
      defaultStaleTime: 0,
      isServer: false,
    });
    expect(router.options.defaultPendingMs).toBe(1000);
    expect(router.options.defaultPendingMinMs).toBe(500);
    expect(router.state.matches.at(-1)?.loaderData).toEqual({
      critical: 'server-index',
    });
    expect(loaderSignals).toHaveLength(0);
    dispose = hydrateApplication(() => views.Application({ router }), root, {
      renderId: bootstrap.documentId,
    });
    await waitFor(
      () =>
        root.querySelector('[data-testid="critical"]')?.textContent ===
        'server-index',
    );
    expect(root.querySelector('[data-testid="layout"]')).toBe(originalLayout);
    expect(root.querySelector('[data-testid="critical"]')).toBe(
      originalCritical,
    );
    expect(loaderSignals).toHaveLength(0);
    root.querySelector<HTMLButtonElement>('[data-testid="increment"]')!.click();
    await waitFor(
      () =>
        root.querySelector('[data-testid="increment"]')?.textContent === '1',
    );
    const form = root.querySelector('form')!;
    const submitter = root.querySelector<HTMLButtonElement>(
      '[data-testid="submit"]',
    )!;
    form.dispatchEvent(
      new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter }),
    );
    await waitFor(
      () =>
        loaderSignals.length === 1 &&
        root
          .querySelector('[data-testid="outcome"]')
          ?.textContent?.includes('Solid RC15 acceptance') === true,
    );
    expect(submitter.disabled).toBe(true);
    expect(loaderSignals[0]?.aborted).toBe(false);
    root
      .querySelector<HTMLAnchorElement>('[data-testid="about-link"]')!
      .click();
    await waitFor(
      () =>
        root.querySelector('[data-testid="about"]')?.textContent === 'complete',
    );
    expect(loaderSignals[0]?.aborted).toBe(true);
    const stale = await invokeRouteData(
      () => ({ critical: 'abandoned-invalidation' }),
      {
        request: new Request('http://localhost/'),
        routeId: 'index_page',
        params: {},
        context: {},
      },
    );
    releaseInvalidation(
      createDataResponse(stale, identity, {
        routeId: 'index_page',
        operation: 'loader',
      }),
    );
    root
      .querySelector<HTMLAnchorElement>('[data-testid="deferred-link"]')!
      .click();
    await waitFor(() => root.querySelector('[data-testid="pending"]') !== null);
    expect(loaderSignals).toHaveLength(2);
    await waitFor(
      () =>
        root.querySelector('[data-testid="late"]')?.textContent ===
        'hydrated-late-value',
    );
    expect(completionSettled).toBe(false);
    expect(loaderSignals[1]?.aborted).toBe(false);
    expect(deferredCancellations).toBe(0);
    // Keep the real transport open beyond the observed 1.5-second failure,
    // including at least half a second after the deferred value paints.
    const eofNotBefore = Math.max(
      performance.now() + 500,
      deferredStartedAt + 2050,
    );
    while (performance.now() < eofNotBefore) {
      await new Promise(resolve => setTimeout(resolve, 25));
      solid.flush();
      expect(completionSettled).toBe(false);
      expect(loaderSignals[1]?.aborted).toBe(false);
      expect(deferredCancellations).toBe(0);
      expect(root.querySelector('[data-testid="late"]')?.textContent).toBe(
        'hydrated-late-value',
      );
    }
    expect(performance.now() - deferredStartedAt).toBeGreaterThanOrEqual(2000);
    terminal();
    await waitFor(() => completionSettled);
    await new Promise(resolve => setTimeout(resolve, 0));
    solid.flush();
    expect(loaderSignals[1]?.aborted).toBe(false);
    expect(deferredCancellations).toBe(0);
    expect(loaderSignals).toHaveLength(2);
    expect(actionRequests).toBe(1);
    expect(root.querySelector('[data-testid="late"]')?.textContent).toBe(
      'hydrated-late-value',
    );
    expect(root.querySelector('[data-testid="layout"]')).toBe(originalLayout);
  } finally {
    clearTimeout(laterTimer);
    terminal();
    dispose?.();
    solid.flush();
    transport.mockRestore();
    for (const [event, listener, options] of nativeListeners)
      document.removeEventListener(event, listener, options);
    container.remove();
    if (previousHydration)
      Object.defineProperty(globalThis, '_$HY', previousHydration);
    else Reflect.deleteProperty(globalThis, '_$HY');
  }
});
