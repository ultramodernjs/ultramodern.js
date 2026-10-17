import { DataProtocolError } from '@modern-js/renderer-core/data';
import type { RequestSession } from '@modern-js/renderer-core/session';
import {
  getHydrationWriter,
  getRequestEvent,
  takeHydrationValue,
} from '@solidjs/web';
import type { AnyRouteMatch, AnyRouter } from '@tanstack/router-core';
import * as Solid from 'solid-js';
import { restoreRouteDataError } from '../route-data-error';
import {
  type PublicSnapshotOwner,
  prepareHydratedLoaderData,
  preparePublicContextData,
  preparePublicLoaderData,
  preparePublicMatchError,
  preparePublishedRouteContext,
} from './publicMatchData';

/**
 * Match-state transfer over Solid's hydration registry — the bare pairing's
 * native SSR channel (no `__TSR_SSR__` script injection, no router-owned
 * stream protocol). Entries are content-addressed (`tsr:<matchId>`; match
 * ids are deterministic route-id + interpolated params, so both sides
 * derive the same key from the same URL), the identical mechanism
 * solid-query v6 ships query payloads through (`sq:<queryHash>`).
 *
 * Server half: while the render's serialization context is live, the
 * provider writes each settled match's transferable state. Client half: the
 * hydration-claiming boot — matching is synchronous, so the provider primes
 * match state from the registry and commits before rendering, without
 * running loaders or resolving route chunks up front. Route components
 * resolve at the read point under the boundaries the server actually
 * rendered (Solid `lazy` semantics), and staleness rules own any
 * post-hydration refetching.
 *
 * Both halves no-op under TanStack Start: `router.serverSsr` marks the
 * Start contract (`attachRouterServerSsrUtils` / `dehydrate` / `hydrate`),
 * which owns transfer there — and a Start-hydrated router reaches the
 * client boot with matches already committed, which skips it.
 */
export const MATCH_KEY_PREFIX = 'tsr:';

/** The slice of a match that transfers; mirrors the single-flight match
 * shape (`createSolidStartFlightMatch`) — state, not identity: the client
 * re-derives identity by matching, then merges this in. */
interface TransferredMatch {
  status: AnyRouteMatch['status'];
  updatedAt: number;
  loaderData?: unknown;
  error?: unknown;
  notFound?: true;
  ssr?: AnyRouteMatch['ssr'];
  beforeLoadContext?: Record<string, unknown>;
}

const preparedTransfers = new WeakMap<
  RequestSession,
  WeakMap<AnyRouter, Map<string, TransferredMatch>>
>();
const publicRouteDataOwners = new WeakMap<
  object,
  {
    owner: WeakRef<PublicSnapshotOwner>;
    privateContexts: Array<WeakRef<object>>;
  }
>();

/** Bind the managed public-data scope before native router construction claims hydration. */
export function registerPublicRouteDataOwner(
  routeTree: object,
  owner: PublicSnapshotOwner,
  privateContexts: readonly object[] = [],
): void {
  publicRouteDataOwners.set(routeTree, {
    owner: new WeakRef(owner),
    privateContexts: privateContexts.map(value => new WeakRef(value)),
  });
}

/** Managed match transfer uses the immutable public-data contract, not custom adapters. */
export function assertNativeSerializationOptions(options: object): void {
  if ('serializationAdapters' in options) {
    const error = new DataProtocolError(
      'Solid serializationAdapters are unsupported by the immutable public-data profile; return public records, arrays and scalars instead',
    );
    const owner: RequestSession | undefined = getRequestEvent()?.locals.session;
    owner?.fail(error);
    throw error;
  }
}

/** Framework SSR accepts only routers that passed its public-data factory boundary. */
export function requireManagedPublicRouter(router: AnyRouter): void {
  assertNativeSerializationOptions(router.options);
  const owner: RequestSession | undefined = getRequestEvent()?.locals.session;
  if (
    !owner ||
    publicRouteDataOwners.get(router.options.routeTree)?.owner.deref()
  )
    return;
  const error = new DataProtocolError(
    'Custom native Solid routers are unsupported by UltraModern SSR. Use the managed filesystem route tree and application router public-data boundary.',
  );
  owner.fail(error);
  throw error;
}

/** Project composed public context before every native match-store publication. */
export function installPublicContextPublication(router: AnyRouter): void {
  const scope = publicRouteDataOwners.get(router.options.routeTree);
  const owner = scope?.owner.deref();
  if (!scope || !owner) return;
  const publish = router.stores.setMatches;
  router.stores.setMatches = matches => {
    try {
      const privateContexts = scope.privateContexts.flatMap(reference => {
        const value = reference.deref();
        return value ? [value] : [];
      });
      preparePublishedMatches(matches, owner, privateContexts);
    } catch (error) {
      owner.fail(error);
      throw error;
    }
    publish(matches);
  };
}

function preparePublishedMatches(
  matches: readonly AnyRouteMatch[],
  owner: PublicSnapshotOwner,
  privateContexts: readonly unknown[],
): void {
  // Check the complete offered chain before native publication updates IDs.
  for (const match of matches)
    preparePublicContextData(match.context, owner, privateContexts);
  for (const match of matches)
    preparePublishedRouteContext(match.context, owner, privateContexts);
}

function prepareEntries(
  router: AnyRouter,
  owner?: RequestSession,
  privateContexts: readonly unknown[] = [],
): Map<string, TransferredMatch> {
  const entries = new Map<string, TransferredMatch>();
  const matches = router.stores.matches.get();
  const contexts = privateContexts;
  for (const match of matches) {
    if (match.status === 'pending') continue;
    const entry: TransferredMatch = {
      status: match.status,
      updatedAt: match.updatedAt,
    };
    if (match.loaderData !== undefined)
      entry.loaderData = preparePublicLoaderData(
        match.loaderData,
        owner,
        contexts,
      );
    if (match.error !== undefined)
      entry.error = preparePublicMatchError(match.error, owner, contexts);
    const beforeLoadContext = nativeContextField(match, '__beforeLoadContext');
    if (beforeLoadContext !== undefined)
      entry.beforeLoadContext = preparePublicContextData(
        beforeLoadContext,
        owner,
        contexts,
      ) as Record<string, unknown>;
    if (match._notFound) entry.notFound = true;
    if (match.ssr !== undefined) entry.ssr = match.ssr;
    entries.set(match.id, entry);
  }
  return entries;
}

/** Validate and capture native settled match state before a response is committed. */
export function prepareRouterMatchTransfer(
  router: AnyRouter,
  owner: RequestSession,
  privateContexts: readonly unknown[] = [],
): void {
  try {
    const entries = prepareEntries(router, owner, privateContexts);
    let routers = preparedTransfers.get(owner);
    if (!routers) {
      routers = new WeakMap();
      preparedTransfers.set(owner, routers);
    }
    routers.set(router, entries);
  } catch (error) {
    owner.fail(error);
    throw error;
  }
}

export function serializeMatchTransfer(router: AnyRouter): void {
  requireManagedPublicRouter(router);
  if (router.serverSsr) return;
  const writer = getHydrationWriter();
  if (!writer || !Solid.isHydratable()) return;

  const owner: RequestSession | undefined = getRequestEvent()?.locals.session;
  const entries =
    (owner && preparedTransfers.get(owner)?.get(router)) ??
    prepareEntries(router, owner);
  for (const [id, entry] of entries) {
    // Pending matches are skipped, not deferred: this core has no per-match
    // settle promise to hand seroval, so promise-valued entries (streaming
    // SSR, loaders landing after first flush) need a dispatch-time hook —
    // the next increment. A missing entry makes the client boot fall
    // through to today's behavior rather than half-prime.
    writer.write(MATCH_KEY_PREFIX + id, entry);
  }
}

/**
 * The hydration-claiming boot. Returns true when every synchronously
 * matched route found its registry entry and the matches were committed;
 * false falls back to the caller's existing behavior (no entries — a
 * non-registry server, `noHydrate`, or a pending match the server skipped).
 *
 * Entries arrive as inline scripts that execute at document parse, so they
 * are readable through Solid's keyed value channel before client rendering.
 * The boot commits before hydration; store writes inside the claim would
 * change the owner tree being claimed.
 */
export function primeRouterFromRegistry(router: AnyRouter): boolean {
  if (router.stores.matches.get().length > 0) return false;
  const registry = (
    globalThis as unknown as { _$HY?: { r: Record<string, unknown> } }
  )._$HY?.r;
  if (!registry) return false;
  // A page with no match entries (SPA, or Start's own channel) skips before
  // paying for a match pass.
  let hasMatchEntries = false;
  for (const key in registry) {
    if (key.startsWith(MATCH_KEY_PREFIX)) {
      hasMatchEntries = true;
      break;
    }
  }
  if (!hasMatchEntries) return false;

  const matches = router.matchRoutes(router.latestLocation);
  if (matches.length === 0) return false;

  const entries: Array<TransferredMatch> = [];
  let complete = true;
  for (const match of matches) {
    const key = MATCH_KEY_PREFIX + match.id;
    const transferred = takeHydrationValue<TransferredMatch>(key);
    if (transferred?.status !== 'resolved') {
      complete = false;
      if (transferred?.status === 'pending')
        void Promise.prototype.then.call(
          transferred.promise,
          undefined,
          () => {},
        );
      continue;
    }
    const entry = transferred.value;
    if (!entry || typeof entry.status !== 'string') {
      complete = false;
      continue;
    }
    entries.push(entry);
  }
  if (!complete) return false;

  const primed: Array<AnyRouteMatch> = [];
  const scope = publicRouteDataOwners.get(router.options.routeTree);
  const owner = scope?.owner.deref();
  const privateContexts =
    scope?.privateContexts.flatMap(reference => {
      const value = reference.deref();
      return value ? [value] : [];
    }) ?? [];
  try {
    for (const [index, match] of matches.entries()) {
      const entry = entries[index]!;
      const beforeLoadContext = preparePublicContextData(
        entry.beforeLoadContext,
        owner,
        privateContexts,
      ) as Record<string, unknown> | undefined;
      const checked: TransferredMatch = {
        ...entry,
        loaderData: prepareHydratedLoaderData(
          entry.loaderData,
          owner,
          privateContexts,
        ),
        ...(beforeLoadContext !== undefined ? { beforeLoadContext } : {}),
        error: preparePublicContextData(entry.error, owner, privateContexts),
      };
      entries[index] = checked;
      primed.push(applyTransferredMatch(match, checked));
    }
    for (const [index, next] of primed.entries()) {
      const match = matches[index]!;
      const route = router.routesById[match.routeId]!;
      const parentContext =
        primed[index - 1]?.context ?? router.options.context ?? {};
      // This is the native core29 hydration context phase: reconstruct client
      // route context, then inherit the explicit checked server beforeLoad value.
      const routeContext =
        route.options.context?.({
          deps: match.loaderDeps,
          params: match.params,
          context: parentContext,
          location: router.latestLocation,
          navigate: (options: Parameters<typeof router.navigate>[0]) =>
            router.navigate({
              ...options,
              _fromLocation: router.latestLocation,
            }),
          buildLocation: router.buildLocation,
          cause: match.cause,
          abortController: match.abortController,
          preload: false,
          matches: primed,
          routeId: route.id,
        }) || undefined;
      Object.defineProperty(next, '_ctx', {
        value: routeContext,
        configurable: true,
        writable: true,
        enumerable: true,
      });
      next.context = {
        ...parentContext,
        ...routeContext,
        ...entries[index]!.beforeLoadContext,
      };
    }
    if (owner) preparePublishedMatches(primed, owner, privateContexts);
  } catch (error) {
    owner?.fail(error);
    return false;
  }

  // Commit the way the single-flight client publishes hydrated matches.
  router._committed = primed;
  router.batch(() => {
    router.stores.setMatches(primed);
    router.stores.status.set('idle');
    router.stores.resolvedLocation.set(router.stores.location.get());
  });
  return true;
}

function applyTransferredMatch(
  match: AnyRouteMatch,
  entry: TransferredMatch,
): AnyRouteMatch {
  const next = {
    ...match,
    status: entry.status,
    updatedAt: entry.updatedAt,
    error: isRouteDataErrorSnapshot(entry.error)
      ? Object.freeze(restoreRouteDataError(entry.error))
      : entry.error,
    invalid: false,
    isFetching: false,
    preload: false,
    _notFound: entry.notFound,
    __beforeLoadContext: entry.beforeLoadContext,
  } as AnyRouteMatch;
  if ('loaderData' in entry) next.loaderData = entry.loaderData;
  if ('ssr' in entry) {
    if (entry.ssr === undefined) delete next.ssr;
    else next.ssr = entry.ssr;
  }
  return next;
}

function isRouteDataErrorSnapshot(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    Object.getOwnPropertyDescriptor(value, 'kind')?.value ===
      'ultramodern-route-data-error'
  );
}

/** Core strips these native hydration fields from its public declarations. */
function nativeContextField(
  match: AnyRouteMatch,
  key: '_ctx' | '__beforeLoadContext',
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(match, key);
  if (descriptor?.get || descriptor?.set)
    throw new DataProtocolError(
      'Native route context must not contain accessor fields',
    );
  return descriptor?.value;
}
