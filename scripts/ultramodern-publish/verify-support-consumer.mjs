#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import semver from 'semver';
import { parse as parseYaml } from 'yaml';
import { packFiles } from '../ultramodern-artifacts/reconstruct.mjs';
import { readBytes } from '../ultramodern-artifacts/transport.mjs';
import {
  inspectSupportTarball,
  supportProtocol as protocol,
} from '../ultramodern-support-artifacts/protocol.mjs';
import { githubReader } from '../ultramodern-support-artifacts/transport.mjs';
import { isDirectRun } from './lib/direct-run.mjs';
import { verifySupportInputs } from './lib/support-artifact-inputs.mjs';

const names = Object.keys(protocol.cohort);
const directBlocks = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
];
const has = (manifest, block, name) =>
  Object.hasOwn(manifest[block] ?? {}, name);
const supportEdges = manifest =>
  names.filter(name =>
    [...directBlocks, 'peerDependencies', 'peerDependenciesMeta'].some(block =>
      has(manifest, block, name),
    ),
  );
const frameworkOwner = manifest =>
  [manifest.name, manifest.ultramodern?.sourceName].some(
    name => typeof name === 'string' && name.startsWith('@modern-js/'),
  );
const commitsDescriptor = manifest =>
  Object.hasOwn(manifest.ultramodern ?? {}, 'supportArtifacts');
const contained = (root, directory) => {
  const relative = path.relative(root, directory);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};
export function supportWorkspaceImporters(root) {
  root = fs.realpathSync(root);
  const workspace = path.join(root, 'pnpm-workspace.yaml');
  const patterns = fs.existsSync(workspace)
    ? (parseYaml(fs.readFileSync(workspace, 'utf8')).packages ?? [])
    : [];
  assert(Array.isArray(patterns), 'Workspace packages must be an array');
  assert(
    patterns.every(
      pattern =>
        typeof pattern === 'string' &&
        !path.isAbsolute(pattern) &&
        !pattern.split('/').includes('..'),
    ),
    'Invalid workspace package pattern',
  );
  const included = patterns
    .filter(pattern => !pattern.startsWith('!'))
    .map(pattern => `${pattern.replace(/\/$/u, '')}/package.json`);
  const excluded = [
    '**/node_modules/**',
    '**/.git/**',
    ...patterns
      .filter(pattern => pattern.startsWith('!'))
      .map(pattern => `${pattern.slice(1).replace(/\/$/u, '')}/package.json`),
  ];
  const members = fs
    .globSync(included, { cwd: root, exclude: excluded })
    .map(filename => fs.realpathSync(path.dirname(path.join(root, filename))));
  for (const member of members)
    assert(
      contained(root, member) &&
        !path
          .relative(root, member)
          .split(path.sep)
          .some(part => ['node_modules', '.git'].includes(part)),
      `Workspace importer escapes consumer boundary: ${member}`,
    );
  return [...new Set([root, ...members])].sort();
}
function manifestAt(directory) {
  directory = fs.realpathSync(directory);
  const filename = path.join(directory, 'package.json');
  const bytes = fs.readFileSync(filename);
  return {
    directory: fs.realpathSync(directory),
    filename,
    bytes,
    manifest: JSON.parse(bytes),
  };
}
function owningManifest(entry, expectedName, filename) {
  const owner = manifestAt(path.dirname(filename));
  assert.equal(
    owner.manifest.name,
    expectedName,
    `Wrong owning manifest for ${entry}`,
  );
  const resolved = fs.realpathSync(entry);
  const relative = path.relative(owner.directory, resolved);
  assert(
    relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    `Resolved entry escapes owning package ${expectedName}: ${entry}`,
  );
  return { ...owner, entry: resolved };
}
function installedManifest(owner, name) {
  assert.match(
    name,
    /^(?:@[\w.-]+\/)?[\w.-]+$/u,
    'Invalid installed dependency name',
  );
  assert(!['.', '..'].includes(name), 'Invalid installed dependency name');
  return (
    createRequire(owner.filename)
      // A manifest subpath always denotes an npm package, even when its name
      // also denotes a Node builtin (events, buffer, util, ...).
      .resolve.paths(`${name}/package.json`)
      ?.map(directory => path.join(directory, name, 'package.json'))
      .find(filename => fs.existsSync(filename))
  );
}
// Resolution only: no require(), import(), lifecycle scripts, or package execution.
function workspacePolicy(directory, catalogs) {
  while (true) {
    const filename = path.join(directory, 'pnpm-workspace.yaml');
    if (fs.existsSync(filename)) {
      if (!catalogs.has(filename)) {
        const bytes = fs.readFileSync(filename);
        catalogs.set(filename, { bytes, policy: parseYaml(bytes.toString()) });
      }
      return catalogs.get(filename).policy;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
const npmAlias = request =>
  /^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/u.exec(request ?? '');
const intersects = (selector, request) =>
  !selector ||
  selector === request ||
  (semver.validRange(selector) &&
    semver.validRange(request) &&
    semver.intersects(selector, request));
function effectiveRequest(owner, name, catalogs, policy) {
  // Linked packages can belong to another installation (including a shared
  // pnpm store). Its nearest workspace, not the caller's, owns that policy.
  policy = workspacePolicy(owner.directory, catalogs) ?? policy;
  let request = [...directBlocks, 'peerDependencies']
    .map(block => owner.manifest[block]?.[name])
    .find(value => typeof value === 'string');
  if (request?.startsWith('catalog:')) {
    policy ??= workspacePolicy(owner.directory, catalogs);
    assert(policy, `No pnpm workspace for ${name}`);
    const catalogName = request.slice('catalog:'.length);
    const catalog = catalogName
      ? policy?.catalogs?.[catalogName]
      : policy?.catalog;
    request = catalog?.[name];
    assert(
      typeof request === 'string' && !request.startsWith('catalog:'),
      `pnpm catalog ${catalogName || 'default'} omits ${name}`,
    );
  }
  // Support cohort authority is never rewritten by installer policy.
  if (names.includes(name)) return request;
  const matches = [];
  for (const [selector, replacement] of Object.entries(
    policy?.overrides ?? {},
  )) {
    // pnpm's parent delimiter excludes comparator ">"/">=" in ranges.
    const delimiter = selector.search(/[^ |@]>/u);
    const parent = delimiter < 0 ? null : selector.slice(0, delimiter + 1);
    const target = delimiter < 0 ? selector : selector.slice(delimiter + 2);
    const split = value => /^((?:@[^/]+\/)?[^@]+)(?:@(.+))?$/u.exec(value);
    const parentMatch = parent && split(parent);
    const targetMatch = split(target.replace(/:peer$/u, ''));
    if (
      parent &&
      (!parentMatch ||
        parentMatch[1] !== owner.manifest.name ||
        (parentMatch[2] &&
          !semver.satisfies(owner.manifest.version, parentMatch[2])))
    )
      continue;
    if (!targetMatch || targetMatch[1] !== name) continue;
    if (
      target.endsWith(':peer') &&
      !has(owner.manifest, 'peerDependencies', name)
    )
      continue;
    const range = targetMatch[2];
    if (!intersects(range, request)) continue;
    matches.push({ parent: !!parent, range, replacement });
  }
  const scoped = matches.some(match => match.parent)
    ? matches.filter(match => match.parent)
    : matches;
  // pnpm orders intersecting selectors last-first within the parent scope.
  const chosen = scoped.sort((a, b) =>
    intersects(b.range ?? '', a.range ?? '') ? -1 : 1,
  )[0];
  return chosen?.replacement ?? request;
}
function resolvePackage(owner, name, specifier, catalogs, policy, peerChecks) {
  const require = createRequire(owner.filename);
  let entry;
  try {
    entry = require.resolve(specifier);
  } catch (error) {
    // Declaration-only packages need not expose a runtime entry. This fallback
    // still uses Node's public resolution and respects package exports.
    try {
      assert(specifier === name);
      assert(!names.includes(name) || name === '@types/ioredis-mock');
      entry = require.resolve(`${name}/package.json`);
    } catch {
      throw error;
    }
  }
  const candidate = installedManifest(owner, name);
  assert(candidate, `No owning manifest for ${name} at ${owner.directory}`);
  return resolvedManifest(
    owner,
    name,
    entry,
    candidate,
    catalogs,
    policy,
    peerChecks,
  );
}
function resolvedManifest(
  owner,
  name,
  entry,
  candidate,
  catalogs,
  policy,
  peerChecks,
) {
  const request = effectiveRequest(owner, name, catalogs, policy);
  const alias = npmAlias(request);
  let expectedName = alias?.[1] ?? name;
  const actual = manifestAt(path.dirname(candidate));
  const deferredPeer =
    peerChecks &&
    !names.includes(name) &&
    expectedName === name &&
    actual.manifest.name !== name &&
    has(owner.manifest, 'peerDependencies', name) &&
    !directBlocks.some(block => has(owner.manifest, block, name));
  if (deferredPeer) expectedName = actual.manifest.name;
  const resolved = owningManifest(
    !entry || isBuiltin(entry) ? candidate : entry,
    expectedName,
    candidate,
  );
  if (alias)
    assert(
      semver.validRange(alias[2]) &&
        semver.satisfies(resolved.manifest.version, alias[2]),
      `${name}: installed alias version differs from installer authority`,
    );
  if (deferredPeer) peerChecks.push({ owner, name, resolved, request });
  // Node's public entry is the builtin, not the separately installed npm
  // package. Its physical manifest still owns the declared dependency graph,
  // just as an import-only package does without a CommonJS entry.
  return !entry || isBuiltin(entry) ? { ...resolved, entry: null } : resolved;
}
function resolveDependency(owner, name, catalogs, policy, peerChecks) {
  // Node supplies the search paths, so this works for ordinary and pnpm-linked
  // layouts without knowing store names. Import-only / subpath-only packages
  // may hide both "." and "./package.json"; their real manifest still owns the
  // dependency edges being traversed, but is not reported as a public entry.
  const candidate = installedManifest(owner, name);
  if (!candidate) {
    const optional =
      has(owner.manifest, 'optionalDependencies', name) ||
      owner.manifest.peerDependenciesMeta?.[name]?.optional === true;
    assert(
      optional,
      `${name}: required installed dependency is missing at ${owner.directory}`,
    );
    return null;
  }
  try {
    return resolvePackage(owner, name, name, catalogs, policy, peerChecks);
  } catch (error) {
    assert(
      ['ERR_PACKAGE_PATH_NOT_EXPORTED', 'MODULE_NOT_FOUND'].includes(
        error.code,
      ),
      error.message,
    );
    return resolvedManifest(
      owner,
      name,
      null,
      candidate,
      catalogs,
      policy,
      peerChecks,
    );
  }
}
function publicSpecifiers(name) {
  if (name === '@effect/opentelemetry')
    return [name, `${name}/NodeSdk`, `${name}/WebSdk`];
  return [name];
}
function snapshot(owner, role = 'root-direct') {
  return {
    role,
    bytes: packFiles(
      new Map([['package.json', { bytes: owner.bytes, mode: 0o644 }]]),
    ),
    supportPackages: supportEdges(owner.manifest),
  };
}
function inspectInstalled(owner, archive) {
  const expected = inspectSupportTarball(archive);
  const actual = [];
  function walk(relative = '') {
    for (const entry of fs.readdirSync(path.join(owner.directory, relative), {
      withFileTypes: true,
    })) {
      // Installed dependency links are not archive members. Nothing else may be
      // hidden here: extra runtime files and symlinks fail the exact inventory.
      if (!relative && entry.name === 'node_modules') continue;
      const file = path.posix.join(relative, entry.name);
      assert(
        !entry.isSymbolicLink(),
        `${owner.manifest.name}: installed symlink ${file}`,
      );
      if (entry.isDirectory()) walk(file);
      else {
        assert(entry.isFile(), `${owner.manifest.name}: non-file ${file}`);
        actual.push(file);
        const bytes = expected.fileContents.get(file);
        assert(
          bytes,
          `${owner.manifest.name}: unexpected installed file ${file}`,
        );
        assert(
          fs.readFileSync(path.join(owner.directory, file)).equals(bytes),
          `${owner.manifest.name}: installed bytes differ: ${file}`,
        );
      }
    }
  }
  walk();
  assert.deepEqual(
    actual.sort(),
    expected.files.map(file => file.path).sort(),
    `${owner.manifest.name}: installed file inventory differs`,
  );
  for (const file of expected.files)
    assert.equal(
      fs.statSync(path.join(owner.directory, file.path)).mode & 0o777,
      file.mode & 0o777,
      `${owner.manifest.name}: installed mode differs: ${file.path}`,
    );
  assert.equal(owner.manifest.name, expected.packageJson.name);
  assert.equal(owner.manifest.version, expected.packageJson.version);
  assert.deepEqual(owner.manifest.exports, expected.packageJson.exports);
  return expected.fileCount;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/**
 * Read-only acceptance of an already installed consumer importer and its reachable
 * installed graph, not an installer or a workspace discovery / runtime qualifier.
 * Call once per release-acceptance importer; root is its actual package directory.
 * All network injection is transport-only; reviewed pins,
 * policy, authenticators and archive reconstruction cannot be replaced.
 * Run through owned-temp-dir (required by verifySupportInputs).
 */
export async function verifySupportConsumer({
  root,
  workspaceRoot,
  descriptor,
  selectedPackages,
  fetchArtifact = fetch,
  readGithub,
  signal,
}) {
  assert(typeof root === 'string' && root, 'Consumer root required');
  assert(
    descriptor,
    'Support descriptor required; hosted acceptance is pending',
  );
  protocol.validateDescriptor(descriptor);
  // Snapshot caller JSON before awaiting network work.
  descriptor = structuredClone(descriptor);
  const consumer = manifestAt(path.resolve(root));
  const memberRoots = new Set(
    workspaceRoot === undefined
      ? [consumer.directory]
      : supportWorkspaceImporters(workspaceRoot),
  );
  assert(
    memberRoots.has(consumer.directory),
    'Consumer is not a workspace importer',
  );
  const direct = names.filter(name =>
    directBlocks.some(block => has(consumer.manifest, block, name)),
  );
  const selected = selectedPackages === undefined ? direct : selectedPackages;
  assert(
    Array.isArray(selected) && selected.length,
    'Nonempty selected support subset required',
  );
  assert.equal(
    new Set(selected).size,
    selected.length,
    'Duplicate selected support name',
  );
  for (const name of selected) {
    assert(names.includes(name), `Unknown selected support package: ${name}`);
    assert(
      direct.includes(name),
      `${name}: selected support must be a direct consumer request`,
    );
  }
  // An explicit list is not a skip list for other real direct support inputs.
  assert.deepEqual(
    [...selected].sort(),
    direct.sort(),
    'Selected support names omit actual direct inputs',
  );
  const selectedNames = [...selected].sort();
  const packedOwners = [snapshot(consumer)];
  const queue = [consumer];
  const seen = new Map();
  const owners = [];
  const resolutions = [];
  const catalogs = new Map();
  const policy = workspacePolicy(
    workspaceRoot === undefined
      ? consumer.directory
      : fs.realpathSync(workspaceRoot),
    catalogs,
  );
  const graphEdges = [];
  const peerChecks = [];
  const selectedRoots = new Map(
    selectedNames.map(name => [
      name,
      resolvePackage(consumer, name, name, catalogs, policy),
    ]),
  );
  while (queue.length) {
    signal?.throwIfAborted();
    const owner = queue.shift();
    if (seen.has(owner.directory)) continue;
    seen.set(owner.directory, owner);
    assert(
      seen.size <= 20000,
      'Installed consumer graph exceeds bounded review size',
    );
    const importer =
      owner.directory === consumer.directory ||
      (memberRoots.has(owner.directory) && !frameworkOwner(owner.manifest));
    const strictOwner =
      importer ||
      frameworkOwner(owner.manifest) ||
      commitsDescriptor(owner.manifest);
    // A descriptor-bearing manifest commits even without a support edge. Upstream
    // devDependencies do not participate in a consumer's installed runtime graph.
    const edges = supportEdges(owner.manifest).filter(
      name =>
        strictOwner ||
        ['dependencies', 'optionalDependencies', 'peerDependencies'].some(
          block => has(owner.manifest, block, name),
        ),
    );
    if (commitsDescriptor(owner.manifest) || (strictOwner && edges.length)) {
      assert.deepEqual(
        owner.manifest.ultramodern?.supportArtifacts,
        descriptor,
        `${owner.manifest.name}: owner must commit to exact support descriptor`,
      );
    }
    if (edges.length) {
      for (const name of edges) {
        const runtime =
          has(owner.manifest, 'dependencies', name) ||
          has(owner.manifest, 'optionalDependencies', name) ||
          has(owner.manifest, 'peerDependencies', name) ||
          has(owner.manifest, 'peerDependenciesMeta', name);
        // Published dev-only tooling is not a public peer requirement and is
        // not installed transitively. Its declared authority is still checked.
        if (strictOwner && !importer) {
          assert(
            !has(owner.manifest, 'dependencies', name) &&
              !has(owner.manifest, 'optionalDependencies', name),
            `${name}: framework owner must use a peer, not a private correction dependency`,
          );
          const development = owner.manifest.devDependencies?.[name];
          if (development !== undefined)
            assert(
              development === protocol.cohort[name] ||
                development === descriptor.packages[name].request,
              `${name}: wrong framework development authority`,
            );
          if (runtime) {
            assert.equal(
              owner.manifest.peerDependencies?.[name],
              protocol.cohort[name],
              `${name}: wrong framework peer`,
            );
            if (owner.manifest.peerDependenciesMeta?.[name]?.optional === true)
              assert.equal(
                name,
                '@effect/opentelemetry',
                'Only Effect support integration may be optional',
              );
          }
        }
        if (importer || runtime) {
          const optionalUpstream =
            !strictOwner &&
            (has(owner.manifest, 'optionalDependencies', name) ||
              (!has(owner.manifest, 'dependencies', name) &&
                owner.manifest.peerDependenciesMeta?.[name]?.optional ===
                  true));
          if (optionalUpstream && !selectedRoots.has(name)) continue;
          assert(
            selectedRoots.has(name),
            `${name}: owner closure requires a selected direct host`,
          );
          if (!strictOwner) {
            for (const block of [
              'dependencies',
              'optionalDependencies',
              'peerDependencies',
            ]) {
              if (!has(owner.manifest, block, name)) continue;
              const range = owner.manifest[block][name];
              assert(
                typeof range === 'string' &&
                  semver.validRange(range) &&
                  semver.satisfies(protocol.cohort[name], range),
                `${name}: upstream ${block} range does not admit selected support version`,
              );
            }
            if (
              optionalUpstream &&
              !resolveDependency(owner, name, catalogs, policy)
            )
              continue;
          }
          for (const specifier of publicSpecifiers(name)) {
            const resolved = resolvePackage(
              owner,
              name,
              specifier,
              catalogs,
              policy,
            );
            assert.equal(
              resolved.manifest.version,
              protocol.cohort[name],
              `${name}: wrong installed support version`,
            );
            assert.equal(
              resolved.directory,
              selectedRoots.get(name).directory,
              `${name}: wrong physical peer / duplicate support correction at ${owner.directory}`,
            );
            resolutions.push({
              owner: owner.directory,
              name,
              specifier,
              entry: resolved.entry,
              directory: resolved.directory,
            });
          }
        }
      }
      if (owner.directory !== consumer.directory && strictOwner)
        packedOwners.push(
          snapshot(owner, importer ? 'root-direct' : 'framework-peer'),
        );
      owners.push({
        directory: owner.directory,
        name: owner.manifest.name,
        role: importer
          ? 'root-direct'
          : strictOwner
            ? 'framework-peer'
            : 'upstream-runtime',
        supportPackages: edges,
      });
    }
    // Actual installed dependency closure, not a built-in guess about historical
    // framework package names. Transitive development edges are not installed.
    const blocks = importer
      ? [...directBlocks, 'peerDependencies']
      : ['dependencies', 'optionalDependencies', 'peerDependencies'];
    for (const name of new Set(
      blocks.flatMap(block => Object.keys(owner.manifest[block] ?? {})),
    )) {
      if (names.includes(name)) continue;
      const resolved = resolveDependency(
        owner,
        name,
        catalogs,
        policy,
        peerChecks,
      );
      if (resolved) {
        assert(
          !names.includes(resolved.manifest.name),
          `${name}: private support correction alias is forbidden`,
        );
        graphEdges.push({ owner, name, resolved });
        queue.push(resolved);
      }
    }
  }
  // A plain peer range may be supplied under an npm alias, but only by an
  // actual installer context that resolves this consumer and declares the host
  // identity. Ordinary npm copies may differ physically; support hosts may not.
  // Resolve the complete graph first: provider traversal order is not authority.
  const peerProven = peer =>
    graphEdges.some(edge => {
      if (edge.resolved.directory !== peer.owner.directory) return false;
      const providerEdge = graphEdges.find(
        candidate =>
          candidate.owner.directory === edge.owner.directory &&
          candidate.name === peer.name &&
          candidate.resolved.manifest.name === peer.resolved.manifest.name &&
          candidate.resolved.manifest.version ===
            peer.resolved.manifest.version &&
          (memberRoots.has(candidate.owner.directory)
            ? directBlocks
            : ['dependencies', 'optionalDependencies']
          ).some(block => has(candidate.owner.manifest, block, peer.name)),
      );
      if (!providerEdge) return false;
      const alias = npmAlias(
        effectiveRequest(edge.owner, peer.name, catalogs, policy),
      );
      return (
        alias?.[1] === peer.resolved.manifest.name &&
        semver.validRange(alias[2]) &&
        semver.satisfies(peer.resolved.manifest.version, alias[2]) &&
        semver.validRange(peer.request) &&
        semver.satisfies(peer.resolved.manifest.version, peer.request)
      );
    });
  // A nested importer may inherit peers from the workspace's installation
  // without itself depending on the package that supplies the alias. Consult
  // that actual root's installed graph, not unrelated packages in node_modules.
  if (
    workspaceRoot !== undefined &&
    peerChecks.some(peer => !peerProven(peer))
  ) {
    const contextQueue = [manifestAt(workspaceRoot)];
    const contextSeen = new Set();
    while (contextQueue.length) {
      signal?.throwIfAborted();
      const owner = contextQueue.shift();
      if (contextSeen.has(owner.directory)) continue;
      contextSeen.add(owner.directory);
      if (seen.has(owner.directory)) {
        contextQueue.push(
          ...graphEdges
            .filter(edge => edge.owner.directory === owner.directory)
            .map(edge => edge.resolved),
        );
        continue;
      }
      seen.set(owner.directory, owner);
      assert(
        seen.size <= 20000,
        'Installed consumer graph exceeds bounded review size',
      );
      if (
        commitsDescriptor(owner.manifest) ||
        (frameworkOwner(owner.manifest) && supportEdges(owner.manifest).length)
      )
        assert.deepEqual(
          owner.manifest.ultramodern?.supportArtifacts,
          descriptor,
          `${owner.manifest.name}: owner must commit to exact support descriptor`,
        );
      const blocks = memberRoots.has(owner.directory)
        ? [...directBlocks, 'peerDependencies']
        : ['dependencies', 'optionalDependencies', 'peerDependencies'];
      for (const name of new Set(
        blocks.flatMap(block => Object.keys(owner.manifest[block] ?? {})),
      )) {
        if (names.includes(name)) continue;
        const resolved = resolveDependency(
          owner,
          name,
          catalogs,
          policy,
          peerChecks,
        );
        if (!resolved) continue;
        assert(
          !names.includes(resolved.manifest.name),
          `${name}: private support correction alias is forbidden`,
        );
        graphEdges.push({ owner, name, resolved });
        contextQueue.push(resolved);
      }
    }
  }
  for (const peer of peerChecks)
    assert(
      peerProven(peer),
      `Wrong owning manifest for ${peer.name}: no installed peer provider alias authority`,
    );
  // Owners came from real manifest bytes; no caller manifest projections.
  const payloads = new Map();
  const transport = async (url, options) => {
    const bytes = await readBytes(url, { ...options, fetchArtifact });
    if (selectedNames.some(name => descriptor.packages[name].request === url))
      payloads.set(url, bytes);
    return new Response(bytes);
  };
  const pins = await verifySupportInputs({
    descriptor,
    owningPackages: packedOwners,
    readGithub: readGithub ?? githubReader({ fetchArtifact, signal }),
    fetchArtifact: transport,
    signal,
  });
  const packages = selectedNames.map(name => {
    const owner = selectedRoots.get(name);
    const files = inspectInstalled(owner, payloads.get(pins[name].request));
    return {
      name,
      version: pins[name].version,
      directory: owner.directory,
      entry: owner.entry,
      files,
      request: pins[name].request,
      integrity: pins[name].integrity,
    };
  });
  // Detect manifest/resolution changes during authentication before issuing proof.
  for (const owner of seen.values())
    assert(
      fs.readFileSync(owner.filename).equals(owner.bytes),
      `Installed owner manifest changed during verification: ${owner.filename}`,
    );
  for (const [filename, { bytes }] of catalogs)
    assert(
      fs.readFileSync(filename).equals(bytes),
      `Installed workspace catalog changed during verification: ${filename}`,
    );
  if (workspaceRoot !== undefined)
    assert.deepEqual(
      supportWorkspaceImporters(workspaceRoot),
      [...memberRoots].sort(),
      'Workspace importer membership changed during verification',
    );
  for (const { owner, name, resolved } of graphEdges) {
    const current = resolveDependency(owner, name, catalogs, policy, []);
    assert.equal(
      current?.directory,
      resolved.directory,
      'Installed dependency resolution changed during verification',
    );
    assert.equal(
      current?.entry,
      resolved.entry,
      'Installed dependency entry changed during verification',
    );
  }
  for (const resolution of resolutions) {
    const owner = manifestAt(resolution.owner);
    const current = resolvePackage(
      owner,
      resolution.name,
      resolution.specifier,
      catalogs,
      policy,
    );
    assert.equal(
      current.directory,
      resolution.directory,
      'Support resolution changed during verification',
    );
    assert.equal(
      current.entry,
      resolution.entry,
      'Support entry changed during verification',
    );
  }
  signal?.throwIfAborted();
  return freeze({
    schema: 'ultramodern.support-consumer.v1',
    root: consumer.directory,
    producer: descriptor.producer,
    selectedPackages: selectedNames,
    packages,
    owners,
    resolutions,
    validation: 'static-installed-bytes-and-resolution-only',
  });
}

export function parseSupportConsumerArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    assert(
      ['--root', '--descriptor', '--select'].includes(option),
      `Unknown option: ${option}`,
    );
    assert(!Object.hasOwn(result, option), `Duplicate option: ${option}`);
    const value = argv[++i];
    assert(value && !value.startsWith('--'), `Missing value for ${option}`);
    result[option] = value;
  }
  assert(
    result['--root'] && result['--descriptor'],
    'Usage: --root <installed consumer> --descriptor <JSON file> [--select <comma-separated names>]',
  );
  return {
    root: result['--root'],
    descriptorPath: result['--descriptor'],
    ...(result['--select']
      ? { selectedPackages: result['--select'].split(',') }
      : {}),
  };
}
if (isDirectRun(import.meta.url)) {
  try {
    const { descriptorPath, ...options } = parseSupportConsumerArgs(
      process.argv.slice(2),
    );
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    console.log(
      JSON.stringify(
        await verifySupportConsumer({ ...options, descriptor }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
