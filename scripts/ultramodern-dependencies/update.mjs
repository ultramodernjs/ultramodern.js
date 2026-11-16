import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import semver from 'semver';
import {
  admitArtifactDescriptors,
  admittedArtifacts,
} from './artifact-admission.mjs';
import {
  artifactOwners,
  coordinatedTransitions,
  currentNames,
  holds,
  queriedAt,
  reviewedRemovals,
  routerDomRemovals,
  rslibPatchSha256,
  satisfiedExceptions,
  sourceRevision,
  targets,
  traceConsolidation,
} from './snapshot.mjs';
import { sourcePinCoverage } from './source-pins.mjs';

const fields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const rootPins = [
  ['packageManager', 'pnpm@12.21.0'],
  ['engines.node', '>=26.13.1'],
  ['engines.pnpm', '>=12.21.0'],
];
const allowedPath = file =>
  file === 'package.json' ||
  file === 'tests/package.json' ||
  /^(packages|scripts|tests|examples|benchmark)\/.+\/package\.json$/.test(file);
const excludedFixture = file =>
  /^tests\/skill\/fixtures\/[^/]+\/package\.json$/.test(file) ||
  file === 'packages/server/core/tests/fixtures/load-plugins/package.json' ||
  file === 'packages/toolkit/utils/tests/fixtures/plugin/package.json';

function replacement({ file, field, name, value }) {
  const edge = { name, from: value, target: targets[name] ?? null };
  if (
    /^tests\/integration\/routes-tanstack-mf\/(?:mf-host|mf-remote|mf-remote-2)\/package\.json$/.test(
      file,
    ) &&
    field === 'dependencies' &&
    name === '@tanstack/react-router' &&
    value === '1.170.44'
  )
    return {
      ...edge,
      status: 'update',
      to: '1.170.46',
      reason:
        'reviewed repository fixture with canonical router-core correction; hosted adoption pending',
    };
  if (
    file === 'packages/toolkit/runtime-utils/package.json' &&
    field === 'devDependencies' &&
    ['ioredis-mock', '@types/ioredis-mock'].includes(name) &&
    value === `^${edge.target}`
  )
    return {
      ...edge,
      status: 'update',
      to: edge.target,
      reason: 'exact owning corrected metadata input; hosted adoption pending',
    };
  if (/^(workspace:|file:|link:)/.test(value))
    return { ...edge, status: 'local' };
  if (
    field === 'peerDependencies' &&
    !semver.valid(value) &&
    edge.target &&
    semver.satisfies(edge.target, value)
  )
    return { ...edge, status: 'admitting-peer' };
  const coordinated = coordinatedTransitions[name];
  if (coordinated && !/^(https?:|git|github:|ssh:)/.test(value)) {
    assert(
      coordinated.from.includes(value),
      `${file}: unreviewed coordinated old edge ${field}.${name}: ${value}`,
    );
    return {
      ...edge,
      target: coordinated.to,
      to:
        semver.valid(coordinated.to) && /^[~^]/.test(value)
          ? `${value[0]}${coordinated.to}`
          : coordinated.to,
      status: 'update',
      reason:
        'reviewed source target; runtime/publication qualification pending',
    };
  }
  if (satisfiedExceptions[name] === value)
    return {
      ...edge,
      status: 'satisfied-exception',
      reason: holds[name],
    };
  if (
    file === 'packages/toolkit/ultramodern-create/package.json' &&
    field === 'dependencies' &&
    name === '@typescript/native'
  ) {
    assert.equal(
      value,
      `npm:typescript@${targets.typescript}`,
      'Generator native TypeScript API alias must select the reviewed stable release',
    );
    return {
      ...edge,
      target: targets.typescript,
      status: 'satisfied-exception',
      reason:
        'native API metadata resolves the reviewed stable TypeScript package, not another compiler backend',
    };
  }
  if (/^(npm:|https?:|git|github:|ssh:|bitbucket:|gitlab:)/.test(value))
    return {
      ...edge,
      status: 'held',
      reason: 'preserve corrected/source identity',
    };
  if (
    name === 'tailwindcss' &&
    /^tests\/integration\/tailwindcss\/fixtures\/tailwindcss-v[23]\/package\.json$/.test(
      file,
    )
  )
    return { ...edge, status: 'fixture', reason: 'semantic Tailwind major' };
  if (name.startsWith('@modern-js/') && !currentNames.has(name))
    return { ...edge, status: 'held', reason: 'local release cohort identity' };
  const hold =
    holds[name] ??
    (name.startsWith('@module-federation/')
      ? 'MF sidecar/canonical patch cohort review'
      : undefined);
  if (hold) return { ...edge, status: 'held', reason: hold };
  if (!edge.target)
    return {
      ...edge,
      status: currentNames.has(name) ? 'snapshot-current' : 'unknown',
    };
  const exact = semver.valid(value);
  const simpleRange = /^[~^]\d+(?:\.\d+){0,2}(?:-[\w.-]+)?$/.test(value);
  if (!exact && !simpleRange)
    return {
      ...edge,
      status: 'held',
      reason: 'non-simple range/tag requires review',
    };
  const oldVersion = exact || semver.minVersion(value).version;
  if (semver.gt(oldVersion, edge.target))
    return { ...edge, status: 'held', reason: 'never downgrade' };
  const to = `${exact ? '' : value[0]}${edge.target}`;
  return { ...edge, to, status: value === to ? 'current' : 'update' };
}

export function planManifestUpdate({
  path: file,
  expected,
  current,
  sourceRevision: revision,
  artifactAuthority,
}) {
  assert.equal(revision, sourceRevision, 'unreviewed snapshot source revision');
  const artifacts = admittedArtifacts(artifactAuthority);
  const admittedPin = name =>
    Object.entries(artifacts).find(([kind]) =>
      artifactOwners[kind]?.[file]?.includes(name),
    )?.[1].packages[name];
  assert(
    allowedPath(file) && !file.split('/').includes('..'),
    'path outside manifest allowlist',
  );
  const manifest = structuredClone(current);
  const reviewed = structuredClone(expected);
  const actualManifest = structuredClone(current);
  const edges = [];
  const changes = [];
  const tanstack = {
    '@tanstack/react-router': ['1.170.44', '1.170.46'],
    '@tanstack/router-core': ['1.171.37', '1.171.39'],
  };
  if (
    file === 'packages/runtime/plugin-tanstack/package.json' &&
    Object.entries(tanstack).every(
      ([name, [from]]) =>
        expected.dependencies?.[name] === from &&
        !Object.hasOwn(expected.peerDependencies ?? {}, name) &&
        !Object.hasOwn(expected.devDependencies ?? {}, name),
    )
  ) {
    const original = Object.entries(tanstack).every(
      ([name, versions]) =>
        versions.includes(current.dependencies?.[name]) &&
        !Object.hasOwn(current.peerDependencies ?? {}, name) &&
        !Object.hasOwn(current.devDependencies ?? {}, name),
    );
    const migrated = Object.entries(tanstack).every(
      ([name, [, version]]) =>
        !Object.hasOwn(current.dependencies ?? {}, name) &&
        current.peerDependencies?.[name] === version &&
        (current.devDependencies?.[name] === version ||
          (admittedPin(name) &&
            current.devDependencies?.[name] === admittedPin(name).request)),
    );
    assert(
      (original || migrated) &&
        Object.keys(tanstack).every(
          name => !Object.hasOwn(current.peerDependenciesMeta ?? {}, name),
        ),
      `${file}: unreviewed TanStack host tuple`,
    );
    for (const [name, [from, version]] of Object.entries(tanstack)) {
      for (const value of [reviewed, actualManifest, manifest]) {
        delete value.dependencies[name];
        (value.peerDependencies ??= {})[name] = version;
        (value.devDependencies ??= {})[name] =
          value !== reviewed && migrated
            ? current.devDependencies[name]
            : version;
      }
      edges.push({
        path: file,
        field: 'dependencies',
        name,
        from,
        status: 'reviewed-removal',
        reason: 'required shared router host peer; hosted adoption pending',
      });
      if (original)
        changes.push(
          {
            field: 'dependencies',
            name,
            from: current.dependencies[name],
            to: null,
          },
          { field: 'peerDependencies', name, from: null, to: version },
          { field: 'devDependencies', name, from: null, to: version },
        );
    }
  }
  if (
    file === 'packages/runtime/renderer-solid/package.json' &&
    expected.dependencies?.['solid-js'] === '2.0.0-rc.15' &&
    !Object.hasOwn(expected.peerDependencies ?? {}, 'solid-js') &&
    !Object.hasOwn(expected.devDependencies ?? {}, 'solid-js')
  ) {
    const name = 'solid-js';
    const version = '2.0.0-rc.22';
    const original =
      ['2.0.0-rc.15', version].includes(current.dependencies?.[name]) &&
      !Object.hasOwn(current.peerDependencies ?? {}, name) &&
      !Object.hasOwn(current.devDependencies ?? {}, name);
    const migrated =
      !Object.hasOwn(current.dependencies ?? {}, name) &&
      current.peerDependencies?.[name] === version &&
      (current.devDependencies?.[name] === version ||
        (admittedPin(name) &&
          current.devDependencies?.[name] === admittedPin(name).request));
    assert(
      (original || migrated) &&
        !Object.hasOwn(current.peerDependenciesMeta ?? {}, name),
      `${file}: unreviewed Solid host tuple`,
    );
    for (const value of [reviewed, actualManifest, manifest]) {
      delete value.dependencies[name];
      const pin = value === reviewed ? expected.dependencies[name] : version;
      (value.peerDependencies ??= {})[name] = pin;
      (value.devDependencies ??= {})[name] =
        value !== reviewed && migrated ? current.devDependencies[name] : pin;
    }
    edges.push({
      path: file,
      field: 'dependencies',
      name,
      from: expected.dependencies[name],
      status: 'reviewed-removal',
      reason:
        'qualified Solid runtime is supplied by the required exact host peer',
    });
    if (original)
      changes.push(
        {
          field: 'dependencies',
          name,
          from: current.dependencies[name],
          to: null,
        },
        { field: 'peerDependencies', name, from: null, to: version },
        { field: 'devDependencies', name, from: null, to: version },
      );
  }
  const trace = traceConsolidation;
  if (
    file === trace.path &&
    Object.entries(trace.from).every(
      ([name, version]) => expected.dependencies?.[name] === version,
    ) &&
    !Object.hasOwn(expected.dependencies, trace.name)
  ) {
    const actual = current.dependencies ?? {};
    const original =
      !Object.hasOwn(actual, trace.name) &&
      Object.entries(trace.from).every(
        ([name, version]) => actual[name] === version,
      );
    const consolidated =
      actual[trace.name] === trace.version &&
      Object.keys(trace.from).every(name => !Object.hasOwn(actual, name));
    assert(original || consolidated, `${file}: unreviewed OTel trace tuple`);
    for (const [name, from] of Object.entries(trace.from)) {
      delete reviewed.dependencies[name];
      delete actualManifest.dependencies[name];
      delete manifest.dependencies[name];
      edges.push({
        path: file,
        field: 'dependencies',
        name,
        from,
        status: 'reviewed-removal',
        reason: 'qualified owning OTel trace consolidation',
      });
      if (original)
        changes.push({ field: 'dependencies', name, from, to: null });
    }
    for (const value of [reviewed, actualManifest, manifest])
      value.dependencies[trace.name] = trace.version;
    if (original)
      changes.push({
        field: 'dependencies',
        name: trace.name,
        from: null,
        to: trace.version,
      });
  }
  for (const field of fields) {
    const before = reviewed[field] ?? {};
    const actual = actualManifest[field] ?? {};
    const removed = new Set(
      [
        ...reviewedRemovals,
        ...routerDomRemovals.map(edge => ({
          ...edge,
          field: 'dependencies',
          name: 'react-router-dom',
        })),
      ]
        .filter(
          edge =>
            edge.path === file &&
            edge.field === field &&
            before[edge.name] === edge.from &&
            !Object.hasOwn(actual, edge.name),
        )
        .map(edge => edge.name),
    );
    assert.deepEqual(
      Object.keys(actual).sort(),
      Object.keys(before)
        .filter(name => !removed.has(name))
        .sort(),
      `${file}: ${field} edge names changed since reviewed source`,
    );
    for (const [name, value] of Object.entries(before)) {
      assert.equal(
        typeof value,
        'string',
        `${file}: invalid dependency edge ${name}`,
      );
      if (removed.has(name)) {
        edges.push({
          path: file,
          field,
          name,
          from: value,
          status: 'reviewed-removal',
          reason: 'exact reviewed dependency removal',
        });
        continue;
      }
      const removeDom =
        field === 'dependencies' &&
        name === 'react-router-dom' &&
        routerDomRemovals.some(
          edge => edge.path === file && edge.from === value,
        );
      if (removeDom) {
        assert.equal(actual[name], value, `${file}: unexpected DOM edge`);
        delete manifest[field][name];
        changes.push({ field, name, from: value, to: null });
        edges.push({
          path: file,
          field,
          name,
          from: value,
          status: 'reviewed-removal',
        });
        continue;
      }
      let edge = excludedFixture(file)
        ? {
            name,
            from: value,
            status: 'fixture',
            reason: 'semantic/synthetic fixture',
          }
        : replacement({ file, field, name, value });
      const artifact = admittedPin(name);
      if (artifact && !excludedFixture(file)) {
        assert(
          field !== 'optionalDependencies',
          `${file}: artifact authority cannot be optional`,
        );
        const to =
          field === 'peerDependencies' ? artifact.version : artifact.request;
        assert(
          actual[name] === value ||
            actual[name] === edge.to ||
            actual[name] === to,
          `${file}: unexpected old artifact edge ${field}.${name}: ${actual[name]}`,
        );
        if (
          field === 'peerDependencies' &&
          [
            'solid-js',
            '@tanstack/router-core',
            '@tanstack/react-router',
          ].includes(name)
        )
          assert.notEqual(
            current.peerDependenciesMeta?.[name]?.optional,
            true,
            `${file}: artifact host peer must be required`,
          );
        edge = {
          ...edge,
          target: artifact.version,
          to,
          status: actual[name] === to ? 'current' : 'update',
          reason:
            'authenticated hosted bytes match reviewed canonical correction',
        };
      }
      assert(
        artifact ||
          actual[name] === value ||
          (edge.to !== undefined && actual[name] === edge.to),
        `${file}: unexpected old edge ${field}.${name}: ${actual[name]}`,
      );
      edges.push({ path: file, field, ...edge });
      if (edge.status === 'update' && actual[name] !== edge.to) {
        manifest[field][name] = edge.to;
        changes.push({ field, name, from: actual[name], to: edge.to });
      }
    }
  }
  for (const kind of ['nativeArtifacts', 'supportArtifacts']) {
    const before = expected.ultramodern?.[kind];
    const actual = current.ultramodern?.[kind];
    const selected =
      artifacts[kind] && artifactOwners[kind][file] ? artifacts[kind] : before;
    assert(
      isDeepStrictEqual(actual, before) || isDeepStrictEqual(actual, selected),
      `${file}: unverified ${kind} metadata`,
    );
    if (!isDeepStrictEqual(actual, selected)) {
      (manifest.ultramodern ??= {})[kind] = structuredClone(selected);
      changes.push({
        field: `ultramodern.${kind}`,
        from: actual ?? null,
        to: selected,
      });
    }
  }
  if (file === 'package.json') {
    for (const [key, to] of rootPins) {
      const parts = key.split('.');
      const get = object =>
        parts.reduce((value, part) => value?.[part], object);
      const from = get(current);
      // Small synthetic callers without root policy may omit these fields.
      if (get(expected) === undefined) {
        assert.equal(from, undefined, `unexpected root pin ${key}`);
        continue;
      }
      assert(
        from === get(expected) || from === to,
        `unexpected root pin ${key}`,
      );
      if (from !== to) {
        const parent = parts.length === 1 ? manifest : manifest[parts[0]];
        parent[parts.at(-1)] = to;
        changes.push({ field: key, from, to });
      }
    }
  } else if (
    /^(packages|examples)\//.test(file) &&
    !/(^|\/)(tests|fixtures|template)(\/|$)/.test(file) &&
    expected.engines?.node === '>=26.12.0'
  ) {
    const from = current.engines?.node;
    const to = '>=26.13.1';
    assert(
      from === expected.engines.node || from === to,
      `${file}: unexpected Node engine pin`,
    );
    if (from !== to) {
      manifest.engines.node = to;
      changes.push({ field: 'engines.node', from, to });
    }
  }
  return { manifest, changes, edges };
}

export function runUpdater({ root, write = false, artifactAuthority }) {
  admittedArtifacts(artifactAuthority);
  const sourcePins = sourcePinCoverage(root);
  assert.equal(sourcePins.errors.length, 0, sourcePins.errors.join('\n'));
  const patch = fs.readFileSync(
    path.join(root, 'patches/rsbuild-plugin-dts@1.0.7.patch'),
  );
  assert.equal(
    createHash('sha256').update(patch).digest('hex'),
    rslibPatchSha256,
    'Rslib canonical native declaration correction differs from reviewed bytes',
  );
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  git('merge-base', '--is-ancestor', sourceRevision, 'HEAD');
  const files = git('ls-tree', '-r', '--name-only', sourceRevision)
    .trim()
    .split('\n')
    .filter(allowedPath)
    .sort();
  const records = files.map(file => {
    const absolute = path.join(root, file);
    assert(
      !fs.lstatSync(absolute).isSymbolicLink(),
      `${file}: symlink manifest`,
    );
    const text = fs.readFileSync(absolute, 'utf8');
    const expected = JSON.parse(git('show', `${sourceRevision}:${file}`));
    const result = planManifestUpdate({
      path: file,
      expected,
      current: JSON.parse(text),
      sourceRevision,
      artifactAuthority,
    });
    return { file, absolute, text, ...result };
  });
  // Validate the entire batch before changing the first file.
  for (const record of records)
    assert.equal(
      fs.readFileSync(record.absolute, 'utf8'),
      record.text,
      `${record.file}: concurrent edit`,
    );
  if (write)
    for (const record of records.filter(record => record.changes.length)) {
      assert.equal(
        fs.readFileSync(record.absolute, 'utf8'),
        record.text,
        `${record.file}: concurrent edit`,
      );
      fs.writeFileSync(
        record.absolute,
        `${JSON.stringify(record.manifest, null, 2)}\n`,
      );
    }
  const allEdges = records.flatMap(record => record.edges);
  const statuses = {};
  for (const edge of allEdges)
    statuses[edge.status] = (statuses[edge.status] ?? 0) + 1;
  return {
    sourceRevision,
    queriedAt,
    mode: write ? 'write' : 'plan',
    complete:
      sourcePins.complete &&
      !allEdges.some(
        edge => edge.status === 'held' || edge.status === 'unknown',
      ),
    manifestsReviewed: records.length,
    sourcePinCoverage: sourcePins,
    changedFiles: records
      .filter(record => record.changes.length)
      .map(record => ({ path: record.file, changes: record.changes })),
    edgeStatuses: statuses,
    unresolved: allEdges.filter(
      edge => edge.status === 'held' || edge.status === 'unknown',
    ),
    exceptions: allEdges.filter(edge =>
      ['fixture', 'satisfied-exception', 'reviewed-removal'].includes(
        edge.status,
      ),
    ),
  };
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const { values } = parseArgs({
    options: {
      write: { type: 'boolean' },
      check: { type: 'boolean' },
      'native-descriptor': { type: 'string' },
      'support-descriptor': { type: 'string' },
    },
  });
  assert(!(values.write && values.check), 'choose --write or --check');
  const readDescriptor = file =>
    file ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
  const artifactAuthority =
    values['native-descriptor'] || values['support-descriptor']
      ? await admitArtifactDescriptors({
          nativeDescriptor: readDescriptor(values['native-descriptor']),
          supportDescriptor: readDescriptor(values['support-descriptor']),
          signal: AbortSignal.timeout(180_000),
        })
      : undefined;
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = runUpdater({ root, write: values.write, artifactAuthority });
  console.log(JSON.stringify(result, null, 2));
  if (values.check && result.changedFiles.length) process.exitCode = 1;
}
