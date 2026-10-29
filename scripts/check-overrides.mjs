#!/usr/bin/env node
// Fails when a pnpm override in the workspace lockfile is dead or wrong.
//
// pnpm applies overrides silently: a key whose target no longer resolves, a
// key with an empty version selector, or a parent selector that names a
// workspace package all install fine and just do nothing (or quietly replace
// that package's own declared version). This check reads pnpm-lock.yaml and
// reports:
//   - a key with an empty version selector (`name@`), which pnpm never matches;
//   - a parent selector naming a workspace importer, which overrides that
//     package's own package.json instead of a third-party dependent;
//   - a key whose target (or parent) resolves nowhere in the lockfile;
//   - a resolution that still sits inside a range the override should close;
//   - a version override whose selector is unranged or spans majors, or whose
//     value leaves the major its selector names;
//   - a dependent whose installed package.json declares a range in another
//     major than the version an override forces on it.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import semver from 'semver';
import { parsePnpmLockfile as parse } from './lib/parse-pnpm-lockfile.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

// `parent>child`: pnpm's parsePkgAndParentSelector treats a `>` as the
// separator unless a space, `|` or `@` precedes it, as in a range.
const PARENT_SEPARATOR = /[^ |@]>/;

function parseSpec(spec) {
  const at = spec.indexOf('@', 1);
  return at === -1
    ? { name: spec, range: undefined }
    : { name: spec.slice(0, at), range: spec.slice(at + 1) };
}

export function parseOverrideKey(key) {
  const at = key.search(PARENT_SEPARATOR);
  return at === -1
    ? { target: parseSpec(key) }
    : {
        parent: parseSpec(key.slice(0, at + 1)),
        target: parseSpec(key.slice(at + 2)),
      };
}

// `name@version(peer@x)` -> { name, version } without the peer suffix.
function parsePackageKey(key) {
  const { name, range } = parseSpec(key.replace(/\(.*$/, ''));
  return { name, version: range };
}

// Selector match with pnpm's default semver semantics: a prerelease only
// matches a range that names a prerelease of the same version.
function inRange(version, range) {
  return range === undefined || semver.satisfies(version, range);
}

// Whether `version` is what the override value asks for: the exact version,
// or inside the value's range. An `npm:bar@x` value needs the edge version
// `bar@<x>`. Other values (`$ref`, `link:`) pass.
function honours(version, value) {
  if (value.startsWith('npm:')) {
    const wanted = parseSpec(value.slice(4));
    const actual = parseSpec(version);
    return (
      actual.name === wanted.name &&
      actual.range !== undefined &&
      (wanted.range === undefined || honours(actual.range, wanted.range))
    );
  }
  if (semver.valid(value)) return version === value;
  if (semver.validRange(value)) {
    return semver.satisfies(version, value);
  }
  return true;
}

function childEdge(snapshot, name) {
  return (
    (snapshot.dependencies ?? {})[name] ??
    (snapshot.optionalDependencies ?? {})[name]
  );
}

function findRemovalViolations(key, parent, target, snapshots, importers) {
  const scope = parent
    ? snapshots.filter(
        entry =>
          entry.name === parent.name && inRange(entry.version, parent.range),
      )
    : [...importers, ...snapshots];
  if (parent && scope.length === 0) {
    return [
      `'${key}': nothing in the lockfile resolves ${parent.name}${parent.range ? `@${parent.range}` : ''}. Delete the override.`,
    ];
  }
  const kept = scope.filter(entry => {
    const child = childEdge(entry.snapshot, target.name);
    if (child === undefined) return false;
    return inRange(
      parsePackageKey(`${target.name}@${child}`).version,
      target.range,
    );
  });
  return kept.map(
    entry =>
      `'${key}': ${entry.version ? `${entry.name}@${entry.version}` : entry.name} still depends on ${target.name}, which this override removes. ` +
      'Run pnpm install so the lockfile picks up the override.',
  );
}

/**
 * @param {string} lockfileText pnpm-lock.yaml contents
 * @param {Map<string, {path: string, version?: string}>} importerNames
 *   workspace package name -> importer path and manifest version
 * @returns {string[]} violations, one line each
 */
export function findOverrideViolations(lockfileText, importerNames) {
  const lockfile = parse(lockfileText);
  // An unresolved or optional peer leaves no snapshot edge, only the name in
  // the package's peerDependencies. It proves an override target is live,
  // but its range is the manifest's: the lockfile keeps a peer range as
  // published even after an override applies (follow-redirects keeps peer
  // `debug: '*'` under `debug: '>=4.4.3'`), so peer ranges are not judged.
  const snapshots = Object.entries(lockfile.snapshots ?? {}).map(
    ([key, snapshot]) => {
      const { name, version } = parsePackageKey(key);
      return {
        name,
        version,
        snapshot: snapshot ?? {},
        peers:
          lockfile.packages?.[`${name}@${version}`]?.peerDependencies ?? {},
      };
    },
  );

  // Workspace projects as edge holders: `version` is undefined, `name` is the
  // importer path, and every dependency field counts as an edge.
  const importers = Object.entries(lockfile.importers ?? {}).map(
    ([importer, manifest]) => {
      const dependencies = {};
      for (const field of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
      ]) {
        for (const [name, entry] of Object.entries(manifest?.[field] ?? {})) {
          dependencies[name] = String(entry.version);
        }
      }
      return {
        name: importer,
        version: undefined,
        snapshot: { dependencies },
        peers: {},
      };
    },
  );
  // Every resolved package is reached through a named edge; an `npm:` alias
  // override's target exists only as such an edge name.
  const edgeNames = new Set(
    [...importers, ...snapshots].flatMap(({ snapshot, peers }) => [
      ...Object.keys(snapshot.dependencies ?? {}),
      ...Object.keys(snapshot.optionalDependencies ?? {}),
      ...Object.keys(peers),
    ]),
  );

  // pnpm picks a matching parent override before a generic one, so a generic
  // override does not judge edges that a parent override for the same target
  // already owns.
  const parentOverrides = Object.keys(lockfile.overrides ?? {})
    .map(parseOverrideKey)
    .filter(({ parent }) => parent);
  const ownedByParentOverride = (entry, targetName) =>
    parentOverrides.some(
      ({ parent, target }) =>
        target.name === targetName &&
        entry.name === parent.name &&
        entry.version !== undefined &&
        inRange(entry.version, parent.range),
    );

  const violations = [];
  for (const [key, rawValue] of Object.entries(lockfile.overrides ?? {})) {
    const value = String(rawValue);
    const { parent, target } = parseOverrideKey(key);

    const empty = [parent, target].find(spec => spec?.range === '');
    if (empty) {
      violations.push(
        `'${key}': '${empty.name}@' has an empty version selector, so pnpm applies it to nothing. ` +
          `Write '${empty.name}@<range>' for the versions it must replace, or drop the '@'.`,
      );
      continue;
    }

    // pnpm matches a parent by name and version, so a versioned selector
    // that excludes the workspace package only targets registry copies.
    const workspaceParent = parent && importerNames.get(parent.name);
    if (
      workspaceParent &&
      (parent.range === undefined ||
        (workspaceParent.version !== undefined &&
          inRange(workspaceParent.version, parent.range)))
    ) {
      violations.push(
        `'${key}': '${parent.name}' is a workspace package, so this overrides its own declared ${target.name}. ` +
          `Delete the override and set ${target.name} in ${workspaceParent.path}/package.json.`,
      );
      continue;
    }

    // `-` removes the dependency: honoured means the edge is gone.
    if (value === '-') {
      violations.push(
        ...findRemovalViolations(key, parent, target, snapshots, importers),
      );
      continue;
    }

    if (!edgeNames.has(target.name)) {
      violations.push(
        `'${key}': nothing in the lockfile resolves ${target.name}. Delete the override.`,
      );
      continue;
    }

    if (parent) {
      const parents = snapshots.filter(
        entry =>
          entry.name === parent.name && inRange(entry.version, parent.range),
      );
      if (parents.length === 0) {
        violations.push(
          `'${key}': nothing in the lockfile resolves ${parent.name}${parent.range ? `@${parent.range}` : ''}. Delete the override.`,
        );
        continue;
      }
      let edges = 0;
      for (const entry of parents) {
        const deps = {
          ...entry.snapshot.dependencies,
          ...entry.snapshot.optionalDependencies,
        };
        const child = deps[target.name];
        if (child === undefined) {
          if (target.name in entry.peers) edges += 1;
          continue;
        }
        edges += 1;
        const { version } = parsePackageKey(`${target.name}@${child}`);
        if (inRange(version, target.range) && !honours(version, value)) {
          violations.push(
            `'${key}': ${entry.name}@${entry.version} still resolves ${target.name}@${version}, not ${value}. ` +
              'Run pnpm install so the lockfile picks up the override.',
          );
        }
      }
      if (edges === 0) {
        violations.push(
          `'${key}': no ${parent.name}${parent.range ? `@${parent.range}` : ''} in the lockfile depends on ${target.name}. Delete the override.`,
        );
      }
      continue;
    }

    const judged = new Set();
    for (const entry of [...importers, ...snapshots]) {
      if (ownedByParentOverride(entry, target.name)) continue;
      const edge = childEdge(entry.snapshot, target.name);
      if (edge !== undefined) judged.add(String(edge).replace(/\(.*$/, ''));
    }
    for (const version of judged) {
      // An unranged selector matches any specifier, including git, file
      // and alias edges.
      const matches =
        target.range === undefined ||
        (semver.valid(version)
          ? inRange(version, target.range)
          : value.startsWith('npm:'));
      if (matches && !honours(version, value)) {
        violations.push(
          `'${key}': the lockfile still resolves ${target.name}@${version}, which this override should replace with ${value}. ` +
            'Run pnpm install, or fix the selector if pnpm does not match it.',
        );
      }
    }
  }
  return violations;
}

// `^<floor>`: the versions semver-compatible with the lowest one in `range`.
function majorOf(range) {
  const floor = semver.minVersion(range);
  return floor ? `^${floor.version}` : undefined;
}

/**
 * A version override has to stay inside the major it fixes: an unranged or
 * cross-major selector hands every dependent a release it never declared.
 *
 * @param {Record<string, unknown>} overrides pnpm-lock.yaml `overrides`
 * @returns {string[]} violations, one line each
 */
export function findUnscopedOverrides(overrides) {
  const violations = [];
  for (const [key, rawValue] of Object.entries(overrides ?? {})) {
    const value = String(rawValue);
    // Removals, aliases and references replace the package, not its version.
    if (!semver.valid(value) && !semver.validRange(value)) continue;
    const { parent, target } = parseOverrideKey(key);
    if (target.range === undefined) {
      if (parent?.range) continue;
      violations.push(
        `'${key}': an unranged selector forces every ${target.name} to ${value}, across majors. ` +
          `Write one '${target.name}@>=<major>.0.0 <<fixed>>' key per affected major.`,
      );
      continue;
    }
    const major = semver.validRange(target.range) && majorOf(target.range);
    if (!major || !semver.subset(target.range, major)) {
      violations.push(
        `'${key}': the selector spans more than one major. Write one key per affected major.`,
      );
      continue;
    }
    const stays = semver.valid(value)
      ? semver.satisfies(value, major)
      : semver.subset(value, major);
    if (!stays) {
      violations.push(
        `'${key}': ${value} is outside ${major}, the major this selector replaces. ` +
          'Pin a fixed release inside that major, or delete the override.',
      );
    }
  }
  return violations;
}

/**
 * Checks each override target edge against the range its dependent declares.
 * The lockfile keeps only resolved versions, so declared ranges come from the
 * installed package.json.
 *
 * @param {string} lockfileText pnpm-lock.yaml contents
 * @param {(name: string, version: string) => object | undefined} readManifest
 *   installed package.json of a registry package
 * @returns {string[]} violations, one line each
 */
export function findForcedMajors(lockfileText, readManifest) {
  const lockfile = parse(lockfileText);
  const targets = new Set(
    Object.keys(lockfile.overrides ?? {}).map(
      key => parseOverrideKey(key).target.name,
    ),
  );
  const violations = [];
  const judge = (dependent, name, declared, edge) => {
    const resolved = String(edge).replace(/\(.*$/, '');
    if (
      !semver.valid(resolved) ||
      !semver.validRange(declared) ||
      semver.satisfies(resolved, declared) ||
      semver.satisfies(resolved, majorOf(declared))
    ) {
      return;
    }
    violations.push(
      `${dependent} declares ${name}@${declared} but resolves ${name}@${resolved}, another major. ` +
        `Scope the ${name} override to the major it fixes, or drop ${dependent}.`,
    );
  };

  for (const [importer, manifest] of Object.entries(lockfile.importers ?? {})) {
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
    ]) {
      for (const [name, entry] of Object.entries(manifest?.[field] ?? {})) {
        if (targets.has(name)) {
          judge(importer, name, String(entry.specifier), entry.version);
        }
      }
    }
  }

  const seen = new Set();
  for (const [key, snapshot] of Object.entries(lockfile.snapshots ?? {})) {
    const edges = {
      ...snapshot?.dependencies,
      ...snapshot?.optionalDependencies,
    };
    const overridden = Object.keys(edges).filter(name => targets.has(name));
    if (overridden.length === 0) continue;
    const { name, version } = parsePackageKey(key);
    const manifest = readManifest(name, version);
    if (!manifest) {
      // Optional snapshots for other platforms are not installed.
      if (!snapshot.optional) {
        violations.push(
          `${name}@${version} is not installed, so its declared ranges cannot be checked. Run pnpm install.`,
        );
      }
      continue;
    }
    for (const target of overridden) {
      const declared =
        manifest.dependencies?.[target] ??
        manifest.optionalDependencies?.[target] ??
        manifest.peerDependencies?.[target];
      const id = `${name}@${version}>${target}@${edges[target]}`;
      if (declared === undefined || seen.has(id)) continue;
      seen.add(id);
      judge(`${name}@${version}`, target, declared, edges[target]);
    }
  }
  return violations;
}

// Reads packages from pnpm's virtual store, whose directory names are
// `<name>@<version>` with path characters as `+` plus an optional
// `_<peers>` suffix. pnpm cuts long names, such as tarball URLs, and ends them
// with `_<hash>`; such a cut prefix must name exactly one store entry.
export function readInstalledManifest(root = repoRoot) {
  const store = path.join(root, 'node_modules', '.pnpm');
  const entries = readdirSync(store);
  return (name, version) => {
    const prefix = `${name}@${version}`.replace(/[\\/:*?"<>|#]/gu, '+');
    let entry = entries.find(
      dir => dir === prefix || dir.startsWith(`${prefix}_`),
    );
    if (!entry && version.includes('://')) {
      const cut = entries.filter(dir => {
        const head = dir.slice(0, dir.lastIndexOf('_'));
        return head.length > name.length + 1 && prefix.startsWith(head);
      });
      if (cut.length === 1) [entry] = cut;
    }
    if (!entry) return undefined;
    try {
      return JSON.parse(
        readFileSync(
          path.join(store, entry, 'node_modules', name, 'package.json'),
          'utf8',
        ),
      );
    } catch {
      return undefined;
    }
  };
}

export function readImporterNames(lockfileText, root = repoRoot) {
  const names = new Map();
  for (const importer of Object.keys(parse(lockfileText).importers ?? {})) {
    const { name, version } = JSON.parse(
      readFileSync(path.join(root, importer, 'package.json'), 'utf8'),
    );
    if (name) names.set(name, { path: importer, version });
  }
  return names;
}

function main() {
  const lockfileText = readFileSync(
    path.join(repoRoot, 'pnpm-lock.yaml'),
    'utf8',
  );
  const violations = [
    ...findOverrideViolations(lockfileText, readImporterNames(lockfileText)),
    ...findUnscopedOverrides(parse(lockfileText).overrides),
    ...findForcedMajors(lockfileText, readInstalledManifest()),
  ];
  if (violations.length > 0) {
    console.error(
      `check-overrides: ${violations.length} dead or wrong override(s) in pnpm-workspace.yaml:\n` +
        violations.map(line => `  - ${line}`).join('\n'),
    );
    process.exit(1);
  }
  console.log(
    'check-overrides: every override is live, honoured and scoped to its major.',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
