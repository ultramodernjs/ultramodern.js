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
  nativeBaselineRevision,
  queriedAt,
  reviewedTransitions,
  routerDomRemovals,
  rslibPatchSha256,
  satisfiedExceptions,
  sourceRevision,
  supportBaselineRevision,
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

// Owner-scoped retirement: a support name this file owns is retired when the
// admitted support descriptor omits it (the v4 candidate has no Solid
// correction). Retirement grants no authority; v3 baselines still bind the
// existing shipped edges.
export function retiredSupportNames(owned, supportPackages) {
  if (supportPackages === undefined) return [];
  return owned.filter(name => !Object.hasOwn(supportPackages, name));
}

// An owner whose every support name is retired drops its support metadata; a
// mixed owner keeps some names and therefore adopts the admitted descriptor.
export function retiresSupportMetadata(owned, supportPackages) {
  return (
    owned.length > 0 &&
    retiredSupportNames(owned, supportPackages).length === owned.length
  );
}

export function planManifestUpdate({
  path: file,
  expected,
  current,
  sourceRevision: revision,
  artifactAuthority,
  supportBaseline,
  nativeBaseline,
}) {
  assert.equal(revision, sourceRevision, 'unreviewed snapshot source revision');
  if (supportBaseline !== undefined)
    assert.equal(
      supportBaseline.revision,
      supportBaselineRevision,
      'unreviewed support baseline revision',
    );
  if (nativeBaseline !== undefined)
    assert.equal(
      nativeBaseline.revision,
      nativeBaselineRevision,
      'unreviewed native baseline revision',
    );
  const artifacts = admittedArtifacts(artifactAuthority);
  const ownerKind = name =>
    Object.keys(artifactOwners).find(kind =>
      artifactOwners[kind][file]?.includes(name),
    );
  const admittedPin = name => artifacts[ownerKind(name)]?.packages[name];
  const supportOwned = artifactOwners.supportArtifacts[file] ?? [];
  const supportPackages = artifacts.supportArtifacts?.packages;
  const retiredSupport = name =>
    retiredSupportNames(supportOwned, supportPackages).includes(name);
  // Each reviewed baseline proves only the exact selections its owning kind
  // makes from its own accepted descriptor; other baseline content is ignored.
  const baselines = {
    nativeArtifacts: nativeBaseline,
    supportArtifacts: supportBaseline,
  };
  const priors = Object.fromEntries(
    Object.entries(baselines).map(([kind, baseline]) => [
      kind,
      artifactOwners[kind][file]
        ? baseline?.manifest?.ultramodern?.[kind]
        : undefined,
    ]),
  );
  if (priors.nativeArtifacts) {
    const immutable = JSON.parse(
      execFileSync('git', ['show', `${nativeBaselineRevision}:${file}`], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        encoding: 'utf8',
      }),
    );
    assert.deepEqual(
      priors.nativeArtifacts,
      immutable.ultramodern.nativeArtifacts,
      `${file}: native baseline differs from immutable source`,
    );
  }
  const priorPin = (field, name) => {
    const kind = ownerKind(name);
    const pin = priors[kind]?.packages?.[name];
    if (!pin || field === 'optionalDependencies') return undefined;
    const value = baselines[kind].manifest[field]?.[name];
    return value === (field === 'peerDependencies' ? pin.version : pin.request)
      ? value
      : undefined;
  };
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
            current.devDependencies?.[name] === admittedPin(name).request) ||
          (priorPin('devDependencies', name) !== undefined &&
            current.devDependencies?.[name] ===
              priorPin('devDependencies', name))),
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
    const version = targets[name];
    const support = admittedPin(name);
    const retired = retiredSupport(name);
    const authorized = (value, ...accepted) =>
      value !== undefined &&
      (accepted.includes(value) ||
        coordinatedTransitions[name]?.via?.includes(value));
    const original =
      ['2.0.0-rc.15', version].includes(current.dependencies?.[name]) &&
      !Object.hasOwn(current.peerDependencies ?? {}, name) &&
      !Object.hasOwn(current.devDependencies ?? {}, name);
    // Shipped historical state: the reviewed v3 peer and hosted dev pins.
    const migrated =
      !Object.hasOwn(current.dependencies ?? {}, name) &&
      authorized(
        current.peerDependencies?.[name],
        version,
        priorPin('peerDependencies', name),
        support?.version,
      ) &&
      authorized(
        current.devDependencies?.[name],
        version,
        priorPin('devDependencies', name),
        support?.request,
      );
    assert(
      (original || migrated) &&
        !Object.hasOwn(current.peerDependenciesMeta ?? {}, name),
      `${file}: unreviewed Solid host tuple`,
    );
    // Without a newer admission the accepted historical state stays; an admitted
    // support pin or a retirement moves it to the snapshot target.
    const keep = migrated && !support && !retired;
    for (const value of [reviewed, actualManifest, manifest]) {
      delete value.dependencies[name];
      if (value === reviewed) {
        (value.peerDependencies ??= {})[name] = expected.dependencies[name];
        (value.devDependencies ??= {})[name] = expected.dependencies[name];
        continue;
      }
      (value.peerDependencies ??= {})[name] = keep
        ? current.peerDependencies[name]
        : (support?.version ?? version);
      (value.devDependencies ??= {})[name] = keep
        ? current.devDependencies[name]
        : (support?.request ?? version);
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
      changes.push({
        field: 'dependencies',
        name,
        from: current.dependencies[name],
        to: null,
      });
    for (const field of ['peerDependencies', 'devDependencies']) {
      const from = current[field]?.[name] ?? null;
      const to = manifest[field][name];
      if (from !== to) changes.push({ field, name, from, to });
    }
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
    const actual = actualManifest[field] ?? {};
    const transitions = reviewedTransitions.filter(
      edge =>
        edge.path === file &&
        edge.field === field &&
        (edge.from === null
          ? !Object.hasOwn(reviewed[field] ?? {}, edge.name)
          : reviewed[field]?.[edge.name] === edge.from),
    );
    const added = new Set();
    for (const edge of transitions)
      if (edge.to !== null && Object.hasOwn(actual, edge.name)) {
        assert.equal(
          actual[edge.name],
          edge.to,
          `${file}: unreviewed transition ${field}.${edge.name}`,
        );
        added.add(edge.name);
      }
    const before = {
      ...reviewed[field],
      ...Object.fromEntries(
        transitions
          .filter(edge => added.has(edge.name))
          .map(edge => [edge.name, edge.to]),
      ),
    };
    const removed = new Set(
      [
        ...transitions.filter(edge => edge.to === null),
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
      // An exact reviewed addition has no old edge for version policy to move.
      let edge = excludedFixture(file)
        ? {
            name,
            from: value,
            status: 'fixture',
            reason: 'semantic/synthetic fixture',
          }
        : added.has(name)
          ? {
              name,
              from: null,
              to: value,
              target: targets[name] ?? null,
              status: 'reviewed-addition',
              reason: 'exact reviewed dependency addition',
            }
          : replacement({ file, field, name, value });
      const artifact = admittedPin(name);
      const prior = excludedFixture(file) ? undefined : priorPin(field, name);
      if (
        (artifact || prior !== undefined) &&
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
            actual[name] === to ||
            (prior !== undefined && actual[name] === prior),
          `${file}: unexpected old artifact edge ${field}.${name}: ${actual[name]}`,
        );
        edge = {
          ...edge,
          target: artifact.version,
          to,
          status: actual[name] === to ? 'current' : 'update',
          reason:
            'authenticated hosted bytes match reviewed canonical correction',
        };
      } else if (
        !retiredSupport(name) &&
        prior !== undefined &&
        actual[name] === prior &&
        actual[name] !== value
      )
        // Without a newer admission the reviewed baseline selection stays.
        edge = {
          ...edge,
          to: prior,
          status: 'current',
          reason: `reviewed baseline ${ownerKind(name) === 'nativeArtifacts' ? 'native' : 'support'} artifact selection`,
        };
      const transition = coordinatedTransitions[name];
      const reviewedIntermediate =
        edge.status === 'update' &&
        transition?.via?.includes(actual[name]) &&
        transition.from.includes(value) &&
        edge.target === transition.to;
      assert(
        artifact ||
          actual[name] === value ||
          (edge.to !== undefined && actual[name] === edge.to) ||
          reviewedIntermediate ||
          (retiredSupport(name) &&
            prior !== undefined &&
            actual[name] === prior),
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
    const admitted =
      artifacts[kind] && artifactOwners[kind][file]
        ? artifacts[kind]
        : undefined;
    const retires =
      kind === 'supportArtifacts' &&
      retiresSupportMetadata(supportOwned, supportPackages);
    const verified = [
      before,
      ...(priors[kind] ? [priors[kind]] : []),
      ...(admitted ? [admitted] : []),
      // After a full retirement the only reviewed state is the absence.
      ...(retires ? [undefined] : []),
    ];
    assert(
      verified.some(value => isDeepStrictEqual(actual, value)),
      `${file}: unverified ${kind} metadata`,
    );
    // Without a newer admission, a verified state is left unchanged.
    const selected = retires ? undefined : (admitted ?? actual);
    if (!isDeepStrictEqual(actual, selected)) {
      if (selected === undefined) {
        delete manifest.ultramodern[kind];
        if (Object.keys(manifest.ultramodern).length === 0)
          delete manifest.ultramodern;
      } else (manifest.ultramodern ??= {})[kind] = structuredClone(selected);
      changes.push({
        field: `ultramodern.${kind}`,
        from: actual ?? null,
        to: selected ?? null,
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
  // A baseline manifest is read only for files owning that artifact kind.
  const baselineAt = (kind, revision) => {
    git('merge-base', '--is-ancestor', revision, 'HEAD');
    const present = new Set(
      git('ls-tree', '-r', '--name-only', revision).trim().split('\n'),
    );
    return file => ({
      revision,
      manifest:
        artifactOwners[kind][file] && present.has(file)
          ? JSON.parse(git('show', `${revision}:${file}`))
          : undefined,
    });
  };
  const supportBaseline = baselineAt(
    'supportArtifacts',
    supportBaselineRevision,
  );
  const nativeBaseline = baselineAt('nativeArtifacts', nativeBaselineRevision);
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
      supportBaseline: supportBaseline(file),
      nativeBaseline: nativeBaseline(file),
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
      [
        'fixture',
        'satisfied-exception',
        'reviewed-removal',
        'reviewed-addition',
      ].includes(edge.status),
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
