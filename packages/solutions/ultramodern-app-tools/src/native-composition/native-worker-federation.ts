import path from 'node:path';
import type { RendererBuildIdentities } from '@modern-js/app-tools-extensions/renderer-build-identity';
import {
  RENDERER_FEDERATION_SCHEMA,
  RENDERER_FEDERATION_SCHEMA_VERSION,
  type RendererFederationCompatibility,
  type RendererFederationContract,
  readRendererFederationContract,
} from '@modern-js/federation-runtime/renderer-contract';
import type { ValidatedNativeCompilerArtifact } from '@modern-js/renderer-core/adapter';
import {
  readWorkerFederationPublication,
  WORKER_FEDERATION_SCHEMA,
  WORKER_FEDERATION_VERSION,
  type WorkerFederationExpose,
  type WorkerFederationPublication,
} from '@modern-js/renderer-core/worker-federation';

export interface NativeWorkerFederationExpose {
  readonly expose: string;
  /** Absolute local request resolved by the native Worker compiler. */
  readonly import: string;
}

/** Coordinates already owned by the workspace's Worker service bindings. */
export interface NativeWorkerFederationFragment {
  readonly remote: string;
  readonly expose: string;
  readonly boundaryId: string;
  /** Concrete endpoints resolved from the topology and final remote i18n config. */
  readonly paths: Readonly<Record<string, string>>;
}

/** Precompile coordinates cannot yet claim the native client publisher hash. */
export interface NativeWorkerFederationCoordinateTemplate {
  readonly schema: typeof WORKER_FEDERATION_SCHEMA;
  readonly schemaVersion: typeof WORKER_FEDERATION_VERSION;
  readonly remote: string;
  readonly exposes: Readonly<
    Record<string, Omit<WorkerFederationExpose, 'native'>>
  >;
}

export interface NativeWorkerFederationPlan {
  readonly renderer: RendererFederationContract;
  readonly coordinateTemplate: NativeWorkerFederationCoordinateTemplate;
  readonly exposes: readonly NativeWorkerFederationExpose[];
}

const federationError = (message: string): Error =>
  new Error(`Native Worker Federation: ${message}`);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function componentExpose(expose: string): void {
  if (
    !/^\.\/[A-Za-z0-9_$@.-]+(?:\/[A-Za-z0-9_$@.-]+)*$/u.test(expose) ||
    expose
      .slice(2)
      .split('/')
      .some(segment => segment === '.' || segment === '..')
  )
    throw federationError(
      `invalid component expose ${JSON.stringify(expose)}.`,
    );
}

function localImport(
  value: unknown,
  appDirectory: string,
  expose: string,
): string {
  if (typeof value !== 'string' && !record(value))
    throw federationError(`unsupported import declaration for ${expose}.`);
  let request: unknown = value;
  if (record(value)) {
    if (
      Object.keys(value).some(key => key !== 'import' && key !== 'name') ||
      (value.name !== undefined &&
        (typeof value.name !== 'string' || !value.name.trim()))
    )
      throw federationError(`unsupported import declaration for ${expose}.`);
    request = value.import;
  }
  if (Array.isArray(request)) {
    if (request.length !== 1)
      throw federationError(`${expose} requires exactly one component import.`);
    request = request[0];
  }
  if (
    typeof request !== 'string' ||
    !/^\.\/[A-Za-z0-9_$@.-]+(?:\/[A-Za-z0-9_$@.-]+)*$/u.test(request) ||
    request
      .slice(2)
      .split('/')
      .some(segment => segment === '.' || segment === '..')
  )
    throw federationError(`${expose} requires a plain local component import.`);
  return path.resolve(appDirectory, request);
}

/** Normalize existing MF expose declarations without loading another config. */
export function normalizeNativeWorkerFederationExposes(
  exposes: unknown,
  appDirectory: string,
): readonly NativeWorkerFederationExpose[] {
  if (!path.isAbsolute(appDirectory))
    throw federationError('the application directory must be absolute.');
  if (exposes === undefined) return Object.freeze([]);
  if (!record(exposes))
    throw federationError('component exposes must be a record.');
  return Object.freeze(
    Object.keys(exposes)
      .sort(compare)
      .map(expose => {
        componentExpose(expose);
        return Object.freeze({
          expose,
          import: localImport(exposes[expose], appDirectory, expose),
        });
      }),
  );
}

function concreteFragmentPath(value: string): void {
  if (
    typeof value !== 'string' ||
    !/^\/[A-Za-z0-9_$@.-]+(?:\/[A-Za-z0-9_$@.-]+)*$/u.test(value) ||
    value
      .slice(1)
      .split('/')
      .some(segment => segment === '.' || segment === '..')
  )
    throw federationError(
      'fragment paths require exact root endpoints without placeholders, URL options or traversal.',
    );
}

function fragmentPaths(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (!record(value) || !Object.keys(value).length)
    throw federationError(
      'fragment coordinates require a concrete locale path map.',
    );
  const locales = Object.keys(value).sort(compare);
  const paths: Record<string, string> = Object.create(null);
  for (const locale of locales) {
    concreteFragmentPath(value[locale]);
    paths[locale] = value[locale];
  }
  return Object.freeze(paths);
}

/**
 * Plan only compiler-owned exposes and entry identities. The entry mapping
 * comes from final compiler ownership, never from authored MF options.
 */
export function createNativeWorkerFederationPlan(options: {
  readonly authored: Readonly<Record<string, unknown>>;
  readonly appDirectory: string;
  readonly remote: string;
  readonly exposeEntryNames: Readonly<Record<string, string>>;
  readonly fragments: readonly NativeWorkerFederationFragment[];
  readonly compatibility: RendererFederationCompatibility;
  readonly identities: RendererBuildIdentities;
}): NativeWorkerFederationPlan {
  const exposes = normalizeNativeWorkerFederationExposes(
    options.authored.exposes,
    options.appDirectory,
  );
  if (!exposes.length)
    throw federationError('a Worker publication requires component exposes.');
  const boundaryId = options.authored.name;
  if (
    typeof boundaryId !== 'string' ||
    !boundaryId.trim() ||
    typeof options.remote !== 'string' ||
    !options.remote.trim()
  )
    throw federationError(
      'publication requires its container name and topology remote id.',
    );
  const renderer = readRendererFederationContract({
    schema: RENDERER_FEDERATION_SCHEMA,
    schemaVersion: RENDERER_FEDERATION_SCHEMA_VERSION,
    ...options.compatibility,
    identities: options.identities.identities,
  });
  if (
    Object.values(renderer.identities).some(
      identity => identity.buildId !== options.identities.buildId,
    )
  )
    throw federationError(
      'publication identities differ from the finalized build.',
    );
  const exposeNames = exposes.map(value => value.expose);
  if (
    JSON.stringify(Object.keys(options.exposeEntryNames).sort(compare)) !==
    JSON.stringify(exposeNames)
  )
    throw federationError(
      'compiler entry ownership must cover exactly the component exposes.',
    );
  const fragments = new Map<string, NativeWorkerFederationFragment>();
  const paths = new Map<string, string>();
  for (const fragment of options.fragments) {
    if (
      fragment.remote !== options.remote ||
      fragment.boundaryId !== boundaryId ||
      !exposeNames.includes(fragment.expose)
    )
      throw federationError(
        'service fragment coordinates differ from the authored publication.',
      );
    if (fragments.has(fragment.expose))
      throw federationError(
        'service fragment coordinates have duplicate exposes.',
      );
    const resolvedPaths = fragmentPaths(fragment.paths);
    for (const endpoint of Object.values(resolvedPaths)) {
      if (paths.has(endpoint) && paths.get(endpoint) !== fragment.expose)
        throw federationError(
          'service fragment coordinates have conflicting expose paths.',
        );
      paths.set(endpoint, fragment.expose);
    }
    fragments.set(fragment.expose, { ...fragment, paths: resolvedPaths });
  }
  const published: Record<
    string,
    NativeWorkerFederationCoordinateTemplate['exposes'][string]
  > = Object.create(null);
  for (const expose of exposeNames) {
    const entryName = options.exposeEntryNames[expose];
    if (
      typeof entryName !== 'string' ||
      !Object.hasOwn(renderer.identities, entryName)
    )
      throw federationError(
        `${expose} has no finalized compiler entry identity.`,
      );
    const fragment = fragments.get(expose);
    if (!fragment)
      throw federationError(
        `${expose} has no Worker service fragment coordinates.`,
      );
    published[expose] = Object.freeze({
      entryName,
      boundaryId: fragment.boundaryId,
      paths: fragment.paths,
    });
  }
  return Object.freeze({
    renderer,
    coordinateTemplate: Object.freeze({
      schema: WORKER_FEDERATION_SCHEMA,
      schemaVersion: WORKER_FEDERATION_VERSION,
      remote: options.remote,
      exposes: Object.freeze(published),
    }),
    exposes,
  });
}

/**
 * Complete publication only after the owning compiler validates CLIENT
 * artifacts. The artifact map must retain that compiler's exact entry keys.
 */
export function finalizeNativeWorkerFederationPublication(
  plan: NativeWorkerFederationPlan,
  validatedClientArtifacts: Readonly<
    Record<string, ValidatedNativeCompilerArtifact>
  >,
): WorkerFederationPublication {
  if (
    !record(validatedClientArtifacts) ||
    !Object.keys(validatedClientArtifacts).length ||
    Object.keys(validatedClientArtifacts).some(
      entryName => !Object.hasOwn(plan.renderer.identities, entryName),
    )
  )
    throw federationError(
      'validated client artifacts require finalized compiler entry ownership.',
    );
  const exposes = Object.fromEntries(
    Object.entries(plan.coordinateTemplate.exposes).map(
      ([expose, coordinate]) => {
        const artifact = Object.hasOwn(
          validatedClientArtifacts,
          coordinate.entryName,
        )
          ? validatedClientArtifacts[coordinate.entryName]
          : undefined;
        if (
          !record(artifact) ||
          !Object.hasOwn(artifact, 'nativeManifest') ||
          artifact.nativeManifest === undefined ||
          artifact.nativeManifest === null ||
          typeof artifact.hydrationBuildId !== 'string' ||
          !artifact.hydrationBuildId
        )
          throw federationError(
            `${expose} requires a validated client artifact and native hydration build ID for ${coordinate.entryName}.`,
          );
        return [
          expose,
          {
            ...coordinate,
            native: {
              publisherBuildId: artifact.hydrationBuildId,
              runtimeABI: 1,
            },
          },
        ];
      },
    ),
  );
  return readWorkerFederationPublication(
    { ...plan.coordinateTemplate, exposes },
    plan.renderer.identities,
  );
}

function immutableSource(value: unknown): string {
  if (Array.isArray(value))
    return `Object.freeze([${value.map(immutableSource).join(',')}])`;
  if (record(value))
    return `Object.freeze({${Object.keys(value)
      .sort(compare)
      .map(key => `[${JSON.stringify(key)}]:${immutableSource(value[key])}`)
      .join(',')}})`;
  return JSON.stringify(value);
}

/** Only literal native imports and immutable admission data enter the Worker. */
export function nativeWorkerContextStartupSource(options: {
  readonly router?: boolean;
  readonly i18n?: boolean;
  readonly contextProfiles?: readonly string[];
}): string {
  const registrations = [
    ...(options.router
      ? [
          {
            name: 'registerOctaneRouterWorkerContexts',
            module: '@modern-js/renderer-octane/router-external-snapshot',
          },
        ]
      : []),
    ...(options.i18n
      ? [
          {
            name: 'registerOctaneI18nWorkerContexts',
            module: '@modern-js/renderer-octane/i18n-external-snapshot',
          },
        ]
      : []),
  ];
  return [
    ...registrations.map(
      registration =>
        `import {${registration.name}} from ${JSON.stringify(registration.module)};`,
    ),
    ...(options.contextProfiles ?? []).map(
      module => `import ${JSON.stringify(module)};`,
    ),
    ...registrations.map(registration => `${registration.name}();`),
  ].join('\n');
}

/** Only literal native imports and immutable admission data enter the Worker. */
export function nativeWorkerFederationRegistrySource(
  plan: NativeWorkerFederationPlan,
  contexts: Parameters<typeof nativeWorkerContextStartupSource>[0] = {},
): string {
  const loaders = plan.exposes
    .map(
      value =>
        `[${JSON.stringify(value.expose)}]:()=>import(${JSON.stringify(value.import)})`,
    )
    .join(',\n');
  return `import {createWorkerFederationHandler,readWorkerFederationPublication} from "@modern-js/renderer-core/worker-federation";
${nativeWorkerContextStartupSource(contexts)}
export const nativeWorkerFederationExposes = Object.freeze({\n${loaders}\n});
export const rendererFederationPublication = ${immutableSource(plan.renderer)};
export const workerFederationCoordinateTemplate = ${immutableSource(plan.coordinateTemplate)};
export function initializeNativeWorkerFederation(options) {
  const worker = readWorkerFederationPublication(options.publication,rendererFederationPublication.identities);
  const template = workerFederationCoordinateTemplate;
  if (worker.remote !== template.remote || Object.keys(worker.exposes).length !== Object.keys(template.exposes).length || Object.entries(template.exposes).some(([expose,coordinate]) => {
    const published = worker.exposes[expose];
    return !published || published.entryName !== coordinate.entryName || published.boundaryId !== coordinate.boundaryId || Object.keys(published.paths).length !== Object.keys(coordinate.paths).length || Object.entries(coordinate.paths).some(([locale,path]) => published.paths[locale] !== path);
  })) throw new Error("Native Worker Federation: completed publication conflicts with the compiled coordinates.");
  return createWorkerFederationHandler({...options,publication:{renderer:rendererFederationPublication,worker},exposes:nativeWorkerFederationExposes});
}
`;
}
