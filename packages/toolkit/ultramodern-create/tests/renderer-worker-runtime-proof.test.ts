import assert from 'node:assert/strict';
import {
  assertCompiledReactRuntime,
  effectiveRuntimePackage,
  workerRuntimeConfig,
} from '../../../../scripts/ultramodern-production-readiness/renderer-worker-lifecycle-proof/runtime-contract.mjs';

const redact = { package: '@tanstack/redact', version: '0.2.2' };
const reactDom = { package: 'react-dom', version: '19.3.1' };
const framework = { package: '@modern-js/runtime', version: '3.8.3' };

test('default worker proof omits Redact configuration and compatibility explicitly opts out', () => {
  assert.deepEqual(workerRuntimeConfig('redact'), { renderer: 'react' });
  assert.deepEqual(workerRuntimeConfig('react'), {
    renderer: 'react',
    redact: false,
  });
  assert.throws(() => workerRuntimeConfig('unknown'), /Unknown React runtime/u);
});

test('default proof authenticates the pinned compiled Redact implementation', () => {
  const evidence = assertCompiledReactRuntime([framework, redact], 'redact');
  assert.equal(evidence.runtime, 'redact');
  assert.equal(evidence.package, '@tanstack/redact');
  assert.deepEqual(evidence.configuration, { renderer: 'react' });
  assert.deepEqual(evidence.modules, [redact]);
});

test('npm-aliased sidecar keeps authenticated physical evidence and the effective Redact identity', () => {
  const sidecar = {
    package: '@bleedingdev/tanstack-redact',
    version: '0.2.2',
    path: '/consumer/node_modules/@tanstack/redact/dist/dom/index.js',
  };
  assert.equal(effectiveRuntimePackage(sidecar.package), '@tanstack/redact');
  const evidence = assertCompiledReactRuntime([framework, sidecar], 'redact');
  assert.equal(evidence.package, '@tanstack/redact');
  assert.deepEqual(evidence.modules, [sidecar]);
  assert.throws(
    () => assertCompiledReactRuntime([reactDom, sidecar], 'react'),
    /compiled TanStack Redact/u,
  );
  assert.throws(
    () => assertCompiledReactRuntime([sidecar, reactDom], 'redact'),
    /compiled native React DOM/u,
  );
  assert.throws(
    () =>
      assertCompiledReactRuntime([{ ...sidecar, version: '0.2.1' }], 'redact'),
    /pinned TanStack Redact sidecar 0\.2\.2/u,
  );
  // A convincing path or claimed effective identity cannot authenticate a name.
  assert.throws(
    () =>
      assertCompiledReactRuntime(
        [
          {
            ...sidecar,
            package: '@unrelated/redact',
            effectivePackage: '@tanstack/redact',
          },
        ],
        'redact',
      ),
    /did not compile TanStack Redact/u,
  );
});

test('default proof cannot pass with React DOM, missing Redact or another Redact version', () => {
  for (const modules of [[], [framework], [reactDom]]) {
    assert.throws(
      () => assertCompiledReactRuntime(modules, 'redact'),
      /did not compile TanStack Redact/u,
    );
  }
  assert.throws(
    () => assertCompiledReactRuntime([redact, reactDom], 'redact'),
    /compiled native React DOM/u,
  );
  for (const version of ['0.2.1', '0.2.3']) {
    assert.throws(
      () =>
        assertCompiledReactRuntime([redact, { ...redact, version }], 'redact'),
      /pinned TanStack Redact sidecar 0\.2\.2/u,
    );
  }
});

test('real React compatibility proof requires React DOM and rejects Redact contamination', () => {
  const evidence = assertCompiledReactRuntime([framework, reactDom], 'react');
  assert.equal(evidence.package, 'react-dom');
  assert.deepEqual(evidence.configuration, {
    renderer: 'react',
    redact: false,
  });
  assert.deepEqual(evidence.modules, [reactDom]);
  assert.throws(
    () => assertCompiledReactRuntime([framework, redact], 'react'),
    /did not compile native React DOM/u,
  );
  assert.throws(
    () => assertCompiledReactRuntime([reactDom, redact], 'react'),
    /compiled TanStack Redact/u,
  );
});
