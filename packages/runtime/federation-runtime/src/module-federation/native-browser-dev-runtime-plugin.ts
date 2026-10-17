import {
  createNativeBrowserDevRefresh,
  isNativeBrowserDevCommitError,
  type NativeBrowserDevGraph,
  type NativeBrowserDevHost,
  nativeBrowserDevCommitFailure,
} from './native-browser-dev-refresh';
import { readRendererFederationContract } from './renderer-contract';

export const NATIVE_BROWSER_DEV_BOUNDARY = Symbol.for(
  'ultramodern.federation.browser-dev-boundary.v1',
);
const REGISTRY = Symbol.for('ultramodern.federation.browser-dev-routing.v1');

interface Replacement {
  readonly commitStarted: boolean;
  execute<T>(factory: () => T): T;
}
interface Reference {
  readonly host: NativeBrowserDevHost;
  readonly remote: NativeBrowserDevGraph['remote'];
  readonly boundary: object;
  readonly prepare: (boundary: object) => Replacement;
}
interface Binding {
  readonly id: string;
  readonly remoteName: string;
  readonly references: Set<Reference>;
  readonly coordinator: ReturnType<typeof createNativeBrowserDevRefresh>;
}
interface Registry {
  readonly sources: WeakMap<object, Map<string, Binding>>;
  readonly bindings: Set<Binding>;
}

function registry(): Registry {
  const root = globalThis as typeof globalThis & { [REGISTRY]?: Registry };
  if (!root[REGISTRY])
    Object.defineProperty(root, REGISTRY, {
      value: { sources: new WeakMap(), bindings: new Set() } satisfies Registry,
    });
  return root[REGISTRY]!;
}

function firstReference(binding: Binding): Reference {
  const reference = binding.references.values().next().value;
  if (!reference)
    throw new Error('Native browser refresh has no mounted boundary owner.');
  return reference;
}

/**
 * This registry routes work to actual mounted boundary references; its names
 * grant no native authority. Octane revalidates the exact compiled root, lease,
 * physical document and every surviving owner inside the opaque capability.
 */
export function createNativeBrowserDevRuntimePlugin(options: {
  readonly remotes: readonly NativeBrowserDevGraph['remote'][];
  readonly prepareReplacement: Reference['prepare'];
  readonly createHost: Parameters<
    typeof createNativeBrowserDevRefresh
  >[0]['createHost'];
}) {
  return {
    name: 'ultramodern-native-browser-dev-refresh',
    beforeInit<T extends { origin: NativeBrowserDevHost }>(args: T): T {
      const host = args.origin;
      if (Object.hasOwn(host, NATIVE_BROWSER_DEV_BOUNDARY)) return args;
      Object.defineProperty(host, NATIVE_BROWSER_DEV_BOUNDARY, {
        value(id: string, source: object, boundary: object): () => void {
          const remote = options.remotes.find(remote =>
            id.startsWith(`${remote.alias}/`),
          );
          if (!remote)
            throw new Error(
              `Native browser refresh has no registered remote for ${id}.`,
            );
          const state = registry();
          let sources = state.sources.get(source);
          if (!sources) state.sources.set(source, (sources = new Map()));
          let binding = sources.get(id);
          if (binding && binding.remoteName !== remote.name)
            throw new Error(
              'Native browser refresh source has conflicting remote ownership.',
            );
          if (!binding) {
            const references = new Set<Reference>();
            const current = (): Reference => firstReference(created);
            const created: Binding = {
              id,
              remoteName: remote.name,
              references,
              coordinator: createNativeBrowserDevRefresh({
                get host() {
                  return current().host;
                },
                id,
                boundary: references,
                prepareReplacement() {
                  const reference = current();
                  return reference.prepare(reference.boundary);
                },
                createHost: options.createHost,
              }),
            };
            binding = created;
            sources.set(id, binding);
            state.bindings.add(binding);
          }
          const reference: Reference = {
            host,
            remote,
            boundary,
            prepare: options.prepareReplacement,
          };
          binding.references.add(reference);
          const owned = binding;
          let released = false;
          return () => {
            if (released) return;
            released = true;
            owned.references.delete(reference);
            if (owned.references.size) return;
            sources!.delete(id);
            state.bindings.delete(owned);
            owned.coordinator.dispose();
          };
        },
      });
      return args;
    },
  };
}

/** One synchronous exposed graph execution serves all of its mounted instances. */
export async function replaceNativeBrowserDevRemote(
  graph: NativeBrowserDevGraph,
): Promise<number> {
  const bindings = [...registry().bindings].filter(
    binding => binding.remoteName === graph.remote.name,
  );
  if (!bindings.length)
    throw new Error(
      'Native browser refresh has no mounted publisher for this remote.',
    );
  let committed = 0;
  try {
    for (const binding of bindings) {
      await binding.coordinator.replace(graph);
      committed++;
    }
  } catch (error) {
    // Separate exposed roots are not an atomic remote-wide transaction. If an
    // earlier root committed, its runtime must survive a later root's failure.
    if (committed && !isNativeBrowserDevCommitError(error, graph.revision))
      throw nativeBrowserDevCommitFailure(graph.revision, error);
    throw error;
  }
  return bindings.length;
}

export interface NativeBrowserDevPublication extends NativeBrowserDevGraph {
  readonly buildId: string;
  readonly runtimeHash: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Discover the latest completed graph through this mounted host's transport. */
export async function readNativeBrowserDevPublication(
  remoteName: string,
  options: { readonly signal: AbortSignal; readonly revisionHeader: string },
): Promise<NativeBrowserDevPublication> {
  const binding = [...registry().bindings].find(
    binding => binding.remoteName === remoteName,
  );
  if (!binding)
    throw new Error(
      'Native browser refresh has no mounted publisher for discovery.',
    );
  const reference = firstReference(binding);
  const remote = reference.remote;
  const host = reference.host;
  const init: RequestInit = { cache: 'no-store', signal: options.signal };
  const context = {
    initiator: 'loadRemote' as const,
    id: binding.id,
    resourceType: 'manifest' as const,
    url: remote.entry,
  };
  const hook = host.loaderHook?.lifecycle.fetch;
  const request = (async () => {
    const hooked = await hook?.emit(remote.entry, init, remote, context);
    const response =
      hooked instanceof Response
        ? hooked
        : await globalThis.fetch(remote.entry, init);
    if (options.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw options.signal.reason;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(
        `Native browser manifest discovery failed: ${response.status}`,
      );
    }
    const manifest: unknown = await response.json();
    const revision = response.headers.get(options.revisionHeader);
    const links = [
      ...(response.headers.get('link') ?? '').matchAll(
        /<([^>]+)>\s*;([^,]*)/gu,
      ),
    ].filter(([, , parameters]) =>
      /\brel\s*=\s*"?ultramodern-completed-graph"?(?:\s|;|$)/u.test(
        parameters!,
      ),
    );
    if (!revision || !/^[a-f0-9]{64}$/u.test(revision) || links.length !== 1)
      throw new Error(
        'Native browser manifest has no unique completed graph coordinate.',
      );
    const entry = new URL(links[0]![1]!, remote.entry);
    if (
      !['http:', 'https:'].includes(entry.protocol) ||
      entry.username ||
      entry.password ||
      entry.hash
    )
      throw new Error('Native browser completed graph URL is invalid.');
    const namespace = /\/__ultramodern_mf__\/([a-f0-9]+)\//u.exec(
      entry.pathname,
    );
    if (!namespace)
      throw new Error(
        'Native browser graph is not in the immutable runtime namespace.',
      );
    const metadata =
      record(manifest) && record(manifest.metaData)
        ? manifest.metaData.ultramodernRenderer
        : undefined;
    const contract = readRendererFederationContract(metadata);
    const buildIds = new Set(
      Object.values(contract.identities).map(identity => identity.buildId),
    );
    if (buildIds.size !== 1)
      throw new Error(
        'Native browser graph has conflicting renderer build identities.',
      );
    return {
      revision,
      runtimeHash: namespace[1]!,
      buildId: [...buildIds][0]!,
      remote: { ...remote, entry: entry.href },
    };
  })();
  let removeAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(options.signal.reason);
    removeAbort = () => options.signal.removeEventListener('abort', abort);
    if (options.signal.aborted) abort();
    else options.signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([request, aborted]);
  } finally {
    removeAbort();
  }
}

export function hasNativeBrowserDevPublisher(remoteName: string): boolean {
  return [...registry().bindings].some(
    binding => binding.remoteName === remoteName,
  );
}
