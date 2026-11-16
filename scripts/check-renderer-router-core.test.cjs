const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  assertRendererRouterCore,
} = require('./check-renderer-router-core.cjs');
const native = require('./ultramodern-renderers/native-artifacts/protocol.mjs');

const core = '@tanstack/router-core';
// The admitted descriptor exactly as the renderer records it.
const recorded = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../packages/runtime/renderer-solid/package.json'),
    'utf8',
  ),
).ultramodern.nativeArtifacts;
const request = recorded.packages[core].request;
const registry = native.cohort[core];
const legacyCore =
  'https://github.com/BleedingDev/router/releases/download/ultramodern-router-core-585d3233f7f5/tanstack-router-core-1.171.38.tgz';

const check = consumers =>
  assertRendererRouterCore(
    {
      versions: consumers.map(([pathRelative, version]) => ({
        version,
        packages: [{ pathRelative }],
      })),
    },
    pathRelative =>
      consumers.find(([candidate]) => candidate === pathRelative)[2] ?? {},
  );
const recording = nativeArtifacts => ({ ultramodern: { nativeArtifacts } });

test('the workspace resolves its own recorded native Core', async () => {
  const { CDVC } = await import('check-dependency-version-consistency');
  const workspace = new CDVC(path.join(__dirname, '..'), {
    ignorePackagePattern: ['^@examples/'],
  });
  assert.doesNotThrow(() =>
    assertRendererRouterCore(workspace.getDependency(core)),
  );
});

test('a recorded descriptor binds its consumer to the canonical Core archive', () => {
  const own = recording(recorded);
  for (const path of [
    'packages/runtime/renderer-solid',
    'packages\\runtime\\renderer-octane',
  ]) {
    assert.doesNotThrow(() => check([[path, request, own]]));
    for (const version of [registry, legacyCore, '1.171.38'])
      assert.throws(() => check([[path, version, own]]), /must resolve/);
  }
});

test('consumers without a descriptor stay on the registry release', () => {
  assert.doesNotThrow(() => check([['packages/new-consumer', registry]]));
  for (const version of [request, legacyCore, '1.171.38', '^1.171.39'])
    assert.throws(
      () => check([['packages/new-consumer', version]]),
      /must resolve/,
    );
  assert.doesNotThrow(() =>
    check([
      ['packages/runtime/renderer-solid', request, recording(recorded)],
      ['packages/new-consumer', registry],
    ]),
  );
});

test('legacy flat and non-canonical descriptors are rejected', () => {
  const flat = {
    [core]: { request: legacyCore, version: '1.171.38', integrity: 'x' },
  };
  assert.throws(
    () =>
      check([['packages/runtime/renderer-solid', legacyCore, recording(flat)]]),
    /invalid native artifact descriptor/,
  );
  const moved = structuredClone(recorded);
  moved.packages[core].request = legacyCore;
  assert.throws(
    () =>
      check([
        ['packages/runtime/renderer-solid', legacyCore, recording(moved)],
      ]),
    /invalid native artifact descriptor/,
  );
});

test('one workspace admits a single native Core identity', () => {
  const producer = {
    ...recorded.producer,
    runAttempt: recorded.producer.runAttempt + 1,
  };
  producer.tag = `native-renderers-${producer.source}-${producer.runId}-${producer.runAttempt}`;
  const other = native.descriptorFor({
    protocol: recorded.protocol,
    producer,
    packages: Object.fromEntries(
      Object.entries(recorded.packages).map(([name, item]) => [
        name,
        {
          ...item,
          request: native.releaseUrl(
            producer,
            native.assetFilename(name, item.version),
          ),
        },
      ]),
    ),
  });
  native.validateDescriptor(other);
  assert.throws(
    () =>
      check([
        ['packages/runtime/renderer-solid', request, recording(recorded)],
        [
          'packages/runtime/renderer-octane',
          other.packages[core].request,
          recording(other),
        ],
      ]),
    /mixed native @tanstack\/router-core identities/,
  );
});
