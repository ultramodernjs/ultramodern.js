#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
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
function owningManifest(entry, expectedName) {
  let directory = path.dirname(fs.realpathSync(entry));
  for (;;) {
    const filename = path.join(directory, 'package.json');
    if (fs.existsSync(filename)) {
      const owner = manifestAt(directory);
      if (owner.manifest.name) {
        assert.equal(
          owner.manifest.name,
          expectedName,
          `Wrong owning manifest for ${entry}`,
        );
        return { ...owner, entry: fs.realpathSync(entry) };
      }
    }
    const parent = path.dirname(directory);
    assert(
      parent !== directory && path.basename(directory) !== 'node_modules',
      `No owning manifest for ${entry}`,
    );
    directory = parent;
  }
}
// Resolution only: no require(), import(), lifecycle scripts, or package execution.
function dependencyName(owner, name, catalogs) {
  let request = [...directBlocks, 'peerDependencies']
    .map(block => owner.manifest[block]?.[name])
    .find(value => typeof value === 'string');
  if (request?.startsWith('catalog:')) {
    let directory = owner.directory;
    let filename = path.join(directory, 'pnpm-workspace.yaml');
    while (!fs.existsSync(filename)) {
      const parent = path.dirname(directory);
      assert(parent !== directory, `No pnpm workspace for ${name}`);
      directory = parent;
      filename = path.join(directory, 'pnpm-workspace.yaml');
    }
    if (!catalogs.has(filename)) {
      const bytes = fs.readFileSync(filename);
      catalogs.set(filename, { bytes, policy: parseYaml(bytes.toString()) });
    }
    const { policy } = catalogs.get(filename);
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
  const alias = /^npm:((?:@[^/]+\/)?[^@]+)@/u.exec(request ?? '');
  return alias?.[1] ?? name;
}
function resolvePackage(owner, name, specifier, catalogs) {
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
  return owningManifest(entry, dependencyName(owner, name, catalogs));
}
function resolveDependency(owner, name, catalogs) {
  assert.match(
    name,
    /^(?:@[\w.-]+\/)?[\w.-]+$/u,
    'Invalid installed dependency name',
  );
  assert(!['.', '..'].includes(name), 'Invalid installed dependency name');
  const require = createRequire(owner.filename);
  // Node supplies the search paths, so this works for ordinary and pnpm-linked
  // layouts without knowing store names. Import-only / subpath-only packages
  // may hide both "." and "./package.json"; their real manifest still owns the
  // dependency edges being traversed, but is not reported as a public entry.
  const candidate = require.resolve
    .paths(name)
    ?.map(directory => path.join(directory, name, 'package.json'))
    .find(filename => fs.existsSync(filename));
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
    return resolvePackage(owner, name, name, catalogs);
  } catch (error) {
    assert(
      ['ERR_PACKAGE_PATH_NOT_EXPORTED', 'MODULE_NOT_FOUND'].includes(
        error.code,
      ),
      error.message,
    );
    const resolved = owningManifest(
      candidate,
      dependencyName(owner, name, catalogs),
    );
    return { ...resolved, entry: null };
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
  const selectedRoots = new Map(
    selectedNames.map(name => [
      name,
      resolvePackage(consumer, name, name, catalogs),
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
    const importer = owner.directory === consumer.directory;
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
            if (optionalUpstream && !resolveDependency(owner, name, catalogs))
              continue;
          }
          for (const specifier of publicSpecifiers(name)) {
            const resolved = resolvePackage(owner, name, specifier, catalogs);
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
      if (!importer && strictOwner)
        packedOwners.push(snapshot(owner, 'framework-peer'));
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
      const resolved = resolveDependency(owner, name, catalogs);
      if (resolved) {
        assert(
          !names.includes(resolved.manifest.name),
          `${name}: private support correction alias is forbidden`,
        );
        queue.push(resolved);
      }
    }
  }
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
  for (const resolution of resolutions) {
    const owner = manifestAt(resolution.owner);
    const current = resolvePackage(
      owner,
      resolution.name,
      resolution.specifier,
      catalogs,
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
