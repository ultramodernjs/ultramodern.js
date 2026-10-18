import {
  identityCacheKey,
  type RendererIdentity,
  readRendererIdentity,
} from '../identity';

export const WORKER_FEDERATION_METADATA_KEY = 'ultramodernWorkerFederation';
export const WORKER_FEDERATION_SCHEMA = 'ultramodern.worker-federation';
export const WORKER_FEDERATION_VERSION = 1;

export interface WorkerFederationExpose {
  readonly entryName: string;
  readonly boundaryId: string;
  readonly paths: Readonly<Record<string, string>>;
  readonly native: {
    readonly publisherBuildId: string;
    readonly runtimeABI: 1;
  };
}

export interface WorkerFederationPublication {
  readonly schema: typeof WORKER_FEDERATION_SCHEMA;
  readonly schemaVersion: typeof WORKER_FEDERATION_VERSION;
  readonly remote: string;
  readonly exposes: Readonly<Record<string, WorkerFederationExpose>>;
}

/** The canonical renderer-contract reader and compatibility check are required. */
export type AdmitWorkerRendererContract = (value: unknown) => {
  readonly identities: Readonly<Record<string, RendererIdentity>>;
};

export interface WorkerFederationAuthority {
  readonly origin: string;
  readonly renderer: ReturnType<AdmitWorkerRendererContract>;
  readonly worker: WorkerFederationPublication;
}

export interface AdmittedWorkerFederationExpose {
  readonly authority: WorkerFederationAuthority;
  readonly expose: string;
  readonly locale: string;
  readonly coordinate: WorkerFederationExpose;
  readonly path: string;
  readonly identity: Readonly<RendererIdentity>;
  readonly endpoint: string;
  /** Browser styles captured from this exact admitted manifest/expose. */
  readonly styles: readonly string[];
}

export interface WorkerFederationEnvelope {
  readonly schema:
    | 'ultramodern.worker-federation-request'
    | 'ultramodern.worker-federation-response';
  readonly schemaVersion: 1;
  readonly authority: WorkerFederationAuthority;
  readonly expose: string;
  readonly locale: string;
  /** Encoded and decoded by the native renderer; the framework never reads it. */
  readonly payload: unknown;
}

export function workerFederationRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error(`Worker federation ${label} must be a plain record.`);
  return value as Record<string, unknown>;
}

function exactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
) {
  if (
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some(key => !fields.includes(key))
  )
    throw new Error(`Worker federation ${label} has unsupported fields.`);
}

function requiredString(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error(`Worker federation requires ${label}.`);
  return value;
}

export function readWorkerFederationPath(value: unknown): string {
  const path = requiredString(value, 'an endpoint path');
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new Error('Worker federation endpoint path has invalid encoding.');
  }
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[\\?#\s\u0000-\u001f\u007f]/u.test(decoded) ||
    /%[0-9a-f]{2}/iu.test(decoded) ||
    decoded.split('/').some(segment => segment === '.' || segment === '..') ||
    new URL(path, 'https://worker.invalid').pathname !== path
  )
    throw new Error('Worker federation endpoint must be an exact root path.');
  return path;
}

export function readWorkerFederationManifestUrl(value: string): URL {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error(
      'Worker federation manifest requires an HTTP(S) publication URL.',
    );
  return url;
}

export function readWorkerFederationPublication(
  value: unknown,
  identities: Readonly<Record<string, RendererIdentity>>,
): WorkerFederationPublication {
  const record = workerFederationRecord(value, 'publication');
  exactFields(
    record,
    ['schema', 'schemaVersion', 'remote', 'exposes'],
    'publication',
  );
  if (
    record.schema !== WORKER_FEDERATION_SCHEMA ||
    record.schemaVersion !== WORKER_FEDERATION_VERSION
  )
    throw new Error('Unsupported Worker federation publication protocol.');
  const remote = requiredString(record.remote, 'a remote');
  const entries = workerFederationRecord(record.exposes, 'exposes');
  if (Object.keys(entries).length === 0)
    throw new Error('Worker federation publication has no exposes.');
  const paths = new Set<string>();
  const exposes = Object.fromEntries(
    Object.entries(entries).map(([expose, raw]) => {
      if (
        !/^\.\/[A-Za-z0-9_$@.-]+(?:\/[A-Za-z0-9_$@.-]+)*$/u.test(expose) ||
        expose
          .slice(2)
          .split('/')
          .some(segment => segment === '.' || segment === '..')
      )
        throw new Error(`Unsupported Worker federation expose ${expose}.`);
      const coordinate = workerFederationRecord(raw, 'expose coordinate');
      exactFields(
        coordinate,
        ['entryName', 'boundaryId', 'paths', 'native'],
        'expose coordinate',
      );
      const entryName = requiredString(coordinate.entryName, 'an entry name');
      if (!Object.hasOwn(identities, entryName))
        throw new Error(
          `Worker federation expose ${expose} has no built entry.`,
        );
      const identity = identities[entryName];
      identityCacheKey(identity);
      if (identity.entryName !== entryName)
        throw new Error(
          'Worker federation entry identity conflicts with its key.',
        );
      const rawPaths = workerFederationRecord(coordinate.paths, 'locale paths');
      const native = workerFederationRecord(
        coordinate.native,
        'native authority',
      );
      exactFields(
        native,
        ['publisherBuildId', 'runtimeABI'],
        'native authority',
      );
      if (native.runtimeABI !== 1)
        throw new Error('Unsupported native Worker federation runtime ABI.');
      if (Object.keys(rawPaths).length === 0)
        throw new Error('Worker federation expose has no locale endpoints.');
      const locales = Object.keys(rawPaths);
      if (
        new Set(locales.map(locale => locale.toLowerCase())).size !==
          locales.length ||
        (locales.includes('default') && locales.length !== 1)
      )
        throw new Error(
          'Worker federation requires unique locales or only default.',
        );
      const localePaths = Object.fromEntries(
        Object.entries(rawPaths).map(([locale, rawPath]) => {
          if (!/^[a-zA-Z0-9]+(?:[-_][a-zA-Z0-9]+)*$/u.test(locale))
            throw new Error(
              'Worker federation endpoint has an invalid locale.',
            );
          const path = readWorkerFederationPath(rawPath);
          if (paths.has(path))
            throw new Error(
              'Worker federation exposes have conflicting endpoint paths.',
            );
          paths.add(path);
          return [locale, path];
        }),
      );
      return [
        expose,
        Object.freeze({
          entryName,
          boundaryId: requiredString(coordinate.boundaryId, 'a boundary ID'),
          paths: Object.freeze(localePaths),
          native: Object.freeze({
            publisherBuildId: requiredString(
              native.publisherBuildId,
              'a native publisher build ID',
            ),
            runtimeABI: 1 as const,
          }),
        }),
      ];
    }),
  );
  return Object.freeze({
    schema: WORKER_FEDERATION_SCHEMA,
    schemaVersion: WORKER_FEDERATION_VERSION,
    remote,
    exposes: Object.freeze(exposes),
  });
}

/** Stable JSON also prevents non-wire values from silently changing on POST. */
export function workerFederationWireJson(value: unknown): string {
  const encode = (input: unknown): unknown => {
    if (
      input === null ||
      typeof input === 'string' ||
      typeof input === 'boolean'
    )
      return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map(encode);
    const record = workerFederationRecord(input, 'wire value');
    return Object.fromEntries(
      Object.keys(record)
        .toSorted()
        .map(key => [key, encode(record[key])]),
    );
  };
  return JSON.stringify(encode(value));
}

function freezeWireValue<T>(value: T): T {
  const copy = JSON.parse(workerFederationWireJson(value)) as T;
  const freeze = (input: unknown) => {
    if (input && typeof input === 'object') {
      Object.values(input).forEach(freeze);
      Object.freeze(input);
    }
  };
  freeze(copy);
  return copy;
}

/** Preserve the completed MF browser publicPath/asset URL semantics. */
export function readWorkerFederationStyles(options: {
  manifest: unknown;
  manifestUrl: string;
  expose: string;
}): readonly string[] {
  const manifest = workerFederationRecord(options.manifest, 'manifest');
  const metadata = workerFederationRecord(
    manifest.metaData,
    'manifest metadata',
  );
  const manifestUrl = readWorkerFederationManifestUrl(options.manifestUrl);
  if (!Array.isArray(manifest.exposes))
    throw new Error('Worker federation manifest exposes must be an array.');
  const selected = manifest.exposes
    .map(value => workerFederationRecord(value, 'manifest expose'))
    .filter(value => value.path === options.expose);
  if (selected.length !== 1)
    throw new Error(
      'Worker federation styles require one exact manifest expose.',
    );
  if (selected[0].assets === undefined) return Object.freeze([]);
  const assets = workerFederationRecord(selected[0].assets, 'expose assets');
  if (assets.css === undefined) return Object.freeze([]);
  const css = workerFederationRecord(assets.css, 'expose CSS assets');
  const files = ['sync', 'async'].flatMap(kind => {
    const values = css[kind];
    if (values === undefined) return [];
    if (!Array.isArray(values))
      throw new Error('Worker federation CSS assets must be string arrays.');
    return values.map(value => requiredString(value, 'a CSS asset URL'));
  });
  if (files.length === 0) return Object.freeze([]);
  if (metadata.publicPath === undefined || metadata.publicPath === 'auto')
    throw new Error(
      'Worker federation CSS requires a completed static publicPath; auto and getPublicPath cannot resolve styles in a Worker.',
    );
  const publicPath = requiredString(
    metadata.publicPath,
    'a completed public path',
  );
  const explicitScheme = /^[a-z][a-z0-9+.-]*:/iu;
  const isHttpScheme = /^https?:/iu;
  const assertScheme = (value: string) => {
    // Check the authored value before concatenation. Otherwise e.g. data: or
    // javascript: would be silently converted into an ordinary HTTP pathname.
    if (explicitScheme.test(value) && !isHttpScheme.test(value))
      throw new Error(
        'Worker federation styles require an HTTP(S) publication URL.',
      );
  };
  assertScheme(publicPath);
  const publicUrl = new URL(publicPath, manifestUrl);
  if (
    !['http:', 'https:'].includes(publicUrl.protocol) ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.hash
  )
    throw new Error(
      'Worker federation styles require an HTTP(S) publication URL.',
    );
  const styles = files.map(file => {
    assertScheme(file);
    // Match remoteBrowserAssets: a leading slash on a relative asset belongs
    // under publicPath; absolute and protocol-relative CDN assets retain theirs.
    const resolved = /^(?:https?:)?\/\//iu.test(file)
      ? file
      : `${publicPath.replace(/\/$/u, '')}/${file.replace(/^\//u, '')}`;
    const url = new URL(resolved, manifestUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error(
        'Worker federation styles require an HTTP(S) publication URL.',
      );
    // Resource identity must match the browser, including protocol-relative
    // URLs, authored host casing and dot segments. URL parsing validates only.
    return resolved;
  });
  return Object.freeze([...new Set(styles)]);
}

export function admitWorkerFederationExpose(options: {
  manifest: unknown;
  manifestUrl: string;
  remote: string;
  expose: string;
  locale: string;
  admitRendererContract: AdmitWorkerRendererContract;
}): AdmittedWorkerFederationExpose {
  const url = readWorkerFederationManifestUrl(options.manifestUrl);
  const manifest = workerFederationRecord(options.manifest, 'manifest');
  const metadata = workerFederationRecord(
    manifest.metaData,
    'manifest metadata',
  );
  const renderer = freezeWireValue(
    options.admitRendererContract(metadata.ultramodernRenderer),
  );
  const worker = readWorkerFederationPublication(
    metadata[WORKER_FEDERATION_METADATA_KEY],
    renderer.identities,
  );
  if (worker.remote !== options.remote)
    throw new Error('Worker federation publication names another remote.');
  if (!Object.hasOwn(worker.exposes, options.expose))
    throw new Error(
      `Worker federation expose ${options.expose} is not published.`,
    );
  const coordinate = worker.exposes[options.expose];
  if (!Object.hasOwn(coordinate.paths, options.locale))
    throw new Error('Worker federation locale has no published endpoint.');
  const path = coordinate.paths[options.locale];
  const identity = readRendererIdentity(
    renderer.identities[coordinate.entryName],
    renderer.identities[coordinate.entryName],
  );
  return Object.freeze({
    authority: Object.freeze({ origin: url.origin, renderer, worker }),
    expose: options.expose,
    locale: options.locale,
    coordinate,
    path,
    identity,
    endpoint: new URL(path, url.origin).href,
    // Handler coordinates carry no browser assets. Transport captures those
    // separately from its actual completed MF manifest, before renderer hooks.
    styles: Object.freeze([]),
  });
}

export function workerFederationEnvelope(
  kind: 'request' | 'response',
  admitted: AdmittedWorkerFederationExpose,
  payload: unknown,
): WorkerFederationEnvelope {
  return {
    schema: `ultramodern.worker-federation-${kind}`,
    schemaVersion: 1,
    authority: admitted.authority,
    expose: admitted.expose,
    locale: admitted.locale,
    payload,
  };
}

export function readWorkerFederationEnvelope(
  value: unknown,
  kind: 'request' | 'response',
  admitted: AdmittedWorkerFederationExpose,
): unknown {
  const record = workerFederationRecord(value, `${kind} envelope`);
  exactFields(
    record,
    ['schema', 'schemaVersion', 'authority', 'expose', 'locale', 'payload'],
    `${kind} envelope`,
  );
  if (
    record.schema !== `ultramodern.worker-federation-${kind}` ||
    record.schemaVersion !== 1 ||
    record.expose !== admitted.expose ||
    record.locale !== admitted.locale ||
    workerFederationWireJson(record.authority) !==
      workerFederationWireJson(admitted.authority)
  )
    throw new Error(
      `Worker federation ${kind} conflicts with the admitted publication.`,
    );
  return record.payload;
}
