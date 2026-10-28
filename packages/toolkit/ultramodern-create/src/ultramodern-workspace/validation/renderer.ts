import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  validateRendererIdentity,
  validateRendererProfile,
  validateRendererRouterBindings,
} from '@modern-js/backend-federation-contracts';
import { specifierRenderer } from '@modern-js/ultramodern-app-tools';
import semver from '@modern-js/utils/semver';
import {
  getRendererGenerationProfile,
  isApplicationRenderer,
} from '../renderer-profile';
import type { RendererGenerationProfile, WorkspaceRenderer } from '../types';
import {
  MODULE_FEDERATION_NODE_VERSION,
  MODULE_FEDERATION_VERSION,
  ULTRAMODERN_PACKAGE_PINS,
} from '../versions';
import { assert, sameJson } from './assertions';
import { readRendererFrameworkPackageEvidence } from './renderer-framework-evidence';
import type { JsonRecord, WorkspaceValidationContract } from './types';

type ExpectedApp = WorkspaceValidationContract['apps'][number];

type RendererDependencyCatalogs = {
  catalog?: Readonly<Record<string, string>>;
  catalogs?: Readonly<Record<string, Readonly<Record<string, string>>>>;
};

const NATIVE_FEDERATION_PINS: Readonly<Record<string, string>> = {
  '@module-federation/enhanced': MODULE_FEDERATION_VERSION,
  '@module-federation/node': MODULE_FEDERATION_NODE_VERSION,
  '@module-federation/runtime':
    ULTRAMODERN_PACKAGE_PINS.appDependencies['@module-federation/runtime'],
};

function assertRendererFrameworkDependencyRequest(
  label: string,
  name: string,
  request: string,
  expected?: string,
): void {
  const evidence = readRendererFrameworkPackageEvidence(name);
  if (expected !== undefined) {
    assert(
      evidence.version === expected,
      `${label} renderer profile version ${expected} disagrees with producer cohort evidence ${evidence.version}`,
    );
  }
  const alias = parseNpmAlias(request);
  assert(
    (request === 'workspace:*' && evidence.kind === 'source-checkout') ||
      (request === evidence.version && evidence.targetName === name) ||
      (alias?.name === evidence.targetName && alias.range === evidence.version),
    `${label} declared renderer ABI ${request} disagrees with the authenticated producer package ${evidence.targetName}@${evidence.version}`,
  );
}

function assertNativeRendererCapabilityDependency(
  label: string,
  name: string,
  request: string | undefined,
  generation: RendererGenerationProfile,
): void {
  const alias = request === undefined ? undefined : parseNpmAlias(request);
  for (const target of [name, ...(alias ? [alias.name] : [])]) {
    assert(
      (!target.startsWith('@module-federation/') ||
        (generation.capabilities.federation &&
          Object.hasOwn(NATIVE_FEDERATION_PINS, target))) &&
        (!target.startsWith('@bleedingdev/mf-') ||
          (generation.capabilities.federation &&
            target === '@bleedingdev/mf-runtime' &&
            name === '@module-federation/runtime' &&
            request === NATIVE_FEDERATION_PINS[name])) &&
        (target !== '@modern-js/federation-runtime' ||
          generation.capabilities.federation) &&
        (target !== 'wrangler' || generation.capabilities.workers),
      `${label} claims an unsupported ${generation.renderer} capability: ${target}`,
    );
  }
  const pinName = Object.hasOwn(NATIVE_FEDERATION_PINS, name)
    ? name
    : alias && Object.hasOwn(NATIVE_FEDERATION_PINS, alias.name)
      ? alias.name
      : undefined;
  const expected =
    pinName === undefined ? undefined : NATIVE_FEDERATION_PINS[pinName];
  if (expected !== undefined) {
    assert(
      request === expected ||
        (semver.valid(expected) !== null &&
          alias?.name === name &&
          alias.range === expected),
      `${label} declared federation ABI ${request} disagrees with the selected pin ${expected}`,
    );
  }
  if (
    name === '@modern-js/federation-runtime' ||
    alias?.name === '@modern-js/federation-runtime'
  ) {
    assert(
      name === '@modern-js/federation-runtime' && typeof request === 'string',
      `${label} must declare the canonical federation runtime dependency`,
    );
    assertRendererFrameworkDependencyRequest(label, name, request);
  }
}

function resolveDependencyRequest(
  name: string,
  request: string,
  options: RendererDependencyCatalogs,
): string {
  if (!request.startsWith('catalog:')) return request;
  const catalogName = request.slice('catalog:'.length);
  const resolved =
    (catalogName === ''
      ? options.catalog?.[name]
      : options.catalogs?.[catalogName]?.[name]) ?? request;
  assert(
    typeof resolved === 'string',
    `${name} catalog dependency must be a string request`,
  );
  return resolved;
}

export function parseNpmAlias(
  value: string,
): { name: string; range: string | undefined } | undefined {
  if (!value.startsWith('npm:')) return undefined;
  const target = value.slice('npm:'.length);
  const separator = target.startsWith('@')
    ? target.indexOf('@', 1)
    : target.indexOf('@');
  if (separator === -1) return { name: target, range: undefined };
  return {
    name: target.slice(0, separator),
    range: target.slice(separator + 1),
  };
}

/**
 * Runtime imports and direct dependencies must agree with the selected
 * adapter. React's composed stack spans more packages than its route
 * ownership; native renderers use their registered ownership.
 */
export function isForeignRendererPackage(
  name: string,
  renderer: WorkspaceRenderer,
): boolean {
  const react =
    name === 'react' ||
    name.startsWith('react/') ||
    name === 'react-dom' ||
    name.startsWith('react-dom/') ||
    name === 'react-router' ||
    name.startsWith('react-router/') ||
    name === 'react-router-dom' ||
    name.startsWith('react-router-dom/') ||
    (name === '@types/react' && renderer !== 'octane') ||
    name === '@types/react-dom' ||
    name === '@tanstack/redact' ||
    name.startsWith('@tanstack/redact/') ||
    name === 'rsbuild-redact-plugin' ||
    name.startsWith('rsbuild-redact-plugin/') ||
    name === '@tanstack/react-router' ||
    name.startsWith('@tanstack/react-router/') ||
    name === '@modern-js/renderer-react' ||
    name.startsWith('@modern-js/renderer-react/') ||
    name === 'react-server-dom-webpack' ||
    name.startsWith('react-server-dom-webpack/') ||
    name === 'react-server-dom-rspack' ||
    name.startsWith('react-server-dom-rspack/') ||
    name === 'react-server-dom-turbopack' ||
    name.startsWith('react-server-dom-turbopack/') ||
    name === 'react-refresh' ||
    name.startsWith('react-refresh/') ||
    name === '@rsbuild/plugin-react' ||
    name.startsWith('@rsbuild/plugin-react/') ||
    name === '@rspack/plugin-react-refresh' ||
    name.startsWith('@rspack/plugin-react-refresh/') ||
    name === '@babel/preset-react' ||
    name.startsWith('@babel/plugin-transform-react-jsx') ||
    name === '@modern-js/runtime' ||
    name.startsWith('@modern-js/runtime/') ||
    name === '@modern-js/runtime-renderer-extensions' ||
    name.startsWith('@modern-js/runtime-renderer-extensions/') ||
    name === '@modern-js/plugin-tanstack' ||
    name.startsWith('@modern-js/plugin-tanstack/') ||
    name === '@modern-js/plugin-i18n' ||
    name.startsWith('@modern-js/plugin-i18n/') ||
    name === '@modern-js/i18n-integration' ||
    name.startsWith('@modern-js/i18n-integration/') ||
    name.startsWith('@modern-js/i18n-runtime-extensions/') ||
    name === '@modern-js/plugin-runtime' ||
    name.startsWith('@modern-js/plugin-runtime/');
  if (react) return renderer !== 'react';
  const owner = specifierRenderer(name);
  return owner !== undefined && owner !== 'react' && owner !== renderer;
}

const RENDERER_PROJECTION_FIELDS = [
  'renderer',
  'rendererIdentity',
  'rendererIdentities',
  'rendererProfile',
  'routerBindings',
  'rendererCapabilities',
] as const;

/** Validate a projection against the selected tuple, never derive selection from it. */
export function assertRendererProjection(
  app: JsonRecord,
  expected?: ExpectedApp,
  pendingUiArtifact = false,
): RendererGenerationProfile | undefined {
  const label = String(app.id ?? 'application');
  const renderer = expected?.renderer ?? app.renderer;
  if (renderer === 'none') {
    assert(app.renderer === 'none', `${label} headless renderer must be none`);
    for (const field of [
      'rendererIdentity',
      'rendererIdentities',
      'rendererProfile',
      'routerBindings',
      'rendererCapabilities',
    ]) {
      assert(
        !Object.hasOwn(app, field),
        `${label} headless unit must omit ${field}`,
      );
    }
    assert(!expected?.emitsUi, `${label} headless unit cannot emit UI`);
    assert(
      !app.moduleFederation &&
        !app.moduleFederationName &&
        !app.mfName &&
        Object.keys(app.exposes ?? {}).length === 0 &&
        (app.verticalRefs?.length ?? 0) === 0 &&
        !Object.hasOwn(app.backendFederation?.versionBoundary ?? {}, 'ui'),
      `${label} headless unit must omit UI federation declarations`,
    );
    return undefined;
  }
  // A React workspace authored before renderer selection persists no renderer
  // projection. Its React selection is still reconciled from modern.config
  // and its dependencies are checked against the React profile; there is
  // simply no stored projection to compare.
  if (
    expected?.renderer === 'react' &&
    RENDERER_PROJECTION_FIELDS.every(field => !Object.hasOwn(app, field))
  )
    return getRendererGenerationProfile('react');
  assert(isApplicationRenderer(renderer), `${label} has an invalid renderer`);
  assert(
    app.renderer === renderer,
    `${label} renderer disagrees with modern.config`,
  );
  assert(
    expected?.emitsUi !== false,
    `${label} headless unit cannot carry a UI renderer`,
  );
  const generation = getRendererGenerationProfile(renderer);
  assert(
    validateRendererProfile(app.rendererProfile).ok &&
      sameJson(app.rendererProfile, generation.profile),
    `${label} renderer profile disagrees with the selected compiler/runtime/router tuple`,
  );
  if (expected?.rendererProfile) {
    assert(
      sameJson(app.rendererProfile, expected.rendererProfile),
      `${label} renderer profile disagrees with modern.config`,
    );
  }
  const identity = app.rendererIdentity;
  assert(
    validateRendererIdentity(identity).ok &&
      identity.renderer === renderer &&
      identity.appId === app.id &&
      identity.protocolVersion === generation.profile.protocolVersion &&
      identity.buildId === app.deliveryUnit?.buildMarker,
    `${label} renderer identity disagrees with its delivery build`,
  );
  if (expected?.rendererIdentity) {
    assert(
      sameJson(identity, expected.rendererIdentity),
      `${label} renderer identity disagrees with modern.config`,
    );
  }
  const identities = app.rendererIdentities;
  assert(
    identities !== null &&
      typeof identities === 'object' &&
      !Array.isArray(identities) &&
      Object.keys(identities).length > 0,
    `${label} requires renderer identities for every configured entry`,
  );
  assert(
    Object.hasOwn(identities, identity.entryName),
    `${label} renderer entry identity is missing`,
  );
  for (const [entryName, value] of Object.entries(identities)) {
    const entry = value as JsonRecord;
    assert(
      validateRendererIdentity(entry).ok &&
        entry.entryName === entryName &&
        entry.renderer === renderer &&
        entry.appId === app.id &&
        entry.protocolVersion === generation.profile.protocolVersion,
      `${label} renderer identity for entry ${entryName} is invalid`,
    );
  }
  if (expected?.rendererIdentities) {
    assert(
      sameJson(identities, expected.rendererIdentities),
      `${label} renderer entry identities disagree with modern.config`,
    );
  }
  assert(
    pendingUiArtifact || app.routerBindings !== undefined,
    `${label} requires router bindings captured from modern.config`,
  );
  if (app.routerBindings !== undefined) {
    assert(
      validateRendererRouterBindings(
        app.routerBindings,
        Object.keys(identities),
        'routerBindings',
        generation.routerFrameworks,
      ).ok,
      `${label} router bindings disagree with its configured entries`,
    );
  }
  if (expected) {
    assert(
      sameJson(app.routerBindings, expected.routerBindings),
      `${label} router bindings disagree with modern.config`,
    );
  }
  assert(
    sameJson(app.rendererCapabilities, generation.capabilities),
    `${label} renderer capabilities disagree with the admitted profile`,
  );
  if (!generation.capabilities.federation) {
    assert(
      !app.moduleFederation &&
        !app.moduleFederationName &&
        !app.mfName &&
        (app.verticalRefs?.length ?? 0) === 0 &&
        Object.keys(app.exposes ?? {}).length === 0,
      `${label} renderer does not support Module Federation`,
    );
  }
  if (!generation.capabilities.workers) {
    assert(!app.cloudflare, `${label} renderer does not support workers`);
  }
  return generation;
}

export function assertRendererDependencies(
  manifest: JsonRecord,
  renderer: WorkspaceRenderer,
  generation?: RendererGenerationProfile,
  options: RendererDependencyCatalogs = {},
): void {
  const nativeGeneration =
    renderer !== 'react' && renderer !== 'none'
      ? (generation ?? getRendererGenerationProfile(renderer))
      : undefined;
  const groups = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ];
  for (const group of groups) {
    for (const [name, request] of Object.entries(manifest[group] ?? {})) {
      const resolved =
        typeof request === 'string'
          ? resolveDependencyRequest(name, request, options)
          : undefined;
      const alias =
        resolved === undefined ? undefined : parseNpmAlias(resolved);
      assert(
        !isForeignRendererPackage(name, renderer) &&
          (!alias || !isForeignRendererPackage(alias.name, renderer)),
        `${manifest.name} ${group} contains foreign renderer package ${name}`,
      );
      if (nativeGeneration) {
        assertNativeRendererCapabilityDependency(
          `${manifest.name} ${group}.${name}`,
          name,
          resolved,
          nativeGeneration,
        );
      }
    }
  }
  if (!generation) return;
  assertAuthoredRendererDependencyPins(manifest, generation, options);
  if (renderer === 'react') return;
  for (const [group, pins] of [
    ['dependencies', generation.dependencies],
    ['devDependencies', generation.devDependencies],
  ] as const) {
    for (const [name, version] of Object.entries(pins)) {
      const request = manifest[group]?.[name];
      const resolved =
        typeof request === 'string'
          ? resolveDependencyRequest(name, request, options)
          : undefined;
      const alias =
        resolved === undefined ? undefined : parseNpmAlias(resolved);
      assert(
        resolved === version ||
          (semver.valid(version) !== null &&
            alias?.name === name &&
            alias.range === version),
        `${manifest.name} ${group}.${name} must use the selected renderer pin ${version}`,
      );
    }
  }
  for (const name of generation.frameworkDependencies) {
    assert(
      typeof manifest.dependencies?.[name] === 'string',
      `${manifest.name} requires the selected renderer adapter ${name}`,
    );
  }
}

/** Check authored ABI declarations before config-derived metadata is staged. */
export function assertAuthoredRendererDependencyPins(
  manifest: JsonRecord,
  generation: RendererGenerationProfile,
  options: RendererDependencyCatalogs = {},
): void {
  const profile = generation.profile;
  const pins: Record<string, string> = {
    [profile.compiler.name]: profile.compiler.version,
    [profile.hydration.name]: profile.hydration.version,
    [profile.router.name]: profile.router.version,
    [profile.router.coreName]: profile.router.coreVersion,
  };
  // Install requests may identify accepted archives while the profile keeps
  // their contained package ABI versions.
  for (const [name, version] of Object.entries({
    ...generation.dependencies,
    ...generation.devDependencies,
  })) {
    if (
      name === profile.compiler.name ||
      name === profile.router.coreName ||
      isForeignRendererPackage(name, 'none')
    )
      pins[name] = version;
  }
  for (const group of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    for (const [name, request] of Object.entries(manifest[group] ?? {})) {
      assert(
        typeof request === 'string',
        `${manifest.name} ${group}.${name} must be a dependency request`,
      );
      const resolved = resolveDependencyRequest(name, request, options);
      const alias = parseNpmAlias(resolved);
      assert(
        !isForeignRendererPackage(name, generation.renderer) &&
          (!alias ||
            !isForeignRendererPackage(alias.name, generation.renderer)),
        `${manifest.name} ${group}.${name} conflicts with the selected ${generation.renderer} renderer`,
      );
      if (generation.renderer !== 'react') {
        assertNativeRendererCapabilityDependency(
          `${manifest.name} ${group}.${name}`,
          name,
          resolved,
          generation,
        );
      }
      const expected = pins[name] ?? (alias ? pins[alias.name] : undefined);
      if (expected === undefined) continue;
      if (name.startsWith('@modern-js/')) {
        assertRendererFrameworkDependencyRequest(
          `${manifest.name} ${group}.${name}`,
          name,
          resolved,
          expected,
        );
        continue;
      }
      if (generation.renderer === 'react') {
        assertReactFrameworkCompatibleRequest(
          `${manifest.name} ${group}.${name}`,
          name,
          request,
          alias ? (alias.name === name ? alias.range : undefined) : resolved,
        );
        continue;
      }
      assert(
        resolved === expected ||
          (semver.valid(expected) !== null &&
            alias?.range === expected &&
            alias.name === name),
        `${manifest.name} ${group}.${name} declared renderer ABI ${request} disagrees with the selected pin ${expected}`,
      );
    }
  }
}

/**
 * Framework owners of the composed React renderer. The application owns its
 * React and router installs; these packages declare which installs they admit.
 */
const REACT_FRAMEWORK_OWNERS = [
  '@modern-js/runtime',
  '@modern-js/plugin-tanstack',
] as const;

let reactFrameworkCompatibleRanges:
  | ReadonlyMap<string, readonly string[]>
  | undefined;

/**
 * Compatible ranges the installed React framework owners declare: their peer
 * ranges, and the patch line of an exact framework dependency the application
 * shares as a singleton (for example `@tanstack/react-router` 1.170.x through
 * `@modern-js/plugin-tanstack`).
 */
export function readReactFrameworkCompatibleRanges(): ReadonlyMap<
  string,
  readonly string[]
> {
  if (reactFrameworkCompatibleRanges) return reactFrameworkCompatibleRanges;
  const require = createRequire(import.meta.url);
  const ranges = new Map<string, string[]>();
  const declare = (name: string, range: string) => {
    ranges.set(name, [...(ranges.get(name) ?? []), range]);
  };
  for (const owner of REACT_FRAMEWORK_OWNERS) {
    const manifest = JSON.parse(
      fs.readFileSync(require.resolve(`${owner}/package.json`), 'utf8'),
    ) as JsonRecord;
    for (const [name, request] of Object.entries(
      manifest.peerDependencies ?? {},
    )) {
      if (typeof request === 'string' && semver.validRange(request))
        declare(name, request);
    }
    for (const [name, request] of Object.entries(manifest.dependencies ?? {})) {
      const version =
        typeof request === 'string' ? semver.valid(request) : null;
      if (version)
        declare(name, `~${semver.major(version)}.${semver.minor(version)}.0`);
    }
  }
  reactFrameworkCompatibleRanges = ranges;
  return ranges;
}

function assertReactFrameworkCompatibleRequest(
  label: string,
  name: string,
  request: string,
  range: string | undefined,
): void {
  const declared = readReactFrameworkCompatibleRanges().get(name) ?? [];
  assert(
    range !== undefined && semver.validRange(range) !== null,
    `${label} declared renderer ABI ${request} must be a version range of ${name}`,
  );
  for (const compatible of declared) {
    assert(
      semver.valid(range)
        ? semver.satisfies(range, compatible)
        : semver.subset(range, compatible),
      `${label} declared renderer ABI ${request} is outside the React framework's compatible range ${compatible}`,
    );
  }
}

export function assertNativeRendererSourceSurface(
  root: string,
  app: JsonRecord,
  generation: RendererGenerationProfile,
  manifest: JsonRecord,
): void {
  const appRoot = path.join(root, app.path);
  for (const relative of [
    'src/routes/layout.tsx',
    'src/routes/page.tsx',
    'src/routes/about/page.tsx',
    'tsconfig.json',
  ]) {
    assert(
      fs.existsSync(path.join(appRoot, relative)),
      `${app.id} native renderer source is missing: ${relative}`,
    );
  }
  for (const relative of [
    ...(!generation.capabilities.federation
      ? [
          'module-federation.config.ts',
          'module-federation.config.tsx',
          'module-federation.config.js',
          'module-federation.config.mjs',
          'module-federation.config.cjs',
          'module-federation.config.mts',
          'module-federation.config.cts',
          'src/federation-entry.ts',
          'src/federation-entry.tsx',
          'src/federation-entry.tsrx',
          'src/federation-entry.gtsx',
        ]
      : []),
    'src/modern.runtime.ts',
    'src/routes/ultramodern-route-head.tsx',
    'src/routes/ultramodern-route-metadata.ts',
    'src/routes/[lang]',
    'wrangler.toml',
    'wrangler.json',
    'wrangler.jsonc',
  ]) {
    assert(
      !fs.existsSync(path.join(appRoot, relative)),
      `${app.id} native renderer contains unsupported artifact ${relative}`,
    );
  }
  const tsconfig = JSON.parse(
    fs.readFileSync(path.join(appRoot, 'tsconfig.json'), 'utf8'),
  );
  assert(
    tsconfig.compilerOptions?.jsxImportSource === generation.jsxImportSource &&
      tsconfig.compilerOptions?.jsx === 'preserve',
    `${app.id} JSX compiler configuration disagrees with the selected renderer`,
  );
  for (const script of Object.values(manifest.scripts ?? {})) {
    assert(
      typeof script === 'string' &&
        !/i18n/iu.test(script) &&
        (generation.capabilities.workers || !/wrangler/iu.test(script)) &&
        (generation.capabilities.federation ||
          !/module-federation/iu.test(script)),
      `${app.id} native renderer scripts claim an unsupported capability`,
    );
  }
}

export function validateApiOnlySourceSurface(
  root: string,
  app: JsonRecord,
): void {
  assert(
    !Object.hasOwn(app.backendFederation?.versionBoundary ?? {}, 'ui'),
    `topology/reference-topology.json verticals.${app.id}.backendFederation must omit the UI boundary for an api-only unit`,
  );
  for (const relative of [
    'module-federation.config.ts',
    'module-federation.config.tsx',
    'src/federation-entry.tsx',
    `src/components/${app.id}-widget.tsx`,
    'src/routes/layout.tsx',
    'src/routes/page.tsx',
    'src/routes/about/page.tsx',
    'src/routes/[lang]/page.tsx',
    'src/routes/[lang]/route.meta.ts',
    'src/routes/ultramodern-route-metadata.ts',
    'src/routes/ultramodern-route-head.tsx',
    'src/routes/index.css',
    ...(app.renderer === 'none' ? ['src/routes', 'src/modern.runtime.ts'] : []),
  ]) {
    assert(
      !fs.existsSync(path.join(root, app.path, relative)),
      `Unexpected ${app.path}/${relative} for a api-only unit`,
    );
  }
  const mfTypesPath = path.join(root, app.path, 'tsconfig.mf-types.json');
  if (fs.existsSync(mfTypesPath)) {
    const mfTypes: unknown = JSON.parse(fs.readFileSync(mfTypesPath, 'utf8'));
    assert(
      mfTypes !== null &&
        typeof mfTypes === 'object' &&
        !Array.isArray(mfTypes),
      `${app.id} tsconfig.mf-types.json must be an object`,
    );
    assert(
      !(mfTypes as JsonRecord).include?.includes('src/federation-entry.tsx'),
      `${app.id}: restore the generated MicroVertical Module Federation DTS boundary`,
    );
  }
}
