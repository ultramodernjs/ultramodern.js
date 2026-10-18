import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {
  assertGeneratedNativeFederationSSR,
  authenticateGeneratedNativeFederationApp,
  planGeneratedNativeFederation,
} from './native-federation-generated.mjs';
import * as packed from './native-federation-packed.mjs';

assert(
  process.env.OWNED_TEMP_DIR,
  'Run these filesystem tests through owned-temp-dir',
);

test('generated MF forwards supplied native archives through its actual packed child boundary', async () => {
  const calls = [];
  const stopped = Promise.resolve('captured generated MF child');
  const key = Symbol.for('generated-mf-native-input-control');
  globalThis[key] = {
    ...packed,
    runPackedNativeFederationProof: options => {
      calls.push(options);
      return stopped;
    },
  };
  const moduleURL = new URL(
    './native-federation-generated.mjs?native-input-control',
    import.meta.url,
  );
  const dependencyURL = `data:text/javascript,${encodeURIComponent(
    `const dependency = globalThis[Symbol.for('generated-mf-native-input-control')];\n${Object.keys(
      packed,
    )
      .map(
        name => `export const ${name} = dependency[${JSON.stringify(name)}];`,
      )
      .join('\n')}`,
  )}`;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        context.parentURL === moduleURL.href &&
        specifier === './native-federation-packed.mjs'
      )
        return { url: dependencyURL, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  try {
    const { runPackedNativeFederationGeneratedProof } = await import(moduleURL);
    const nativeInputs = {
      '@tanstack/router-core': { request: 'control:authenticated-core' },
    };
    const context = {
      renderer: 'octane',
      consumerRoot: '/owned/app',
      generatorConsumerRoot: '/owned/create',
      browserDependencyRoot: '/owned/browser',
      browserExecutable: '/owned/chromium',
    };
    assert.equal(
      runPackedNativeFederationGeneratedProof({ ...context, nativeInputs }),
      stopped,
    );
    assert.equal(calls[0].contextExtras.nativeInputs, nativeInputs);
    assert.equal(Object.hasOwn(calls[0], 'nativeInputs'), false);
    assert.equal(
      calls[0].contextExtras.generatorConsumerRoot,
      context.generatorConsumerRoot,
    );
    assert.equal(
      calls[0].contextExtras.browserDependencyRoot,
      context.browserDependencyRoot,
    );
    assert.equal(
      calls[0].contextExtras.browserExecutable,
      context.browserExecutable,
    );
    assert.equal(calls[0].consumerRoot, context.consumerRoot);
    assert.equal(runPackedNativeFederationGeneratedProof(context), stopped);
    assert.equal(Object.hasOwn(calls[1].contextExtras, 'nativeInputs'), false);
  } finally {
    hooks.deregister();
    delete globalThis[key];
  }
});

const ssrPlan = {
  remote: { id: 'packed-mf' },
  host: { displayName: 'Packed MF shell' },
};
const ssrRoute = '/remotes/packed-mf';
const remoteMarkup =
  '<section data-testid="native-remote" data-remote-id="packed-mf"><p>Packed MF shell</p></section>';

function octaneSSRDocument(payload, completionId = 'mf-segment') {
  const contents = JSON.stringify(payload).replaceAll('<', '\\u003c');
  const carrier = `<div hidden data-oct-s="mf-segment"><script type="application/json" data-octane-stream>${contents}</script></div>`;
  return completionId
    ? `${carrier}<script data-octane-stream>$OCTRC(${JSON.stringify(completionId)})</script>`
    : carrier;
}

for (const renderer of ['solid', 'octane']) {
  const document = markup =>
    renderer === 'octane' ? octaneSSRDocument(markup) : markup;

  test(`accepts completed generated ${renderer} native remote SSR`, () => {
    assert.equal(
      assertGeneratedNativeFederationSSR({
        html: document(remoteMarkup),
        plan: ssrPlan,
        renderer,
        route: ssrRoute,
      }),
      undefined,
    );
  });

  test(`rejects ${renderer} SSR with a native marker for another remote`, () => {
    assert.throws(
      () =>
        assertGeneratedNativeFederationSSR({
          html: document(
            remoteMarkup.replace(
              'data-remote-id="packed-mf"',
              'data-remote-id="foreign"',
            ),
          ),
          plan: ssrPlan,
          renderer,
          route: ssrRoute,
        }),
      { code: 'ERR_ASSERTION' },
    );
  });

  test(`requires shell props inside the ${renderer} remote even when its header has them`, () => {
    const markup = `<header>${ssrPlan.host.displayName}</header>${remoteMarkup.replace(
      '<p>Packed MF shell</p>',
      '<p>No shell prop</p>',
    )}`;
    assert.throws(
      () =>
        assertGeneratedNativeFederationSSR({
          html: document(markup),
          plan: ssrPlan,
          renderer,
          route: ssrRoute,
        }),
      /Generated remote omitted shell props/u,
    );
  });

  for (const [name, markup] of [
    ['an HTML comment', `<!-- ${remoteMarkup} -->`],
    ['inert script text', `<script type="text/plain">${remoteMarkup}</script>`],
    [
      'different attributes containing the required names',
      remoteMarkup
        .replace('data-testid=', 'data-other-data-testid=')
        .replace('data-remote-id=', 'data-other-data-remote-id='),
    ],
  ]) {
    test(`rejects apparent ${renderer} remote markup in ${name}`, () => {
      assert.throws(
        () =>
          assertGeneratedNativeFederationSSR({
            html: document(markup),
            plan: ssrPlan,
            renderer,
            route: ssrRoute,
          }),
        /omitted native remote SSR/u,
      );
    });
  }
}

for (const [name, completionId] of [
  ['an incomplete Octane carrier', null],
  ['an Octane completion for another segment', 'foreign-segment'],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () =>
        assertGeneratedNativeFederationSSR({
          html: octaneSSRDocument(remoteMarkup, completionId),
          plan: ssrPlan,
          renderer: 'octane',
          route: ssrRoute,
        }),
      /omitted native remote SSR/u,
    );
  });
}

test('rejects a foreign carrier containing the expected native markup', () => {
  assert.throws(
    () =>
      assertGeneratedNativeFederationSSR({
        html: octaneSSRDocument(remoteMarkup).replace(
          'data-oct-s=',
          'data-foreign-segment=',
        ),
        plan: ssrPlan,
        renderer: 'octane',
        route: ssrRoute,
      }),
    /omitted native remote SSR/u,
  );
});

for (const [name, html] of [
  [
    'an Octane carrier and completion inside an HTML comment',
    `<!-- ${octaneSSRDocument(remoteMarkup)} -->`,
  ],
  [
    'an actual Octane carrier with only a commented completion',
    `${octaneSSRDocument(remoteMarkup, null)}<!-- <script data-octane-stream>$OCTRC("mf-segment")</script> -->`,
  ],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () =>
        assertGeneratedNativeFederationSSR({
          html,
          plan: ssrPlan,
          renderer: 'octane',
          route: ssrRoute,
        }),
      /omitted native remote SSR/u,
    );
  });
}

test('rejects malformed JSON in an Octane SSR carrier', () => {
  assert.throws(
    () =>
      assertGeneratedNativeFederationSSR({
        html: '<div hidden data-oct-s="mf-segment"><script type="application/json" data-octane-stream>{invalid</script></div><script data-octane-stream>$OCTRC("mf-segment")</script>',
        plan: ssrPlan,
        renderer: 'octane',
        route: ssrRoute,
      }),
    SyntaxError,
  );
});

test('rejects an Octane SSR carrier whose payload is not HTML text', () => {
  assert.throws(
    () =>
      assertGeneratedNativeFederationSSR({
        html: octaneSSRDocument({ html: remoteMarkup }),
        plan: ssrPlan,
        renderer: 'octane',
        route: ssrRoute,
      }),
    /native SSR segment holds HTML/u,
  );
});

test('rejects an Octane SSR carrier as direct Solid markup', () => {
  assert.throws(
    () =>
      assertGeneratedNativeFederationSSR({
        html: octaneSSRDocument(remoteMarkup),
        plan: ssrPlan,
        renderer: 'solid',
        route: ssrRoute,
      }),
    /omitted native remote SSR/u,
  );
});

test('rejects an unsupported renderer in generated SSR evidence', () => {
  assert.throws(
    () =>
      assertGeneratedNativeFederationSSR({
        html: remoteMarkup,
        plan: ssrPlan,
        renderer: 'react',
        route: ssrRoute,
      }),
    { code: 'ERR_ASSERTION' },
  );
});

function generatedTopology(renderer) {
  return {
    workspaceRoot: path.resolve('/generated-workspace'),
    renderer,
    hostPort: 4100,
    remotePort: 4200,
    workspaceResult: {
      createdApps: [
        {
          kind: 'shell',
          id: 'shell',
          directory: 'apps/shell',
          displayName: 'Workspace shell',
          portEnv: 'SHELL_PORT',
        },
      ],
    },
    verticalResult: {
      createdApps: [
        {
          kind: 'vertical',
          id: 'inventory',
          directory: 'apps/inventory',
          displayName: 'Inventory',
          portEnv: 'INVENTORY_PORT',
        },
      ],
    },
    topology: {
      shell: {
        id: 'shell',
        path: 'apps/shell',
        renderer,
        rendererCapabilities: { federation: true },
        moduleFederation: {
          role: 'host',
          remotes: [
            {
              id: 'inventory',
              name: 'inventoryRemote',
              manifestEnv: 'INVENTORY_MF_MANIFEST',
            },
          ],
        },
      },
      verticals: [
        {
          id: 'inventory',
          path: 'apps/inventory',
          renderer,
          rendererCapabilities: { federation: true },
          moduleFederation: {
            role: 'remote',
            exposes: ['./Route', './Widget'],
          },
          api: {
            runtime: 'effect',
            basePath: '/api/inventory/items',
            bff: { prefix: '/api' },
            readiness: { endpoint: '/inventory/ready' },
          },
        },
      ],
    },
  };
}

for (const renderer of ['solid', 'octane']) {
  test(`plans the generated ${renderer} shell, native remote, and BFF`, () => {
    const supplied = generatedTopology(renderer);
    const before = structuredClone(supplied);
    for (const app of [
      supplied.topology.shell,
      supplied.topology.verticals[0],
    ]) {
      assert.equal(Object.hasOwn(app, 'displayName'), false);
      assert.equal(Object.hasOwn(app, 'portEnv'), false);
    }
    const plan = planGeneratedNativeFederation(supplied);
    assert.equal(plan.host.displayName, 'Workspace shell');
    assert.equal(plan.host.portEnv, 'SHELL_PORT');
    assert.equal(plan.remote.displayName, 'Inventory');
    assert.equal(plan.remote.portEnv, 'INVENTORY_PORT');
    assert.equal(
      plan.hostRoot,
      path.join(supplied.workspaceRoot, 'apps/shell'),
    );
    assert.equal(
      plan.remoteRoot,
      path.join(supplied.workspaceRoot, 'apps/inventory'),
    );
    assert.equal(plan.hostOrigin, 'http://127.0.0.1:4100');
    assert.equal(plan.remoteOrigin, 'http://127.0.0.1:4200');
    assert.equal(plan.routePath, '/remotes/inventory');
    assert.deepEqual(plan.remote.api, supplied.topology.verticals[0].api);
    assert.deepEqual(plan.env, {
      SHELL_PORT: '4100',
      INVENTORY_PORT: '4200',
      INVENTORY_MF_MANIFEST:
        'inventoryRemote@http://127.0.0.1:4200/mf-manifest.json',
    });
    assert.deepEqual(supplied, before);
  });

  for (const [name, change, expected] of [
    [
      'a remote with another renderer',
      input => {
        input.topology.verticals[0].renderer =
          renderer === 'solid' ? 'octane' : 'solid';
      },
      { code: 'ERR_ASSERTION' },
    ],
    [
      'a headless vertical',
      input => {
        input.topology.verticals[0].renderer = 'headless';
        input.topology.verticals[0].rendererCapabilities.federation = false;
      },
      { code: 'ERR_ASSERTION' },
    ],
    [
      'a shell without its matching remote reference',
      input => {
        input.topology.shell.moduleFederation.remotes[0].id = 'another-remote';
      },
      /Generated shell must compose its native vertical/u,
    ],
    [
      'a remote source path outside the workspace',
      input => {
        input.topology.verticals[0].path = '../foreign-app';
        input.verticalResult.createdApps[0].directory = '../foreign-app';
      },
      /Generated application escapes its workspace/u,
    ],
    [
      'an absolute generated source path',
      input => {
        const directory = path.join(input.workspaceRoot, 'apps/inventory');
        input.topology.verticals[0].path = directory;
        input.verticalResult.createdApps[0].directory = directory;
      },
      /Generated application path must be relative/u,
    ],
    [
      'a descriptor from another generated app',
      input => {
        input.verticalResult.createdApps[0].id = 'another-app';
      },
      { code: 'ERR_ASSERTION' },
    ],
    [
      'a descriptor with a different source directory',
      input => {
        input.workspaceResult.createdApps[0].directory = 'apps/another-shell';
      },
      { code: 'ERR_ASSERTION' },
    ],
    [
      'a remote without its widget exposure',
      input => {
        input.topology.verticals[0].moduleFederation.exposes = ['./Route'];
      },
      { code: 'ERR_ASSERTION' },
    ],
    [
      'a vertical without its BFF readiness contract',
      input => {
        input.topology.verticals[0].api.readiness.endpoint = '';
      },
      /Generated vertical must have its real BFF contract/u,
    ],
  ]) {
    test(`rejects ${name} in a generated ${renderer} plan`, () => {
      const supplied = generatedTopology(renderer);
      change(supplied);
      assert.throws(() => planGeneratedNativeFederation(supplied), expected);
    });
  }
}

function installedGeneratedApp(t, renderer = 'solid') {
  const root = fs.realpathSync(
    fs.mkdtempSync(
      path.join(process.env.OWNED_TEMP_DIR, 'generated-native-mf-'),
    ),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  const appRoot = path.join(workspaceRoot, 'apps/shell');
  const store = path.join(workspaceRoot, 'node_modules/.pnpm');
  const roots = {};
  const links = {};
  const artifacts = [];
  const catalog = {};
  const dependencies = {};
  const devDependencies = {};
  const packageIdentities = {};
  fs.mkdirSync(appRoot, { recursive: true });

  for (const sourceName of [
    '@modern-js/ultramodern-app-tools',
    '@modern-js/renderer-core',
    `@modern-js/renderer-${renderer}`,
    '@modern-js/federation-runtime',
    '@module-federation/enhanced',
    '@module-federation/node',
    '@module-federation/runtime',
  ]) {
    const candidate = sourceName.startsWith('@modern-js/');
    const targetName = candidate
      ? `@bleedingdev/modern-js-${sourceName.slice('@modern-js/'.length)}`
      : sourceName;
    const version = candidate ? '1.0.0-candidate' : '2.9.2';
    const directory = path.join(
      store,
      `${targetName.replace('/', '+')}@${version}`,
      'node_modules',
      targetName,
    );
    const files = {
      'package.json': JSON.stringify({ name: targetName, version }),
      'dist/index.mjs': `export const packageName = ${JSON.stringify(targetName)};\n`,
    };
    for (const [filename, contents] of Object.entries(files)) {
      const destination = path.join(directory, filename);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, contents);
    }
    const link = path.join(appRoot, 'node_modules', sourceName);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(directory, link, 'dir');
    roots[sourceName] = directory;
    links[sourceName] = link;
    if (candidate) {
      catalog[sourceName] = `npm:${targetName}@${version}`;
      artifacts.push({
        sourceName,
        targetName,
        version,
        files: Object.entries(files).map(([filename, contents]) => ({
          path: filename,
          size: Buffer.byteLength(contents),
          sha256: createHash('sha256').update(contents).digest('hex'),
        })),
      });
      const destination = sourceName.endsWith('/ultramodern-app-tools')
        ? devDependencies
        : dependencies;
      destination[sourceName] = 'catalog:ultramodern';
    } else {
      dependencies[sourceName] = version;
      packageIdentities[sourceName] = { name: targetName, version };
    }
  }
  fs.writeFileSync(
    path.join(appRoot, 'package.json'),
    JSON.stringify({ dependencies, devDependencies }),
  );
  fs.writeFileSync(
    path.join(workspaceRoot, 'pnpm-workspace.yaml'),
    `packages:\n  - apps/*\ncatalogs:\n  ultramodern:\n${Object.entries(catalog)
      .map(
        ([name, request]) =>
          `    ${JSON.stringify(name)}: ${JSON.stringify(request)}`,
      )
      .join('\n')}\n`,
  );
  return {
    root,
    workspaceRoot,
    appRoot,
    roots,
    links,
    context: { renderer, cohort: { artifacts }, packageIdentities },
  };
}

for (const renderer of ['solid', 'octane']) {
  test(`authenticates unchanged generated ${renderer} catalog dependencies`, t => {
    const supplied = installedGeneratedApp(t, renderer);
    assert.deepEqual(
      authenticateGeneratedNativeFederationApp(
        supplied.appRoot,
        supplied.workspaceRoot,
        supplied.context,
      ),
      supplied.roots,
    );
  });
}

test('rejects a generated catalog that selects a foreign candidate', t => {
  const supplied = installedGeneratedApp(t);
  const workspace = path.join(supplied.workspaceRoot, 'pnpm-workspace.yaml');
  fs.writeFileSync(
    workspace,
    fs
      .readFileSync(workspace, 'utf8')
      .replace(
        'npm:@bleedingdev/modern-js-renderer-solid@1.0.0-candidate',
        'npm:@foreign/renderer-solid@1.0.0-candidate',
      ),
  );
  assert.throws(
    () =>
      authenticateGeneratedNativeFederationApp(
        supplied.appRoot,
        supplied.workspaceRoot,
        supplied.context,
      ),
    /Generated dependency @modern-js\/renderer-solid does not select the candidate/u,
  );
});

test('rejects changed candidate bytes behind a valid generated catalog', t => {
  const supplied = installedGeneratedApp(t);
  fs.appendFileSync(
    path.join(supplied.roots['@modern-js/renderer-solid'], 'dist/index.mjs'),
    'export const localPatch = true;\n',
  );
  assert.throws(
    () =>
      authenticateGeneratedNativeFederationApp(
        supplied.appRoot,
        supplied.workspaceRoot,
        supplied.context,
      ),
    /differs from its tarball at dist\/index\.mjs/u,
  );
});

test('rejects an identical renderer linked from outside the workspace pnpm store', t => {
  const supplied = installedGeneratedApp(t);
  const name = '@modern-js/renderer-solid';
  const sourceCheckout = path.join(supplied.root, 'source-checkout/renderer');
  fs.cpSync(supplied.roots[name], sourceCheckout, { recursive: true });
  fs.unlinkSync(supplied.links[name]);
  fs.symlinkSync(sourceCheckout, supplied.links[name], 'dir');
  assert.throws(
    () =>
      authenticateGeneratedNativeFederationApp(
        supplied.appRoot,
        supplied.workspaceRoot,
        supplied.context,
      ),
    /outside the packed consumer's pnpm store/u,
  );
});

test('requires the selected renderer among the generated app dependencies', t => {
  const supplied = installedGeneratedApp(t);
  const filename = path.join(supplied.appRoot, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  delete manifest.dependencies['@modern-js/renderer-solid'];
  fs.writeFileSync(filename, JSON.stringify(manifest));
  assert.throws(
    () =>
      authenticateGeneratedNativeFederationApp(
        supplied.appRoot,
        supplied.workspaceRoot,
        supplied.context,
      ),
    /Generated native MF did not install @modern-js\/renderer-solid/u,
  );
});
