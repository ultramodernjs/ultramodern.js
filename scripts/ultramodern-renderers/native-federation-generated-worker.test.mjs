import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { generatedWorkerCoordinates } from '../../tests/ultramodern-renderers/octane-federation-workers/generated.mjs';
import * as packed from './native-federation-packed.mjs';
import * as worker from './native-federation-worker.mjs';
import * as workers from './native-federation-workers.mjs';

test('public generation requires actual profile Start requests instead of injecting seed dependencies', async () => {
  const moduleURL = new URL(
    './native-federation-generated-worker.mjs?dependencies',
    import.meta.url,
  );
  const { generatedWorkerDependencies, verifyGeneratedWorkerNativeRequests } =
    await import(moduleURL);
  const packageRequests = Object.fromEntries(
    [
      '@modern-js/ultramodern-app-tools',
      '@modern-js/renderer-octane',
      '@modern-js/renderer-core',
      '@modern-js/i18n-runtime-extensions',
      'octane',
      'i18next',
    ].map(name => [name, '1.0.0']),
  );
  const context = { cohort: { artifacts: [] }, packageRequests };
  const original = { ...packageRequests };
  assert.deepEqual(generatedWorkerDependencies(context), original);
  delete packageRequests.i18next;
  assert.equal(
    generatedWorkerDependencies({
      ...context,
      release: {
        packages: [
          {
            sourceName: '@modern-js/i18n-runtime-extensions',
            packageJson: { devDependencies: { i18next: '26.1.3' } },
          },
        ],
      },
    }).i18next,
    '26.1.3',
  );
  packageRequests.i18next = original.i18next;
  verifyGeneratedWorkerNativeRequests(
    { dependencies: original },
    packageRequests,
  );
  packageRequests['@tanstack/router-core'] =
    'https://github.com/BleedingDev/router/releases/download/ultramodern-router-core-bbbbbbbbbbbb/tanstack-router-core-1.0.0.tgz';
  for (const [name, profile] of Object.entries({
    '@tanstack/start-storage-context': 'storage',
    '@tanstack/start-client-core': 'client',
    '@tanstack/start-server-core': 'server',
  }))
    packageRequests[name] =
      `https://github.com/BleedingDev/router/releases/download/ultramodern-start-${profile}-cccccccccccc/tanstack-${name.slice('@tanstack/'.length)}-1.0.0.tgz`;
  assert.deepEqual(generatedWorkerDependencies(context), original);
  assert.throws(
    () =>
      verifyGeneratedWorkerNativeRequests(
        { dependencies: original },
        packageRequests,
      ),
    /Public generator must emit/u,
  );
  verifyGeneratedWorkerNativeRequests(
    { dependencies: packageRequests },
    packageRequests,
  );
  const mixed = { ...packageRequests, '@tanstack/start-client-core': '1.0.0' };
  assert.throws(
    () =>
      verifyGeneratedWorkerNativeRequests(
        { dependencies: mixed },
        packageRequests,
      ),
    /owning hosted/u,
  );
  delete packageRequests['@tanstack/start-storage-context'];
  assert.throws(
    () => generatedWorkerDependencies(context),
    /Incomplete native Start closure/u,
  );
});

test('generated proof rejects incomplete Start before creating evidence or child resources', async t => {
  const directory = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'generated-start-preflight-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ dependencies: { '@octanejs/tanstack-start': '1.0.0' } }),
  );
  const { runPackedNativeFederationGeneratedWorkerProof } = await import(
    new URL(
      './native-federation-generated-worker.mjs?preflight',
      import.meta.url,
    )
  );
  await assert.rejects(
    runPackedNativeFederationGeneratedWorkerProof({
      consumerRoot: directory,
      receiptPath: path.join(directory, 'receipt.json'),
      workDir: path.join(directory, 'proof'),
      binding: { control: true },
      nativeInputs: {},
    }),
    /Incomplete native Start closure/u,
  );
  assert.deepEqual(fs.readdirSync(directory), ['package.json']);
});

test('generated Worker proof forwards the supplied native archives to its isolated child', async t => {
  assert(process.env.OWNED_TEMP_DIR, 'Run this control through owned-temp-dir');
  const directory = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'generated-worker-inputs-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // Stop at the real child-launch boundary. These descriptors never qualify
  // native archives or execute a browser, compiler or Worker.
  const nativeInputs = Object.fromEntries(
    [
      'octane',
      '@octanejs/tanstack-router',
      '@octanejs/rspack-plugin',
      '@tanstack/router-core',
    ].map(name => [name, { request: `control:${name}` }]),
  );
  const stopped = new Error('captured generated Worker child context');
  fs.writeFileSync(path.join(directory, 'package.json'), '{}');
  let child;
  let validated;
  const key = Symbol.for('generated-worker-input-control');
  globalThis[key] = {
    ...packed,
    verifyPackedNativeFederationInputs: (root, inputs) => {
      validated = { root, inputs };
    },
    runPackedNativeFederationProof: async options => {
      child = options;
      throw stopped;
    },
  };
  const moduleURL = new URL(
    './native-federation-generated-worker.mjs',
    import.meta.url,
  );
  const dependencyURL = `data:text/javascript,${encodeURIComponent(
    `const dependency = globalThis[Symbol.for('generated-worker-input-control')];\n${Object.keys(
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
    const { runPackedNativeFederationGeneratedWorkerProof } = await import(
      moduleURL
    );
    await assert.rejects(
      runPackedNativeFederationGeneratedWorkerProof({
        consumerRoot: directory,
        nativeInputs,
        receiptPath: path.join(directory, 'receipt.json'),
        binding: { control: true },
        workDir: path.join(directory, 'proof'),
      }),
      error => error === stopped,
    );
    assert.equal(child.contextExtras.nativeInputs, nativeInputs);
    assert.deepEqual(validated, { root: directory, inputs: nativeInputs });
    assert.equal(child.renderer, 'octane');
    assert.equal(fs.existsSync(path.join(directory, 'receipt.json')), false);
  } finally {
    hooks.deregister();
    delete globalThis[key];
  }
});

test('generated Worker compilation receives its generated sources and installed lockfile revision', async t => {
  assert(process.env.OWNED_TEMP_DIR, 'Run this control through owned-temp-dir');
  const directory = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'generated-worker-source-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const environment = { ...process.env };
  t.after(() => {
    for (const name of [
      'SOURCE_CONTROL_HOST',
      'SOURCE_CONTROL_REMOTE_0',
      'SOURCE_CONTROL_REMOTE_1',
      'VERTICAL_REMOTE_A_WORKER_NAME',
      'VERTICAL_REMOTE_B_WORKER_NAME',
    ]) {
      if (name in environment) process.env[name] = environment[name];
      else delete process.env[name];
    }
  });
  const generatorRoot = path.join(directory, 'generator');
  fs.mkdirSync(generatorRoot);
  fs.writeFileSync(path.join(generatorRoot, 'package.json'), '{}');
  const packageRequests = Object.fromEntries(
    [
      '@modern-js/ultramodern-app-tools',
      '@modern-js/renderer-octane',
      '@modern-js/renderer-core',
      '@modern-js/i18n-runtime-extensions',
      'octane',
      'i18next',
    ].map(name => [name, '1.0.0']),
  );
  const coordinates = [
    generatedWorkerCoordinates.host,
    ...generatedWorkerCoordinates.remotes,
  ];
  const stopped = new Error('captured generated Worker compilation');
  let generationInput;
  let typechecked = false;
  let compiled = false;
  const key = Symbol.for('generated-worker-source-control');
  globalThis[key] = {
    packed: {
      ...packed,
      installPackedNativeFederationDependencies: async ({ directory }) => {
        fs.writeFileSync(
          path.join(directory, 'pnpm-lock.yaml'),
          'lockfileVersion: 9.0\n',
        );
      },
      verifyPackedNativeFederationDependencies: () => {},
      runPackedNativeFederationCommand: async (_command, args) => {
        if (args.includes('typecheck')) {
          typechecked = true;
          return;
        }
        generationInput = JSON.parse(fs.readFileSync(args[1], 'utf8'));
        const { workspaceRoot, origins, resultPath } = generationInput;
        fs.mkdirSync(path.join(workspaceRoot, 'topology'), { recursive: true });
        execFileSync('git', ['init', '--quiet'], {
          cwd: workspaceRoot,
          env: Object.fromEntries(
            Object.entries(process.env).filter(
              ([name]) => !name.toUpperCase().startsWith('GIT_'),
            ),
          ),
        });
        fs.writeFileSync(
          path.join(workspaceRoot, 'pnpm-workspace.yaml'),
          'minimumReleaseAge: 1440\nminimumReleaseAgeStrict: true\n',
        );
        const applications = coordinates.map(coordinate => ({
          ...coordinate,
          renderer: 'octane',
          buildIdentity: { renderer: 'octane' },
        }));
        for (const app of applications) {
          const appRoot = path.join(workspaceRoot, app.directory);
          fs.mkdirSync(appRoot, { recursive: true });
          fs.writeFileSync(
            path.join(appRoot, 'package.json'),
            JSON.stringify({ dependencies: packageRequests }),
          );
          fs.writeFileSync(
            path.join(appRoot, 'route.tsx'),
            'export default () => <p>generated Worker source</p>;\n',
          );
          const toolsRoot = path.join(
            appRoot,
            'node_modules/@modern-js/ultramodern-app-tools',
          );
          fs.mkdirSync(toolsRoot, { recursive: true });
          const services =
            app.id === coordinates[0].id
              ? generationInput.services.host
              : app.id === coordinates[1].id
                ? generationInput.services.remoteA
                : [];
          fs.writeFileSync(
            path.join(toolsRoot, 'index.js'),
            `exports.presetUltramodernWorkspace = config => ({...config, deploy: {worker: {services: ${JSON.stringify(services)}}}});\n`,
          );
        }
        fs.writeFileSync(
          path.join(workspaceRoot, 'topology/reference-topology.json'),
          JSON.stringify({
            shell: {
              ...applications[0],
              cloudflare: { publicUrlEnv: 'SOURCE_CONTROL_HOST' },
            },
            verticals: applications.slice(1).map((app, index) => ({
              ...app,
              cloudflare: { publicUrlEnv: `SOURCE_CONTROL_REMOTE_${index}` },
            })),
          }),
        );
        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            applications,
            origins,
            operations: applications.map((app, index) => ({
              operation: index ? 'vertical' : 'workspace',
              warnings: [],
              createdApps: [app],
            })),
          }),
        );
      },
    },
    workers: {
      ...workers,
      verifyWorkerFederationModule: () => ({ directory: generatorRoot }),
    },
    worker: {
      ...worker,
      // Keep the real source preparation. Stop before expensive compilation.
      buildCompiledWorkerApplications: async options => {
        assert(
          typechecked,
          'Source preparation must follow shared typechecking',
        );
        assert.equal(options.sourceDirectory, generationInput.workspaceRoot);
        assert.match(options.sourceRevision, /^[a-f0-9]{40}$/u);
        const git = args =>
          execFileSync('git', args, {
            cwd: options.sourceDirectory,
            encoding: 'utf8',
            env: Object.fromEntries(
              Object.entries(process.env).filter(
                ([name]) => !name.toUpperCase().startsWith('GIT_'),
              ),
            ),
          });
        assert.equal(git(['rev-parse', 'HEAD']).trim(), options.sourceRevision);
        assert.equal(git(['status', '--porcelain']), '');
        assert.equal(
          git(['show', 'HEAD:pnpm-lock.yaml']),
          'lockfileVersion: 9.0\n',
        );
        for (const coordinate of coordinates)
          assert.match(
            git(['show', `HEAD:${coordinate.directory}/route.tsx`]),
            /generated Worker source/u,
          );
        compiled = true;
        throw stopped;
      },
    },
  };
  const moduleURL = new URL(
    './native-federation-generated-worker.mjs?source-control',
    import.meta.url,
  );
  const dependencies = Object.fromEntries(
    Object.entries(globalThis[key]).map(([name, values]) => [
      `./native-federation-${name}.mjs`,
      `data:text/javascript,${encodeURIComponent(
        `const dependency = globalThis[Symbol.for('generated-worker-source-control')].${name};\n${Object.keys(
          values,
        )
          .map(
            name =>
              `export const ${name} = dependency[${JSON.stringify(name)}];`,
          )
          .join('\n')}`,
      )}`,
    ]),
  );
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL === moduleURL.href && dependencies[specifier])
        return { url: dependencies[specifier], shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  try {
    const { runGeneratedWorkerConsumer } = await import(moduleURL);
    await assert.rejects(
      runGeneratedWorkerConsumer(
        {
          workRoot: directory,
          generatorConsumerRoot: generatorRoot,
          browserDependencyRoot: directory,
          packageRequests,
          pnpmExecutable: 'unused-control-pnpm',
          cohort: {
            artifacts: [
              {
                sourceName: '@modern-js/ultramodern-create',
                targetName: '@bleedingdev/create',
                version: '1.0.0',
              },
            ],
          },
          release: {
            release: { version: '1.0.0' },
            packages: [{ targetName: '@bleedingdev/create', version: '1.0.0' }],
          },
        },
        { signal: new AbortController().signal },
      ),
      error => error === stopped,
    );
    assert(compiled);
  } finally {
    hooks.deregister();
    delete globalThis[key];
  }
});
