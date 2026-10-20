import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { parse } from '@babel/parser';
import { resolveRendererAdapter } from '@modern-js/ultramodern-app-tools';

/** The Octane adapter's create support generates these sources. */
function generateOctaneAppSources(options: any) {
  const adapter = resolveRendererAdapter('octane');
  if (adapter.kind !== 'native' || !adapter.create)
    throw new Error('The octane adapter has no create support');
  return adapter.create.generateAppSources(options);
}

const options = {
  appId: 'octane-shell',
  title: 'Octane shell',
  sourceExtension: '.tsx',
  jsxImportSource: 'octane',
  capabilities: { ssr: false, federation: false },
};

function parseNativeRoutes(result) {
  return result.artifacts.map(artifact => ({
    path: artifact.path,
    program: parse(artifact.content, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    }).program,
  }));
}

test('the emitted routes use native Octane hook state and router bindings', () => {
  const result = generateOctaneAppSources(options);
  const routes = parseNativeRoutes(result);
  assert.equal(result.sourceExtension, '.tsx');
  assert.equal(result.jsxImportSource, 'octane');
  assert.deepEqual(
    routes.map(route => route.path),
    [
      'src/routes/layout.tsx',
      'src/routes/page.tsx',
      'src/routes/page.head.ts',
      'src/routes/about/page.tsx',
      'src/routes/about/page.head.ts',
      'src/components/counter.tsx',
      'src/components/stable.tsx',
      'src/routes/page.data.ts',
      'src/routes/error.tsx',
      'src/routes/not-found.tsx',
    ],
  );
  const importedModules = routes.flatMap(route =>
    route.program.body
      .filter(node => node.type === 'ImportDeclaration')
      .map(node => node.source.value),
  );
  assert.deepEqual(
    new Set(importedModules),
    new Set([
      '@modern-js/renderer-octane/router',
      'octane',
      '@modern-js/renderer-core/data',
      '../components/counter',
      '../components/stable',
      './index.css',
    ]),
  );
  const layoutImport = routes[0].program.body[0];
  assert.deepEqual(
    layoutImport.specifiers.map(specifier => specifier.imported.name),
    ['Link', 'Outlet'],
  );
  const homeImport = routes[1].program.body[0];
  assert.deepEqual(
    homeImport.specifiers.map(specifier => specifier.imported.name),
    ['Link', 'useLoaderData', 'useOctaneRouteAction'],
  );
  for (const name of ['Counter', 'Stable']) {
    const component = routes.find(
      route => route.path === `src/components/${name.toLowerCase()}.tsx`,
    );
    assert.equal(
      component.program.body[0].specifiers[0].imported.name,
      'useState',
    );
    assert.equal(
      component.program.body[1].declaration.body.body[0].type,
      'VariableDeclaration',
    );
  }
  const data = routes.find(route => route.path === 'src/routes/page.data.ts');
  assert.equal(data.program.body[0].importKind, 'type');
  assert.deepEqual(
    data.program.body
      .filter(node => node.type === 'ExportNamedDeclaration')
      .map(node => node.declaration.id.name),
    ['loader', 'action'],
  );
});

test('the home route submits through native useActionState and framework action identity', () => {
  const home = parseNativeRoutes(generateOctaneAppSources(options)).find(
    route => route.path === 'src/routes/page.tsx',
  );
  const component = home.program.body.find(
    node => node.type === 'ExportDefaultDeclaration',
  ).declaration;
  const state = component.body.body
    .filter(node => node.type === 'VariableDeclaration')
    .flatMap(node => node.declarations)
    .find(node => node.id.type === 'ArrayPattern');
  assert.deepEqual(
    state.id.elements.map(element => element.name),
    ['result', 'action', 'pending'],
  );
  assert.equal(state.init.callee.name, 'useActionState');
  assert.deepEqual(
    state.init.arguments.map(argument => argument.name),
    ['submit', 'undefined'],
  );
  const submit = component.body.body
    .filter(node => node.type === 'VariableDeclaration')
    .flatMap(node => node.declarations)
    .find(node => node.id.name === 'submit');
  // The framework hook owns route identity and aborts on unmount.
  assert.equal(submit.init.callee.name, 'useOctaneRouteAction');
  assert.deepEqual(submit.init.arguments, []);
});

test('the emitted server module preserves loader/action HTTP outcomes and request-local values', async () => {
  const artifact = generateOctaneAppSources(options).artifacts.find(
    source => source.path === 'src/routes/page.data.ts',
  );
  const source = stripTypeScriptTypes(artifact.content, { mode: 'strip' });
  const { loader, action } = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  );
  const request = new Request('https://native.example/', {
    headers: { 'x-conformance-private': 'request-one' },
  });
  assert.deepEqual(loader({ request }), {
    message: 'Native loader value',
    privateValue: 'request-one',
  });
  assert.equal(
    loader({ request: new Request('https://native.example/') }).privateValue,
    null,
  );
  const redirect = loader({
    request: new Request('https://native.example/?case=redirect'),
  });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/about');
  assert.throws(
    () =>
      loader({
        request: new Request('https://native.example/?case=not-found'),
      }),
    error => error instanceof Response && error.status === 404,
  );
  assert.throws(
    () =>
      loader({ request: new Request('https://native.example/?case=error') }),
    /Native loader failure/,
  );
  const invalid = await action({
    request: new Request('https://native.example/', {
      method: 'POST',
      body: new URLSearchParams({ name: ' ' }),
    }),
  });
  assert.equal(invalid.status, 422);
  assert.deepEqual(await invalid.json(), {
    fieldErrors: { name: 'Name required' },
  });
  const saved = await action({
    request: new Request('https://native.example/', {
      method: 'POST',
      headers: { 'x-conformance-private': 'request-two' },
      body: new URLSearchParams({ name: 'Native customer' }),
    }),
  });
  assert.deepEqual(saved, {
    saved: 'Native customer',
    privateValue: 'request-two',
  });
  const savedRedirect = await action({
    request: new Request('https://native.example/', {
      method: 'POST',
      body: new URLSearchParams({
        name: 'Native customer',
        intent: 'redirect',
      }),
    }),
  });
  assert.equal(savedRedirect.status, 303);
  assert.equal(savedRedirect.headers.get('location'), '/about');
  assert.equal(
    savedRedirect.headers.get('set-cookie'),
    'conformance-saved=1; Path=/; SameSite=Lax',
  );
  await assert.rejects(
    action({
      request: new Request('https://native.example/', {
        method: 'POST',
        body: new URLSearchParams({ name: 'Native customer', intent: 'throw' }),
      }),
    }),
    /Native action failure/,
  );
});

test('user-supplied names remain data in TypeScript JSX', () => {
  const supplied = {
    ...options,
    appId: 'shell"; throw new Error("injected"); //',
    title: 'A "quoted" title\n</script><script>bad()</script>\u2028',
  };
  const routes = parseNativeRoutes(generateOctaneAppSources(supplied));
  const home = routes.find(route => route.path === 'src/routes/page.tsx');
  const declarations = home.program.body.filter(
    node => node.type === 'VariableDeclaration',
  );
  assert.deepEqual(
    declarations.map(node => node.declarations[0].init.value),
    [supplied.appId, supplied.title],
  );
});

test('admitted CSR and SSR hosts receive the same native route sources', () => {
  assert.deepEqual(
    generateOctaneAppSources(options),
    generateOctaneAppSources({
      ...options,
      entryName: 'main',
      capabilities: { ssr: true, federation: false },
    }),
  );
});

test('unadmitted profiles and capabilities fail before emitting artifacts', () => {
  assert.throws(
    () => generateOctaneAppSources({ ...options, sourceExtension: '.tsrx' }),
    /admitted native template profile/,
  );
  assert.throws(
    () => generateOctaneAppSources({ ...options, jsxImportSource: 'react' }),
    /jsxImportSource: "octane"/,
  );
  assert.throws(
    () => generateOctaneAppSources({ ...options, entryName: 'admin' }),
    /main entry only/,
  );
  assert.throws(
    () =>
      generateOctaneAppSources({
        ...options,
        capabilities: { ssr: undefined, federation: false },
      }),
    /requires admitted capabilities/,
  );
});

test('admitted federation templates retain the native action and route sources', () => {
  const sources = parseNativeRoutes(
    generateOctaneAppSources({
      ...options,
      capabilities: { ssr: true, federation: true },
    }),
  );
  assert.equal(
    sources.length,
    generateOctaneAppSources(options).artifacts.length,
  );
  assert.equal(
    sources.find(route => route.path === 'src/routes/page.tsx').program.body[0]
      .source.value,
    '@modern-js/renderer-octane/router',
  );
});
