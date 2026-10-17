import {
  getResourceUrl,
  isBrowserEnvValue,
  isReactNativeEnv,
} from '@module-federation/sdk';
import {
  assertRendererFederationCompatibility,
  RENDERER_FEDERATION_METADATA_KEY,
  type RendererFederationCompatibility,
  type RendererFederationContract,
  readRendererFederationCompatibility,
  readRendererFederationContract,
  rendererFederationError,
} from './renderer-contract';

const ATTESTATION = Symbol.for(
  'ultramodern.renderer-federation.attestation.v1',
);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

type Snapshot = Record<string, unknown>;
type SnapshotArgs = {
  remoteSnapshot: Snapshot;
  from: 'global' | 'manifest';
  manifestJson?: unknown;
};
type Attestation = Readonly<{
  contract: RendererFederationContract;
  coordinates: string;
}>;

// Snapshot fields are projected by the native SDK and retain both its browser
// and SSR entries. Bind the attestation to exactly those immutable coordinates.
const coordinates = (snapshot: Snapshot): string =>
  JSON.stringify(
    [
      'globalName',
      'buildVersion',
      'remoteEntry',
      'remoteEntryType',
      'ssrRemoteEntry',
      'ssrRemoteEntryType',
      'publicPath',
      'ssrPublicPath',
      'getPublicPath',
    ].map(key => [key, snapshot[key]]),
  );

function attestation(snapshot: Snapshot): Attestation {
  const descriptor = Object.getOwnPropertyDescriptor(snapshot, ATTESTATION);
  const value: unknown = descriptor?.value;
  if (
    !descriptor ||
    descriptor.writable ||
    descriptor.configurable ||
    !record(value) ||
    typeof value.coordinates !== 'string' ||
    value.coordinates !== coordinates(snapshot)
  )
    throw rendererFederationError(
      'cached remote snapshot is missing or has changed its attestation.',
    );
  return {
    contract: readRendererFederationContract(value.contract),
    coordinates: value.coordinates,
  };
}

const assertManifestRemote = (remote: unknown): void => {
  if (!record(remote))
    throw rendererFederationError('remote registration is absent.');
  // Native snapshot handling treats any non-JSON entry as an unchecked direct
  // container. Version-only registrations may resolve to a native manifest.
  if (
    'entry' in remote &&
    (typeof remote.entry !== 'string' || !remote.entry.includes('.json'))
  )
    throw rendererFederationError(
      'renderer components require a native JSON manifest remote.',
    );
};

type Shared = Record<string, unknown> & { version?: string };
type ShareResolution =
  | { shared: Shared; useTreesShaking?: boolean }
  | undefined;
type ResolveShareArgs = {
  pkgName: string;
  shareScopeMap: Record<string, Record<string, Record<string, Shared>>>;
  resolver: () => ShareResolution;
};

function sameFactory(left: Shared, right: Shared): boolean {
  if (left === right) return true;
  if (typeof left.lib === 'function' && typeof right.lib === 'function')
    return left.lib === right.lib;
  return typeof left.get === 'function' && left.get === right.get;
}

const containerCoordinates = (info: Record<string, unknown>): string =>
  JSON.stringify(
    ['name', 'entry', 'type', 'entryGlobalName', 'buildVersion'].map(key => [
      key,
      info[key],
    ]),
  );

const entryCoordinates = (info: Record<string, unknown>): string =>
  JSON.stringify(
    ['name', 'entry', 'type', 'entryGlobalName'].map(key => [key, info[key]]),
  );

/**
 * Exact versions every shared copy of the consuming renderer tuple must carry.
 * React keeps its established package set; native renderers derive theirs from
 * the tuple's runtime, hydration, bootstrap and router owners.
 */
export function rendererShareVersions(
  expected: RendererFederationCompatibility,
): ReadonlyMap<string, string> {
  const { profile, runtime, bootstrap } = expected;
  if (profile.renderer === 'react')
    return new Map([
      ['react', runtime.version],
      ['react-dom', profile.hydration.version],
      ['react-dom/client', profile.hydration.version],
      ['@modern-js/runtime', bootstrap.version],
    ]);
  const versions = new Map<string, string>();
  for (const [name, version] of [
    [runtime.name, runtime.version],
    [profile.hydration.name, profile.hydration.version],
    [bootstrap.name, bootstrap.version],
    [profile.router.name, profile.router.version],
    [profile.router.coreName, profile.router.coreVersion],
  ] as const) {
    const prior = versions.get(name);
    if (prior !== undefined && prior !== version)
      throw rendererFederationError(
        `renderer tuple names ${name} with conflicting versions.`,
      );
    versions.set(name, version);
  }
  return versions;
}

/** Gate the native snapshot and share lifecycles before executing component factories. */
export function createRendererFederationRuntimePlugin(
  options: RendererFederationCompatibility,
) {
  const expected = readRendererFederationCompatibility(options);
  const selected = new Map<string, Shared>();
  const approvedRemoteInfos = new WeakMap<object, string>();
  const observedEntries = new WeakMap<object, string>();
  const acceptedEntries = new Set<string>();
  const versions = rendererShareVersions(expected);
  const sharedVersion = (name: string): string | undefined =>
    versions.get(name) ??
    (expected.profile.renderer === 'react'
      ? undefined
      : [...versions].find(([owner]) => name.startsWith(`${owner}/`))?.[1]);
  return {
    name: 'ultramodern-renderer-federation-contract',
    beforeRegisterRemote(args: { remote: unknown }) {
      assertManifestRemote(args.remote);
      return args;
    },
    async afterMatchRemote(args: { remote?: unknown; error?: unknown }) {
      if (!args.error) assertManifestRemote(args.remote);
      return args;
    },
    async loadRemoteSnapshot(args: SnapshotArgs) {
      const snapshot = args.remoteSnapshot;
      if (args.from === 'manifest') {
        const manifest = args.manifestJson;
        const metadata =
          record(manifest) && record(manifest.metaData)
            ? manifest.metaData[RENDERER_FEDERATION_METADATA_KEY]
            : undefined;
        const contract = readRendererFederationContract(metadata);
        // The native loading promise is process-global. Validate publication
        // independently here; an incompatible creator host must not poison a
        // later compatible host's cached promise. Every host checks below.
        if (!record(snapshot) || typeof snapshot.remoteEntry !== 'string')
          throw rendererFederationError(
            'native remote entry coordinates are absent.',
          );
        const existing = Object.getOwnPropertyDescriptor(snapshot, ATTESTATION);
        if (existing) {
          const prior = attestation(snapshot);
          if (JSON.stringify(prior.contract) !== JSON.stringify(contract))
            throw rendererFederationError(
              'remote snapshot has conflicting publication ownership.',
            );
        } else {
          Object.defineProperty(snapshot, ATTESTATION, {
            value: Object.freeze({
              contract,
              coordinates: coordinates(snapshot),
            }),
          });
        }
      } else {
        assertRendererFederationCompatibility(
          expected,
          attestation(snapshot).contract,
        );
      }
      return args;
    },
    async afterLoadSnapshot(args: {
      remoteSnapshot: Snapshot;
      moduleInfo?: { name: string };
    }) {
      // Native __MANIFEST_LOADING__ promises are global: every host must run
      // this awaited gate even when another host created the retained snapshot.
      assertRendererFederationCompatibility(
        expected,
        attestation(args.remoteSnapshot).contract,
      );
      const snapshot = args.remoteSnapshot;
      const browser =
        isBrowserEnvValue ||
        isReactNativeEnv() ||
        !('ssrRemoteEntry' in snapshot);
      const entry = browser ? snapshot.remoteEntry : snapshot.ssrRemoteEntry;
      if (typeof entry !== 'string' || !entry)
        throw rendererFederationError(
          'native projected remote entry is absent.',
        );
      // Reuse the native public URL projection. Its preload path makes a new
      // RemoteInfo without buildVersion before custom afterResolve runs.
      let entryUrl = getResourceUrl(
        snapshot as Parameters<typeof getResourceUrl>[0],
        entry,
      );
      // Mirror the native runtime's server projection exactly: the accepted
      // coordinates must equal the entry it loads, root-relative ones included.
      if (!isBrowserEnvValue && !entryUrl.startsWith('http'))
        entryUrl = `https:${entryUrl}`;
      acceptedEntries.add(
        entryCoordinates({
          name: args.moduleInfo?.name ?? snapshot.globalName,
          entry: entryUrl,
          type: browser
            ? snapshot.remoteEntryType
            : snapshot.ssrRemoteEntryType || 'global',
          entryGlobalName: snapshot.globalName,
        }),
      );
      return args;
    },
    async afterResolve(args: {
      remote: { name: string };
      remoteInfo: Record<string, unknown>;
      remoteSnapshot?: Snapshot;
      origin: {
        moduleCache: Map<string, { remoteInfo: Record<string, unknown> }>;
      };
    }) {
      if (!args.remoteSnapshot)
        throw rendererFederationError(
          'native remote resolution has no attested snapshot.',
        );
      assertRendererFederationCompatibility(
        expected,
        attestation(args.remoteSnapshot).contract,
      );
      // Native Module reuse is by name. Raw-container insertion bypasses entry
      // loading, even for a declared manifest. Accept only Module coordinates
      // that this host previously resolved through the attested native path.
      const cached = args.origin.moduleCache.get(args.remote.name);
      if (
        cached &&
        (approvedRemoteInfos.get(cached.remoteInfo) !==
          containerCoordinates(cached.remoteInfo) ||
          containerCoordinates(cached.remoteInfo) !==
            containerCoordinates(args.remoteInfo))
      )
        throw rendererFederationError(
          'cached remote container has unattested or conflicting ownership.',
        );
      const priorCoordinates = approvedRemoteInfos.get(args.remoteInfo);
      if (
        priorCoordinates !== undefined &&
        priorCoordinates !== containerCoordinates(args.remoteInfo)
      )
        throw rendererFederationError(
          'native remote container coordinates changed after attestation.',
        );
      approvedRemoteInfos.set(
        args.remoteInfo,
        containerCoordinates(args.remoteInfo),
      );
      return args;
    },
    loadEntry(args: { remoteInfo: Record<string, unknown> }): void {
      if (!acceptedEntries.has(entryCoordinates(args.remoteInfo)))
        throw rendererFederationError(
          'remote entry coordinates differ from the attested native snapshot.',
        );
    },
    async afterLoadEntry(args: {
      remoteInfo: Record<string, unknown>;
      remoteEntryExports?: unknown;
      cached?: boolean;
      error?: unknown;
      recovered?: boolean;
    }) {
      if (args.error && !args.recovered) return args;
      const binding = containerCoordinates(args.remoteInfo);
      const entryBinding = entryCoordinates(args.remoteInfo);
      if (args.cached && approvedRemoteInfos.get(args.remoteInfo) !== binding)
        throw rendererFederationError(
          'remote entry has no attested native container resolution.',
        );
      if (!acceptedEntries.has(entryBinding))
        throw rendererFederationError(
          'remote entry coordinates differ from the attested native snapshot.',
        );
      const entry = args.remoteEntryExports;
      if (
        (typeof entry !== 'object' || entry === null) &&
        typeof entry !== 'function'
      )
        throw rendererFederationError('native container exports are absent.');
      // The native loader emits cached:true for Module-provided exports,
      // including initRawContainer. Such exports must have been observed from
      // this host's validated native load before any container.get executes.
      if (args.cached && observedEntries.get(entry) !== entryBinding)
        throw rendererFederationError(
          'cached native container exports have unattested ownership.',
        );
      approvedRemoteInfos.set(args.remoteInfo, binding);
      observedEntries.set(entry, entryBinding);
      return args;
    },
    resolveShare(args: ResolveShareArgs) {
      const version = sharedVersion(args.pkgName);
      if (version === undefined) return args;
      const resolve = args.resolver;
      return {
        ...args,
        resolver() {
          const result = resolve();
          if (!result) return result;
          const shared =
            result.useTreesShaking && record(result.shared.treeShaking)
              ? result.shared.treeShaking
              : result.shared;
          if (result.shared.version !== version)
            throw rendererFederationError(
              `shared ${args.pkgName} version must be ${version}.`,
            );
          const prior = selected.get(args.pkgName);
          if (prior && !sameFactory(prior, shared))
            throw rendererFederationError(
              `shared ${args.pkgName} has conflicting runtime ownership.`,
            );
          // Unloaded alternative registrations are valid MF candidates. A
          // second already loaded factory for this renderer runtime is not.
          for (const scope of Object.values(args.shareScopeMap))
            for (const candidate of Object.values(scope[args.pkgName] ?? {})) {
              const active =
                record(candidate.treeShaking) && candidate.treeShaking.loaded
                  ? candidate.treeShaking
                  : candidate;
              if ((active.loaded || active.lib) && !sameFactory(active, shared))
                throw rendererFederationError(
                  `shared ${args.pkgName} has duplicate loaded runtime identities.`,
                );
            }
          selected.set(
            args.pkgName,
            Object.freeze({ lib: shared.lib, get: shared.get }),
          );
          return result;
        },
      };
    },
    afterLoadShare(args: { pkgName: string; selectedShared?: Shared }) {
      // Native loading fills lib after resolveShare. Observe that completed
      // factory identity here; rejection remains in the pre-factory resolver
      // because native afterLoadShare deliberately swallows thrown errors.
      if (sharedVersion(args.pkgName) !== undefined && args.selectedShared) {
        const shared =
          record(args.selectedShared.treeShaking) &&
          args.selectedShared.treeShaking.loaded
            ? args.selectedShared.treeShaking
            : args.selectedShared;
        selected.set(
          args.pkgName,
          Object.freeze({ lib: shared.lib, get: shared.get }),
        );
      }
    },
  };
}

export default createRendererFederationRuntimePlugin;
