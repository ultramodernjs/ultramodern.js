import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceRevision, targets } from './snapshot.mjs';
import { planManifestUpdate, runUpdater } from './update.mjs';

const plan = (expected, current = expected, path = 'package.json') =>
  planManifestUpdate({ path, expected, current, sourceRevision });

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
  const receiving = { devDependencies: { '@rsbuild/core': '2.3.2' } };
  const received = {
    devDependencies: {
      ...receiving.devDependencies,
      '@rsbuild/plugin-svgr': '2.0.5',
      '@types/babel__core': '^7.20.5',
      prettier: '~3.10.1',
    },
  };
  const receivedPlan = plan(receiving, received, extensions);
  assert.deepEqual(receivedPlan.manifest, received);
  assert.equal(receivedPlan.changes.length, 0);
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
  const input = { dependencies: { 'solid-js': '2.0.0-rc.15' } };
  const result = plan(input, input, file);
  assert.deepEqual(result.manifest, {
    dependencies: {},
    peerDependencies: { 'solid-js': '2.0.0-rc.22' },
    devDependencies: { 'solid-js': '2.0.0-rc.22' },
  });
  assert.equal(plan(input, result.manifest, file).changes.length, 0);
  for (const changed of [
    {
      ...result.manifest,
      peerDependencies: { 'solid-js': '^2.0.0-rc.22' },
    },
    {
      ...result.manifest,
      peerDependenciesMeta: { 'solid-js': { optional: true } },
    },
    { ...result.manifest, devDependencies: {} },
    {
      ...result.manifest,
      dependencies: { 'solid-js': '2.0.0-rc.22' },
    },
  ])
    assert.throws(() => plan(input, changed, file), /Solid host tuple/u);
  assert.equal(
    plan(input, input, 'packages/runtime/another-renderer/package.json')
      .manifest.dependencies['solid-js'],
    '2.0.0-rc.22',
  );
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
    '@effect/tsgo': '0.69.0',
    tsrs: '0.25.0-ts7.1.0-beta',
    '@solidjs/compiler': '2.0.0-rc.22',
    '@solidjs/signals': '2.0.0-rc.22',
    '@solidjs/web': '2.0.0-rc.22',
    'solid-js': '2.0.0-rc.22',
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
  git('-C', root, 'checkout', sourceRevision, '--', ...selectedFiles);
  let reviewedEdges = 0;
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
    for (const [kind, owners] of Object.entries(artifactOwners)) {
      for (const name of owners[file] ?? []) {
        for (const field of [
          'dependencies',
          'devDependencies',
          'peerDependencies',
        ]) {
          if (!Object.hasOwn(result.manifest[field] ?? {}, name)) continue;
          const pin = descriptors[kind].packages[name];
          assert.equal(
            result.manifest[field][name],
            field === 'peerDependencies' ? pin.version : pin.request,
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
        assert.deepEqual(result.manifest.ultramodern[kind], descriptors[kind]);
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
  // The batch reviews current source selections as well as manifest edges.
  // Keep the real reviewed source descriptor while exercising the transition
  // from original dependency edges to deliberately synthetic admitted URLs.
  const sourceOwner = 'packages/runtime/renderer-octane/package.json';
  const stagedOwner = JSON.parse(
    fs.readFileSync(path.join(root, sourceOwner), 'utf8'),
  );
  stagedOwner.ultramodern.nativeArtifacts = JSON.parse(
    fs.readFileSync(path.join(checkout, sourceOwner), 'utf8'),
  ).ultramodern.nativeArtifacts;
  fs.writeFileSync(
    path.join(root, sourceOwner),
    `${JSON.stringify(stagedOwner, null, 2)}\n`,
  );
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
  forgedSupport.packages['solid-js'].patchSha256 = 'f'.repeat(64);
  await assert.rejects(
    admitArtifactDescriptors({
      ...options,
      nativeDescriptor: undefined,
      supportDescriptor: forgedSupport,
    }),
    /unreviewed support patch/,
  );
});
