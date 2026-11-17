import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { parsePnpmLockfile } from '../lib/parse-pnpm-lockfile.mjs';

const fields = ['dependencies', 'optionalDependencies'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const record = value =>
  value && typeof value === 'object' && !Array.isArray(value);
const sorted = values =>
  [...values].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
const packageNamePattern =
  /^(?:@[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9_.-]*$/u;
const exactVersionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/u;

function within(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function packageIdentity(key) {
  const match = /^(@[^/]+\/[^@]+|[^@]+)@([^()]+)/u.exec(key);
  assert.ok(match, `Unsupported raw package identity: ${key}`);
  return { name: match[1], version: match[2] };
}

function snapshotKey(name, version) {
  assert.equal(
    typeof version,
    'string',
    `Missing raw dependency version for ${name}`,
  );
  return /^(?:\d|https?:\/\/)/u.test(version) ? `${name}@${version}` : version;
}

function yamlDocuments(source, label) {
  return parseAllDocuments(source).map(document => {
    assert.equal(
      document.errors.length,
      0,
      `Invalid ${label}: ${document.errors[0]?.message}`,
    );
    const value = document.toJS();
    assert.ok(record(value), `Expected ${label} mapping`);
    return value;
  });
}

function correctedVersions(packageName, versions) {
  assert.ok(
    record(versions) && Object.keys(versions).length > 0,
    `Expected corrected ${packageName} versions`,
  );
  const corrected = new Map();
  for (const [version, entry] of Object.entries(versions).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    assert.match(
      version,
      exactVersionPattern,
      `Expected exact corrected ${packageName} version: ${version}`,
    );
    assert.ok(record(entry), `Expected ${packageName}@${version} correction`);
    const { expectedIntegrity, patchSha256, referenceFiles } = entry;
    assert.match(
      expectedIntegrity,
      /^sha512-[A-Za-z0-9+/]+={0,2}$/u,
      `Expected authenticated ${packageName}@${version} integrity`,
    );
    assert.match(
      patchSha256,
      /^[a-f0-9]{64}$/u,
      `Expected canonical ${packageName}@${version} patch hash`,
    );
    assert.ok(
      referenceFiles instanceof Map && referenceFiles.size > 0,
      `Expected authenticated ${packageName}@${version} reference files`,
    );
    const reference = new Map();
    for (const [name, bytes] of referenceFiles) {
      assert.ok(
        typeof name === 'string' &&
          name !== '' &&
          !name.includes('\\') &&
          !path.posix.isAbsolute(name) &&
          name
            .split('/')
            .every(part => part !== '' && part !== '.' && part !== '..'),
        `Unsafe reference file: ${name}`,
      );
      assert.ok(
        Buffer.isBuffer(bytes) || bytes instanceof Uint8Array,
        `Expected reference bytes for ${name}`,
      );
      reference.set(name, Buffer.from(bytes));
    }
    const referenceManifest = JSON.parse(
      reference.get('package.json')?.toString('utf8') ?? 'null',
    );
    assert.equal(
      referenceManifest?.name,
      packageName,
      'Reference package must retain its upstream name',
    );
    assert.equal(
      referenceManifest?.version,
      version,
      'Reference package must retain its upstream version',
    );
    const identity = `${packageName}@${version}`;
    corrected.set(version, {
      version,
      identity,
      expectedIntegrity,
      patchSha256,
      reference,
      snapshot: `${identity}(patch_hash=${patchSha256})`,
    });
  }
  return corrected;
}

/** Prove every raw and installed production occurrence uses its authenticated patched payload. */
export function inspectInstalledCorrectionGraph({
  root,
  packageName,
  versions,
}) {
  assert.equal(typeof root, 'string', 'Expected repository root');
  assert.ok(
    typeof packageName === 'string' && packageNamePattern.test(packageName),
    `Expected corrected package name: ${packageName}`,
  );
  const corrected = correctedVersions(packageName, versions);
  const prefix = `${packageName}@`;
  const repository = fs.realpathSync(root);
  const observed = new Map();
  const resolutions = new Map();
  const payloads = new Map();
  const statIdentity = stat =>
    [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(
      String,
    );
  const pathState = file => {
    const stat = fs.lstatSync(file, { bigint: true });
    return {
      stat: statIdentity(stat),
      link: stat.isSymbolicLink() ? fs.readlinkSync(file) : null,
    };
  };
  const observeDirectory = directory => {
    const stat = fs.lstatSync(directory, { bigint: true });
    assert.ok(
      stat.isDirectory() && !stat.isSymbolicLink(),
      `Expected physical directory: ${directory}`,
    );
    // Directory contents can change independently; payload sets and dependency resolution are checked below.
    const next = {
      directory: [String(stat.dev), String(stat.ino), String(stat.mode)],
    };
    if (observed.has(directory))
      assert.deepEqual(
        observed.get(directory),
        next,
        `Directory changed during graph inspection: ${directory}`,
      );
    observed.set(directory, next);
  };
  const read = file => {
    assert.ok(within(repository, file), `File escaped repository: ${file}`);
    const state = pathState(file);
    assert.equal(
      state.link,
      null,
      `Expected regular file, not symbolic link: ${file}`,
    );
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    let bytes;
    try {
      const before = fs.fstatSync(fd, { bigint: true });
      assert.ok(before.isFile(), `Expected regular file: ${file}`);
      assert.deepEqual(
        statIdentity(before),
        state.stat,
        `File changed while opening: ${file}`,
      );
      bytes = fs.readFileSync(fd);
      assert.deepEqual(
        statIdentity(fs.fstatSync(fd, { bigint: true })),
        state.stat,
        `File changed while reading: ${file}`,
      );
    } finally {
      fs.closeSync(fd);
    }
    const next = { ...state, sha256: digest(bytes) };
    if (observed.has(file))
      assert.deepEqual(
        observed.get(file),
        next,
        `File changed during graph inspection: ${file}`,
      );
    observed.set(file, next);
    return bytes;
  };
  observeDirectory(repository);
  const lockSource = read(path.join(repository, 'pnpm-lock.yaml')).toString(
    'utf8',
  );
  const workspaceDocuments = yamlDocuments(
    read(path.join(repository, 'pnpm-workspace.yaml')).toString('utf8'),
    'workspace',
  );
  assert.equal(workspaceDocuments.length, 1, 'Expected one workspace document');
  const workspace = workspaceDocuments[0];
  for (const { identity, patchSha256 } of corrected.values()) {
    const patchPath = workspace.patchedDependencies?.[identity];
    assert.equal(
      typeof patchPath,
      'string',
      `Workspace must register the exact ${identity} patch`,
    );
    assert.ok(
      !path.isAbsolute(patchPath) && !patchPath.includes('\\'),
      `Unsafe ${identity} patch path`,
    );
    const patchFile = path.resolve(repository, patchPath);
    assert.ok(
      within(repository, patchFile) && fs.realpathSync(patchFile) === patchFile,
      `${identity} patch escaped its physical repository`,
    );
    assert.equal(
      digest(read(patchFile)),
      patchSha256,
      `Canonical ${identity} patch bytes differ`,
    );
  }
  const lock = parsePnpmLockfile(lockSource);
  assert.ok(
    record(lock?.importers) &&
      record(lock?.packages) &&
      record(lock?.snapshots),
    'Expected complete pnpm lock graph',
  );
  for (const { identity, patchSha256 } of corrected.values())
    assert.equal(
      lock.patchedDependencies?.[identity],
      patchSha256,
      `Lock must register the exact ${identity} patch hash`,
    );
  const admitted = reference =>
    [...corrected.values()].some(
      ({ snapshot }) =>
        reference.startsWith(`${snapshot})`) ||
        reference.startsWith(`${snapshot}(`),
    );
  const assertCorrectedReference = key => {
    if (key.startsWith(prefix)) {
      assert.ok(
        [...corrected.values()].some(
          ({ snapshot }) => key === snapshot || key.startsWith(`${snapshot}(`),
        ),
        `Unpatched or unexpected ${packageName} snapshot: ${key}`,
      );
    }
    for (
      let index = key.indexOf(`(${prefix}`);
      index !== -1;
      index = key.indexOf(`(${prefix}`, index + 1)
    ) {
      assert.ok(
        admitted(key.slice(index + 1)),
        `Unpatched ${packageName} peer context: ${key}`,
      );
    }
  };
  const documents = yamlDocuments(lockSource, 'lockfile');
  const mergedRecords = new Map();
  const packageRecords = new Map();
  for (const document of documents) {
    for (const section of ['packages', 'snapshots']) {
      for (const [key, value] of Object.entries(document[section] ?? {})) {
        const context = `${section}:${key}`;
        if (mergedRecords.has(context))
          assert.deepEqual(
            value,
            mergedRecords.get(context),
            `Conflicting raw lock record: ${context}`,
          );
        mergedRecords.set(context, value);
        if (section === 'packages' && key.startsWith(prefix)) {
          const version = key.slice(prefix.length);
          const correction = corrected.get(version);
          assert.equal(
            key,
            correction?.identity,
            `Unexpected ${packageName} package record: ${key}`,
          );
          assert.equal(
            value.resolution?.integrity,
            correction.expectedIntegrity,
            `${correction.identity} upstream integrity differs`,
          );
          packageRecords.set(version, (packageRecords.get(version) ?? 0) + 1);
        } else if (section === 'snapshots') assertCorrectedReference(key);
      }
    }
    for (const section of ['importers', 'snapshots']) {
      for (const [parentKey, value] of Object.entries(
        document[section] ?? {},
      )) {
        for (const field of [
          ...fields,
          ...(section === 'importers' ? ['devDependencies'] : []),
        ]) {
          for (const [name, entry] of Object.entries(value[field] ?? {})) {
            const version = section === 'importers' ? entry.version : entry;
            const key = snapshotKey(name, version);
            if (name === packageName)
              assert.ok(
                key.startsWith(prefix),
                `Unexpected ${packageName} alias: ${parentKey} > ${key}`,
              );
            assertCorrectedReference(key);
            if (key.startsWith(prefix))
              assert.ok(
                Object.hasOwn(lock.snapshots, key),
                `Missing raw ${packageName} snapshot: ${key}`,
              );
          }
        }
      }
    }
  }
  for (const { version, identity } of corrected.values())
    assert.ok(
      packageRecords.has(version),
      `No ${identity} package record was found`,
    );

  const nodes = new Map();
  const reverse = new Map();
  const importerId = importer => `importer:${importer}`;
  const snapshotId = key => `snapshot:${key}`;
  const importerDirectory = importer => {
    assert.ok(
      importer === '.' ||
        (typeof importer === 'string' &&
          !importer.includes('\\') &&
          !path.posix.isAbsolute(importer) &&
          path.posix.normalize(importer) === importer &&
          !importer.split('/').includes('..')),
      `Unsafe importer path: ${importer}`,
    );
    const directory = path.resolve(repository, importer);
    assert.ok(
      within(repository, directory),
      `Importer escaped repository: ${importer}`,
    );
    return directory;
  };
  const queue = Object.keys(lock.importers).map(importer => ({
    id: importerId(importer),
    importer,
  }));
  for (let position = 0; position < queue.length; position += 1) {
    const node = queue[position];
    if (nodes.has(node.id)) continue;
    const value =
      node.importer === undefined
        ? lock.snapshots[node.key]
        : lock.importers[node.importer];
    assert.ok(
      record(value),
      `Missing raw lock snapshot or importer: ${node.key ?? node.importer}`,
    );
    if (node.importer !== undefined) importerDirectory(node.importer);
    const edges = [];
    nodes.set(node.id, { ...node, edges });
    for (const field of fields) {
      for (const [dependencyKey, entry] of Object.entries(value[field] ?? {})) {
        const version = node.importer === undefined ? entry : entry.version;
        assert.equal(
          typeof version,
          'string',
          `Missing raw dependency version: ${node.id} > ${dependencyKey}`,
        );
        let child;
        if (version.startsWith('link:')) {
          // pnpm records importer links relative to the importer and snapshot peer links relative to the workspace.
          const linkedDirectory = path.resolve(
            node.importer === undefined
              ? repository
              : importerDirectory(node.importer),
            version.slice(5),
          );
          assert.ok(
            within(repository, linkedDirectory),
            `Workspace link escaped repository: ${version}`,
          );
          const importer =
            path
              .relative(repository, linkedDirectory)
              .split(path.sep)
              .join('/') || '.';
          assert.ok(
            Object.hasOwn(lock.importers, importer),
            `Missing linked importer: ${importer}`,
          );
          child = { id: importerId(importer), importer };
        } else {
          const key = snapshotKey(dependencyKey, version);
          assert.ok(
            Object.hasOwn(lock.snapshots, key),
            `Missing raw lock snapshot: ${key}`,
          );
          child = { id: snapshotId(key), key };
        }
        edges.push({ dependencyKey, child: child.id });
        const parents = reverse.get(child.id) ?? new Set();
        parents.add(node.id);
        reverse.set(child.id, parents);
        queue.push(child);
      }
    }
  }
  const relevant = new Set(
    [...nodes.values()]
      .filter(node => node.key?.startsWith(prefix))
      .map(node => node.id),
  );
  const pending = [...relevant];
  for (let position = 0; position < pending.length; position += 1) {
    for (const parent of reverse.get(pending[position]) ?? []) {
      if (!relevant.has(parent)) {
        relevant.add(parent);
        pending.push(parent);
      }
    }
  }

  const manifest = directory => {
    assert.ok(
      within(repository, directory),
      `Installed package borrowed an external root: ${directory}`,
    );
    observeDirectory(directory);
    const value = JSON.parse(
      read(path.join(directory, 'package.json')).toString('utf8'),
    );
    assert.ok(
      record(value),
      `Missing installed package manifest: ${directory}`,
    );
    return value;
  };
  const resolveDependency = (parent, dependencyKey) => {
    assert.match(
      dependencyKey,
      /^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/u,
      `Unsafe dependency key: ${dependencyKey}`,
    );
    const paths = createRequire(
      path.join(parent, 'package.json'),
    ).resolve.paths(dependencyKey);
    assert.ok(
      Array.isArray(paths),
      `Unsupported dependency resolution: ${dependencyKey}`,
    );
    for (const directory of paths) {
      const logical = path.join(directory, dependencyKey);
      const stat = fs.lstatSync(logical, { throwIfNoEntry: false });
      if (!stat) continue;
      const physical = fs.realpathSync(logical);
      assert.ok(
        within(repository, logical) && within(repository, physical),
        `Installed dependency borrowed an external root: ${logical} > ${physical}`,
      );
      const state = { logical, physical, ...pathState(logical) };
      return state;
    }
    throw new Error(
      `Missing installed dependency: ${parent} > ${dependencyKey}`,
    );
  };
  const listPayload = (directory, reference) => {
    const files = [];
    const walk = (current, prefix = '') => {
      for (const name of fs.readdirSync(current).sort()) {
        const file = path.join(current, name);
        const relative = prefix ? `${prefix}/${name}` : name;
        const stat = fs.lstatSync(file);
        assert.ok(
          !stat.isSymbolicLink(),
          `${packageName} payload contains a symbolic link: ${file}`,
        );
        if (stat.isDirectory()) {
          assert.ok(
            [...reference.keys()].some(key => key.startsWith(`${relative}/`)),
            `Unexpected ${packageName} payload directory: ${relative}`,
          );
          walk(file, relative);
        } else {
          assert.ok(
            stat.isFile(),
            `${packageName} payload is not a regular file: ${file}`,
          );
          files.push(relative);
        }
      }
    };
    walk(directory);
    return files.sort();
  };
  const targets = new Map();
  const identities = [];
  const physicalQueue = [...nodes.values()]
    .filter(node => node.importer !== undefined && relevant.has(node.id))
    .map(node => ({
      importer: node.importer,
      node,
      directory: importerDirectory(node.importer),
    }));
  const seen = new Set();
  for (let position = 0; position < physicalQueue.length; position += 1) {
    const current = physicalQueue[position];
    const physicalParent = fs.realpathSync(current.directory);
    assert.ok(
      within(repository, physicalParent),
      `Importer borrowed an external root: ${current.directory}`,
    );
    const visit = JSON.stringify([
      current.importer,
      current.node.id,
      physicalParent,
    ]);
    if (seen.has(visit)) continue;
    seen.add(visit);
    const parentManifest = manifest(physicalParent);
    for (const edge of current.node.edges) {
      if (!relevant.has(edge.child)) continue;
      assert.ok(
        [...fields, 'peerDependencies'].some(field =>
          Object.hasOwn(parentManifest[field] ?? {}, edge.dependencyKey),
        ),
        `Installed parent does not declare its lock dependency: ${physicalParent} > ${edge.dependencyKey}`,
      );
      const child = nodes.get(edge.child);
      const resolved = resolveDependency(physicalParent, edge.dependencyKey);
      const key = JSON.stringify([physicalParent, edge.dependencyKey]);
      if (resolutions.has(key))
        assert.deepEqual(
          resolutions.get(key).state,
          resolved,
          `Dependency resolution changed during inspection: ${key}`,
        );
      resolutions.set(key, {
        parent: physicalParent,
        dependencyKey: edge.dependencyKey,
        state: resolved,
      });
      const value = manifest(resolved.physical);
      if (child.importer !== undefined) {
        assert.equal(
          resolved.physical,
          fs.realpathSync(importerDirectory(child.importer)),
          `Installed workspace link differs from lock importer: ${child.importer}`,
        );
      } else {
        const expected = packageIdentity(child.key);
        assert.equal(
          value.name,
          expected.name,
          `Installed dependency name differs from raw snapshot: ${child.key}`,
        );
        const version = /^\d/u.test(expected.version)
          ? expected.version
          : lock.packages[child.key.split('(')[0]]?.version;
        assert.equal(
          typeof version,
          'string',
          `Missing lock package version: ${child.key}`,
        );
        assert.equal(
          value.version,
          version,
          `Installed dependency version differs from raw snapshot: ${child.key}`,
        );
      }
      identities.push({
        importer: current.importer,
        rawparentkey: current.node.key ?? `importer:${current.node.importer}`,
        dependencyKey: edge.dependencyKey,
        physicalparent: physicalParent,
        physicaltarget: resolved.physical,
        name: value.name ?? null,
        version: value.version ?? null,
        snapshot: child.key ?? `importer:${child.importer}`,
      });
      if (value.name === packageName) {
        const correction = corrected.get(value.version);
        assert.ok(
          correction && child.key?.startsWith(correction.snapshot),
          `Installed ${packageName} version is not corrected: ${resolved.physical}`,
        );
        if (targets.has(resolved.physical))
          assert.equal(
            targets.get(resolved.physical),
            correction.version,
            `Installed ${packageName} payload changed version: ${resolved.physical}`,
          );
        targets.set(resolved.physical, correction.version);
        if (!payloads.has(resolved.physical)) {
          const files = listPayload(resolved.physical, correction.reference);
          assert.deepEqual(
            files,
            [...correction.reference.keys()].sort(),
            `Installed ${correction.identity} payload file set differs: ${resolved.physical}`,
          );
          for (const file of files)
            assert.ok(
              read(path.join(resolved.physical, file)).equals(
                correction.reference.get(file),
              ),
              `Installed ${correction.identity} payload bytes differ: ${resolved.physical}/${file}`,
            );
          payloads.set(resolved.physical, {
            files,
            reference: correction.reference,
          });
        }
      }
      physicalQueue.push({
        importer: current.importer,
        node: child,
        directory: resolved.physical,
      });
    }
  }
  for (const { version, identity } of corrected.values())
    assert.ok(
      [...targets.values()].includes(version),
      `No installed production consumer reaches patched ${identity}`,
    );
  const assertUnchanged = () => {
    for (const [file, expected] of observed) {
      if (expected.directory) {
        const stat = fs.lstatSync(file, { bigint: true });
        assert.ok(
          stat.isDirectory() && !stat.isSymbolicLink(),
          `Observed directory changed: ${file}`,
        );
        assert.deepEqual(
          [String(stat.dev), String(stat.ino), String(stat.mode)],
          expected.directory,
          `Observed directory identity changed: ${file}`,
        );
      } else {
        assert.deepEqual(
          pathState(file),
          { stat: expected.stat, link: expected.link },
          `Observed file identity changed: ${file}`,
        );
        assert.equal(
          digest(read(file)),
          expected.sha256,
          `Observed file bytes changed: ${file}`,
        );
      }
    }
    for (const { parent, dependencyKey, state } of resolutions.values())
      assert.deepEqual(
        resolveDependency(parent, dependencyKey),
        state,
        `Installed dependency edge changed: ${parent} > ${dependencyKey}`,
      );
    for (const [directory, { files, reference }] of payloads)
      assert.deepEqual(
        listPayload(directory, reference),
        files,
        `Installed ${packageName} payload file set changed: ${directory}`,
      );
  };
  assertUnchanged();
  return {
    targets: [...targets]
      .map(([target, version]) => ({ root: target, version }))
      .sort(
        (a, b) =>
          a.root.localeCompare(b.root) || a.version.localeCompare(b.version),
      ),
    identities: sorted(identities),
    digests: [...observed]
      .filter(([, value]) => value.sha256 !== undefined)
      .map(([file, value]) => ({ path: file, sha256: value.sha256 }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    assertUnchanged,
  };
}
