import { runtime } from '@modern-js/plugin/runtime';
import * as actualRouter from '@modern-js/runtime-utils/router' with {
  rstest: 'importActual',
};
import { render } from '@testing-library/react';
import type React from 'react';
import {
  getInitialContext,
  InternalRuntimeContext,
} from '../../src/core/context';
import { routerPlugin } from '../../src/router/runtime/plugin';
import type { RouterConfig } from '../../src/router/runtime/types';

const routerProviderProps: Array<Record<string, unknown>> = [];

rstest.mock('@modern-js/runtime-utils/router', () => ({
  ...actualRouter,
  RouterProvider: (props: Record<string, unknown>) => {
    routerProviderProps.push(props);
    return null;
  },
}));

rstest.mock('../../src/router/runtime/rsc-router', () => ({
  createClientRouterFromPayload: () => null,
}));

const renderWithRouterConfig = (
  runtimeRouterConfig: Partial<RouterConfig> | undefined,
) => {
  const { runtimeContext: manager } = runtime.run({
    config: { router: runtimeRouterConfig },
    plugins: [
      routerPlugin({
        createRoutes: () => [{ path: '/', element: null }],
      }),
    ],
  });
  const Shell = ({ children }: React.PropsWithChildren) => <>{children}</>;
  const RouterWrapper = manager.hooks.wrapRoot.call(Shell);
  render(
    <InternalRuntimeContext.Provider value={getInitialContext()}>
      <RouterWrapper />
    </InternalRuntimeContext.Provider>,
  );

  return routerProviderProps[routerProviderProps.length - 1];
};

describe('router useTransitions', () => {
  beforeEach(() => {
    routerProviderProps.length = 0;
  });

  it('does not pass useTransitions by default', () => {
    expect(renderWithRouterConfig(undefined).useTransitions).toBeUndefined();
  });

  it('passes useTransitions to RouterProvider', () => {
    expect(
      renderWithRouterConfig({ useTransitions: false }).useTransitions,
    ).toBe(false);
    expect(
      renderWithRouterConfig({ useTransitions: true }).useTransitions,
    ).toBe(true);
  });

  it('falls back to future.v7_startTransition', () => {
    expect(
      renderWithRouterConfig({ future: { v7_startTransition: false } })
        .useTransitions,
    ).toBe(false);
    expect(
      renderWithRouterConfig({
        useTransitions: true,
        future: { v7_startTransition: false },
      }).useTransitions,
    ).toBe(true);
  });
});
