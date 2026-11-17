import fs from 'node:fs';
import path from 'node:path';
import { yaml } from '@modern-js/utils';
import {
  NATIVE_ROUTER_CORE,
  readNativeArtifacts,
  readSupportArtifacts,
  type SupportArtifacts,
} from './package-source';
import { getRendererGenerationProfile } from './renderer-profile';
import type { JsonValue, WorkspaceRenderer } from './types';
import { isRecord } from './types';
import { sameJson } from './validation/assertions';
import {
  assertNativeRendererSourceSurface,
  assertRendererDependencies,
  assertRendererProjection,
  assertWorkspaceRootToolingDependencies,
  isForeignRendererPackage,
  parseNpmAlias,
  validateApiOnlySourceSurface,
} from './validation/renderer';
import {
  assertSupportDependencyPolicies,
  assertWorkspaceDependencyOverrides,
} from './validation/workspace';
import {
  EFFECT_VERSION,
  REACT_DOM_VERSION,
  REACT_VERSION,
  TAILWIND_VERSION,
  TANSTACK_ROUTER_CORE_VERSION,
  TANSTACK_ROUTER_VERSION,
  ULTRAMODERN_PACKAGE_PINS,
} from './versions';

/**
 * Platform Baseline producer pins (G21 / CONTEXT.md "Platform Baseline").
 * A Platform Overlay (overlays.ts) may only *narrow* choices — it must never
 * relax the baseline. The concrete, structurally-checkable meaning of "must not
 * relax" is: an overlay's output must not change the pinned version of any
 * baseline dependency (React, TanStack Router, Effect, Tailwind) in any
 * generated package manifest, and must not (re)introduce a package that pins a
 * baseline dependency to a version other than the platform pin.
 *
 * These names match the specifiers emitted into generated `package.json`
 * manifests. `@tanstack/react-router` and `@tanstack/router-core` are the two
 * router producers; `tailwindcss` is the Tailwind producer; `effect` is the
 * Effect producer; `react`/`react-dom` are the React producers.
 */
export const BASELINE_DEPENDENCY_PINS: Readonly<Record<string, string>> =
  Object.freeze({
    react: REACT_VERSION,
    'react-dom': REACT_DOM_VERSION,
    '@tanstack/react-router': TANSTACK_ROUTER_VERSION,
    '@tanstack/router-core': TANSTACK_ROUTER_CORE_VERSION,
    effect: EFFECT_VERSION,
    tailwindcss: TAILWIND_VERSION,
  });

/**
 * Forbidden artifact classes an overlay may not (re)introduce into a thin Shell
 * (G21). A Platform Overlay narrows freedom; it may not smuggle a forbidden
 * structural artifact back into a shell. These relative path segments are
 * checked against files an overlay newly creates under a shell package, and are
 * intentionally aligned with the structural thin-shell gate (G30a): a shell
 * never owns an `api/` or `server/` surface or backend-federation artifacts.
 */
const FORBIDDEN_SHELL_ARTIFACT_SEGMENTS = [
  'api',
  'server',
  'backend-federation.config.ts',
] as const;

const IGNORED_WALK_DIRECTORIES = new Set([
  '.git',
  '.nx',
  '.output',
  'coverage',
  'dist',
  'dist-cloudflare',
  'node_modules',
]);

export type OverlayBaselineViolation = {
  kind:
    | 'baseline-version-relaxation'
    | 'forbidden-shell-artifact'
    | 'renderer-profile-relaxation';
  path: string;
  detail: string;
};

/**
 * Typed error raised BEFORE an overlaid workspace is accepted when a CodeSmith
 * overlay relaxes the Platform Baseline (G21). Carries the exact violations so
 * callers can surface which baseline pin or forbidden artifact the overlay
 * changed.
 */
export class OverlayBaselineRelaxationError extends Error {
  readonly code = 'ULTRAMODERN_OVERLAY_BASELINE_RELAXATION';
  readonly generator: string;
  readonly violations: OverlayBaselineViolation[];

  constructor(generator: string, violations: OverlayBaselineViolation[]) {
    super(
      [
        `UltraModern CodeSmith overlay relaxed the Platform Baseline: ${generator}`,
        ...violations.map(
          violation => `  - ${violation.path}: ${violation.detail}`,
        ),
      ].join('\n'),
    );
    this.name = 'OverlayBaselineRelaxationError';
    this.generator = generator;
    this.violations = violations;
  }
}

function walkFiles(root: string, predicate: (relativePath: string) => boolean) {
  const matches: string[] = [];
  const queue: string[] = [root];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_WALK_DIRECTORIES.has(entry.name)) {
          queue.push(absolute);
        }
        continue;
      }
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (predicate(relative)) {
        matches.push(relative);
      }
    }
  }

  return matches.sort();
}

function isPackageManifest(relativePath: string): boolean {
  return (
    relativePath === 'package.json' || relativePath.endsWith('/package.json')
  );
}

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

type DependencyEntry = {
  section: string;
  name: string;
  value: string;
};

type PolicyEntry = {
  path: string;
  dependency: string;
  value: string;
};

function readPackageJson(
  workspaceRoot: string,
  packageJsonRelativePath: string,
): Record<string, JsonValue> {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, packageJsonRelativePath), 'utf-8'),
  );
  return isRecord(parsed) ? parsed : {};
}

function dependencyEntries(
  parsed: Record<string, JsonValue>,
): DependencyEntry[] {
  const entries: DependencyEntry[] = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const group = parsed[section];
    if (!isRecord(group)) continue;
    for (const [name, value] of Object.entries(group)) {
      if (typeof value === 'string') {
        entries.push({ section, name, value });
      }
    }
  }
  return entries;
}

function baselineDependencyFromKey(
  key: string,
  pins: Readonly<Record<string, string>>,
): string | undefined {
  const candidate = key.trim().split('>').at(-1) ?? '';
  return Object.keys(pins).find(
    dependency =>
      candidate === dependency || candidate.startsWith(`${dependency}@`),
  );
}

function collectPolicyEntries(
  value: JsonValue,
  prefix: string,
  entries: PolicyEntry[],
  pins: Readonly<Record<string, string>>,
): void {
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = prefix === '' ? key : `${prefix}.${key}`;
    const dependency = baselineDependencyFromKey(key, pins);
    if (dependency !== undefined && typeof child === 'string') {
      entries.push({ path: childPath, dependency, value: child });
    }
    if (isRecord(child)) {
      collectPolicyEntries(child, childPath, entries, pins);
    }
  }
}

function policyRoots(
  parsed: Record<string, JsonValue>,
): Array<[string, JsonValue | undefined]> {
  const pnpm = isRecord(parsed.pnpm) ? parsed.pnpm : undefined;
  return [
    ['overrides', parsed.overrides],
    ['resolutions', parsed.resolutions],
    ['pnpm.overrides', pnpm?.overrides],
    ['catalog', parsed.catalog],
    ['catalogs', parsed.catalogs],
    ['pnpm.catalog', pnpm?.catalog],
    ['pnpm.catalogs', pnpm?.catalogs],
  ];
}

function baselinePolicyEntries(
  parsed: Record<string, JsonValue>,
  pins: Readonly<Record<string, string>>,
): PolicyEntry[] {
  const entries: PolicyEntry[] = [];
  for (const [prefix, value] of policyRoots(parsed)) {
    if (value !== undefined) {
      collectPolicyEntries(value, prefix, entries, pins);
    }
  }
  return entries;
}

function readPnpmWorkspaceYaml(
  workspaceRoot: string,
): Record<string, JsonValue> {
  try {
    const parsed: unknown = yaml.load(
      fs.readFileSync(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'utf-8'),
    );
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function collectCatalogValues(
  parsed: Record<string, JsonValue>,
): Map<string, string> {
  const values = new Map<string, string>();
  const collect = (value: JsonValue, prefix: string) => {
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = prefix === '' ? key : `${prefix}.${key}`;
      if (typeof child === 'string') {
        values.set(key, child);
        values.set(childPath, child);
      } else {
        collect(child, childPath);
      }
    }
  };
  for (const [prefix, value] of policyRoots(parsed).filter(([prefix]) =>
    /catalog/u.test(prefix),
  )) {
    collect(value ?? {}, prefix);
  }
  return values;
}

function resolveCatalogReference(
  value: string,
  catalogValues: Map<string, string>,
): string {
  if (!value.startsWith('catalog:')) return value;
  return catalogValues.get(value.slice('catalog:'.length)) ?? value;
}

function baselineSpecMatches(
  value: string,
  dependency: string,
  pins: Readonly<Record<string, string>>,
): boolean {
  const expected = pins[dependency];
  if (value === expected) return true;
  const alias = parseNpmAlias(value);
  return alias?.name === dependency && alias.range === expected;
}

function baselinePinsFromParsed(
  parsed: Record<string, JsonValue>,
  baseline: Readonly<Record<string, string>>,
): Record<string, string> {
  const pins: Record<string, string> = {};

  for (const section of DEPENDENCY_SECTIONS) {
    const group = parsed[section];
    if (!isRecord(group)) {
      continue;
    }
    for (const dependency of Object.keys(baseline)) {
      const value = group[dependency];
      if (typeof value === 'string') {
        pins[`${section}.${dependency}`] = value;
      }
    }
  }

  return pins;
}

function readBaselinePins(
  workspaceRoot: string,
  packageJsonRelativePath: string,
  pins: Readonly<Record<string, string>>,
): Record<string, string> {
  return baselinePinsFromParsed(
    readPackageJson(workspaceRoot, packageJsonRelativePath),
    pins,
  );
}

/**
 * Snapshot of the baseline-relevant workspace state taken BEFORE an overlay
 * runs. Compared against the post-overlay state to prove non-relaxation.
 */
export type OverlayBaselineSnapshot = {
  baselinePinsByManifest: Record<string, Record<string, string>>;
  baselinePolicyPinsByManifest?: Record<string, Record<string, string>>;
  baselineWorkspacePolicyPins?: Record<string, string>;
  shellPackageDirectories: string[];
  shellFiles: Set<string>;
  deferredUiArtifactPaths?: ReadonlySet<string>;
  baselineDependencyPins?: Readonly<Record<string, string>>;
  baselineDependencyPinsByManifest?: Record<
    string,
    Readonly<Record<string, string>>
  >;
  rendererProjectionsByManifest?: Record<string, RendererProjection>;
  supportArtifacts?: SupportArtifacts;
};

type RendererProjection = {
  appId: string;
  renderer: WorkspaceRenderer;
  rendererIdentity?: JsonValue;
  rendererIdentities?: JsonValue;
  rendererProfile?: JsonValue;
  routerBindings?: JsonValue;
  rendererCapabilities?: JsonValue;
};

function rendererProjections(
  workspaceRoot: string,
  deferredUiArtifactPaths: ReadonlySet<string> = new Set(),
): Record<string, RendererProjection> {
  const file = path.join(workspaceRoot, 'topology/reference-topology.json');
  if (!fs.existsSync(file)) return {};
  const topology: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isRecord(topology))
    throw new Error('Workspace topology must be an object.');
  const apps = [
    topology.shell,
    ...(Array.isArray(topology.shells) ? topology.shells : []),
    ...(Array.isArray(topology.verticals) ? topology.verticals : []),
  ];
  const projections: Record<string, RendererProjection> = {};
  for (const app of apps) {
    if (!isRecord(app) || app.renderer === undefined) continue;
    assertRendererProjection(
      app,
      undefined,
      typeof app.path === 'string' &&
        deferredUiArtifactPaths.has(
          `${app.path}/shared/ultramodern-build.json`,
        ),
    );
    if (
      typeof app.path !== 'string' ||
      path.isAbsolute(app.path) ||
      app.path.split(/[\\/]/u).includes('..')
    ) {
      throw new Error(
        `Application ${String(app.id)} renderer path must stay within the workspace.`,
      );
    }
    const projection: RendererProjection = {
      appId: String(app.id),
      renderer: app.renderer as WorkspaceRenderer,
    };
    for (const field of [
      'rendererIdentity',
      'rendererIdentities',
      'rendererProfile',
      'routerBindings',
      'rendererCapabilities',
    ] as const) {
      if (Object.hasOwn(app, field))
        projection[field] = structuredClone(app[field]);
    }
    projections[`${app.path}/package.json`] = projection;
  }
  return projections;
}

function rendererBaselinePins(
  renderer: WorkspaceRenderer,
): Readonly<Record<string, string>> {
  if (renderer === 'react') return BASELINE_DEPENDENCY_PINS;
  const common = { effect: EFFECT_VERSION, tailwindcss: TAILWIND_VERSION };
  if (renderer === 'none') return common;
  const generation = getRendererGenerationProfile(renderer);
  return {
    ...common,
    ...generation.dependencies,
    ...generation.devDependencies,
    // The architecture validator uses this named tool's unstable AST API;
    // native application typechecking retains its selected TypeScript pin.
    '@typescript/native':
      ULTRAMODERN_PACKAGE_PINS.rootDevDependencies['@typescript/native'],
  };
}

export function captureOverlayBaselineSnapshot(
  workspaceRoot: string,
  shellPackageDirectories: string[],
  deferredUiArtifactPaths: ReadonlySet<string> = new Set(),
): OverlayBaselineSnapshot {
  const rootManifest = fs.existsSync(path.join(workspaceRoot, 'package.json'))
    ? readPackageJson(workspaceRoot, 'package.json')
    : undefined;
  const supportArtifacts = rootManifest
    ? readSupportArtifacts(rootManifest)
    : undefined;
  // An admitted native Core is the baseline; a registry Core relaxes it.
  const nativeCore = rootManifest
    ? readNativeArtifacts(rootManifest)?.packages[NATIVE_ROUTER_CORE].request
    : undefined;
  const supportPins = (pins: Readonly<Record<string, string>>) =>
    Object.fromEntries(
      Object.entries(pins).map(([name, request]) => [
        name,
        supportArtifacts?.packages[name as keyof SupportArtifacts['packages']]
          ?.request ??
          (name === NATIVE_ROUTER_CORE ? nativeCore : undefined) ??
          request,
      ]),
    );
  const rendererProjectionsByManifest = rendererProjections(
    workspaceRoot,
    deferredUiArtifactPaths,
  );
  for (const artifactPath of deferredUiArtifactPaths) {
    const manifestPath = artifactPath.replace(
      /\/shared\/ultramodern-build\.json$/u,
      '/package.json',
    );
    const projection = rendererProjectionsByManifest[manifestPath];
    if (
      manifestPath === artifactPath ||
      !projection ||
      projection.renderer === 'none' ||
      projection.routerBindings !== undefined ||
      fs.existsSync(path.join(workspaceRoot, artifactPath))
    ) {
      throw new Error(`Invalid deferred UI artifact: ${artifactPath}`);
    }
  }
  const renderers = new Set(
    Object.values(rendererProjectionsByManifest)
      .map(projection => projection.renderer)
      .filter(renderer => renderer !== 'none'),
  );
  const workspaceRenderer = renderers.size === 1 ? [...renderers][0] : 'react';
  const baselineDependencyPins = supportPins(
    rendererBaselinePins(workspaceRenderer),
  );
  const baselineDependencyPinsByManifest = Object.fromEntries(
    Object.entries(rendererProjectionsByManifest).map(
      ([manifest, projection]) => [
        manifest,
        supportPins(rendererBaselinePins(projection.renderer)),
      ],
    ),
  );
  const baselinePinsByManifest: Record<string, Record<string, string>> = {};
  const baselinePolicyPinsByManifest: Record<
    string,
    Record<string, string>
  > = {};
  for (const manifest of walkFiles(workspaceRoot, isPackageManifest)) {
    const parsed = readPackageJson(workspaceRoot, manifest);
    const pins =
      baselineDependencyPinsByManifest[manifest] ?? baselineDependencyPins;
    baselinePinsByManifest[manifest] = readBaselinePins(
      workspaceRoot,
      manifest,
      pins,
    );
    baselinePolicyPinsByManifest[manifest] = Object.fromEntries(
      baselinePolicyEntries(parsed, pins).map(entry => [
        entry.path,
        entry.value,
      ]),
    );
  }

  const shellFiles = new Set<string>();
  for (const shellDir of shellPackageDirectories) {
    const absolute = path.join(workspaceRoot, shellDir);
    if (!fs.existsSync(absolute)) {
      continue;
    }
    for (const file of walkFiles(absolute, () => true)) {
      shellFiles.add(`${shellDir}/${file}`);
    }
  }

  return {
    baselinePinsByManifest,
    baselinePolicyPinsByManifest,
    baselineWorkspacePolicyPins: Object.fromEntries(
      baselinePolicyEntries(
        readPnpmWorkspaceYaml(workspaceRoot),
        baselineDependencyPins,
      ).map(entry => [entry.path, entry.value]),
    ),
    shellPackageDirectories,
    shellFiles,
    deferredUiArtifactPaths: new Set(deferredUiArtifactPaths),
    baselineDependencyPins,
    baselineDependencyPinsByManifest,
    rendererProjectionsByManifest,
    supportArtifacts,
  };
}

function collectPolicyViolations(
  parsed: Record<string, JsonValue>,
  beforePolicyPins: Record<string, string>,
  displayPath: string,
  pins: Readonly<Record<string, string>>,
): OverlayBaselineViolation[] {
  const violations: OverlayBaselineViolation[] = [];
  const currentPolicyEntries = baselinePolicyEntries(parsed, pins);
  const currentPolicyPins = Object.fromEntries(
    currentPolicyEntries.map(entry => [entry.path, entry.value]),
  );

  for (const [policyPath, previous] of Object.entries(beforePolicyPins)) {
    if (Object.hasOwn(currentPolicyPins, policyPath)) continue;
    const dependency =
      baselineDependencyFromKey(policyPath.split('.').at(-1) ?? '', pins) ??
      policyPath.split('.').at(-1) ??
      policyPath;
    const expected = pins[dependency];
    if (expected === undefined) continue;
    violations.push({
      kind: 'baseline-version-relaxation',
      path: `${displayPath}#${policyPath}`,
      detail: `overlay removed baseline policy "${policyPath}" from "${previous}"; Platform Baseline pin is "${expected}"`,
    });
  }

  const catalogValues = collectCatalogValues(parsed);
  for (const entry of currentPolicyEntries) {
    const resolvedVersion = resolveCatalogReference(entry.value, catalogValues);
    const expected = pins[entry.dependency];
    if (baselineSpecMatches(resolvedVersion, entry.dependency, pins)) continue;
    violations.push({
      kind: 'baseline-version-relaxation',
      path: `${displayPath}#${entry.path}`,
      detail: `overlay policy "${entry.path}" pins baseline dependency "${entry.dependency}" at "${entry.value}"; Platform Baseline pin is "${expected}"`,
    });
  }

  return violations;
}

function collectVersionViolations(
  workspaceRoot: string,
  snapshot: OverlayBaselineSnapshot,
): OverlayBaselineViolation[] {
  const violations: OverlayBaselineViolation[] = [];

  const manifests = new Set([
    ...walkFiles(workspaceRoot, isPackageManifest),
    ...Object.keys(snapshot.baselinePinsByManifest),
  ]);

  for (const manifest of manifests) {
    let parsed: Record<string, JsonValue>;
    try {
      parsed = readPackageJson(workspaceRoot, manifest);
    } catch {
      parsed = {};
    }
    const baseline =
      snapshot.baselineDependencyPinsByManifest?.[manifest] ??
      snapshot.baselineDependencyPins ??
      BASELINE_DEPENDENCY_PINS;
    const pins = baselinePinsFromParsed(parsed, baseline);
    const before = snapshot.baselinePinsByManifest[manifest] ?? {};

    for (const key of Object.keys(before)) {
      if (Object.hasOwn(pins, key)) continue;
      const separator = key.indexOf('.');
      const section = key.slice(0, separator);
      const dependency = key.slice(separator + 1);
      const expected = baseline[dependency];
      violations.push({
        kind: 'baseline-version-relaxation',
        path: manifest,
        detail: `overlay removed baseline dependency "${dependency}" from ${section}; Platform Baseline pin is "${expected}"`,
      });
    }

    const catalogValues = collectCatalogValues(parsed);
    for (const [key, version] of Object.entries(pins)) {
      const dependency = key.slice(key.indexOf('.') + 1);
      const expected = baseline[dependency];
      const previous = before[key];
      const resolvedVersion = resolveCatalogReference(version, catalogValues);
      const matches = baselineSpecMatches(
        resolvedVersion,
        dependency,
        baseline,
      );
      if (previous === undefined && !matches) {
        violations.push({
          kind: 'baseline-version-relaxation',
          path: manifest,
          detail: `overlay added baseline dependency "${dependency}" at "${version}"; Platform Baseline pin is "${expected}"`,
        });
      } else if (previous !== undefined && version !== previous && !matches) {
        violations.push({
          kind: 'baseline-version-relaxation',
          path: manifest,
          detail: `overlay changed baseline dependency "${dependency}" from "${previous}" to "${version}"; Platform Baseline pin is "${expected}"`,
        });
      }
    }

    for (const entry of dependencyEntries(parsed)) {
      const alias = parseNpmAlias(entry.value);
      if (alias === undefined) continue;
      if (
        entry.section === 'devDependencies' &&
        entry.name === '@typescript/native' &&
        entry.value === baseline[entry.name]
      ) {
        continue;
      }
      const expected = baseline[alias.name];
      if (expected === undefined || alias.range === expected) continue;
      violations.push({
        kind: 'baseline-version-relaxation',
        path: manifest,
        detail: `overlay alias "${entry.name}" resolves to baseline dependency "${alias.name}" at "${entry.value}"; Platform Baseline pin is "${expected}"`,
      });
    }

    violations.push(
      ...collectPolicyViolations(
        parsed,
        snapshot.baselinePolicyPinsByManifest?.[manifest] ?? {},
        manifest,
        baseline,
      ),
    );
  }

  violations.push(
    ...collectPolicyViolations(
      readPnpmWorkspaceYaml(workspaceRoot),
      snapshot.baselineWorkspacePolicyPins ?? {},
      'pnpm-workspace.yaml',
      snapshot.baselineDependencyPins ?? BASELINE_DEPENDENCY_PINS,
    ),
  );

  return violations;
}

function collectForbiddenShellArtifactViolations(
  workspaceRoot: string,
  snapshot: OverlayBaselineSnapshot,
): OverlayBaselineViolation[] {
  const violations: OverlayBaselineViolation[] = [];

  for (const shellDir of snapshot.shellPackageDirectories) {
    const absolute = path.join(workspaceRoot, shellDir);
    if (!fs.existsSync(absolute)) {
      continue;
    }
    for (const file of walkFiles(absolute, () => true)) {
      const relative = `${shellDir}/${file}`;
      if (snapshot.shellFiles.has(relative)) {
        continue;
      }
      const segments = file.split('/');
      const forbidden = FORBIDDEN_SHELL_ARTIFACT_SEGMENTS.find(
        segment => segments.includes(segment) || file === segment,
      );
      if (forbidden) {
        violations.push({
          kind: 'forbidden-shell-artifact',
          path: relative,
          detail: `overlay introduced a forbidden thin-shell artifact class "${forbidden}" into shell package ${shellDir}`,
        });
      }
    }
  }

  return violations;
}

function collectRendererViolations(
  workspaceRoot: string,
  snapshot: OverlayBaselineSnapshot,
): OverlayBaselineViolation[] {
  const before = snapshot.rendererProjectionsByManifest ?? {};
  if (Object.keys(before).length === 0) return [];
  const violations: OverlayBaselineViolation[] = [];
  const workspacePolicy = readPnpmWorkspaceYaml(workspaceRoot);
  const dependencyCatalogs = {
    catalog: workspacePolicy.catalog as Record<string, string> | undefined,
    catalogs: workspacePolicy.catalogs as
      | Record<string, Record<string, string>>
      | undefined,
  };
  const reject = (displayPath: string, detail: string) => {
    violations.push({
      kind: 'renderer-profile-relaxation',
      path: displayPath,
      detail,
    });
  };
  let current: Record<string, RendererProjection>;
  try {
    current = rendererProjections(
      workspaceRoot,
      snapshot.deferredUiArtifactPaths,
    );
  } catch (error) {
    reject(
      'topology/reference-topology.json',
      error instanceof Error ? error.message : String(error),
    );
    current = {};
  }
  if (!sameJson(current, before)) {
    reject(
      'topology/reference-topology.json',
      'overlay changed the selected renderer identity, compiler/runtime/router tuple or admitted capabilities',
    );
  }
  const renderers = new Set(
    Object.values(before)
      .map(value => value.renderer)
      .filter(renderer => renderer !== 'none'),
  );
  const workspaceRenderer =
    renderers.size === 1 ? [...renderers][0] : undefined;
  const inspectPolicy = (
    value: JsonValue,
    prefix: string,
    renderer: WorkspaceRenderer,
    displayPath: string,
  ): void => {
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const candidate = key.trim().split('>').at(-1) ?? '';
      const versionSeparator = candidate.startsWith('@')
        ? candidate.indexOf('@', 1)
        : candidate.indexOf('@');
      const dependency =
        versionSeparator === -1
          ? candidate
          : candidate.slice(0, versionSeparator);
      const policyPath = `${prefix}.${key}`;
      const alias =
        typeof child === 'string' ? parseNpmAlias(child) : undefined;
      // Exact support policy is validated against the captured descriptor below.
      // Root tooling hosts may intentionally belong to another renderer.
      if (
        snapshot.supportArtifacts &&
        Object.hasOwn(snapshot.supportArtifacts.packages, dependency)
      )
        continue;
      if (
        isForeignRendererPackage(dependency, renderer) ||
        (alias && isForeignRendererPackage(alias.name, renderer))
      ) {
        reject(
          `${displayPath}#${policyPath}`,
          `overlay policy introduced a foreign renderer package for ${renderer}`,
        );
      }
      if (isRecord(child))
        inspectPolicy(child, policyPath, renderer, displayPath);
    }
  };
  for (const manifestPath of new Set([
    ...Object.keys(before),
    ...walkFiles(workspaceRoot, isPackageManifest),
  ])) {
    const selected = before[manifestPath];
    if (selected && !fs.existsSync(path.join(workspaceRoot, manifestPath))) {
      reject(manifestPath, 'Overlay removed a selected application manifest.');
      continue;
    }
    const renderer = selected?.renderer ?? workspaceRenderer;
    if (!renderer) continue;
    const parsed = readPackageJson(workspaceRoot, manifestPath);
    try {
      if (manifestPath === 'package.json')
        assertWorkspaceRootToolingDependencies(
          parsed,
          renderer,
          dependencyCatalogs,
        );
      else
        assertRendererDependencies(
          parsed,
          renderer,
          undefined,
          dependencyCatalogs,
        );
    } catch (error) {
      reject(
        manifestPath,
        error instanceof Error ? error.message : String(error),
      );
    }
    for (const [prefix, value] of policyRoots(parsed)) {
      if (value !== undefined)
        inspectPolicy(value, prefix, renderer, manifestPath);
    }
    if (!selected) continue;
    try {
      const generation =
        renderer === 'none'
          ? undefined
          : getRendererGenerationProfile(renderer);
      assertRendererDependencies(
        parsed,
        renderer,
        generation,
        dependencyCatalogs,
      );
      const appPath = path.dirname(manifestPath);
      if (generation && renderer !== 'react') {
        assertNativeRendererSourceSurface(
          workspaceRoot,
          {
            id: selected.appId,
            path: appPath,
          },
          generation,
          parsed,
        );
      }
      const artifactPath = `${appPath}/shared/ultramodern-build.json`;
      if (snapshot.deferredUiArtifactPaths?.has(artifactPath)) {
        try {
          fs.lstatSync(path.join(workspaceRoot, artifactPath));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        throw new Error(
          'New UI artifact must remain absent until modern.config supplies its actual router bindings.',
        );
      }
      const build = JSON.parse(
        fs.readFileSync(path.join(workspaceRoot, artifactPath), 'utf8'),
      );
      if (renderer === 'none') {
        validateApiOnlySourceSurface(workspaceRoot, {
          id: selected.appId,
          path: appPath,
          renderer: 'none',
        });
        if (Object.hasOwn(build.surfaces ?? {}, 'ui'))
          throw new Error('Headless build must omit its UI renderer surface.');
      } else if (
        !sameJson(
          build.surfaces?.ui?.rendererProfile,
          selected.rendererProfile,
        ) ||
        !sameJson(
          build.surfaces?.ui?.rendererIdentity,
          selected.rendererIdentity,
        ) ||
        !sameJson(build.surfaces?.ui?.routerBindings, selected.routerBindings)
      ) {
        throw new Error(
          'Build renderer profile/identity disagrees with the selected projection.',
        );
      }
    } catch (error) {
      reject(
        manifestPath,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (workspaceRenderer) {
    for (const [prefix, value] of policyRoots(
      readPnpmWorkspaceYaml(workspaceRoot),
    )) {
      if (value !== undefined)
        inspectPolicy(value, prefix, workspaceRenderer, 'pnpm-workspace.yaml');
    }
  }
  return violations;
}

/**
 * Validate that an applied CodeSmith overlay did not relax the Platform
 * Baseline (G21). Compares the post-overlay workspace against the pre-overlay
 * {@link OverlayBaselineSnapshot}; throws {@link OverlayBaselineRelaxationError}
 * when the overlay changed a baseline pin or reintroduced a forbidden thin-shell
 * artifact. Pure read + throw: it never writes, so a relaxing overlay fails
 * before its output is accepted by the generator.
 */
export function assertOverlayPreservedBaseline(options: {
  workspaceRoot: string;
  generator: string;
  snapshot: OverlayBaselineSnapshot;
}) {
  const supportViolations: OverlayBaselineViolation[] = [];
  if (options.snapshot.supportArtifacts) {
    try {
      const rootManifest = readPackageJson(
        options.workspaceRoot,
        'package.json',
      );
      if (
        !sameJson(
          readSupportArtifacts(rootManifest),
          options.snapshot.supportArtifacts,
        )
      )
        throw new Error('Overlay changed the selected support descriptor.');
      assertWorkspaceDependencyOverrides(
        readPnpmWorkspaceYaml(options.workspaceRoot),
        rootManifest,
      );
      for (const manifestPath of walkFiles(
        options.workspaceRoot,
        isPackageManifest,
      ))
        assertSupportDependencyPolicies(
          readPackageJson(options.workspaceRoot, manifestPath),
          options.snapshot.supportArtifacts,
          manifestPath,
        );
    } catch (error) {
      supportViolations.push({
        kind: 'baseline-version-relaxation',
        path: 'pnpm-workspace.yaml',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const violations = [
    ...supportViolations,
    ...collectVersionViolations(options.workspaceRoot, options.snapshot),
    ...collectForbiddenShellArtifactViolations(
      options.workspaceRoot,
      options.snapshot,
    ),
    ...collectRendererViolations(options.workspaceRoot, options.snapshot),
  ];

  if (violations.length > 0) {
    throw new OverlayBaselineRelaxationError(options.generator, violations);
  }
}
