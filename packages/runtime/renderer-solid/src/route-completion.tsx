import { DataProtocolError } from '@modern-js/renderer-core/data';
import type { RequestSession } from '@modern-js/renderer-core/session';
import { Dynamic, type JSX } from '@solidjs/web';
import type { AnyRouter, CreateRouterFn } from '@tanstack/router-core';
import type { Accessor } from 'solid-js';
import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { AnyRoute, RouteComponent } from './router-binding/index';
import {
  createRouter,
  preparePublicContextData,
  useMatch,
} from './router-binding/index';
import {
  assertNativeSerializationOptions,
  registerPublicRouteDataOwner,
} from './router-binding/registryTransfer';

interface CompletionRecord {
  readonly failure: Accessor<{ reason: unknown } | undefined>;
  acquire(): () => void;
}

interface PublicDataGeneration {
  readonly owner: Pick<RequestSession, 'fail' | 'signal'>;
  publish(value: unknown, completion?: Promise<void>): void;
}

export interface RouteCompletionScope {
  readonly hydrationOwner: Pick<RequestSession, 'fail' | 'signal'>;
  readonly privateRoots: readonly object[];
  attach(router: AnyRouter): void;
  begin(signal: AbortSignal, cancel: () => void): PublicDataGeneration;
  component(component: RouteComponent): RouteComponent;
  dispose(): void;
}

// These weak associations contain owned lifecycles, never ambient request data.
const routeScopes = new WeakMap<AnyRoute, RouteCompletionScope>();
const routerScopes = new WeakMap<AnyRouter, RouteCompletionScope>();

function assertManagedRouteData(route: AnyRoute | undefined): void {
  if (!route) return;
  if (route.options.loader || route.options.beforeLoad || route.options.context)
    throw new DataProtocolError(
      'Custom native Solid loader/beforeLoad/context routes are unsupported by the immutable public-data profile; use createFileSystemRouteTree',
    );
  for (const child of route.children ?? []) assertManagedRouteData(child);
}

export function registerRouteCompletionScope(
  route: AnyRoute,
  scope: RouteCompletionScope,
): void {
  routeScopes.set(route, scope);
}

export const createApplicationRouter: CreateRouterFn = options => {
  assertNativeSerializationOptions(options);
  const scope = options.routeTree
    ? routeScopes.get(options.routeTree)
    : undefined;
  if (!scope) assertManagedRouteData(options.routeTree);
  if (scope && options.routeTree)
    registerPublicRouteDataOwner(
      options.routeTree,
      scope.hydrationOwner,
      scope.privateRoots,
    );
  const context = preparePublicContextData(
    options.context,
    scope?.hydrationOwner,
  );
  if (
    context !== undefined &&
    (!context || typeof context !== 'object' || Array.isArray(context))
  )
    throw new DataProtocolError(
      'The native Solid router context must be a public record',
    );
  const router = createRouter({ ...options, context });
  if (scope) {
    scope.attach(router);
    routerScopes.set(router, scope);
  }
  return router;
};

export function ownApplicationRouteData(router: AnyRouter): void {
  const scope = routerScopes.get(router);
  if (scope) onCleanup(() => scope.dispose());
  else assertManagedRouteData(router.options.routeTree);
}

/** A framing failure belongs to the exact native loader generation that read it. */
export function createRouteCompletionScope(
  privateRoots: readonly object[] = [],
  session?: RequestSession,
): RouteCompletionScope {
  const records = new WeakMap<object, CompletionRecord>();
  const pending = new Set<() => void>();
  const hydration = new AbortController();
  let router: AnyRouter | undefined;

  function begin(
    signal: AbortSignal,
    cancel: () => void,
  ): PublicDataGeneration {
    if (!router)
      throw new Error(
        'Use createApplicationRouter to own progressive Solid route data',
      );
    const [failure, setFailure] = createSignal<{ reason: unknown }>();
    const native = router;
    let value: unknown;
    let leases = 0;
    let settled = false;
    let failed = false;
    const stop = () => {
      if (!settled) {
        pending.delete(stop);
        if (value && typeof value === 'object')
          native.clearCache({ filter: match => match.loaderData === value });
        cancel();
      }
    };
    const fail = (reason: unknown) => {
      if (failed) return;
      failed = true;
      settled = true;
      pending.delete(stop);
      if (value && typeof value === 'object')
        native.clearCache({ filter: match => match.loaderData === value });
      setFailure({ reason });
      cancel();
    };
    const record: CompletionRecord = {
      failure,
      acquire() {
        leases++;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          if (
            --leases === 0 &&
            !native.state.matches.some(match => match.loaderData === value)
          )
            stop();
        };
      },
    };
    return {
      owner: { signal, fail },
      publish(publicValue, completion) {
        value = publicValue;
        const deferred =
          value && typeof value === 'object'
            ? Reflect.ownKeys(value).flatMap(key => {
                const entry = Object.getOwnPropertyDescriptor(value, key);
                return entry && !entry.get && entry.value instanceof Promise
                  ? [entry.value]
                  : [];
              })
            : [];
        if (!completion && deferred.length === 0) return;
        if (value && typeof value === 'object') {
          records.set(value, record);
          pending.add(stop);
        } else if (completion) {
          throw new DataProtocolError(
            'Progressive route data requires its native value object',
          );
        }
        if (completion)
          void completion.then(() => {
            settled = true;
            pending.delete(stop);
          }, fail);
        else
          void Promise.allSettled(deferred).then(() => {
            settled = true;
            pending.delete(stop);
          });
      },
    };
  }

  return {
    privateRoots,
    hydrationOwner: session ?? {
      signal: hydration.signal,
      fail: error => hydration.abort(error),
    },
    attach(native) {
      if (router && router !== native)
        throw new Error('A Solid data scope already owns its native router');
      router = native;
    },
    begin,
    component(component) {
      return function RouteCompletionView(): JSX.Element {
        // Select the registry record before native structural sharing can reuse
        // a deeply equal previous loaderData object from another generation.
        const record = useMatch({
          strict: false,
          select: match =>
            match.loaderData && typeof match.loaderData === 'object'
              ? records.get(match.loaderData)
              : undefined,
        });
        createEffect(record, current => current?.acquire());
        const ready = createMemo(() => {
          const failure = record()?.failure();
          if (failure) throw failure.reason;
          return component;
        });
        return <Dynamic component={ready()} />;
      };
    },
    dispose() {
      hydration.abort();
      for (const stop of pending) stop();
      pending.clear();
    },
  };
}
