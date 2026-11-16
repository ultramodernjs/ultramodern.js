import { RuntimeContext } from '@modern-js/runtime';
import { renderToString } from 'react-dom/server';
import { renderToReadableStream } from 'react-dom/server.edge';
import {
  createDistributedSsrComponent,
  DISTRIBUTED_SSR_FRAGMENT_REQUEST_LOCALS_KEY,
  DISTRIBUTED_SSR_FRAGMENTS_LOCALS_KEY,
  DistributedSsrBoundary,
  distributedSsrFragmentKey,
  useDistributedSsrFragmentProps,
} from '../../src/module-federation/distributed-ssr';

const key = distributedSsrFragmentKey('inventory', './Widget');

interface CheckoutRemoteProps {
  price: number;
  sku: string;
}

function renderBoundary(context: Record<string, unknown>) {
  return renderToString(
    <RuntimeContext.Provider value={context as never}>
      <DistributedSsrBoundary
        expose="./Widget"
        fallback={<p>unavailable</p>}
        remote="inventory"
      >
        <section data-native-mf="inventory">inventory</section>
      </DistributedSsrBoundary>
    </RuntimeContext.Provider>,
  );
}

function AddToCartFragment() {
  const props = useDistributedSsrFragmentProps<CheckoutRemoteProps>({
    boundaryId: 'verticalCheckout',
    expose: './AddToCart',
  });

  return <output>{`${props.sku}:${props.price}`}</output>;
}

function MiniCartFragment() {
  useDistributedSsrFragmentProps({
    boundaryId: 'verticalCheckout',
    expose: './MiniCart',
  });
  return null;
}

describe('DistributedSsrBoundary', () => {
  it('renders the typed fallback when a required Worker fragment is degraded', () => {
    const html = renderBoundary({
      isBrowser: false,
      requestContext: {
        request: {},
        response: {
          locals: {
            [DISTRIBUTED_SSR_FRAGMENTS_LOCALS_KEY]: {
              required: true,
              fragments: {
                [key]: {
                  boundaryId: 'verticalInventory',
                  expose: './Widget',
                  reason: 'binding-unavailable',
                  remote: 'inventory',
                  status: 'degraded',
                },
              },
            },
          },
        },
      },
    });

    expect(html).toContain('unavailable');
    expect(html).toContain('data-modern-distributed-ssr-status="degraded"');
    expect(html).toContain(
      'data-modern-distributed-ssr-reason="binding-unavailable"',
    );
  });
});

describe('useDistributedSsrFragmentProps', () => {
  it('returns only props verified for the rendered remote expose', () => {
    const html = renderToString(
      <RuntimeContext.Provider
        value={
          {
            isBrowser: false,
            requestContext: {
              request: {},
              response: {
                locals: {
                  [DISTRIBUTED_SSR_FRAGMENT_REQUEST_LOCALS_KEY]: {
                    boundaryId: 'verticalCheckout',
                    expose: './AddToCart',
                    props: { price: 7750, sku: 'CL-08-GR' },
                    remote: 'checkout',
                    sourceUrl:
                      'https://tractor.example.com/en/tractors/holland-hamster',
                  },
                },
              },
            },
          } as never
        }
      >
        <AddToCartFragment />
      </RuntimeContext.Provider>,
    );

    expect(html).toContain('CL-08-GR:7750');
  });

  it('rejects a fragment request for a different expose', () => {
    expect(() =>
      renderToString(
        <RuntimeContext.Provider
          value={
            {
              isBrowser: false,
              requestContext: {
                request: {},
                response: {
                  locals: {
                    [DISTRIBUTED_SSR_FRAGMENT_REQUEST_LOCALS_KEY]: {
                      boundaryId: 'verticalCheckout',
                      expose: './AddToCart',
                      props: {},
                      remote: 'checkout',
                      sourceUrl: 'https://tractor.example.com/en/cart',
                    },
                  },
                },
              },
            } as never
          }
        >
          <MiniCartFragment />
        </RuntimeContext.Provider>,
      ),
    ).toThrow(/fragment request contract mismatch/u);
  });
});

describe('createDistributedSsrComponent', () => {
  it('suspends workerd SSR until an asynchronous service fragment is ready', async () => {
    const fragment = {
      boundaryId: 'verticalCheckout',
      expose: './AddToCart',
      html: '<button>Add asynchronous tractor</button>',
      remote: 'checkout',
      status: 'ready' as const,
    };
    let resolved = false;
    let pending: Promise<typeof fragment> | undefined;
    const Remote = createDistributedSsrComponent<{ sku: string }>({
      createComponent: () => () => (
        <section data-native-mf="checkout">native checkout</section>
      ),
      expose: './AddToCart',
      fallback: <p>unavailable</p>,
      remote: 'checkout',
    });
    const stream = await renderToReadableStream(
      <RuntimeContext.Provider
        value={
          {
            isBrowser: false,
            requestContext: {
              request: {},
              response: {
                locals: {
                  [DISTRIBUTED_SSR_FRAGMENTS_LOCALS_KEY]: {
                    required: true,
                    resolve: () => {
                      if (resolved) {
                        return fragment;
                      }
                      pending ??= Promise.resolve(fragment).then(value => {
                        resolved = true;
                        return value;
                      });
                      return pending;
                    },
                  },
                },
              },
            },
          } as never
        }
      >
        <Remote sku="CL-08-GR" />
      </RuntimeContext.Provider>,
    );
    await stream.allReady;
    const html = await new Response(stream).text();

    expect(html).toContain('Add asynchronous tractor');
    expect(html).not.toContain('unavailable');
    expect(html).not.toContain('data-native-mf');
  });

  it('resolves a workerd fragment from the actual serializable component props', () => {
    const requests: Array<{
      expose: string;
      props: Record<string, unknown>;
      remote: string;
    }> = [];
    const Remote = createDistributedSsrComponent<CheckoutRemoteProps>({
      createComponent: () => () => (
        <section data-native-mf="inventory">native inventory</section>
      ),
      expose: './AddToCart',
      fallback: <p>unavailable</p>,
      remote: 'checkout',
    });
    const html = renderToString(
      <RuntimeContext.Provider
        value={
          {
            isBrowser: false,
            requestContext: {
              request: {},
              response: {
                locals: {
                  [DISTRIBUTED_SSR_FRAGMENTS_LOCALS_KEY]: {
                    required: true,
                    resolve: (
                      remote: string,
                      expose: string,
                      props: Record<string, unknown>,
                    ) => {
                      requests.push({ expose, props, remote });
                      return {
                        boundaryId: 'verticalCheckout',
                        buildMarker: 'checkout-build-b',
                        digest: 'sha256-checkout-b',
                        expose,
                        html: '<button>Add Holland Hamster</button><output>7750</output>',
                        remote,
                        status: 'ready',
                      };
                    },
                  },
                },
              },
            },
          } as never
        }
      >
        <Remote price={7750} sku="CL-08-GR" />
      </RuntimeContext.Provider>,
    );

    expect(requests).toEqual([
      {
        expose: './AddToCart',
        props: { price: 7750, sku: 'CL-08-GR' },
        remote: 'checkout',
      },
    ]);
    expect(html).toContain(
      '<button>Add Holland Hamster</button><output>7750</output>',
    );
    expect(html).toContain(
      'data-modern-distributed-ssr-build="checkout-build-b"',
    );
    expect(html).toContain(
      'data-modern-distributed-ssr-digest="sha256-checkout-b"',
    );
    expect(html).not.toContain('data-native-mf');
  });

  it('constructs and caches the native remote for Node SSR without bridge-injected links', () => {
    const fallback = <p>unavailable</p>;
    const lazyOptions: unknown[] = [];
    const Remote = createDistributedSsrComponent({
      createComponent: options => {
        lazyOptions.push(options);
        return () => <section data-native-mf="inventory">inventory</section>;
      },
      expose: './Widget',
      fallback,
      remote: 'inventory',
    });
    const context = {
      isBrowser: false,
      requestContext: { request: {}, response: {} },
    } as never;

    expect(
      renderToString(
        <RuntimeContext.Provider value={context}>
          <Remote />
        </RuntimeContext.Provider>,
      ),
    ).toContain('data-native-mf="inventory"');
    renderToString(
      <RuntimeContext.Provider value={context}>
        <Remote />
      </RuntimeContext.Provider>,
    );

    // The bridge renders a remote CSS <link> into SSR HTML unless injectLink
    // is false; the boundary owns remote CSS, so it hands the native factory
    // the options that turn the bridge link off in every build format.
    expect(lazyOptions).toEqual([
      {
        export: 'default',
        fallback,
        injectLink: false,
        loading: null,
      },
    ]);
  });

  // Shells generated before the factory received options pass a factory that
  // takes none, with the Props type argument written out.
  it('accepts a native factory that ignores the boundary options', () => {
    type WidgetProps = { label: string };
    const Remote = createDistributedSsrComponent<WidgetProps>({
      createComponent:
        () =>
        ({ label }: WidgetProps) => (
          <section data-native-mf="inventory">{label}</section>
        ),
      expose: './Widget',
      fallback: null,
      remote: 'inventory',
    });

    expect(
      renderToString(
        <RuntimeContext.Provider
          value={
            {
              isBrowser: false,
              requestContext: { request: {}, response: {} },
            } as never
          }
        >
          <Remote label="tractor" />
        </RuntimeContext.Provider>,
      ),
    ).toContain('>tractor</section>');
  });
});
