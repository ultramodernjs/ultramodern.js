import type { NativeLocationRewrite } from '@modern-js/renderer-core/router';
import {
  type Context,
  type ExternalSnapshotContextCodec,
  registerExternalSnapshotContext,
  useContext,
} from 'octane';

export const OCTANE_WORKER_CONTEXT_KEYS = Object.freeze({
  router: 'ultramodern.octane.router-context.v1',
  match: 'ultramodern.octane.match-context.v1',
  i18n: 'ultramodern.octane.i18n-context.v1',
} as const);

type OctaneWorkerContextKey =
  (typeof OCTANE_WORKER_CONTEXT_KEYS)[keyof typeof OCTANE_WORKER_CONTEXT_KEYS];

export interface OctaneWorkerContextCodec<T>
  extends ExternalSnapshotContextCodec<T> {
  readonly key: OctaneWorkerContextKey;
  readonly dispose?: (value: T) => void | PromiseLike<void>;
  readonly isProvided: (value: T) => boolean;
}

const builtinKeys = Object.values(OCTANE_WORKER_CONTEXT_KEYS);
const contexts = new Map<OctaneWorkerContextKey, () => boolean>();

/** Optional renderer modules register their actual native context identities. */
export function registerOctaneWorkerContext<T>(
  context: Context<T>,
  codec: OctaneWorkerContextCodec<T>,
): () => void {
  const { key, isProvided } = codec;
  if (!builtinKeys.includes(key) || typeof isProvided !== 'function')
    throw new TypeError('Invalid Octane Worker builtin context codec');

  const unregister = registerExternalSnapshotContext(context, codec);
  const hasProvider = () => isProvided(useContext(context));
  contexts.set(key, hasProvider);

  return () => {
    if (contexts.get(key) !== hasProvider) return;
    unregister();
    contexts.delete(key);
  };
}

/** Read live providers on every render; explicit requirements retain native validation. */
export function useOctaneWorkerContextKeys(
  explicit: readonly string[] = [],
): readonly string[] {
  const selected: string[] = [];
  for (const key of builtinKeys) {
    const hasProvider = contexts.get(key);
    if (hasProvider?.() && !explicit.includes(key)) selected.push(key);
  }
  return [...selected, ...explicit];
}

export interface OctaneWorkerRouterRewrite {
  readonly capture: (rewrite: NativeLocationRewrite) => unknown;
  readonly restore: (descriptor: unknown) => NativeLocationRewrite;
}
let routerRewrite: OctaneWorkerRouterRewrite | undefined;

/** The optional i18n owner supplies its own native rewrite provenance. */
export function registerOctaneWorkerRouterRewrite(
  codec: OctaneWorkerRouterRewrite,
): () => void {
  if (
    routerRewrite ||
    typeof codec.capture !== 'function' ||
    typeof codec.restore !== 'function'
  )
    throw new TypeError(
      'Invalid or duplicate Octane Worker router rewrite codec',
    );
  const captured = Object.freeze({
    capture: codec.capture,
    restore: codec.restore,
  });
  routerRewrite = captured;
  return () => {
    if (routerRewrite === captured) routerRewrite = undefined;
  };
}
export function getOctaneWorkerRouterRewrite():
  | OctaneWorkerRouterRewrite
  | undefined {
  return routerRewrite;
}
