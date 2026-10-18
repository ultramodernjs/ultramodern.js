import fs from 'node:fs';
import path from 'node:path';
import { yaml } from '@modern-js/utils';
import {
  assertReleaseCohortAliasRequest,
  hasCreateReleaseCohort,
  isCreatePackageSourceCheckout,
  readCreateReleaseCohort,
} from '../../ultramodern-release-cohort';
import { ULTRAMODERN_WORKSPACE_POLICY } from '../policy';
import { assertCompilerArchitecture } from './architecture';
import { sameJson } from './assertions';
import {
  assertNativeRendererSourceSurface,
  assertRendererDependencies,
  assertRendererProjection,
  validateApiOnlySourceSurface,
} from './renderer';

export { validateApiOnlySourceSurface } from './renderer';

import type { JsonRecord, WorkspaceValidationContract } from './types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown, label: string): JsonRecord {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as JsonRecord;
}

function entries(value: unknown, label: string): JsonRecord[] {
  assert(Array.isArray(value), `${label} must be an array`);
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

function distinct(values: string[], label: string) {
  assert(
    new Set(values).size === values.length,
    `${label} contains duplicate entries`,
  );
}

function requiredFile(root: string, relative: string, label: string): void {
  assert(
    fs.existsSync(path.join(root, relative)),
    `${label} is missing: ${relative}`,
  );
}

function developmentUrl(
  value: unknown,
  port: number,
  label: string,
  generatedPath?: string,
): URL {
  assert(typeof value === 'string', `${label} must be a URL`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a URL`);
  }
  assert(
    ['http:', 'https:'].includes(parsed.protocol) && parsed.hostname.length > 0,
    `${label} must be an HTTP URL`,
  );
  if (
    generatedPath &&
    parsed.pathname === generatedPath &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  )
    assert(
      Number(parsed.port) === port,
      `${label} must use the app development port ${port}`,
    );
  return parsed;
}

function safePath(root: string, relative: unknown, label: string): string {
  assert(
    typeof relative === 'string' &&
      relative.length > 0 &&
      !path.isAbsolute(relative),
    `${label} must be a relative path`,
  );
  const resolved = path.resolve(root, relative);
  assert(
    resolved.startsWith(`${path.resolve(root)}${path.sep}`),
    `${label} leaves the workspace`,
  );
  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(resolved);
  assert(
    real.startsWith(`${realRoot}${path.sep}`),
    `${label} resolves outside the workspace`,
  );
  return resolved;
}

export function validateApiClientExports(
  root: string,
  appPath: string,
  appId: string,
  exports: JsonRecord | undefined,
): void {
  const clients = ['./api/client', './api/rpc-client']
    .map(key => exports?.[key])
    .filter(value => value !== undefined);
  assert(clients.length > 0, `${appId} must export its API client`);
  for (const client of clients) {
    assert(
      typeof client === 'string' &&
        client.startsWith('./') &&
        !client.split(/[\\/]/u).includes('..') &&
        /\.[cm]?[jt]sx?$/u.test(client),
      `${appId} must export its API client from an app-owned source module`,
    );
    assert(
      fs.existsSync(path.join(root, appPath, client)),
      `${appId} API client is missing: ${client}`,
    );
    const clientFile = safePath(
      path.join(root, appPath),
      client,
      `${appId} API client`,
    );
    assert(
      fs.statSync(clientFile).isFile(),
      `${appId} API client must be a file`,
    );
  }
}

export function validateBackendFederationEntrypoints(
  root: string,
  appPath: string,
  appId: string,
): void {
  for (const relative of [
    'backend-federation.config.ts',
    'api/index.ts',
    'api/effect-api.ts',
  ])
    requiredFile(root, `${appPath}/${relative}`, `${appId} API surface`);
}

/** Keep every native dependency path on the producer's reviewed corrections. */
export function assertWorkspaceDependencyOverrides(
  workspace: JsonRecord,
): void {
  const overrides = record(
    workspace.overrides,
    'Workspace dependency overrides',
  );
  const required = ULTRAMODERN_WORKSPACE_POLICY.pnpm.overrides;
  for (const [selector, specifier] of Object.entries(required)) {
    assert(
      overrides[selector] === specifier,
      `Workspace dependency override ${selector} must be ${specifier}`,
    );
  }
  const managed = Object.keys(required).map(selector => selector.split('@')[0]);
  // Match the final dependency target, allowing > inside semver ranges.
  // A managed parent such as braces@3>foo still targets unrelated foo.
  const managedSelector = new RegExp(
    `(?:^|>)\\s*(?:${managed.map(name => RegExp.escape(name)).join('|')})(?:@(?:[^>]|>(?=\\s*(?:=|\\d|v\\d)))*)?\\s*$`,
    'u',
  );
  for (const selector of Object.keys(overrides)) {
    assert(
      Object.hasOwn(required, selector) || !managedSelector.test(selector),
      `Workspace dependency override ${selector} conflicts with the producer policy`,
    );
  }
}

/** Validate authored workspace relationships without evaluating application config. */
export function validateWorkspace(
  root: string,
  expected: WorkspaceValidationContract,
): void {
  const readJson = (relative: string) =>
    record(
      JSON.parse(fs.readFileSync(safePath(root, relative, relative), 'utf8')),
      relative,
    );
  const topology = readJson('topology/reference-topology.json');
  const ownership = readJson('topology/ownership.json');
  const overlay = readJson('topology/local-overlays/development.json');
  const rootManifest = readJson('package.json');
  const workspace = record(
    yaml.load(fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8')),
    'pnpm-workspace.yaml',
  );
  assertWorkspaceDependencyOverrides(workspace);
  const dependencyCatalogs = {
    catalog: record(workspace.catalog ?? {}, 'workspace catalog'),
    catalogs: record(workspace.catalogs ?? {}, 'workspace catalogs'),
  };
  for (const [label, value] of [
    ['topology', topology],
    ['ownership', ownership],
    ['overlay', overlay],
  ] as const) {
    assert(value.schemaVersion === 1, `${label} schemaVersion must be 1`);
  }
  assert(
    rootManifest.name === expected.packageScope,
    'Root package name disagrees with the workspace scope',
  );

  const shell = record(topology.shell, 'topology.shell');
  const verticals = entries(topology.verticals, 'topology.verticals');
  const shells = [shell, ...entries(topology.shells ?? [], 'topology.shells')];
  const apps = [...shells, ...verticals];
  const shared = entries(
    topology.sharedPackages ?? [],
    'topology.sharedPackages',
  );
  const owners = entries(ownership.owners, 'ownership.owners');
  distinct(
    apps.map(app => app.id),
    'topology app ids',
  );
  distinct(
    [...apps, ...shared].map(app => app.path),
    'topology package paths',
  );
  distinct(
    shared.map(pkg => pkg.id),
    'topology shared package ids',
  );
  distinct(
    owners.map(owner => owner.id),
    'ownership ids',
  );
  assert(
    shared.length === expected.sharedPackages.length,
    'Shared package membership disagrees with canonical inputs',
  );
  for (const expectedShared of expected.sharedPackages) {
    const actual = shared.find(entry => entry.id === expectedShared.id);
    assert(
      actual?.path === expectedShared.path &&
        actual?.package === expectedShared.packageName,
      `${expectedShared.id} shared package identity disagrees with canonical inputs`,
    );
  }
  const expectedApps = new Map(expected.apps.map(app => [app.id, app]));
  assert(
    apps.length === expectedApps.size,
    'Topology app membership disagrees with canonical inputs',
  );
  const verticalIds = new Set(verticals.map(vertical => vertical.id));
  const ids = new Set(apps.map(app => app.id));
  for (const app of apps) {
    const input = expectedApps.get(app.id);
    assert(input, `Unexpected topology app ${app.id}`);
    assert(
      app.kind === input.kind,
      `${app.id} kind disagrees with canonical inputs`,
    );
    // Structural-only contracts do not certify a renderer. Installed workspace
    // validation supplies the profile reconciled from the authored app config.
    const generation =
      input.validatesRendererProjection ||
      input.renderer === 'none' ||
      Object.hasOwn(app, 'rendererProfile')
        ? assertRendererProjection(app, input)
        : undefined;
    const nativeRenderer = generation && generation.renderer !== 'react';
    assert(
      app.path === input.path,
      `${app.id} path disagrees with canonical inputs`,
    );
    assert(
      app.package === input.packageName,
      `${app.id} package identity disagrees with canonical inputs`,
    );
    const manifest = readJson(`${app.path}/package.json`);
    assert(
      manifest.name === app.package,
      `${app.id} package name contradicts topology`,
    );
    assert(
      manifest.modernjs?.appId === app.id,
      `${app.id} modernjs.appId contradicts topology`,
    );
    if (generation || input.renderer === 'none') {
      assertRendererDependencies(
        manifest,
        generation?.renderer ?? 'none',
        generation,
        dependencyCatalogs,
      );
    }
    if (nativeRenderer) {
      assertNativeRendererSourceSurface(root, app, generation, manifest);
      if (!generation.capabilities.federation) {
        assert(
          !Object.hasOwn(overlay.manifests ?? {}, app.id),
          `${app.id} renderer does not support a Module Federation manifest`,
        );
      }
    }
    const owner = owners.find(candidate => candidate.id === app.id);
    assert(
      owner?.path === app.path && owner?.package === manifest.name,
      `${app.id} ownership identity contradicts topology and package.json`,
    );
    const refs = app.moduleFederation?.verticalRefs ?? app.verticalRefs ?? [];
    assert(Array.isArray(refs), `${app.id} verticalRefs must be an array`);
    distinct(refs, `${app.id} verticalRefs`);
    for (const ref of refs)
      assert(
        verticalIds.has(ref),
        `${app.id} references unknown vertical ${ref}`,
      );
    assert(
      JSON.stringify(refs) === JSON.stringify(input.verticalRefs),
      `${app.id} verticalRefs disagree with canonical inputs`,
    );
    const nativeFederationConfigured =
      nativeRenderer &&
      (Boolean(app.moduleFederation) ||
        refs.length > 0 ||
        Object.keys(input.exposes).length > 0 ||
        Object.hasOwn(overlay.manifests ?? {}, app.id));
    if (nativeFederationConfigured && generation.capabilities.federation) {
      requiredFile(
        root,
        `${app.path}/module-federation.config.ts`,
        `${app.id} Module Federation config`,
      );
    }
    const port = overlay.ports?.[app.id];
    assert(
      Number.isInteger(port) && port > 0 && port < 65536,
      `${app.id} has no development port`,
    );
    if (
      nativeRenderer &&
      generation.capabilities.federation &&
      app.kind === 'shell' &&
      Object.hasOwn(overlay.manifests ?? {}, app.id)
    ) {
      developmentUrl(
        overlay.manifests[app.id],
        port,
        `${app.id} MF manifest URL`,
        '/mf-manifest.json',
      );
    }
    requiredFile(
      root,
      `${app.path}/modern.config.ts`,
      `${app.id} Modern.js config`,
    );
    if (input.emitsUi && !nativeRenderer) {
      requiredFile(
        root,
        `${app.path}/src/modern.runtime.ts`,
        `${app.id} runtime`,
      );
    }
    requiredFile(
      root,
      `${app.path}/shared/ultramodern-build.json`,
      `${app.id} build stamp`,
    );
    if (!nativeRenderer || generation.capabilities.workers) {
      const cloudflare = record(app.cloudflare, `${app.id} cloudflare`);
      for (const field of ['workerName', 'publicUrlEnv'])
        assert(
          typeof cloudflare[field] === 'string' && cloudflare[field].length > 0,
          `${app.id} cloudflare.${field} is required`,
        );
      const cloudflareRoutes = record(
        cloudflare.routes,
        `${app.id} cloudflare.routes`,
      );
      record(cloudflare.security, `${app.id} cloudflare.security`);
      record(cloudflare.qualityGates, `${app.id} cloudflare.qualityGates`);
      if (app.kind === 'shell')
        assert(
          typeof cloudflareRoutes.ssr === 'string' &&
            cloudflareRoutes.ssr.startsWith('/'),
          `${app.id} cloudflare SSR route is required`,
        );
      if (input.emitsApi) {
        const routeKey = app.api?.protocol === 'rpc' ? 'rpc' : 'apiReadiness';
        assert(
          typeof cloudflareRoutes[routeKey] === 'string' &&
            cloudflareRoutes[routeKey].startsWith('/'),
          `${app.id} cloudflare API ${routeKey} route is required`,
        );
      }
    }
    if (
      input.emitsUi &&
      app.kind !== 'shell' &&
      (!nativeRenderer ||
        (generation.capabilities.federation && nativeFederationConfigured))
    ) {
      assert(
        typeof overlay.manifests?.[app.id] === 'string',
        `${app.id} has no development MF manifest URL`,
      );
      developmentUrl(
        overlay.manifests[app.id],
        port,
        `${app.id} MF manifest URL`,
        '/mf-manifest.json',
      );
      if (!nativeRenderer) {
        requiredFile(
          root,
          `${app.path}/module-federation.config.ts`,
          `${app.id} Module Federation config`,
        );
      }
      for (const [expose, relative] of Object.entries(input.exposes)) {
        assert(
          typeof relative === 'string' && relative.startsWith('./src/'),
          `${app.id} ${expose} Module Federation expose must target a source file`,
        );
        assert(
          fs.existsSync(path.join(root, app.path, relative)),
          `${app.id} ${expose} Module Federation expose source ${relative} is missing`,
        );
      }
    }
    if (input.emitsApi)
      assert(
        typeof overlay.apis?.[app.id] === 'string',
        `${app.id} has no development API URL`,
      );
    if (input.emitsApi && app.kind === 'vertical') {
      const apiUrl = developmentUrl(
        overlay.apis[app.id],
        port,
        `${app.id} API URL`,
      );
      const serverExecution = record(
        overlay.serverExecution?.[app.id],
        `${app.id} server execution`,
      );
      assert(
        serverExecution.apiBaseUrl === apiUrl.href.replace(/\/$/, ''),
        `${app.id} server execution API URL disagrees with overlay`,
      );
      const backend = record(
        app.backendFederation,
        `${app.id} backendFederation`,
      );
      const node = record(
        backend.executionSurfaces?.node,
        `${app.id} backendFederation node`,
      );
      developmentUrl(
        node.manifestUrl,
        port,
        `${app.id} backend manifest URL`,
        '/backend-mf-manifest.json',
      );
      developmentUrl(
        node.containerEntry,
        port,
        `${app.id} backend container URL`,
        '/backendRemoteEntry.cjs',
      );
      validateBackendFederationEntrypoints(root, app.path, app.id);
      const apiExport = manifest.exports?.['./api'];
      assert(
        typeof apiExport === 'string' && apiExport.startsWith('./shared/'),
        `${app.id} must export its shared API contract`,
      );
      assert(
        fs.existsSync(path.join(root, app.path, apiExport)),
        `${app.id} shared API contract ${apiExport} is missing`,
      );
      validateApiClientExports(root, app.path, app.id, manifest.exports);
      const backendDelivery = record(
        backend.deliveryUnit,
        `${app.id} backendFederation.deliveryUnit`,
      );
      assert(
        backendDelivery.unitId === app.deliveryUnit?.unitId &&
          backendDelivery.packageName === manifest.name &&
          backendDelivery.buildMarker === app.deliveryUnit?.buildMarker,
        `${app.id} backend federation delivery identity contradicts topology`,
      );
      assert(
        backend.versionBoundary?.identityRoot === 'deliveryUnit' &&
          backend.versionBoundary?.packageName === manifest.name,
        `${app.id} backend federation version boundary contradicts topology`,
      );
      assert(
        node.expected?.unitId === app.deliveryUnit?.unitId &&
          node.expected?.buildMarker === app.deliveryUnit?.buildMarker,
        `${app.id} backend federation node identity contradicts topology`,
      );
      assert(
        serverExecution.deliveryUnit?.unitId === app.deliveryUnit?.unitId &&
          serverExecution.deliveryUnit?.buildMarker ===
            app.deliveryUnit?.buildMarker,
        `${app.id} server execution identity contradicts topology`,
      );
      assert(
        serverExecution.node?.manifestUrl === node.manifestUrl &&
          serverExecution.node?.containerEntry === node.containerEntry,
        `${app.id} server execution node endpoints contradict topology`,
      );
      if (Object.hasOwn(serverExecution.node ?? {}, 'expected'))
        assert(
          serverExecution.node.expected?.unitId === app.deliveryUnit?.unitId &&
            serverExecution.node.expected?.buildMarker ===
              app.deliveryUnit?.buildMarker,
          `${app.id} server execution node identity contradicts topology`,
        );
    }
    if (app.kind === 'vertical' && !input.emitsUi) {
      validateApiOnlySourceSurface(root, app);
    }
    if (app.kind === 'vertical' && !input.emitsApi) {
      assert(
        !Object.hasOwn(overlay.apis ?? {}, app.id) &&
          !Object.hasOwn(overlay.serverExecution ?? {}, app.id),
        `${app.id} UI-only vertical must not declare API endpoints`,
      );
      assert(
        !app.backendFederation && !app.api,
        `${app.id} UI-only vertical must not declare a backend API`,
      );
      for (const relative of [
        'shared/api.ts',
        'shared/rpc.ts',
        'backend-federation.config.ts',
        'api/index.ts',
        'api/effect-api.ts',
        'api/backend-federation.ts',
        `src/api/${app.id}-client.ts`,
        `src/api/${app.id}-rpc-client.ts`,
      ])
        assert(
          !fs.existsSync(path.join(root, app.path, relative)),
          `Unexpected ${app.path}/${relative} for a ui-only unit`,
        );
    }
    const delivery = record(app.deliveryUnit, `${app.id} deliveryUnit`);
    assert(
      typeof delivery.unitId === 'string' &&
        delivery.unitId.length > 0 &&
        delivery.packageName === manifest.name,
      `${app.id} delivery unit identity contradicts package.json`,
    );
    const build = readJson(`${app.path}/shared/ultramodern-build.json`);
    assert(
      build.deliveryUnit?.unitId === delivery.unitId &&
        build.deliveryUnit?.packageName === manifest.name &&
        build.deliveryUnit?.buildMarker === delivery.buildMarker,
      `${app.id} build identity contradicts topology`,
    );
    if (generation) {
      assert(
        sameJson(build.surfaces?.ui?.rendererProfile, app.rendererProfile) &&
          sameJson(build.surfaces?.ui?.routerBindings, app.routerBindings) &&
          sameJson(build.surfaces?.ui?.rendererIdentity, app.rendererIdentity),
        `${app.id} build renderer profile/identity contradicts topology`,
      );
    } else if (input.renderer === 'none') {
      assert(
        !build.surfaces?.ui,
        `${app.id} headless build must omit its UI surface`,
      );
    }
  }
  for (const pkg of shared) {
    const manifest = readJson(`${pkg.path}/package.json`);
    assert(
      manifest.name === pkg.package,
      `${pkg.id} shared package identity contradicts topology`,
    );
    assert(
      owners.some(
        owner =>
          owner.id === pkg.id &&
          owner.path === pkg.path &&
          owner.package === manifest.name,
      ),
      `${pkg.id} ownership identity contradicts package.json`,
    );
  }
  for (const owner of owners)
    assert(
      ids.has(owner.id) || shared.some(pkg => pkg.id === owner.id),
      `Ownership names unknown package ${owner.id}`,
    );

  const catalogs = record(workspace.catalogs ?? {}, 'workspace catalogs');
  const catalog = record(catalogs.ultramodern ?? {}, 'ultramodern catalog');
  // Only catalog requests resolve through the release cohort; a workspace
  // generated with the workspace package source links every framework package
  // with workspace:* and needs no cohort.
  const producer = hasCreateReleaseCohort()
    ? readCreateReleaseCohort()
    : undefined;
  if (producer) {
    const policies = [
      [
        'workspace overrides',
        record(workspace.overrides, 'workspace overrides'),
      ],
      ['workspace catalog', dependencyCatalogs.catalog],
      ...Object.entries(catalogs).map(
        ([name, values]) =>
          [
            `workspace catalog ${name}`,
            record(values, `workspace catalog ${name}`),
          ] as const,
      ),
    ] as const;
    for (const [label, values] of policies)
      for (const [name, request] of Object.entries(values))
        assertReleaseCohortAliasRequest(producer, request, `${label} ${name}`);
  }
  const sourceCheckout = isCreatePackageSourceCheckout();
  const cohort = new Map(
    producer?.packages.map(pkg => [pkg.sourceName, pkg]) ?? [],
  );
  const members = [...apps, ...shared].map(app => `${app.path}/package.json`);
  members.push('package.json');
  const selectedRenderers = new Set(
    expected.apps
      .filter(app => app.emitsUi)
      .map(app => app.renderer)
      .filter(renderer => renderer !== undefined),
  );
  const uniformRenderer =
    selectedRenderers.size === 1 ? [...selectedRenderers][0] : undefined;
  for (const member of members) {
    const manifest = readJson(member);
    if (uniformRenderer)
      assertRendererDependencies(
        manifest,
        uniformRenderer,
        undefined,
        dependencyCatalogs,
      );
    for (const group of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const [name, request] of Object.entries(
        record(manifest[group] ?? {}, `${member} ${group}`),
      )) {
        if (producer) {
          assertReleaseCohortAliasRequest(
            producer,
            request,
            `${member} ${name}`,
          );
          if (typeof request === 'string' && request.startsWith('catalog:')) {
            const catalogName = request.slice('catalog:'.length);
            const values = catalogName
              ? record(catalogs[catalogName] ?? {}, `catalog ${catalogName}`)
              : dependencyCatalogs.catalog;
            assertReleaseCohortAliasRequest(
              producer,
              values[name],
              `${member} ${name} catalog request`,
            );
          }
        }
        if (!(expected.modernPackages as string[]).includes(name)) continue;
        assert(
          typeof request === 'string',
          `${member} ${name} dependency request must be a string`,
        );
        const catalogRequest =
          request === 'catalog:ultramodern' ? catalog[name] : undefined;
        const effective = catalogRequest ?? request;
        assert(
          typeof effective === 'string' && effective.length > 0,
          `${member} ${name} has no catalog entry`,
        );
        if (request !== 'workspace:*')
          assert(
            request === 'catalog:ultramodern',
            `${member} ${name} must use the ultramodern catalog`,
          );
        assert(
          producer || sourceCheckout || request === 'workspace:*',
          `${member} ${name} uses the ultramodern catalog, but the installed ultramodern-create package is missing release-cohort.json. Install a published ultramodern-create release, or generate with --ultramodern-package-source workspace.`,
        );
        if (producer && request !== 'workspace:*') {
          const release = cohort.get(name);
          assert(
            release,
            `${member} ${name} is absent from the installed release cohort`,
          );
          assert(
            effective === `npm:${release.targetName}@${release.version}`,
            `${member} ${name} catalog request disagrees with the installed release cohort`,
          );
        }
        let memberDir = path.dirname(path.join(root, member));
        let installedPath: string | undefined;
        while (memberDir.startsWith(path.resolve(root))) {
          const candidate = path.join(
            memberDir,
            'node_modules',
            name,
            'package.json',
          );
          if (fs.existsSync(candidate)) {
            installedPath = candidate;
            break;
          }
          if (memberDir === path.resolve(root)) break;
          memberDir = path.dirname(memberDir);
        }
        if (
          request !== 'workspace:*' &&
          fs.existsSync(path.join(root, 'node_modules'))
        ) {
          assert(installedPath, `${member} ${name} is not installed`);
        }
        if (installedPath && request !== 'workspace:*') {
          const installed = record(
            JSON.parse(fs.readFileSync(installedPath, 'utf8')),
            installedPath,
          );
          const aliasMatch = /^npm:(@[^/]+\/[^@]+)@(.+)$/u.exec(effective);
          assert(
            aliasMatch,
            `${member} ${name} catalog entry must name an installed package and version`,
          );
          assert(
            installed.name === aliasMatch[1] &&
              installed.version === aliasMatch[2],
            `${member} ${name} installed package identity/version disagrees with the catalog`,
          );
          if (producer)
            assert(
              installed.version === producer.release.version,
              `${member} ${name} installed version disagrees with the release cohort`,
            );
        }
      }
    }
  }
  assertCompilerArchitecture(root, expected);
  console.log('UltraModern workspace validated');
}
