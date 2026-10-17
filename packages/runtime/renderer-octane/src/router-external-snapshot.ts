import type { LocalisedUrlsOption } from '@modern-js/i18n-runtime-extensions/paths';
import {
  type AnyRouter,
  assertDefaultRouterRenderHost,
  associateRouterRenderProfile,
  captureRouterRenderSnapshot,
  createRouterRenderRouteTree,
  defaultParseSearch,
  defaultStringifySearch,
  disposeRouterRenderSnapshot,
  getRouterRenderProfile,
  matchContext,
  type RouterRenderJsonRecord,
  type RouterRenderSnapshot,
  registerRouterRenderProfile,
  restoreRouterRenderSnapshot,
  routerContext,
} from '@octanejs/tanstack-router';
import {
  getOctaneWorkerRouterRewrite,
  OCTANE_WORKER_CONTEXT_KEYS,
  registerOctaneWorkerContext,
} from './worker-federation-contexts';

export const OCTANE_FILE_ROUTE_SNAPSHOT_PROFILE = Object.freeze({
  key: 'ultramodern.file-routes',
  version: '1',
});

interface GeneratedRouterOrigin {
  readonly publicContext: RouterRenderJsonRecord;
  readonly rewrite: AnyRouter['options']['rewrite'];
}
const origins = new WeakMap<AnyRouter, GeneratedRouterOrigin>();
let profileRegistered = false;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function record(
  value: unknown,
  fields?: readonly string[],
): Record<string, unknown> {
  if (!plainRecord(value))
    throw new TypeError('Worker router context requires a plain record');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      (fields && !fields.includes(key)) ||
      !descriptor ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    )
      throw new TypeError('Unknown Worker router context field or accessor');
  }
  return value;
}

function nonempty(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024)
    throw new TypeError('Invalid Worker router identity');
  return value;
}

/** Only the host entry's public logical identity crosses the Worker boundary. */
function publicContext(value: unknown): RouterRenderJsonRecord {
  const context = record(value, ['ultramodern']);
  const metadata = record(context.ultramodern, ['rendererIdentity']);
  const identity = record(metadata.rendererIdentity, [
    'renderer',
    'appId',
    'entryName',
    'protocolVersion',
    'buildId',
  ]);
  if (identity.renderer !== 'octane' || identity.protocolVersion !== 1)
    throw new TypeError('Unsupported Worker router identity');
  return Object.freeze({
    ultramodern: Object.freeze({
      rendererIdentity: Object.freeze({
        renderer: 'octane',
        appId: nonempty(identity.appId),
        entryName: nonempty(identity.entryName),
        protocolVersion: 1,
        buildId: nonempty(identity.buildId),
      }),
    }),
  });
}

function localizedUrls(value: unknown): LocalisedUrlsOption | undefined {
  if (value === undefined || typeof value === 'boolean') return value;
  const input = record(value);
  const result: Exclude<LocalisedUrlsOption, boolean> = {};
  for (const [path, translations] of Object.entries(input)) {
    const names: Record<string, string> = {};
    for (const [language, target] of Object.entries(record(translations)))
      names[nonempty(language)] = nonempty(target);
    result[path] = names;
  }
  return result;
}

function rewriteDescriptor(value: unknown):
  | {
      readonly language: string;
      readonly languages: readonly string[];
      readonly localisedUrls?: LocalisedUrlsOption;
    }
  | undefined {
  if (value === undefined) return undefined;
  const input = record(value, ['language', 'languages', 'localisedUrls']);
  if (
    !Array.isArray(input.languages) ||
    !input.languages.length ||
    input.languages.length > 64
  )
    throw new TypeError('Invalid Worker router i18n languages');
  const languages = input.languages.map(nonempty);
  const language = nonempty(input.language);
  if (
    new Set(languages).size !== languages.length ||
    !languages.includes(language)
  )
    throw new TypeError('Invalid Worker router i18n language');
  const urls = localizedUrls(input.localisedUrls);
  return {
    language,
    languages,
    ...(urls === undefined ? {} : { localisedUrls: urls }),
  };
}

function nativeRewriteDescriptor(
  router: AnyRouter,
): RouterRenderJsonRecord | undefined {
  if (!router.options.rewrite) return undefined;
  const known = getOctaneWorkerRouterRewrite()?.capture(router.options.rewrite);
  if (!known)
    throw new TypeError(
      'Custom router rewrite requires an exact Worker profile',
    );
  const descriptor = rewriteDescriptor(known);
  if (!descriptor)
    throw new TypeError('Missing native router rewrite provenance');
  return {
    language: descriptor.language,
    languages: [...descriptor.languages],
    ...(descriptor.localisedUrls === undefined
      ? {}
      : { localisedUrls: descriptor.localisedUrls }),
  };
}

function validateDefaultSnapshot(snapshot: RouterRenderSnapshot): void {
  publicContext(snapshot.publicContext);
  rewriteDescriptor(snapshot.i18n);
}

function ensureDefaultProfile(): void {
  if (profileRegistered) return;
  registerRouterRenderProfile({
    id: OCTANE_FILE_ROUTE_SNAPSHOT_PROFILE,
    assertHost: (router, snapshot) => {
      const origin = origins.get(router);
      if (
        !origin ||
        origin.rewrite !== router.options.rewrite ||
        JSON.stringify(publicContext(router.options.context)) !==
          JSON.stringify(origin.publicContext)
      )
        throw new TypeError('Generated Worker router origin changed');
      assertDefaultRouterRenderHost(router, snapshot.i18n !== undefined);
      validateDefaultSnapshot(snapshot);
      if (
        JSON.stringify(nativeRewriteDescriptor(router)) !==
        JSON.stringify(snapshot.i18n)
      )
        throw new TypeError(
          'Worker router rewrite differs from its native provenance',
        );
    },
    createRoutingTree: snapshot => {
      validateDefaultSnapshot(snapshot);
      return createRouterRenderRouteTree(snapshot.routes);
    },
    routingOptions: snapshot => {
      const defaults = {
        parseSearch: defaultParseSearch,
        stringifySearch: defaultStringifySearch,
      };
      const i18n = rewriteDescriptor(snapshot.i18n);
      if (!i18n) return defaults;
      const codec = getOctaneWorkerRouterRewrite();
      if (!codec)
        throw new TypeError('Missing owning Worker router i18n codec');
      return { ...defaults, rewrite: codec.restore(i18n) };
    },
  });
  profileRegistered = true;
}

/** Associate the genuine router produced by the generated file-route factory. */
export function associateOctaneFileRouteSnapshot(router: AnyRouter): void {
  ensureDefaultProfile();
  const context = publicContext(router.options.context);
  origins.set(router, {
    publicContext: context,
    rewrite: router.options.rewrite,
  });
  associateRouterRenderProfile(router, {
    id: OCTANE_FILE_ROUTE_SNAPSHOT_PROFILE,
    publicContext: context,
  });
}

export function captureOctaneRouterSnapshot(
  router: AnyRouter,
): RouterRenderSnapshot {
  const origin = origins.get(router);
  const declared = getRouterRenderProfile(router);
  if (
    origin &&
    declared?.key === OCTANE_FILE_ROUTE_SNAPSHOT_PROFILE.key &&
    declared.version === OCTANE_FILE_ROUTE_SNAPSHOT_PROFILE.version
  ) {
    const i18n = nativeRewriteDescriptor(router);
    associateRouterRenderProfile(router, {
      id: OCTANE_FILE_ROUTE_SNAPSHOT_PROFILE,
      publicContext: origin.publicContext,
      ...(i18n === undefined ? {} : { i18n }),
    });
  }
  return captureRouterRenderSnapshot(router);
}

let registrations = 0;
let releaseContexts: (() => void) | undefined;

/** Startup registration uses the actual physical native router/match Contexts. */
export function registerOctaneRouterWorkerContexts(): () => void {
  ensureDefaultProfile();
  if (!releaseContexts) {
    const releaseRouter = registerOctaneWorkerContext(routerContext, {
      key: OCTANE_WORKER_CONTEXT_KEYS.router,
      encode: value => {
        if (!value) throw new TypeError('Missing native router provider');
        return captureOctaneRouterSnapshot(value);
      },
      decode: (value, signal) => restoreRouterRenderSnapshot(value, { signal }),
      dispose: value => {
        if (value) disposeRouterRenderSnapshot(value);
      },
      isProvided: value => value !== undefined,
    });
    try {
      const releaseMatch = registerOctaneWorkerContext(matchContext, {
        key: OCTANE_WORKER_CONTEXT_KEYS.match,
        encode: nonempty,
        decode: nonempty,
        validate: (value, readContext) => {
          const selected = readContext(routerContext);
          if (
            !selected.present ||
            !selected.value ||
            !selected.value.state.matches.some(match => match.id === value)
          )
            throw new TypeError(
              'Worker match context requires its selected native router and a current match',
            );
        },
        isProvided: value => value !== undefined,
      });
      releaseContexts = () => {
        releaseMatch();
        releaseRouter();
      };
    } catch (error) {
      releaseRouter();
      throw error;
    }
  }
  registrations++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--registrations === 0) {
      releaseContexts?.();
      releaseContexts = undefined;
    }
  };
}
