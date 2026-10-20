import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import * as packed from './native-federation-packed.mjs';

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
