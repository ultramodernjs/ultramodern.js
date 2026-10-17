import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CloudflareWorkerServiceBindingConfig } from '@modern-js/app-tools-extensions/config';
import type { RendererBuildIdentities } from '@modern-js/app-tools-extensions/renderer-build-identity';
import {
  distributedSsrFragmentRoute,
  findWorkspaceRoot,
  normalizeRelativePath,
  REFERENCE_TOPOLOGY_PATH,
  type TopologyApp,
} from '@modern-js/app-tools-extensions/workspace-topology';
import {
  readWorkerFederationManifestUrl,
  readWorkerFederationPath,
} from '@modern-js/renderer-core/worker-federation';
import { localiseTargetPathname } from '@modern-js/runtime-extensions/localised-urls';
import type { NativeI18nConfig } from './native-i18n';
import { readNativeFederationRemotes } from './native-module-federation';
import {
  type NativeWorkerFederationFragment,
  normalizeNativeWorkerFederationExposes,
} from './native-worker-federation';

/** A compiler-resolved remote policy; an empty policy means unlocalized. */
export interface NativeWorkerFederationLocaleConfig {
  readonly i18n?: NativeI18nConfig;
  readonly basePath?: string;
}

export interface NativeWorkerFederationServiceConfig {
  /** Authored import alias, mapped to the pinned topology remote at runtime. */
  readonly alias: string;
  readonly name: string;
  readonly remote: string;
  readonly binding: string;
  readonly manifestUrl: string;
  readonly fragments: readonly {
    readonly expose: string;
    readonly boundaryId: string;
    readonly paths: Readonly<Record<string, string>>;
  }[];
}

export interface NativeWorkerFederationConfig {
  readonly contextProfiles: readonly string[];
  readonly publication?: {
    readonly remote: string;
    readonly exposeEntryNames: Readonly<Record<string, string>>;
    readonly fragments: readonly NativeWorkerFederationFragment[];
  };
  readonly services: readonly NativeWorkerFederationServiceConfig[];
}

const configError = (message: string): Error =>
  new Error(`Native Worker Federation: ${message}`);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value)
    throw configError(`requires ${label}.`);
  return value;
}

/** Materialize the existing locale route with the resolved app's URL policy. */
export function concreteNativeWorkerFederationPaths(
  pathTemplate: string,
  i18n?: NativeI18nConfig,
  basePath = '',
): Readonly<Record<string, string>> {
  const template = requiredString(pathTemplate, 'a fragment path template');
  const canonical = template.startsWith('/{locale}/')
    ? template.slice('/{locale}'.length)
    : template;
  if (/[{}]/u.test(canonical))
    throw configError(
      'fragment coordinates contain an unresolved placeholder.',
    );
  readWorkerFederationPath(canonical);
  const prefix = basePath === '/' ? '' : basePath.replace(/\/$/u, '');
  if (prefix) readWorkerFederationPath(prefix);
  if (!i18n)
    return Object.freeze({
      default: readWorkerFederationPath(`${prefix}${canonical}`),
    });
  if (!i18n.languages.length)
    throw configError('resolved remote i18n has no languages.');
  const paths = Object.fromEntries(
    [...i18n.languages].sort(compare).map(locale => {
      const localized = localiseTargetPathname(
        canonical,
        locale,
        i18n.languages,
        i18n.localisedUrls,
      );
      if (/[{}]/u.test(localized))
        throw configError('localized fragment has an unresolved placeholder.');
      return [locale, readWorkerFederationPath(`${prefix}${localized}`)];
    }),
  );
  return Object.freeze(paths);
}

function selfTopologyRemote(
  appDirectory: string,
  containerName: string,
  fallbackAppId: string,
): string {
  const workspaceRoot = findWorkspaceRoot(appDirectory);
  if (!workspaceRoot) return fallbackAppId;
  const topology: unknown = JSON.parse(
    readFileSync(path.join(workspaceRoot, REFERENCE_TOPOLOGY_PATH), 'utf8'),
  );
  if (
    !record(topology) ||
    topology.schemaVersion !== 1 ||
    (topology.shell !== undefined && !record(topology.shell)) ||
    (topology.shells !== undefined && !Array.isArray(topology.shells)) ||
    (topology.verticals !== undefined && !Array.isArray(topology.verticals))
  )
    throw configError('invalid reference topology.');
  const apps: unknown[] = [
    ...(topology.shell ? [topology.shell] : []),
    ...((topology.shells as unknown[] | undefined) ?? []),
    ...((topology.verticals as unknown[] | undefined) ?? []),
  ];
  const ids = new Set<string>();
  const paths = new Set<string>();
  let selected: TopologyApp | undefined;
  for (const app of apps) {
    if (!record(app)) throw configError('invalid reference topology app.');
    const id = requiredString(app.id, 'a topology app id');
    const declared = requiredString(app.path, `${id} topology app path`);
    const absolute = path.resolve(
      workspaceRoot,
      normalizeRelativePath(declared),
    );
    const relative = path.relative(workspaceRoot, absolute);
    if (
      path.isAbsolute(declared) ||
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      ids.has(id) ||
      paths.has(absolute)
    )
      throw configError(
        'unsafe or duplicate reference topology app identity/path.',
      );
    ids.add(id);
    paths.add(absolute);
    if (absolute === appDirectory) selected = app;
  }
  if (!selected)
    throw configError(
      'the application directory has no reference topology owner.',
    );
  if (selected.moduleFederation?.name !== containerName)
    throw configError(
      'the authored container conflicts with its topology owner.',
    );
  return requiredString(selected.id, 'a topology remote id');
}

/** Resolve existing MF/topology coordinates; do not author a second endpoint API. */
export function resolveNativeWorkerFederationConfig(options: {
  readonly authored: Readonly<Record<string, unknown>>;
  readonly appDirectory: string;
  readonly identities: RendererBuildIdentities;
  readonly services: readonly CloudflareWorkerServiceBindingConfig[];
  readonly i18n?: NativeI18nConfig;
  readonly basePath?: string;
  /** Canonical app-owned source files already admitted by compiler preflight. */
  readonly contextProfiles?: readonly string[];
  /** Loaded through the owning config loader, keyed by topology remote id. */
  readonly remoteI18n?: Readonly<
    Record<string, NativeWorkerFederationLocaleConfig>
  >;
}): NativeWorkerFederationConfig {
  const exposes = normalizeNativeWorkerFederationExposes(
    options.authored.exposes,
    options.appDirectory,
  );
  let publication: NativeWorkerFederationConfig['publication'];
  if (exposes.length) {
    const entries = Object.entries(options.identities.identities);
    if (entries.length !== 1)
      throw configError(
        'Worker exposes require one finalized compiler entry until multi-entry ownership is established.',
      );
    const [entryName, identity] = entries[0];
    if (identity.entryName !== entryName)
      throw configError(
        'finalized entry identity conflicts with its compiler key.',
      );
    const boundaryId = requiredString(
      options.authored.name,
      'the authored container name',
    );
    const remote = selfTopologyRemote(
      path.resolve(options.appDirectory),
      boundaryId,
      requiredString(identity.appId, 'the finalized application id'),
    );
    publication = Object.freeze({
      remote,
      exposeEntryNames: Object.freeze(
        Object.fromEntries(exposes.map(expose => [expose.expose, entryName])),
      ),
      fragments: Object.freeze(
        exposes.map(({ expose }) =>
          Object.freeze({
            remote,
            expose,
            boundaryId,
            paths: concreteNativeWorkerFederationPaths(
              distributedSsrFragmentRoute(expose),
              options.i18n,
              options.basePath,
            ),
          }),
        ),
      ),
    });
  }
  const remotes = Object.entries(
    readNativeFederationRemotes(options.authored),
  ).map(([alias, entry]) => {
    const separator = entry.indexOf('@');
    return {
      alias,
      name: entry.slice(0, separator),
      url: entry.slice(separator + 1),
    };
  });
  const services = new Map<string, NativeWorkerFederationServiceConfig>();
  const bindings = new Set<string>();
  for (const service of options.services) {
    if (!service.fragments?.length) continue;
    const binding = requiredString(service.binding, 'a Worker service binding');
    if (bindings.has(binding))
      throw configError('Worker fragment service bindings must be unique.');
    bindings.add(binding);
    const fragments = new Map<
      string,
      NativeWorkerFederationServiceConfig['fragments'][number]
    >();
    const paths = new Set<string>();
    let owner:
      | { alias: string; name: string; remote: string; manifestUrl: string }
      | undefined;
    for (const fragment of service.fragments) {
      const remote = requiredString(
        fragment.remote,
        'a service fragment remote id',
      );
      const boundaryId = requiredString(
        fragment.boundaryId,
        'a service fragment boundary id',
      );
      const matches = remotes.filter(value => value.name === boundaryId);
      if (matches.length !== 1)
        throw configError(
          'each Worker fragment container must match exactly one authored MF remote.',
        );
      const match = matches[0];
      if (owner && (owner.remote !== remote || owner.name !== boundaryId))
        throw configError(
          'a Worker service binding has conflicting remote owners.',
        );
      owner ??= {
        alias: match.alias,
        name: match.name,
        remote,
        manifestUrl: readWorkerFederationManifestUrl(match.url).href,
      };
      if (!options.remoteI18n || !Object.hasOwn(options.remoteI18n, remote))
        throw configError(
          `remote ${remote} requires its compiler-resolved i18n/base-path policy.`,
        );
      const localeConfig = options.remoteI18n[remote];
      if (
        !localeConfig ||
        typeof localeConfig !== 'object' ||
        Array.isArray(localeConfig)
      )
        throw configError(`remote ${remote} has no resolved locale policy.`);
      const expose = requiredString(
        fragment.expose,
        'a service fragment expose',
      );
      if (fragments.has(expose))
        throw configError(
          'Worker service remote/expose coordinates must be unique.',
        );
      const endpoints = concreteNativeWorkerFederationPaths(
        fragment.path,
        localeConfig.i18n,
        localeConfig.basePath,
      );
      for (const endpoint of Object.values(endpoints)) {
        if (paths.has(endpoint))
          throw configError(
            'Worker service fragments have conflicting endpoint paths.',
          );
        paths.add(endpoint);
      }
      fragments.set(
        expose,
        Object.freeze({ expose, boundaryId, paths: endpoints }),
      );
    }
    if (!owner) continue;
    if (
      services.has(owner.remote) ||
      [...services.values()].some(value => value.alias === owner.alias)
    )
      throw configError('Worker service remote/alias owners must be unique.');
    services.set(
      owner.remote,
      Object.freeze({
        ...owner,
        binding,
        fragments: Object.freeze(
          [...fragments.values()].sort((left, right) =>
            compare(left.expose, right.expose),
          ),
        ),
      }),
    );
  }
  return Object.freeze({
    contextProfiles: Object.freeze([...(options.contextProfiles ?? [])]),
    ...(publication ? { publication } : {}),
    services: Object.freeze(
      [...services.values()].sort((left, right) =>
        compare(left.remote, right.remote),
      ),
    ),
  });
}
