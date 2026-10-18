import type { RendererIdentity } from '@modern-js/renderer-core/identity';
import { flush, onSettled } from 'solid-js';
import { startNativeClient } from '../../src/entry-client';

const identity: RendererIdentity = {
  renderer: 'solid',
  appId: 'entry-disposal',
  entryName: 'main',
  protocolVersion: 1,
  buildId: 'entry-disposal-build',
};

function observeBrowserHistory() {
  const pushState = window.history.pushState;
  const replaceState = window.history.replaceState;
  const added = rstest.spyOn(window, 'addEventListener');
  const removed = rstest.spyOn(window, 'removeEventListener');
  const historyListeners = () =>
    added.mock.calls.filter(
      ([event]) => event === 'popstate' || event === 'beforeunload',
    );
  return {
    assertReleased() {
      const listeners = historyListeners();
      expect(listeners.map(([event]) => event).sort()).toEqual([
        'beforeunload',
        'popstate',
      ]);
      for (const listener of listeners)
        expect(removed).toHaveBeenCalledWith(...listener);
      expect(window.history.pushState).toBe(pushState);
      expect(window.history.replaceState).toBe(replaceState);
    },
    cleanup() {
      // A failing regression must not leak its browser globals into the next case.
      for (const [event, listener, options] of historyListeners())
        window.removeEventListener(event, listener, options);
      window.history.pushState = pushState;
      window.history.replaceState = replaceState;
      added.mockRestore();
      removed.mockRestore();
    },
  };
}

test('HMR disposal during the initial load cancels its pending route matches', async () => {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  let loading!: () => void;
  const started = new Promise<void>(resolve => {
    loading = resolve;
  });
  let loaderSignal: AbortSignal | undefined;
  let dispose: (() => void) | undefined;
  const history = observeBrowserHistory();
  try {
    startNativeClient({
      identity,
      hot: { dispose: (callback: () => void) => (dispose = callback) },
      load: async () => ({
        basePath: '/',
        routeIR: [
          {
            id: 'home',
            index: true,
            modules: { data: '/home.data.ts' },
            children: [],
          },
        ],
        routeModules: { home: { component: { default: () => null } } },
        dataModules: {
          home: {
            // A loader that never settles on its own.
            loader: ({ request }: { request: Request }) => {
              loaderSignal = request.signal;
              loading();
              return new Promise(() => {});
            },
          },
        },
      }),
    });
    await started;
    expect(loaderSignal?.aborted).toBe(false);
    dispose!();
    expect(loaderSignal?.aborted).toBe(true);
    history.assertReleased();
  } finally {
    dispose?.();
    history.cleanup();
    root.remove();
  }
});

test('HMR replacement releases mounted entries before the next browser router starts', async () => {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  try {
    for (let generation = 0; generation < 2; generation++) {
      const ready = Promise.withResolvers<void>();
      function Home() {
        onSettled(() => ready.resolve());
        return <p data-entry-generation={generation}>Ready</p>;
      }
      let dispose: (() => void) | undefined;
      const history = observeBrowserHistory();
      try {
        startNativeClient({
          identity,
          hot: { dispose: callback => (dispose = callback) },
          load: async () => ({
            basePath: '/',
            routeIR: [{ id: 'home', index: true, children: [] }],
            routeModules: { home: { component: { default: Home } } },
            dataModules: {},
          }),
        });
        await ready.promise;
        expect(root.querySelector('p')?.dataset.entryGeneration).toBe(
          String(generation),
        );
        dispose!();
        await Promise.resolve();
        flush();
        expect(root.querySelector('p')).toBeNull();
        history.assertReleased();
      } finally {
        dispose?.();
        await Promise.resolve();
        flush();
        history.cleanup();
      }
    }
  } finally {
    root.remove();
  }
});
