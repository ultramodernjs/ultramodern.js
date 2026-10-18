import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import * as packed from './native-federation-packed.mjs';

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
  let child;
  const key = Symbol.for('generated-worker-input-control');
  globalThis[key] = {
    ...packed,
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
        nativeInputs,
        receiptPath: path.join(directory, 'receipt.json'),
        binding: { control: true },
        workDir: path.join(directory, 'proof'),
      }),
      error => error === stopped,
    );
    assert.equal(child.contextExtras.nativeInputs, nativeInputs);
    assert.equal(child.renderer, 'octane');
    assert.equal(fs.existsSync(path.join(directory, 'receipt.json')), false);
  } finally {
    hooks.deregister();
    delete globalThis[key];
  }
});
