import { afterEach, describe, expect, test } from '@rstest/core';
import { createContext, createElement, createRoot, flushSync } from 'octane';
import {
  OCTANE_WORKER_CONTEXT_KEYS,
  type OctaneWorkerContextCodec,
  registerOctaneWorkerContext,
  useOctaneWorkerContextKeys,
} from '../src/worker-federation-contexts';

const releases: (() => void)[] = [];

afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
});

function codec(
  key: OctaneWorkerContextCodec<string | null>['key'],
): OctaneWorkerContextCodec<string | null> {
  return {
    key,
    encode: value => value,
    decode: value => (value === null ? null : String(value)),
    isProvided: value => value !== null,
  };
}

function Selection(props: { readonly explicit?: readonly string[] }) {
  return createElement(
    'output',
    null,
    JSON.stringify(useOctaneWorkerContextKeys(props.explicit)),
  );
}

function mount() {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  releases.push(() => {
    root.unmount();
    element.remove();
  });
  return {
    render: (node: Parameters<typeof root.render>[0]) =>
      flushSync(() => root.render(node)),
    keys: () => JSON.parse(element.textContent ?? 'null'),
  };
}

describe('Octane Worker builtin context selection', () => {
  test('omits default contexts and preserves every explicit requirement', () => {
    const Context = createContext<string | null>(null);
    releases.push(
      registerOctaneWorkerContext(
        Context,
        codec(OCTANE_WORKER_CONTEXT_KEYS.router),
      ),
    );
    const explicit = [
      'application.context',
      OCTANE_WORKER_CONTEXT_KEYS.router,
      'application.context',
    ];
    const view = mount();
    view.render(createElement(Selection, { explicit }));

    expect(view.keys()).toEqual(explicit);
    expect(explicit).toEqual([
      'application.context',
      OCTANE_WORKER_CONTEXT_KEYS.router,
      'application.context',
    ]);
    expect(Object.isFrozen(OCTANE_WORKER_CONTEXT_KEYS)).toBe(true);
  });

  test('selects live native providers in fixed order and preserves explicit ordering', () => {
    const Router = createContext<string | null>(null);
    const Match = createContext<string | null>(null);
    const I18n = createContext<string | null>(null);
    releases.push(
      registerOctaneWorkerContext(I18n, codec(OCTANE_WORKER_CONTEXT_KEYS.i18n)),
      registerOctaneWorkerContext(
        Match,
        codec(OCTANE_WORKER_CONTEXT_KEYS.match),
      ),
      registerOctaneWorkerContext(
        Router,
        codec(OCTANE_WORKER_CONTEXT_KEYS.router),
      ),
    );
    const explicit = [
      'application.context',
      OCTANE_WORKER_CONTEXT_KEYS.match,
      OCTANE_WORKER_CONTEXT_KEYS.match,
    ];
    const child = createElement(Selection, { explicit });
    const view = mount();
    const render = (language: string | null, route: string | null) =>
      view.render(
        createElement(Router, {
          value: route,
          children: createElement(Match, {
            value: 'matched-route',
            children: createElement(I18n, { value: language, children: child }),
          }),
        }),
      );

    render('en', '/');
    expect(view.keys()).toEqual([
      OCTANE_WORKER_CONTEXT_KEYS.router,
      OCTANE_WORKER_CONTEXT_KEYS.i18n,
      ...explicit,
    ]);

    render(null, '/about');
    expect(view.keys()).toEqual([
      OCTANE_WORKER_CONTEXT_KEYS.router,
      ...explicit,
    ]);

    render('cs', null);
    expect(view.keys()).toEqual([OCTANE_WORKER_CONTEXT_KEYS.i18n, ...explicit]);
  });

  test('reads the nearest native provider and does not select its absent value', () => {
    const Context = createContext<string | null>(null);
    releases.push(
      registerOctaneWorkerContext(
        Context,
        codec(OCTANE_WORKER_CONTEXT_KEYS.i18n),
      ),
    );
    const view = mount();
    view.render(
      createElement(Context, {
        value: 'outer language',
        children: createElement(Context, {
          value: null,
          children: createElement(Selection),
        }),
      }),
    );
    expect(view.keys()).toEqual([]);
  });

  test('keeps the registered predicate and rejects duplicate native registration', () => {
    const Context = createContext<string | null>(null);
    const Other = createContext<string | null>(null);
    const options = { ...codec(OCTANE_WORKER_CONTEXT_KEYS.router) };
    releases.push(registerOctaneWorkerContext(Context, options));
    options.isProvided = () => false;

    expect(() =>
      registerOctaneWorkerContext(
        Other,
        codec(OCTANE_WORKER_CONTEXT_KEYS.router),
      ),
    ).toThrow();
    expect(() =>
      registerOctaneWorkerContext(
        Context,
        codec(OCTANE_WORKER_CONTEXT_KEYS.match),
      ),
    ).toThrow();

    const view = mount();
    view.render(
      createElement(Context, {
        value: 'provided',
        children: createElement(Selection),
      }),
    );
    expect(view.keys()).toEqual([OCTANE_WORKER_CONTEXT_KEYS.router]);
  });

  test('unregisters once and preserves a later native registration', () => {
    const Context = createContext<string | null>(null);
    const unregister = registerOctaneWorkerContext(
      Context,
      codec(OCTANE_WORKER_CONTEXT_KEYS.router),
    );
    releases.push(unregister);
    unregister();
    releases.push(
      registerOctaneWorkerContext(
        Context,
        codec(OCTANE_WORKER_CONTEXT_KEYS.router),
      ),
    );
    unregister();

    const view = mount();
    view.render(
      createElement(Context, {
        value: 'replacement',
        children: createElement(Selection),
      }),
    );
    expect(view.keys()).toEqual([OCTANE_WORKER_CONTEXT_KEYS.router]);
  });
});
