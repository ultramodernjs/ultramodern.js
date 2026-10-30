import assert from 'node:assert/strict';

/** Omission, not an app-level plugin, must select the default runtime. */
export function workerRuntimeConfig(runtime) {
  assert(['redact', 'react'].includes(runtime), 'Unknown React runtime proof');
  return {
    renderer: 'react',
    ...(runtime === 'react' ? { redact: false } : {}),
  };
}

/** The installed manifest, not a pathname or React ABI symbol, owns identity.
 * npm aliases retain the sidecar's physical name at the @tanstack/redact slot.
 */
export function effectiveRuntimePackage(name) {
  return name === '@bleedingdev/tanstack-redact' ? '@tanstack/redact' : name;
}

/** Authenticate compiled implementation, never infer it from React ABI symbols. */
export function assertCompiledReactRuntime(inputs, runtime) {
  workerRuntimeConfig(runtime);
  const modules = [...inputs];
  const redact = modules.filter(
    item => effectiveRuntimePackage(item.package) === '@tanstack/redact',
  );
  const reactDom = modules.filter(item => item.package === 'react-dom');
  if (runtime === 'redact') {
    assert(redact.length > 0, 'Default build did not compile TanStack Redact');
    assert(
      redact.every(item => item.version === '0.2.2'),
      'Default build must compile the pinned TanStack Redact sidecar 0.2.2',
    );
    assert.equal(reactDom.length, 0, 'Default build compiled native React DOM');
  } else {
    assert(
      reactDom.length > 0,
      'Opt-out build did not compile native React DOM',
    );
    assert.equal(redact.length, 0, 'Opt-out build compiled TanStack Redact');
  }
  return {
    runtime,
    configuration: workerRuntimeConfig(runtime),
    package: runtime === 'redact' ? '@tanstack/redact' : 'react-dom',
    modules: runtime === 'redact' ? redact : reactDom,
  };
}
