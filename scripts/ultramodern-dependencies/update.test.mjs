import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  artifactOwners,
  nativeBaselineRevision,
  sourceRevision,
  supportBaselineRevision,
  targets,
} from './snapshot.mjs';
import {
  planManifestUpdate,
  retiredSupportNames,
  retiresSupportMetadata,
  runUpdater,
} from './update.mjs';

const plan = (expected, current = expected, path = 'package.json') =>
  planManifestUpdate({ path, expected, current, sourceRevision });
const showAt = (revision, file) =>
  JSON.parse(
    execFileSync('git', ['show', `${revision}:${file}`], {
      cwd: new URL('../../', import.meta.url),
      encoding: 'utf8',
    }),
  );

// The reviewed v4 candidate cohort (PR #330) and the shipped v3 cohort, read from
// immutable git bytes rather than the in-flight protocol module.
const v4Packages = Object.fromEntries(
  [
    '@effect/opentelemetry',
    '@rstest/core',
    '@tanstack/react-router',
    '@types/ioredis-mock',
    'ioredis-mock',
    'rsbuild-plugin-dts',
  ].map(name => [name, {}]),
);
const v3Packages = Object.fromEntries(
  Object.keys(
    showAt(
      supportBaselineRevision,
      'packages/runtime/renderer-solid/package.json',
    ).ultramodern.supportArtifacts.packages,
  ).map(name => [name, {}]),
);

function assertPreservedArtifactSelection(result, manifest, kind, names) {
  assert.deepEqual(
    result.manifest.ultramodern[kind],
    manifest.ultramodern[kind],
  );
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies'])
    for (const name of names)
      assert.equal(result.manifest[field]?.[name], manifest[field]?.[name]);
}

test('only the reviewed support baseline keeps its exact owned selections', () => {
  const file = 'packages/server/bff-effect/package.json';
  const expected = showAt(sourceRevision, file);
  const accepted = showAt(supportBaselineRevision, file);
  const prior = accepted.ultramodern.supportArtifacts;
  const request = prior.packages['@effect/opentelemetry'].request;
  assert.equal(accepted.devDependencies['@effect/opentelemetry'], request);
  const invoke = ({
    path = file,
    current = accepted,
    supportBaseline = {
      revision: supportBaselineRevision,
      manifest: accepted,
    },
  } = {}) =>
    planManifestUpdate({
      path,
      expected,
      current,
      sourceRevision,
      supportBaseline,
    });
  // Without the baseline the accepted descriptor is unverifiable.
  assert.throws(
    () =>
      planManifestUpdate({
        path: file,
        expected,
        current: accepted,
        sourceRevision,
      }),
    /unexpected old edge|unverified supportArtifacts/,
  );
  const kept = invoke();
  assert.deepEqual(kept.manifest, accepted);
  assert.equal(kept.changes.length, 0);
  assert.deepEqual(
    kept.edges.find(edge => edge.name === '@effect/opentelemetry'),
    {
      path: file,
      field: 'devDependencies',
      name: '@effect/opentelemetry',
      from: expected.devDependencies['@effect/opentelemetry'],
      target: targets['@effect/opentelemetry'],
      to: request,
      status: 'current',
      reason: 'reviewed baseline support artifact selection',
    },
  );
  const forgedUrl = structuredClone(accepted);
  forgedUrl.devDependencies['@effect/opentelemetry'] = request.replace(
    /-\d+\/(?=[^/]+$)/u,
    '-9/',
  );
  assert.notEqual(forgedUrl.devDependencies['@effect/opentelemetry'], request);
  assert.throws(
    () => invoke({ current: forgedUrl }),
    /unexpected old edge devDependencies.@effect\/opentelemetry/,
  );
  const forgedMetadata = structuredClone(accepted);
  forgedMetadata.ultramodern.supportArtifacts.producer.runAttempt += 1;
  assert.throws(
    () => invoke({ current: forgedMetadata }),
    /unverified supportArtifacts metadata/,
  );
  assert.throws(
    () =>
      invoke({
        supportBaseline: { revision: 'f'.repeat(40), manifest: accepted },
      }),
    /unreviewed support baseline revision/,
  );
  // A baseline selection that differs from its own descriptor grants nothing.
  const inconsistent = structuredClone(accepted);
  inconsistent.devDependencies['@effect/opentelemetry'] =
    forgedUrl.devDependencies['@effect/opentelemetry'];
  assert.throws(
    () =>
      invoke({
        current: inconsistent,
        supportBaseline: {
          revision: supportBaselineRevision,
          manifest: inconsistent,
        },
      }),
    /unexpected old edge/,
  );
  // Unowned manifests and unowned edges never inherit baseline authority.
  const unowned = 'examples/unrelated/package.json';
  assert.equal(artifactOwners.supportArtifacts[unowned], undefined);
  assert.throws(
    () =>
      planManifestUpdate({
        path: unowned,
        expected: { dependencies: { '@effect/opentelemetry': '4.1.4' } },
        current: {
          dependencies: { '@effect/opentelemetry': request },
          ultramodern: { supportArtifacts: prior },
        },
        sourceRevision,
        supportBaseline: {
          revision: supportBaselineRevision,
          manifest: {
            dependencies: { '@effect/opentelemetry': request },
            ultramodern: { supportArtifacts: prior },
          },
        },
      }),
    /unexpected old edge|unverified supportArtifacts/,
  );
  const otherEdge = structuredClone(accepted);
  otherEdge.devDependencies.effect = request;
  assert.throws(
    () =>
      invoke({
        current: otherEdge,
        supportBaseline: {
          revision: supportBaselineRevision,
          manifest: otherEdge,
        },
      }),
    /unexpected old edge devDependencies.effect/,
  );
});

test('the shipped support-v3 activation stays current only through the reviewed baseline', () => {
  // Activation 92307d27 shipped these exact support selections; the accepted
  // cohort's main source is the reviewed baseline carrying them unchanged.
  const activation = '92307d27ccf49a83bf0027aacd492e90b5b01c12';
  const priorV2 = 'c4a6393979e763cf94cdcd18337e5047a8577d63';
  let files = 0;
  let selections = 0;
  for (const [file, names] of Object.entries(artifactOwners.supportArtifacts)) {
    // Native-owned selections need their own native authority.
    if (artifactOwners.nativeArtifacts[file]) continue;
    const shipped = showAt(activation, file);
    const descriptor = shipped.ultramodern.supportArtifacts;
    assert.equal(descriptor.protocol, 'ultramodern.support-artifacts.v3');
    assert.deepEqual(
      [
        descriptor.producer.source,
        descriptor.producer.runId,
        descriptor.producer.runAttempt,
      ],
      ['d62b29f5039311ec122012887ce6bf7c4a527d6e', 43934193068, 2],
    );
    const expected = showAt(sourceRevision, file);
    const bound = {
      revision: supportBaselineRevision,
      manifest: showAt(supportBaselineRevision, file),
    };
    const invoke = (current, supportBaseline = bound) =>
      planManifestUpdate({
        path: file,
        expected,
        current,
        sourceRevision,
        supportBaseline,
      });
    const kept = invoke(shipped);
    assertPreservedArtifactSelection(kept, shipped, 'supportArtifacts', names);
    for (const name of names)
      for (const field of ['dependencies', 'devDependencies']) {
        const value = shipped[field]?.[name];
        if (value === undefined) continue;
        assert.equal(value, descriptor.packages[name].request);
        assert.equal(
          kept.edges.find(edge => edge.field === field && edge.name === name)
            ?.status,
          'current',
        );
        selections++;
        // Another run attempt of the same producer is not the shipped bytes.
        const forged = structuredClone(shipped);
        forged[field][name] = value.replace(/-\d+\/(?=[^/]+$)/u, '-9/');
        assert.notEqual(forged[field][name], value);
        assert.throws(() => invoke(forged), /unexpected old edge/);
        // The superseded v2 selection is no longer reviewed authority.
        const v2 = structuredClone(shipped);
        v2[field][name] = showAt(priorV2, file)[field][name];
        assert.notEqual(v2[field][name], value);
        assert.throws(() => invoke(v2), /unexpected old edge/);
      }
    const forgedMetadata = structuredClone(shipped);
    forgedMetadata.ultramodern.supportArtifacts.producer.source = 'f'.repeat(
      40,
    );
    assert.throws(
      () => invoke(forgedMetadata),
      /unverified supportArtifacts metadata/,
    );
    // Only the reviewed revision binds; even the activation commit or the
    // prior v2 baseline presented as the baseline grant nothing.
    for (const revision of [activation, priorV2])
      assert.throws(
        () => invoke(shipped, { ...bound, revision }),
        /unreviewed support baseline revision/,
      );
    files++;
  }
  assert(files > 15 && selections > 20);
});

test('only the reviewed native baseline keeps its exact owned selections', () => {
  const supersededNative = 'ea6b64f23735f29a2cb2a4647c04d2dc3a185cbc';
  const nativeActivation = 'c40bbf9976ff568bad06be140dad2613fe25dafb';
  const nativeOnly = Object.keys(artifactOwners.nativeArtifacts).filter(
    file => !artifactOwners.supportArtifacts[file],
  );
  assert.equal(nativeOnly.length, 4);
  for (const file of nativeOnly) {
    const accepted = showAt(nativeBaselineRevision, file);
    const prior = accepted.ultramodern.nativeArtifacts;
    assert.equal(prior.producer.runId, 43993884470);
    assert.equal(prior.producer.runAttempt, 1);
    const expected = showAt(sourceRevision, file);
    const bound = { revision: nativeBaselineRevision, manifest: accepted };
    const invoke = (current = accepted, nativeBaseline = bound) =>
      planManifestUpdate({
        path: file,
        expected,
        current,
        sourceRevision,
        nativeBaseline,
      });
    // Without the baseline the accepted descriptor is unverifiable.
    assert.throws(
      () =>
        planManifestUpdate({
          path: file,
          expected,
          current: accepted,
          sourceRevision,
        }),
      /unexpected old edge|unverified nativeArtifacts/,
    );
    // Without a newer admission the accepted state stays, idempotently.
    const kept = invoke();
    assertPreservedArtifactSelection(
      kept,
      accepted,
      'nativeArtifacts',
      artifactOwners.nativeArtifacts[file],
    );
    let selections = 0;
    for (const name of artifactOwners.nativeArtifacts[file])
      for (const field of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
      ]) {
        if (!Object.hasOwn(accepted[field] ?? {}, name)) continue;
        const pin = prior.packages[name];
        const to = field === 'peerDependencies' ? pin.version : pin.request;
        assert.equal(accepted[field][name], to);
        const edge = kept.edges.find(
          edge => edge.field === field && edge.name === name,
        );
        assert.equal(edge.to, to);
        assert.equal(edge.status, 'current');
        assert.equal(
          edge.reason,
          'reviewed baseline native artifact selection',
        );
        selections++;
        // An edge differing from the baseline descriptor's canonical selection
        // is never accepted, in the consumer or in the baseline itself.
        const forged = structuredClone(accepted);
        forged[field][name] =
          field === 'peerDependencies'
            ? `${pin.version}-forged`
            : pin.request.replace(/-\d+\/(?=[^/]+$)/u, '-9/');
        assert.notEqual(forged[field][name], to);
        assert.throws(
          () => invoke(forged),
          new RegExp(
            `unexpected old edge ${field}\\.${name.replace('/', '\\/')}`,
          ),
        );
        assert.throws(
          () => invoke(forged, { ...bound, manifest: forged }),
          /unexpected old edge/,
        );
        if (field === 'peerDependencies') continue;
        // A later native run (stand-in id) needs admission, not the baseline.
        const later = structuredClone(accepted);
        later[field][name] = pin.request.replace(
          '-43993884470-1/',
          '-44131000000-1/',
        );
        assert.notEqual(later[field][name], to);
        assert.throws(() => invoke(later), /unexpected old edge/);
        // The superseded native run is no longer reviewed authority.
        const superseded = structuredClone(accepted);
        superseded[field][name] = showAt(supersededNative, file)[field][name];
        assert.notEqual(superseded[field][name], to);
        assert.throws(() => invoke(superseded), /unexpected old edge/);
      }
    assert(selections >= 2, `${file}: native selections`);
    const forgedMetadata = structuredClone(accepted);
    forgedMetadata.ultramodern.nativeArtifacts.producer.runAttempt = 2;
    assert.throws(
      () => invoke(forgedMetadata),
      /unverified nativeArtifacts metadata/,
    );
    for (const revision of ['f'.repeat(40), supersededNative, nativeActivation])
      assert.throws(
        () => invoke(accepted, { revision, manifest: accepted }),
        /unreviewed native baseline revision/,
      );
    // A self-consistent re-tagged baseline is not the sealed producer manifest.
    const tag = prior.producer.tag;
    const retagged = JSON.parse(
      JSON.stringify(accepted).replaceAll(tag, tag.replace(/-1$/u, '-2')),
    );
    retagged.ultramodern.nativeArtifacts.producer.runAttempt = 2;
    assert.throws(
      () => invoke(retagged, { ...bound, manifest: retagged }),
      /native baseline descriptor differs from its sealed manifest/,
    );
    // Arbitrary JSON capabilities are not native protocol descriptors.
    const capability = structuredClone(accepted);
    capability.ultramodern.nativeArtifacts.accepted = true;
    assert.throws(
      () => invoke(capability, { ...bound, manifest: capability }),
      /native descriptor: unknown or missing fields/,
    );
  }
  // Optional declarations never inherit the baseline selection.
  const file = 'packages/runtime/renderer-octane/package.json';
  const optional = value => {
    const result = structuredClone(value);
    result.optionalDependencies = { octane: result.devDependencies.octane };
    delete result.devDependencies.octane;
    return result;
  };
  const accepted = optional(showAt(nativeBaselineRevision, file));
  assert.throws(
    () =>
      planManifestUpdate({
        path: file,
        expected: optional(showAt(sourceRevision, file)),
        current: accepted,
        sourceRevision,
        nativeBaseline: {
          revision: nativeBaselineRevision,
          manifest: accepted,
        },
      }),
    /unexpected old edge optionalDependencies\.octane/,
  );
  // Wrong owners never inherit baseline authority, even with the descriptor.
  const prior = accepted.ultramodern.nativeArtifacts;
  for (const path of [
    'packages/runtime/renderer-solid/package.json',
    'examples/unrelated/package.json',
  ]) {
    const manifest = {
      devDependencies: { octane: prior.packages.octane.request },
      ultramodern: { nativeArtifacts: prior },
    };
    assert.throws(
      () =>
        planManifestUpdate({
          path,
          expected: { devDependencies: { octane: '0.13.8' } },
          current: manifest,
          sourceRevision,
          nativeBaseline: { revision: nativeBaselineRevision, manifest },
        }),
      /unexpected old edge devDependencies\.octane|unverified nativeArtifacts/,
    );
  }
});

test('every native owner keeps the shipped native activation exactly', () => {
  // Activation c40bbf99 shipped native run 43993884470; the reviewed baseline
  // carries the same descriptor and owned selections for every owner.
  const activation = 'c40bbf9976ff568bad06be140dad2613fe25dafb';
  const fields = ['dependencies', 'devDependencies', 'peerDependencies'];
  let selections = 0;
  for (const [file, names] of Object.entries(artifactOwners.nativeArtifacts)) {
    const shipped = showAt(activation, file);
    const baseline = showAt(nativeBaselineRevision, file);
    const descriptor = shipped.ultramodern.nativeArtifacts;
    assert.deepEqual(
      [
        descriptor.producer.source,
        descriptor.producer.runId,
        descriptor.producer.runAttempt,
      ],
      ['ea6b64f23735f29a2cb2a4647c04d2dc3a185cbc', 43993884470, 1],
    );
    assert.deepEqual(baseline.ultramodern.nativeArtifacts, descriptor);
    const supportBaseline = artifactOwners.supportArtifacts[file]
      ? {
          revision: supportBaselineRevision,
          manifest: showAt(supportBaselineRevision, file),
        }
      : undefined;
    const kept = planManifestUpdate({
      path: file,
      expected: showAt(sourceRevision, file),
      current: shipped,
      sourceRevision,
      supportBaseline,
      nativeBaseline: { revision: nativeBaselineRevision, manifest: baseline },
    });
    assertPreservedArtifactSelection(kept, shipped, 'nativeArtifacts', names);
    for (const name of names)
      for (const field of fields) {
        const value = shipped[field]?.[name];
        if (value === undefined) continue;
        const pin = descriptor.packages[name];
        assert.equal(
          value,
          field === 'peerDependencies' ? pin.version : pin.request,
        );
        assert.equal(baseline[field][name], value);
        selections++;
      }
  }
  assert(selections > 20);
});

test('accepts only the exact reviewed server compiler owner move', () => {
  const utils = 'packages/server/utils/package.json';
  const extensions = 'packages/solutions/app-tools-extensions/package.json';
  const shipped = '0024faeea760417227135429fe2727ae471abbe4';
  for (const file of [utils, extensions]) {
    const expected = showAt(sourceRevision, file);
    const current = showAt(shipped, file);
    const supportBaseline = {
      revision: supportBaselineRevision,
      manifest: showAt(supportBaselineRevision, file),
    };
    const invoke = manifest =>
      planManifestUpdate({
        path: file,
        expected,
        current: manifest,
        sourceRevision,
        supportBaseline,
      });
    const selected = invoke(current).manifest.dependencies;
    for (const name of [
      '@rslib/core',
      'typescript',
      '@modern-js/app-tools-extensions',
    ])
      assert.equal(
        selected?.[name],
        current.dependencies?.[name],
        `${file}:${name}`,
      );
    // The updater never performs the move itself.
    if (file === utils) {
      const result = invoke(current);
      assert.deepEqual(
        result.edges
          .filter(edge => edge.field === 'dependencies')
          .filter(edge =>
            ['reviewed-addition', 'reviewed-removal'].includes(edge.status),
          )
          .map(edge => [edge.name, edge.from, edge.to ?? null, edge.status])
          .sort(([a], [b]) => a.localeCompare(b)),
        [
          [
            '@modern-js/app-tools-extensions',
            null,
            'workspace:*',
            'reviewed-addition',
          ],
          ['@rslib/core', '1.0.3', null, 'reviewed-removal'],
          ['typescript', '7.0.2', null, 'reviewed-removal'],
        ],
      );
    }
  }
  const current = showAt(shipped, extensions);
  const expected = showAt(sourceRevision, extensions);
  const invoke = manifest =>
    planManifestUpdate({
      path: extensions,
      expected,
      current: manifest,
      sourceRevision,
      supportBaseline: {
        revision: supportBaselineRevision,
        manifest: showAt(supportBaselineRevision, extensions),
      },
    });
  for (const [name, wrong] of [
    ['@rslib/core', '1.0.6'],
    ['typescript', '^7.0.2'],
  ]) {
    const bad = structuredClone(current);
    bad.dependencies[name] = wrong;
    assert.throws(
      () => invoke(bad),
      new RegExp(
        `unreviewed transition dependencies\\.${name.replace('/', '\\/')}`,
      ),
    );
  }
  // Right names in the wrong field, or an unreviewed neighbour, grant nothing.
  const misplaced = structuredClone(current);
  misplaced.peerDependencies.typescript = misplaced.dependencies.typescript;
  delete misplaced.dependencies.typescript;
  assert.throws(() => invoke(misplaced), /edge names changed/);
  const surprise = structuredClone(current);
  surprise.dependencies['@rslib/api-extractor'] = '1.0.7';
  assert.throws(() => invoke(surprise), /edge names changed/);
});

test('framework declaration plugin peer and development input stay raw exact', () => {
  const file = 'packages/solutions/app-tools-extensions/package.json';
  const input = {
    peerDependencies: { '@rsbuild/core': '2.3.2' },
    devDependencies: { '@rsbuild/core': '2.3.2' },
  };
  const added = {
    peerDependencies: {
      ...input.peerDependencies,
      'rsbuild-plugin-dts': '1.0.7',
    },
    devDependencies: {
      ...input.devDependencies,
      'rsbuild-plugin-dts': '1.0.7',
    },
  };
  const result = plan(input, added, file);
  assert.deepEqual(result.manifest, {
    peerDependencies: {
      ...added.peerDependencies,
      '@rsbuild/core': targets['@rsbuild/core'],
    },
    devDependencies: {
      ...added.devDependencies,
      '@rsbuild/core': targets['@rsbuild/core'],
    },
  });
  assert.deepEqual(
    result.changes.map(edge => edge.name),
    ['@rsbuild/core', '@rsbuild/core'],
  );
  for (const [field, wrong] of [
    ['peerDependencies', '^1.0.7'],
    ['devDependencies', '1.0.6'],
  ]) {
    const current = structuredClone(added);
    current[field]['rsbuild-plugin-dts'] = wrong;
    assert.throws(() => plan(input, current, file), /unreviewed transition/);
  }
  assert.throws(
    () =>
      plan(
        input,
        { ...added, dependencies: { 'rsbuild-plugin-dts': '1.0.7' } },
        file,
      ),
    /edge names changed/,
  );
});

test('accepts only exact reviewed post-source edge additions and moves', () => {
  const solid = 'packages/runtime/renderer-solid/package.json';
  const input = { dependencies: { isbot: '5.2.3' } };
  const added = {
    dependencies: { isbot: '5.2.3', '@types/convert-source-map': '2.0.3' },
  };
  const result = plan(input, added, solid);
  assert.deepEqual(result.manifest, added);
  assert.equal(result.changes.length, 0);
  assert.deepEqual(
    result.edges.find(edge => edge.name === '@types/convert-source-map'),
    {
      path: solid,
      field: 'dependencies',
      name: '@types/convert-source-map',
      from: null,
      to: '2.0.3',
      target: null,
      status: 'reviewed-addition',
      reason: 'exact reviewed dependency addition',
    },
  );
  // The updater never performs a reviewed addition itself.
  assert.deepEqual(plan(input, input, solid).manifest, input);
  assert.throws(
    () =>
      plan(
        input,
        {
          dependencies: {
            ...added.dependencies,
            '@types/convert-source-map': '2.0.4',
          },
        },
        solid,
      ),
    /unreviewed transition dependencies.@types\/convert-source-map/,
  );
  for (const [current, file] of [
    [added, 'packages/runtime/renderer-octane/package.json'],
    [{ devDependencies: added.dependencies }, solid],
    [{ dependencies: { ...added.dependencies, surprise: '1.0.0' } }, solid],
  ])
    assert.throws(() => plan(input, current, file), /edge names changed/);

  const tools = 'packages/solutions/app-tools/package.json';
  const extensions = 'packages/solutions/app-tools-extensions/package.json';
  const source = {
    dependencies: {
      '@types/babel__core': '^7.20.5',
      prettier: '~3.9.10',
      semver: '7.8.6',
    },
  };
  const moved = { dependencies: { semver: '7.8.6' } };
  assert.deepEqual(plan(source, moved, tools).manifest, moved);
  assert.throws(
    () =>
      plan(
        { dependencies: { ...source.dependencies, prettier: '~3.9.9' } },
        moved,
        tools,
      ),
    /edge names changed/,
  );
  const receiving = {
    devDependencies: { '@rsbuild/core': '2.3.2' },
  };
  const received = {
    devDependencies: {
      ...receiving.devDependencies,
      '@rsbuild/plugin-svgr': '2.0.5',
      '@types/babel__core': '^7.20.5',
      prettier: '~3.10.1',
    },
  };
  const receivedPlan = plan(receiving, received, extensions);
  assert.deepEqual(receivedPlan.manifest, {
    devDependencies: {
      ...received.devDependencies,
      '@rsbuild/core': targets['@rsbuild/core'],
    },
  });
  assert.deepEqual(
    receivedPlan.changes.map(edge => edge.name),
    ['@rsbuild/core'],
  );
  for (const [name, wrong] of [
    ['prettier', '~3.9.10'],
    ['@rsbuild/plugin-svgr', '^2.0.5'],
  ])
    assert.throws(
      () =>
        plan(
          receiving,
          { devDependencies: { ...received.devDependencies, [name]: wrong } },
          extensions,
        ),
      /unreviewed transition/,
    );
  assert.throws(
    () =>
      plan(receiving, { dependencies: received.devDependencies }, extensions),
    /edge names changed/,
  );
});

test('runtime-utils keeps metadata corrections as exact development inputs, not public peers', () => {
  const input = {
    devDependencies: {
      'ioredis-mock': '^8.13.1',
      '@types/ioredis-mock': '^8.2.8',
    },
  };
  const file = 'packages/toolkit/runtime-utils/package.json';
  const result = plan(input, input, file);
  assert.deepEqual(result.manifest, {
    devDependencies: {
      'ioredis-mock': '8.13.1',
      '@types/ioredis-mock': '8.2.8',
    },
  });
  assert.equal(plan(input, result.manifest, file).changes.length, 0);
  assert.deepEqual(plan(input).manifest, input);
});

test('TanStack integration requires the application router and core as one host tuple', () => {
  const file = 'packages/runtime/plugin-tanstack/package.json';
  const input = {
    dependencies: {
      '@tanstack/react-router': '1.170.44',
      '@tanstack/router-core': '1.171.37',
    },
  };
  const peers = {
    '@tanstack/react-router': '1.170.46',
    '@tanstack/router-core': '1.171.39',
  };
  const result = plan(input, input, file);
  assert.deepEqual(result.manifest, {
    dependencies: {},
    peerDependencies: peers,
    devDependencies: peers,
  });
  assert.equal(plan(input, result.manifest, file).changes.length, 0);
  for (const changed of [
    { ...result.manifest, devDependencies: {} },
    {
      ...result.manifest,
      dependencies: { '@tanstack/router-core': '1.171.39' },
    },
    {
      ...result.manifest,
      peerDependencies: { ...peers, '@tanstack/react-router': '^1.170.46' },
    },
  ])
    assert.throws(() => plan(input, changed, file), /TanStack host tuple/u);
});

test('Solid renderer moves only its reviewed runtime input to the required host peer', () => {
  const file = 'packages/runtime/renderer-solid/package.json';
  const target = targets['solid-js'];
  const input = { dependencies: { 'solid-js': '2.0.0-rc.15' } };
  const result = plan(input, input, file);
  assert.deepEqual(result.manifest, {
    dependencies: {},
    peerDependencies: { 'solid-js': target },
    devDependencies: { 'solid-js': target },
  });
  assert.equal(plan(input, result.manifest, file).changes.length, 0);
  for (const changed of [
    {
      ...result.manifest,
      peerDependencies: { 'solid-js': `^${target}` },
    },
    {
      ...result.manifest,
      peerDependenciesMeta: { 'solid-js': { optional: true } },
    },
    { ...result.manifest, devDependencies: {} },
    {
      ...result.manifest,
      dependencies: { 'solid-js': target },
    },
  ])
    assert.throws(() => plan(input, changed, file), /Solid host tuple/u);
  assert.equal(
    plan(input, input, 'packages/runtime/another-renderer/package.json')
      .manifest.dependencies['solid-js'],
    target,
  );
});

test('Solid host tuple keeps the shipped rc.22 peer and v3 hosted dev only as historical proof', () => {
  const file = 'packages/runtime/renderer-solid/package.json';
  const shipped = showAt(supportBaselineRevision, file);
  const invoke = (current, supportBaseline) =>
    planManifestUpdate({
      path: file,
      expected: showAt(sourceRevision, file),
      current,
      sourceRevision,
      supportBaseline,
      nativeBaseline: { revision: nativeBaselineRevision, manifest: shipped },
    });
  const bound = { revision: supportBaselineRevision, manifest: shipped };
  assert.equal(shipped.peerDependencies['solid-js'], '2.0.0-rc.22');
  // Accepted only through the reviewed v3 baseline, never as the live target.
  assert.throws(() => invoke(shipped), /unreviewed Solid host tuple/u);
  const kept = invoke(shipped, bound);
  assert.equal(kept.manifest.peerDependencies['solid-js'], '2.0.0-rc.22');
  assert.equal(
    kept.manifest.devDependencies['solid-js'],
    shipped.devDependencies['solid-js'],
  );
  assert.deepEqual(
    kept.manifest.ultramodern.supportArtifacts,
    shipped.ultramodern.supportArtifacts,
  );
  assert.deepEqual(
    kept.changes.filter(change => change.name === 'solid-js'),
    [],
  );
});

test('retires only owner-scoped Solid support that the v4 candidate omits', () => {
  const v4 = v4Packages;
  assert(!Object.hasOwn(v4, 'solid-js'));
  const retiring = Object.keys(artifactOwners.supportArtifacts).filter(
    file =>
      retiredSupportNames(artifactOwners.supportArtifacts[file], v4).length,
  );
  assert.deepEqual(retiring, [
    'packages/runtime/renderer-solid/package.json',
    'tests/integration/renderer-solid/package.json',
  ]);
  // Each owner loses exactly the names the candidate omits, never another owner's.
  for (const [file, owned] of Object.entries(artifactOwners.supportArtifacts))
    assert.deepEqual(
      retiredSupportNames(owned, v4),
      owned.filter(name => !Object.hasOwn(v4, name)),
      file,
    );
  assert.deepEqual(retiredSupportNames([], v4), []);
  assert.deepEqual(
    retiredSupportNames(
      artifactOwners.supportArtifacts[retiring[0]],
      undefined,
    ),
    [],
  );
});

test('drops support metadata only when every owned support name is retired', () => {
  const v4 = v4Packages;
  const v3 = v3Packages;
  for (const file of [
    'packages/runtime/renderer-solid/package.json',
    'tests/integration/renderer-solid/package.json',
  ])
    assert.equal(
      retiresSupportMetadata(artifactOwners.supportArtifacts[file], v4),
      true,
      file,
    );
  // A mixed owner keeps its non-retired names and adopts the descriptor instead.
  assert.deepEqual(retiredSupportNames(['solid-js', '@rstest/core'], v4), [
    'solid-js',
  ]);
  assert.equal(retiresSupportMetadata(['solid-js', '@rstest/core'], v4), false);
  // Without an admitted descriptor, or with the v3 cohort, nothing is dropped.
  assert.equal(retiresSupportMetadata(['solid-js'], undefined), false);
  assert.equal(retiresSupportMetadata(['solid-js'], v3), false);
  assert.equal(retiresSupportMetadata([], v4), false);
  for (const [file, owned] of Object.entries(artifactOwners.supportArtifacts))
    if (!owned.some(name => !Object.hasOwn(v4, name)))
      assert.equal(retiresSupportMetadata(owned, v4), false, file);
});

test('without an admitted descriptor the Solid-only owners keep their shipped metadata', () => {
  for (const file of [
    'packages/runtime/renderer-solid/package.json',
    'tests/integration/renderer-solid/package.json',
  ]) {
    const shipped = showAt(supportBaselineRevision, file);
    const kept = planManifestUpdate({
      path: file,
      expected: showAt(sourceRevision, file),
      current: structuredClone(shipped),
      sourceRevision,
      supportBaseline: { revision: supportBaselineRevision, manifest: shipped },
      nativeBaseline: { revision: nativeBaselineRevision, manifest: shipped },
    });
    assert.deepEqual(kept.manifest.ultramodern, shipped.ultramodern, file);
    assert(
      kept.changes.every(change => !change.field.startsWith('ultramodern.')),
      file,
    );
  }
});

test('updates ordinary declarations and root tool pins without changing scripts', () => {
  const input = {
    dependencies: { semver: '7.8.5', axios: '^1.20.0' },
    devDependencies: { 'lint-staged': '~17.6.0' },
    scripts: { prepare: 'preserve me' },
    engines: { node: '>=26.12.0', pnpm: '>=12' },
    packageManager: 'pnpm@12.11.2',
  };
  const result = plan(input);
  assert.deepEqual(result.manifest, {
    ...input,
    dependencies: { semver: '7.8.6', axios: '^1.21.1' },
    devDependencies: { 'lint-staged': '~17.6.1' },
    engines: { node: '>=26.13.1', pnpm: '>=12.21.0' },
    packageManager: 'pnpm@12.21.0',
  });
  assert.equal(input.dependencies.semver, '7.8.5');
  assert.equal(plan(input, result.manifest).changes.length, 0);
});

test('preserves workspace identities, corrected aliases and URLs in every field', () => {
  const input = {
    dependencies: {
      semver: 'workspace:*',
      axios: 'npm:@bleedingdev/axios@1.0.0',
      effect:
        'https://github.com/BleedingDev/effect/releases/download/fix/effect.tgz',
    },
    devDependencies: { typescript: 'link:../typescript' },
    optionalDependencies: { yaml: 'file:./yaml' },
    peerDependencies: { '@modern-js/runtime': 'workspace:^3.8.3' },
    ultramodern: { nativeArtifacts: { integrity: 'unchanged' } },
  };
  const result = plan(input);
  assert.deepEqual(result.manifest, input);
  assert.equal(result.changes.length, 0);
  assert.equal(result.edges.filter(edge => edge.status === 'local').length, 4);
  assert.equal(result.edges.filter(edge => edge.status === 'held').length, 2);
});

test('retains admitting broad peers while advancing an exact ordinary peer', () => {
  const input = {
    peerDependencies: {
      react: '^18.0.0 || ^19.0.0',
      i18next: '>=25.7.4',
      semver: '7.8.5',
    },
  };
  const result = plan(input);
  assert.deepEqual(result.manifest.peerDependencies, {
    ...input.peerDependencies,
    semver: '7.8.6',
  });
  assert.equal(
    result.edges.filter(edge => edge.status === 'admitting-peer').length,
    2,
  );
});

test('retains unresolved TanStack artifacts but advances qualified OXC', () => {
  const input = {
    dependencies: {
      '@tanstack/react-router': '1.170.44',
      '@tsrx/oxc': '0.20.0',
    },
  };
  const result = plan(input);
  assert.deepEqual(result.manifest, {
    dependencies: {
      '@tanstack/react-router': '1.170.44',
      '@tsrx/oxc': '0.24.0',
    },
  });
  assert.equal(
    result.edges.find(edge => edge.name === '@tanstack/react-router').status,
    'held',
  );
  assert.equal(
    result.edges.find(edge => edge.name === '@tsrx/oxc').target,
    '0.24.0',
  );
});

test('recognizes the exact reviewed MF fixture transition without admitting arbitrary routers', () => {
  const input = { dependencies: { '@tanstack/react-router': '1.170.44' } };
  for (const name of ['mf-host', 'mf-remote', 'mf-remote-2']) {
    const file = `tests/integration/routes-tanstack-mf/${name}/package.json`;
    const result = plan(input, input, file);
    assert.equal(
      result.manifest.dependencies['@tanstack/react-router'],
      '1.170.46',
    );
    assert.equal(plan(input, result.manifest, file).changes.length, 0);
    assert.equal(result.manifest.ultramodern, undefined);
    for (const version of ['1.170.45', '1.170.47', '^1.170.46'])
      assert.throws(
        () =>
          plan(
            input,
            { dependencies: { '@tanstack/react-router': version } },
            file,
          ),
        /unexpected old edge/u,
      );
  }
  assert.deepEqual(plan(input).manifest, input);
});

test('advances qualified Rslib without treating arbitrary new versions as accepted', () => {
  const input = { devDependencies: { '@rslib/core': '1.0.3' } };
  const result = plan(input);
  assert.equal(result.manifest.devDependencies['@rslib/core'], '1.0.7');
  assert.equal(plan(input, result.manifest).changes.length, 0);
  assert.throws(
    () => plan(input, { devDependencies: { '@rslib/core': '1.0.8' } }),
    /edge/,
  );
});

test('accepts only the generator native API alias to the reviewed stable TypeScript release', () => {
  const file = 'packages/toolkit/ultramodern-create/package.json';
  const input = {
    dependencies: { '@typescript/native': 'npm:typescript@7.0.2' },
  };
  const result = plan(input, input, file);
  assert.equal(result.edges[0].status, 'satisfied-exception');
  assert.equal(result.edges[0].target, targets.typescript);
  assert.deepEqual(result.manifest, input);
  for (const alias of [
    'npm:typescript@7.0.1',
    'npm:typescript@next',
    'npm:@typescript/native-preview@7.0.2',
  ]) {
    const changed = { dependencies: { '@typescript/native': alias } };
    assert.throws(
      () => plan(changed, changed, file),
      /native TypeScript API alias/u,
    );
  }
  assert.equal(plan(input).edges[0].status, 'held');
});

test('advances specifically reviewed compiler, Solid and Cloudflare source targets', () => {
  const input = {
    dependencies: {
      '@effect/tsgo': '0.67.0',
      tsrs: '0.21.0-ts7.1.0-beta',
      '@solidjs/compiler': '2.0.0-rc.15',
      '@solidjs/signals': '2.0.0-rc.15',
      '@solidjs/web': '2.0.0-rc.15',
      'solid-js': '2.0.0-rc.15',
      miniflare: '5.20261012.0-beta',
      wrangler: '4.151.0',
      '@cloudflare/workers-types': '5.20261015.1',
    },
  };
  const result = plan(input);
  assert.deepEqual(result.manifest.dependencies, {
    '@effect/tsgo': '0.70.0',
    tsrs: '0.25.0-ts7.1.0-beta',
    '@solidjs/compiler': targets['@solidjs/compiler'],
    '@solidjs/signals': targets['@solidjs/signals'],
    '@solidjs/web': targets['@solidjs/web'],
    'solid-js': targets['solid-js'],
    miniflare: '5.20261113.0-beta',
    wrangler: '4.162.0',
    '@cloudflare/workers-types': '5.20261115.1',
  });
  assert(!Object.hasOwn(result.manifest.dependencies, 'workerd'));
  assert.equal(plan(input, result.manifest).changes.length, 0);
  assert.throws(
    () => plan({ dependencies: { '@effect/tsgo': '0.68.0' } }),
    /unreviewed coordinated old edge/,
  );
});

test('upgrades the shipped Effect compiler from the reviewed historical snapshot', () => {
  const file = 'package.json';
  const expected = showAt(sourceRevision, file);
  const shipped = showAt('0024faeea760417227135429fe2727ae471abbe4', file);
  const invoke = manifest =>
    planManifestUpdate({
      path: file,
      expected,
      current: manifest,
      sourceRevision,
      supportBaseline: {
        revision: supportBaselineRevision,
        manifest: showAt(supportBaselineRevision, file),
      },
      nativeBaseline: {
        revision: nativeBaselineRevision,
        manifest: showAt(nativeBaselineRevision, file),
      },
    });
  const result = invoke(shipped);
  assert.equal(result.manifest.devDependencies['@effect/tsgo'], '0.70.0');
  assert.deepEqual(
    result.changes.find(change => change.name === '@effect/tsgo'),
    {
      field: 'devDependencies',
      name: '@effect/tsgo',
      from: '0.69.0',
      to: '0.70.0',
    },
  );
  assert.equal(invoke(result.manifest).changes.length, 0);
  const drifted = structuredClone(shipped);
  drifted.devDependencies['@effect/tsgo'] = '0.68.0';
  assert.throws(
    () => invoke(drifted),
    /unexpected old edge devDependencies\.@effect\/tsgo/u,
  );
});

test('advances the shipped registry declarations without accepting nearby versions', () => {
  const expected = { dependencies: { hono: '^4.13.13' } };
  const shipped = { dependencies: { hono: '^4.13.18' } };
  const refreshed = plan(expected, shipped).manifest;
  assert.deepEqual(refreshed, { dependencies: { hono: '^4.13.19' } });
  assert.equal(plan(expected, refreshed).changes.length, 0);
  assert.throws(
    () => plan(expected, { dependencies: { hono: '4.13.18' } }),
    /unexpected old edge dependencies\.hono/u,
  );
});

test('uses exact reviewed supply identities for upstream and existing fork declarations', () => {
  const input = {
    dependencies: {
      '@module-federation/runtime': '2.9.2',
      '@module-federation/modern-js-v3':
        'npm:@bleedingdev/mf-modern-js-v3@2.9.4',
      '@module-federation/node': '2.7.52',
      '@tanstack/redact': 'npm:@bleedingdev/tanstack-redact@0.2.2',
      ultracite: '8.0.1',
    },
    peerDependencies: {
      '@module-federation/enhanced': 'npm:@bleedingdev/mf-enhanced@2.9.3',
    },
  };
  const result = plan(input);
  assert.deepEqual(result.manifest, {
    dependencies: {
      '@module-federation/runtime': 'npm:@bleedingdev/mf-runtime@2.9.5',
      '@module-federation/modern-js-v3':
        'npm:@bleedingdev/mf-modern-js-v3@2.9.5',
      '@module-federation/node': 'npm:@bleedingdev/mf-node@2.7.54',
      '@tanstack/redact': 'npm:@bleedingdev/tanstack-redact@0.3.2',
      ultracite: 'npm:@bleedingdev/ultracite@8.2.2',
    },
    peerDependencies: {
      '@module-federation/enhanced': 'npm:@bleedingdev/mf-enhanced@2.9.5',
    },
  });
  assert.equal(plan(input, result.manifest).changes.length, 0);
  assert.throws(
    () =>
      plan({
        dependencies: {
          '@module-federation/runtime': 'npm:@someone-else/runtime@2.9.2',
        },
      }),
    /unreviewed coordinated old edge/,
  );
});

test('keeps admitting broad peers even for explicitly coordinated packages', () => {
  const input = {
    peerDependencies: {
      '@module-federation/runtime': '^2.0.0',
      '@effect/tsgo': '>=0.67.0',
      '@solidjs/compiler': '^2.0.0-rc.15',
    },
  };
  const result = plan(input);
  assert.deepEqual(result.manifest, input);
  assert(result.edges.every(edge => edge.status === 'admitting-peer'));
});

test('moves all native React Router declarations to v8 and removes only obsolete DOM parents', () => {
  for (const value of ['7.18.4', '^7.18.4']) {
    const input = { dependencies: { 'react-router': value } };
    const result = plan(input);
    assert.equal(
      result.manifest.dependencies['react-router'],
      value.startsWith('^') ? '^8.5.1' : '8.5.1',
    );
    assert.equal(plan(input, result.manifest).changes.length, 0);
  }
  for (const [file, value] of [
    ['examples/module-federation/app-export/host/package.json', '^7.18.4'],
    ['examples/module-federation/base/host/package.json', '^7.18.4'],
    ['tests/e2e/builder/package.json', '7.18.4'],
  ]) {
    const input = {
      dependencies: { 'react-router-dom': value, semver: '7.8.5' },
    };
    const result = plan(input, input, file);
    assert(!Object.hasOwn(result.manifest.dependencies, 'react-router-dom'));
    assert.equal(plan(input, result.manifest, file).changes.length, 0);
  }
  const untouched = { dependencies: { 'react-router-dom': '7.18.4' } };
  assert.deepEqual(
    plan(untouched, untouched, 'tests/integration/dev-server/package.json')
      .manifest,
    untouched,
  );
});

test('counts current image prereleases and newer postcss-initial as satisfied exceptions', () => {
  const input = {
    dependencies: {
      'postcss-initial': '4.0.1',
      '@rsbuild-image/core': '0.0.1-next.36',
      '@rsbuild-image/react': '0.0.1-next.36',
    },
  };
  const result = plan(input);
  assert.deepEqual(result.manifest, input);
  assert(result.edges.every(edge => edge.status === 'satisfied-exception'));
});

test('accepts only the exact already-performed Redact wrapper removal', () => {
  const file = 'packages/solutions/ultramodern-app-tools/package.json';
  const input = {
    dependencies: { 'rsbuild-redact-plugin': '0.1.0', semver: '7.8.5' },
  };
  const removed = { dependencies: { semver: '7.8.6' } };
  const result = plan(input, removed, file);
  assert.deepEqual(result.manifest, removed);
  assert(result.edges.some(edge => edge.status === 'reviewed-removal'));
  assert.equal(result.changes.length, 0);
  assert.equal(
    plan(input, input, file).manifest.dependencies['rsbuild-redact-plugin'],
    '0.1.0',
  );
  assert.throws(
    () => plan(input, removed, 'packages/runtime/render/package.json'),
    /edge/,
  );
  assert.throws(() => plan(input, { dependencies: {} }, file), /edge/);
  assert.throws(
    () =>
      plan(
        {
          dependencies: { 'rsbuild-redact-plugin': '0.2.0' },
        },
        { dependencies: {} },
        file,
      ),
    /edge/,
  );
});

test('accepts removal of the unused MF host router while retaining actual framework router edges', () => {
  const input = { dependencies: { 'react-router': '^7.18.4' } };
  const removed = { dependencies: {} };
  const result = plan(
    input,
    removed,
    'examples/module-federation/app-export/host/package.json',
  );
  assert.deepEqual(result.manifest, removed);
  assert.equal(result.edges[0].status, 'reviewed-removal');
  assert.throws(
    () => plan(input, removed, 'packages/runtime/plugin-runtime/package.json'),
    /edge/,
  );
});

test('recognizes only the exact glob edges removed by the Node glob migrations', () => {
  for (const [file, field, name, from] of [
    [
      'scripts/lint-package-json/package.json',
      'dependencies',
      'fast-glob',
      '3.3.3',
    ],
    ['scripts/prebundle/package.json', 'devDependencies', 'fast-glob', '3.3.3'],
    ['scripts/prebundle/package.json', 'devDependencies', 'globby', '16.2.4'],
    [
      'packages/toolkit/utils/package.json',
      'dependencies',
      'fast-glob',
      '3.3.3',
    ],
  ]) {
    const expected = { [field]: { [name]: from } };
    const current = { [field]: {} };
    const result = plan(expected, current, file);
    assert.deepEqual(result.manifest, current);
    assert.equal(result.edges[0].status, 'reviewed-removal');
  }
  assert.throws(
    () =>
      plan(
        { dependencies: { 'fast-glob': '3.3.3' } },
        { dependencies: {} },
        'packages/cli/builder/package.json',
      ),
    /edge names changed/u,
  );
});

test('skips complete semantic fixtures but updates unrelated Tailwind fixture edges', () => {
  const fixture = {
    dependencies: { react: '^18.3.1', '@modern-js/runtime': '2.71.1' },
    devDependencies: { '@types/node': '^20' },
  };
  assert.deepEqual(
    plan(
      fixture,
      fixture,
      'tests/skill/fixtures/v2-app-needs-migrate/package.json',
    ).manifest,
    fixture,
  );
  const tailwind = {
    dependencies: { tailwindcss: '^2.2.19', postcss: '^8.5.31' },
  };
  const result = plan(
    tailwind,
    tailwind,
    'tests/integration/tailwindcss/fixtures/tailwindcss-v2/package.json',
  );
  assert.deepEqual(result.manifest.dependencies, {
    tailwindcss: '^2.2.19',
    postcss: '^8.5.33',
  });
});

test('includes examples without changing their local framework identities', () => {
  const input = {
    dependencies: { '@modern-js/runtime': 'workspace:*', koa: '3.2.1' },
    devDependencies: { typescript: '~5.9.3' },
  };
  const result = plan(input, input, 'examples/mcp-apps-todo/package.json');
  assert.deepEqual(result.manifest, {
    dependencies: { '@modern-js/runtime': 'workspace:*', koa: '3.3.0' },
    devDependencies: { typescript: '~7.0.2' },
  });
});

test('advances abbreviated ordinary ranges and the top-level test runner manifest', () => {
  const input = {
    devDependencies: { '@types/node': '^20', '@rstest/core': '0.12.3' },
  };
  const result = plan(input, input, 'tests/package.json');
  assert.deepEqual(result.manifest.devDependencies, {
    '@types/node': '^26.6.6',
    '@rstest/core': '0.12.6',
  });
});

test('fails closed on wrong source, unexpected old edges, missing or added edges', () => {
  const input = { dependencies: { semver: '7.8.5' } };
  assert.throws(
    () =>
      planManifestUpdate({
        path: 'package.json',
        expected: input,
        current: input,
        sourceRevision: 'not-the-reviewed-source',
      }),
    /source/,
  );
  for (const current of [
    { dependencies: { semver: '7.8.4' } },
    { dependencies: {} },
    { dependencies: { semver: '7.8.5', surprise: '1.0.0' } },
  ]) {
    assert.throws(() => plan(input, current), /edge/);
  }
  assert.throws(() => plan({}, {}, '../elsewhere/package.json'), /allowlist/);
});

test('consolidates only the reviewed owning OTel trace dependency tuple atomically', () => {
  const file = 'packages/server/bff-effect/package.json';
  const legacy = {
    '@opentelemetry/sdk-trace-base': '2.12.0',
    '@opentelemetry/sdk-trace-node': '2.12.0',
    '@opentelemetry/sdk-trace-web': '2.12.0',
  };
  const input = {
    dependencies: { ...legacy, '@opentelemetry/api': '1.10.0' },
    scripts: { build: 'preserve owning build' },
  };
  const result = plan(input, input, file);
  assert.deepEqual(result.manifest, {
    ...input,
    dependencies: {
      '@opentelemetry/api': '1.10.0',
      '@opentelemetry/sdk-trace': '3.1.1',
    },
  });
  assert.equal(plan(input, result.manifest, file).changes.length, 0);
  assert(!result.edges.some(edge => edge.status === 'unknown'));
  assert.throws(
    () => plan(input, result.manifest, 'packages/server/bff-core/package.json'),
    /edge/,
  );
  for (const dependencies of [
    { ...legacy, '@opentelemetry/sdk-trace': '3.1.1' },
    { ...result.manifest.dependencies, '@opentelemetry/sdk-trace': '3.1.2' },
    {
      ...result.manifest.dependencies,
      '@opentelemetry/sdk-trace-base': '2.12.0',
    },
    { '@opentelemetry/api': '1.10.0' },
  ])
    assert.throws(
      () => plan(input, { ...input, dependencies }, file),
      /edge|tuple/,
    );
  assert.throws(
    () =>
      plan(
        input,
        {
          ...input,
          dependencies: {},
          devDependencies: result.manifest.dependencies,
        },
        file,
      ),
    /edge|tuple/,
  );
});

test('preserves concurrent non-dependency changes and rejects root pin drift', () => {
  const input = {
    dependencies: { semver: '7.8.5' },
    engines: { node: '>=26.12.0', pnpm: '>=12' },
    packageManager: 'pnpm@12.11.2',
  };
  assert.deepEqual(
    plan(input, { ...input, scripts: { test: 'parent-change' } }).manifest
      .scripts,
    { test: 'parent-change' },
  );
  assert.throws(
    () => plan(input, { ...input, packageManager: 'pnpm@13.0.0' }),
    /pin/,
  );
});

test('never downgrades and makes missing targets explicit', () => {
  const input = {
    dependencies: { semver: '8.0.0', 'unknown-dependency': '^1.0.0' },
  };
  const result = plan(input);
  assert.deepEqual(result.manifest, input);
  assert.equal(result.edges[0].status, 'held');
  assert.equal(result.edges[1].status, 'unknown');
  assert.equal(targets.semver, '7.8.6');
});

test('preserves both Tailwind legacy majors and the synthetic plugin fixtures', () => {
  for (const [major, version] of [
    [2, '^2.2.19'],
    [3, '^3.4.19'],
  ]) {
    const input = {
      dependencies: { tailwindcss: version, postcss: '^8.5.31' },
    };
    const result = plan(
      input,
      input,
      `tests/integration/tailwindcss/fixtures/tailwindcss-v${major}/package.json`,
    );
    assert.equal(result.manifest.dependencies.tailwindcss, version);
    assert.equal(result.manifest.dependencies.postcss, '^8.5.33');
  }
  for (const file of [
    'packages/server/core/tests/fixtures/load-plugins/package.json',
    'packages/toolkit/utils/tests/fixtures/plugin/package.json',
  ]) {
    const input = { dependencies: { semver: '7.8.5', 'plugin-a': '*' } };
    assert.deepEqual(plan(input, input, file).manifest, input);
  }
});

test('rejects changes to a held corrected edge instead of treating it as current', () => {
  const input = {
    dependencies: {
      '@module-federation/runtime': '2.9.2',
      '@tanstack/router-core': 'https://github.com/BleedingDev/router/fix.tgz',
    },
  };
  for (const [name, version] of [
    ['@module-federation/runtime', '2.9.3'],
    ['@tanstack/router-core', '1.171.39'],
  ]) {
    assert.throws(
      () =>
        plan(input, {
          dependencies: { ...input.dependencies, [name]: version },
        }),
      /edge/,
    );
  }
});

test('raises only the exact production Node floor and remains idempotent', () => {
  const input = {
    engines: { node: '>=26.12.0', pnpm: '>=12' },
    dependencies: { semver: '7.8.5' },
  };
  for (const file of [
    'packages/solutions/app-tools/package.json',
    'packages/runtime/renderer-solid/package.json',
    'examples/deploy/self-built-node/package.json',
  ]) {
    const result = plan(input, input, file);
    assert.equal(result.manifest.engines.node, '>=26.13.1');
    assert.equal(result.manifest.engines.pnpm, '>=12');
    assert.equal(plan(input, result.manifest, file).changes.length, 0);
    assert.throws(
      () => plan(input, { ...input, engines: { node: '>=27.0.0' } }, file),
      /pin/,
    );
  }
});

test('does not raise broad compatibility ranges or fixture Node floors', () => {
  for (const floor of ['>=18', '^22.18.0 || >=24.3.0', '>=26.0.0']) {
    const input = { engines: { node: floor } };
    assert.deepEqual(
      plan(input, input, 'packages/runtime/render/package.json').manifest,
      input,
    );
  }
  const fixture = { engines: { node: '>=26.12.0' } };
  for (const file of [
    'tests/integration/ultramodern-sandpack-profile-smoke/package.json',
    'tests/skill/fixtures/v2-app-needs-migrate/package.json',
    'packages/toolkit/utils/tests/fixtures/plugin/package.json',
  ]) {
    assert.deepEqual(plan(fixture, fixture, file).manifest, fixture);
  }
});

test('JSON receipts and arbitrary URL maps cannot authorize an artifact transition', () => {
  for (const artifactAuthority of [
    {},
    { accepted: true },
    {
      nativeArtifacts: {
        packages: { octane: { request: 'https://evil.invalid/a.tgz' } },
      },
    },
  ])
    assert.throws(
      () =>
        planManifestUpdate({
          path: 'package.json',
          expected: {},
          current: {},
          sourceRevision,
          artifactAuthority,
        }),
      /Verified artifact admission authority/,
    );
  assert.throws(
    () => plan({}, { ultramodern: { supportArtifacts: { accepted: true } } }),
    /unverified supportArtifacts metadata/,
  );
});

test('SYNTHETIC GitHub evidence ONLY: real reviewed native-four/support-six bytes authorize bounded, convergent updates', {
  timeout: 180_000,
}, async t => {
  // NOT hosted acceptance: synthetic API/run/tag evidence, actual pinned npm bytes
  // plus the repository's reviewed patches. No owning builds/install/activation.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { gzipSync, gunzipSync } = await import('node:zlib');
  const native = await import(
    '../ultramodern-renderers/native-artifacts/protocol.mjs'
  );
  const { supportProtocol: support } = await import(
    '../ultramodern-support-artifacts/protocol.mjs'
  );
  const { releaseRecipe: nativeRecipe } = await import(
    '../ultramodern-renderers/native-artifacts/recipes.mjs'
  );
  const { releaseRecipe: supportRecipe } = await import(
    '../ultramodern-support-artifacts/recipes.mjs'
  );
  const { reconstructArtifact } = await import(
    '../ultramodern-artifacts/reconstruct.mjs'
  );
  const { releaseBody } = await import(
    '../ultramodern-artifacts/transport.mjs'
  );
  const { admitArtifactDescriptors } = await import('./artifact-admission.mjs');
  const { artifactOwners } = await import('./snapshot.mjs');
  assert(process.env.OWNED_TEMP_DIR, 'Run through owned-temp-dir');
  const directory = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'updater-integration-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const signal = AbortSignal.timeout(150_000);
  const registryBytes = new Map();
  const hosted = new Map();
  const github = new Map();
  const descriptors = {};
  const upstreams = new Set();
  const fetchArtifact = async url => {
    if (hosted.has(url)) return new Response(hosted.get(url));
    assert(upstreams.has(url), `Unexpected fixture transport ${url}`);
    if (!registryBytes.has(url)) {
      const response = await fetch(url, { signal });
      assert(response.ok, `Pinned registry input HTTP ${response.status}`);
      registryBytes.set(url, Buffer.from(await response.arrayBuffer()));
    }
    return new Response(registryBytes.get(url));
  };
  const fixtures = [];
  for (const [kind, p, recipe] of [
    ['nativeArtifacts', native, nativeRecipe()],
    ['supportArtifacts', support, supportRecipe()],
  ]) {
    for (const item of Object.values(recipe.packages))
      upstreams.add(item.upstream.request);
    const source = (kind === 'nativeArtifacts' ? 'a' : 'b').repeat(40);
    const producer = {
      repository: p.repository,
      repositoryId: p.repositoryId,
      workflow: p.workflow,
      source,
      runId: kind === 'nativeArtifacts' ? 123 : 456,
      runAttempt: 2,
      tag: `${kind === 'nativeArtifacts' ? 'native-renderers' : 'support-artifacts'}-${source}-${kind === 'nativeArtifacts' ? 123 : 456}-2`,
    };
    const out = path.join(directory, kind);
    const manifest = await reconstructArtifact({
      protocol: p,
      recipe,
      producer,
      directory: out,
      fetchArtifact,
      signal,
    });
    for (const [name, item] of Object.entries(manifest.packages)) {
      const canonical = fs.readFileSync(
        path.join(out, p.assetFilename(name, item.version)),
      );
      // Exercise a provider-distinct gzip representation with the SAME tar bytes.
      const bytes = gzipSync(gunzipSync(canonical), { level: 1 });
      assert(!bytes.equals(canonical));
      item.integrity = p.integrity(bytes);
      hosted.set(item.request, bytes);
    }
    const descriptor = p.descriptorFor(manifest);
    descriptors[kind] = descriptor;
    hosted.set(descriptor.manifest.request, p.manifestBytes(manifest));
    const repo = { id: p.repositoryId, full_name: p.repository };
    github.set(`/repositories/${p.repositoryId}`, repo);
    const base = `/repos/${p.repository}`;
    const run = {
      id: producer.runId,
      run_attempt: 2,
      repository: repo,
      head_repository: repo,
      head_sha: source,
      path: p.workflow,
      event: 'workflow_dispatch',
      head_branch: 'main-ultramodern',
      actor: { login: 'BleedingDev' },
      triggering_actor: { login: 'BleedingDev' },
      status: 'completed',
      conclusion: 'success',
    };
    github.set(`${base}/actions/runs/${producer.runId}/attempts/2`, run);
    github.set(
      `${base}/actions/runs/${producer.runId}/attempts/2/jobs?per_page=100`,
      {
        total_count: 2,
        jobs: ['produce', 'qualify'].map(name => ({
          name,
          head_sha: source,
          status: 'completed',
          conclusion: 'success',
        })),
      },
    );
    github.set(`${base}/git/ref/tags/${producer.tag}`, {
      ref: `refs/tags/${producer.tag}`,
      object: { type: 'commit', sha: source },
    });
    const release = {
      tag_name: producer.tag,
      target_commitish: source,
      draft: false,
      prerelease: false,
      html_url: `https://github.com/${p.repository}/releases/tag/${producer.tag}`,
      body: releaseBody({ protocol: p, descriptor }),
      assets: [
        p.manifestFilename,
        ...Object.entries(p.cohort).map(([name, version]) =>
          p.assetFilename(name, version),
        ),
      ].map((name, index) => ({
        id: index + 1,
        name,
        state: 'uploaded',
        browser_download_url: p.releaseUrl(producer, name),
        digest: `sha256:${p.sha256(hosted.get(p.releaseUrl(producer, name)))}`,
      })),
    };
    github.set(`${base}/releases/tags/${producer.tag}`, release);
    fixtures.push({ p, run, release, descriptor });
  }
  const readGithub = async route => {
    assert(github.has(route), `Unexpected synthetic GitHub route ${route}`);
    return structuredClone(github.get(route));
  };
  const options = {
    nativeDescriptor: descriptors.nativeArtifacts,
    supportDescriptor: descriptors.supportArtifacts,
    fetchArtifact,
    readNativeGithub: readGithub,
    readSupportGithub: readGithub,
    signal,
  };
  assert.deepEqual(
    Object.keys(descriptors.supportArtifacts.packages).sort(),
    Object.keys(support.cohort).sort(),
    'the admitted support descriptor is the exact six-package v4 cohort',
  );
  // A name the admitted support descriptor omits is retired: its selection is
  // the live snapshot target, and a fully retired owner drops its support block.
  const selectedValue = (kind, name, field) => {
    const pin = descriptors[kind].packages[name];
    if (pin === undefined) return targets[name];
    return field === 'peerDependencies' ? pin.version : pin.request;
  };
  const retiredAway = (kind, file) =>
    kind === 'supportArtifacts' &&
    retiresSupportMetadata(
      artifactOwners.supportArtifacts[file] ?? [],
      descriptors.supportArtifacts.packages,
    );
  const authority = await admitArtifactDescriptors(options);
  const selectedFiles = [
    ...new Set(
      Object.values(artifactOwners).flatMap(owners => Object.keys(owners)),
    ),
  ];
  // The live checkout may already carry the real admitted artifacts. Synthetic
  // descriptors transition only the authoritative pre-activation originals.
  const checkout = fileURLToPath(new URL('../../', import.meta.url));
  const root = path.join(directory, 'source');
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' });
  git('clone', '--quiet', '--shared', '--no-checkout', checkout, root);
  git(
    '-C',
    root,
    'checkout',
    '--quiet',
    '--detach',
    git('-C', checkout, 'rev-parse', 'HEAD').trim(),
  );
  // Validate the candidate's tracked source selections, not the older HEAD
  // copies. Only the artifact-owning manifests start from the shipped inputs.
  const candidateChanges = execFileSync(
    'git',
    ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD'],
    { cwd: checkout, maxBuffer: 16 * 1024 * 1024 },
  );
  if (candidateChanges.length)
    execFileSync('git', ['apply', '-'], {
      cwd: root,
      input: candidateChanges,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  git('-C', root, 'checkout', sourceRevision, '--', ...selectedFiles);
  let reviewedEdges = 0;
  // The generator has no direct support edge but emits support requests from
  // its own manifest metadata into every generated app.
  const generator = 'packages/toolkit/ultramodern-create/package.json';
  for (const file of selectedFiles) {
    const expected = JSON.parse(
      execFileSync('git', ['-C', root, 'show', `${sourceRevision}:${file}`], {
        encoding: 'utf8',
      }),
    );
    const current = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    const invoke = current =>
      planManifestUpdate({
        path: file,
        expected,
        current,
        sourceRevision,
        artifactAuthority: authority,
      });
    const result = invoke(current);
    if (file === generator)
      assert.deepEqual(
        result.manifest.ultramodern.supportArtifacts,
        descriptors.supportArtifacts,
        `${file}: generator receives the admitted support descriptor`,
      );
    for (const [kind, owners] of Object.entries(artifactOwners)) {
      for (const name of owners[file] ?? []) {
        for (const field of [
          'dependencies',
          'devDependencies',
          'peerDependencies',
        ]) {
          if (!Object.hasOwn(result.manifest[field] ?? {}, name)) continue;
          assert.equal(
            result.manifest[field][name],
            selectedValue(kind, name, field),
            `${file}:${field}.${name}`,
          );
          assert(
            !result.edges.some(
              edge => edge.name === name && edge.status === 'held',
            ),
          );
          reviewedEdges++;
        }
      }
      if (owners[file])
        assert.deepEqual(
          result.manifest.ultramodern?.[kind],
          retiredAway(kind, file) ? undefined : descriptors[kind],
        );
    }
    assert.equal(
      invoke(result.manifest).changes.length,
      0,
      `${file}: converges`,
    );
    const selected = Object.values(artifactOwners).flatMap(
      owners => owners[file] ?? [],
    );
    const field = ['dependencies', 'devDependencies'].find(field =>
      selected.some(name => result.manifest[field]?.[name]),
    );
    if (field) {
      const bad = structuredClone(result.manifest);
      const name = selected.find(name => bad[field]?.[name]);
      bad[field][name] = 'https://evil.invalid/forged.tgz';
      assert.throws(() => invoke(bad), /edge|tuple/);
    }
  }
  assert(reviewedEdges > 50);
  // Shipped v3 manifests move to a newly admitted descriptor only through the
  // reviewed baseline commit's exact owned support selections.
  const supportOnly = await admitArtifactDescriptors({
    ...options,
    nativeDescriptor: undefined,
  });
  const supportV4 = descriptors.supportArtifacts;
  let migratedEdges = 0;
  let migratedFiles = 0;
  for (const [file, names] of Object.entries(artifactOwners.supportArtifacts)) {
    if (artifactOwners.nativeArtifacts[file]) continue;
    const baseline = JSON.parse(
      execFileSync(
        'git',
        ['-C', root, 'show', `${supportBaselineRevision}:${file}`],
        { encoding: 'utf8' },
      ),
    );
    const prior = baseline.ultramodern?.supportArtifacts;
    if (!prior) continue;
    assert.equal(prior.protocol, 'ultramodern.support-artifacts.v3');
    assert.equal(prior.producer.runId, 43934193068);
    const expected = JSON.parse(
      execFileSync('git', ['-C', root, 'show', `${sourceRevision}:${file}`], {
        encoding: 'utf8',
      }),
    );
    const invoke = (current, supportBaseline) =>
      planManifestUpdate({
        path: file,
        expected,
        current,
        sourceRevision,
        artifactAuthority: supportOnly,
        supportBaseline,
      });
    const bound = { revision: supportBaselineRevision, manifest: baseline };
    // Fails without the reviewed baseline: the shipped run is not the newly
    // admitted one.
    assert.throws(() => invoke(baseline), /unexpected old|unverified|tuple/);
    const result = invoke(baseline, bound);
    assert.deepEqual(
      result.manifest.ultramodern?.supportArtifacts,
      retiredAway('supportArtifacts', file) ? undefined : supportV4,
    );
    for (const name of names)
      for (const field of ['dependencies', 'devDependencies']) {
        const value = baseline[field]?.[name];
        if (value === undefined) continue;
        assert.equal(value, prior.packages[name].request, `${file}:${name}`);
        assert.equal(
          result.manifest[field][name],
          selectedValue('supportArtifacts', name, field),
        );
        migratedEdges++;
        const forged = structuredClone(baseline);
        forged[field][name] = value.replace(/-\d+\/(?=[^/]+$)/u, '-9/');
        assert.notEqual(forged[field][name], value);
        assert.throws(() => invoke(forged, bound), /unexpected old|tuple/);
      }
    assert.equal(invoke(result.manifest, bound).changes.length, 0);
    migratedFiles++;
  }
  assert(migratedFiles > 15 && migratedEdges > 20);
  // Accepted native consumers move to a newly admitted native descriptor only
  // through the reviewed native baseline's exact owned selections. Their
  // support-owned parts are staged at the reviewed support baseline so this
  // synthetic support descriptor (not the real one) can be admitted alongside.
  const nativeNew = descriptors.nativeArtifacts;
  const fields = ['dependencies', 'devDependencies', 'peerDependencies'];
  let nativeEdges = 0;
  for (const [file, names] of Object.entries(artifactOwners.nativeArtifacts)) {
    const show = revision =>
      JSON.parse(
        execFileSync('git', ['-C', root, 'show', `${revision}:${file}`], {
          encoding: 'utf8',
        }),
      );
    const baseline = show(nativeBaselineRevision);
    const prior = baseline.ultramodern.nativeArtifacts;
    assert.equal(prior.producer.runId, 43993884470);
    const expected = show(sourceRevision);
    const current = structuredClone(baseline);
    const supportBound = { revision: supportBaselineRevision };
    if (artifactOwners.supportArtifacts[file]) {
      supportBound.manifest = show(supportBaselineRevision);
      current.ultramodern.supportArtifacts =
        supportBound.manifest.ultramodern.supportArtifacts;
      for (const name of artifactOwners.supportArtifacts[file])
        for (const field of fields)
          if (Object.hasOwn(supportBound.manifest[field] ?? {}, name))
            current[field][name] = supportBound.manifest[field][name];
    }
    const nativeBound = {
      revision: nativeBaselineRevision,
      manifest: baseline,
    };
    const invoke = (manifest, artifactAuthority, nativeBaseline) =>
      planManifestUpdate({
        path: file,
        expected,
        current: manifest,
        sourceRevision,
        artifactAuthority,
        supportBaseline: supportBound,
        nativeBaseline,
      });
    assert.throws(
      () => invoke(current, authority),
      /unexpected old|unverified|tuple/,
    );
    // Without a newer native admission the accepted native state stays.
    const kept = invoke(current, supportOnly, nativeBound);
    assert.deepEqual(kept.manifest.ultramodern.nativeArtifacts, prior);
    const result = invoke(current, authority, nativeBound);
    assert.deepEqual(result.manifest.ultramodern.nativeArtifacts, nativeNew);
    for (const name of names)
      for (const field of fields) {
        const value = baseline[field]?.[name];
        if (value === undefined) continue;
        const peer = field === 'peerDependencies';
        const pin = prior.packages[name];
        assert.equal(
          value,
          peer ? pin.version : pin.request,
          `${file}:${name}`,
        );
        assert.equal(kept.manifest[field][name], value);
        assert.equal(
          result.manifest[field][name],
          peer
            ? nativeNew.packages[name].version
            : nativeNew.packages[name].request,
        );
        nativeEdges++;
        if (peer) continue;
        const forged = structuredClone(current);
        forged[field][name] = value.replace(/-\d+\/(?=[^/]+$)/u, '-9/');
        assert.notEqual(forged[field][name], value);
        assert.throws(
          () => invoke(forged, authority, nativeBound),
          /unexpected old|tuple/,
        );
      }
    assert.equal(
      invoke(result.manifest, authority, nativeBound).changes.length,
      0,
      `${file}: native transition converges`,
    );
  }
  assert(nativeEdges > 20);
  // The batch reviews current source selections as well as manifest edges.
  // Stage the admitted synthetic descriptor and matching source URL selections,
  // then exercise the transition from the original dependency edges. These
  // throwaway sources are not production evidence.
  const sourceOwner = 'packages/runtime/renderer-octane/package.json';
  const stagedOwner = JSON.parse(
    fs.readFileSync(path.join(root, sourceOwner), 'utf8'),
  );
  const actualDescriptor = JSON.parse(
    fs.readFileSync(path.join(checkout, sourceOwner), 'utf8'),
  ).ultramodern.nativeArtifacts;
  stagedOwner.ultramodern.nativeArtifacts = descriptors.nativeArtifacts;
  fs.writeFileSync(
    path.join(root, sourceOwner),
    `${JSON.stringify(stagedOwner, null, 2)}\n`,
  );
  for (const file of [
    'packages/runtime/renderer-octane/src/plugin/profile.ts',
    'packages/runtime/renderer-solid/src/plugin/profile.ts',
  ]) {
    const filename = path.join(root, file);
    let source = fs.readFileSync(filename, 'utf8');
    for (const [name, item] of Object.entries(actualDescriptor.packages))
      source = source.replaceAll(
        item.request,
        descriptors.nativeArtifacts.packages[name].request,
      );
    fs.writeFileSync(filename, source);
  }
  const batch = runUpdater({ root, artifactAuthority: authority });
  for (const edge of batch.unresolved)
    assert(
      !Object.values(artifactOwners).some(owners =>
        owners[edge.path]?.includes(edge.name),
      ),
      `Known selected artifact remains unresolved: ${edge.path}:${edge.name}`,
    );
  assert(
    batch.changedFiles.some(record =>
      record.changes.some(
        change => change.field === 'ultramodern.nativeArtifacts',
      ),
    ),
  );
  assert(
    batch.changedFiles.some(record =>
      record.changes.some(
        change => change.field === 'ultramodern.supportArtifacts',
      ),
    ),
  );
  assert.throws(
    () =>
      planManifestUpdate({
        path: 'package.json',
        expected: {},
        current: {},
        sourceRevision,
        artifactAuthority: structuredClone(authority),
      }),
    /authority/,
  );
  const unknown = {
    dependencies: {
      'unknown-package': '1.0.0',
      octane: 'https://evil.invalid/unreviewed.tgz',
    },
  };
  const untouched = planManifestUpdate({
    path: 'examples/unrelated/package.json',
    expected: unknown,
    current: unknown,
    sourceRevision,
    artifactAuthority: authority,
  });
  assert.deepEqual(
    untouched.edges.map(edge => edge.status),
    ['unknown', 'held'],
  );
  for (const f of fixtures) {
    f.run.conclusion = 'failure';
    await assert.rejects(admitArtifactDescriptors(options));
    f.run.conclusion = 'success';
    for (const [key, bad] of [
      ['head_sha', 'f'.repeat(40)],
      ['run_attempt', 1],
      ['path', '.github/workflows/untrusted.yml'],
    ]) {
      const old = f.run[key];
      f.run[key] = bad;
      await assert.rejects(admitArtifactDescriptors(options));
      f.run[key] = old;
    }
    const name = Object.keys(f.descriptor.packages)[0];
    const item = f.descriptor.packages[name];
    const original = hosted.get(item.request);
    hosted.set(item.request, Buffer.from('tampered hosted bytes'));
    await assert.rejects(admitArtifactDescriptors(options), /SHA512/);
    hosted.set(item.request, original);
    // Even self-consistent replacement hashes and synthetic release evidence do
    // not grant authority for bytes outside the reviewed canonical correction.
    const oldIntegrity = item.integrity;
    const tar = gunzipSync(original);
    tar[tar.length - 1] = 1;
    const altered = gzipSync(tar);
    hosted.set(item.request, altered);
    item.integrity = f.p.integrity(altered);
    const reseal = () => {
      const manifest = {
        protocol: f.descriptor.protocol,
        producer: f.descriptor.producer,
        packages: f.descriptor.packages,
      };
      f.descriptor.manifest = f.p.descriptorFor(manifest).manifest;
      hosted.set(f.descriptor.manifest.request, f.p.manifestBytes(manifest));
      f.release.body = releaseBody({ protocol: f.p, descriptor: f.descriptor });
      for (const asset of f.release.assets)
        asset.digest = `sha256:${f.p.sha256(hosted.get(asset.browser_download_url))}`;
    };
    reseal();
    await assert.rejects(
      admitArtifactDescriptors(options),
      /tar bytes mismatch/,
    );
    item.integrity = oldIntegrity;
    hosted.set(item.request, original);
    reseal();
  }
  const forged = structuredClone(options.nativeDescriptor);
  forged.packages.octane.patchSha256 = 'f'.repeat(64);
  await assert.rejects(
    admitArtifactDescriptors({ ...options, nativeDescriptor: forged }),
    /unreviewed native patch/,
  );
  const forgedSupport = structuredClone(options.supportDescriptor);
  const [forgedName] = Object.keys(forgedSupport.packages);
  forgedSupport.packages[forgedName].patchSha256 = 'f'.repeat(64);
  await assert.rejects(
    admitArtifactDescriptors({
      ...options,
      nativeDescriptor: undefined,
      supportDescriptor: forgedSupport,
    }),
    /unreviewed support patch/,
  );
});
