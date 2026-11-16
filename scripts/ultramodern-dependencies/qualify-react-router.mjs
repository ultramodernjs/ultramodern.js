import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';

// Run with owned-temp-dir --run router8 -- node <this file>. No repository install.
const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = process.env.OWNED_TEMP_DIR;
assert(
  temporary && path.isAbsolute(temporary),
  'an owned temporary directory is required',
);
const modules = path.join(temporary, 'node_modules');
fs.mkdirSync(modules);
const guardian = '/Users/satan/bin/disk-guardian-artifacts';
const owner = `react-router8-${process.pid}`;
execFileSync(guardian, [
  'register',
  modules,
  '--owner',
  owner,
  '--owner-pid',
  `${process.pid}`,
  '--kind',
  'dependencies',
]);
const requireRoot = createRequire(path.join(root, 'package.json'));
const requireRuntime = createRequire(
  path.join(root, 'packages/runtime/plugin-runtime/package.json'),
);
const downloaded = [];
try {
  const fixtureRequire = createRequire(path.join(temporary, 'package.json'));
  for (const name of [
    'react',
    'react-dom',
    '@types/react',
    '@types/react-dom',
  ]) {
    const source = path.dirname(
      (name.startsWith('@types/') ? requireRoot : requireRuntime).resolve(
        `${name}/package.json`,
      ),
    );
    const target = path.join(modules, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(source, target, 'dir');
  }
  const queue = [['react-router', '8.5.1']];
  while (queue.length) {
    const [name, version] = queue.shift();
    const target = path.join(modules, name);
    if (fs.existsSync(target)) continue;
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
      { signal: AbortSignal.timeout(20000) },
    );
    assert(response.ok, `${name}@${version}: registry ${response.status}`);
    const metadata = await response.json();
    const artifact = await fetch(metadata.dist.tarball, {
      signal: AbortSignal.timeout(20000),
    });
    assert(artifact.ok, `${name}: tarball ${artifact.status}`);
    const bytes = Buffer.from(await artifact.arrayBuffer());
    assert.equal(
      `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      metadata.dist.integrity,
    );
    fs.mkdirSync(target, { recursive: true });
    execFileSync('tar', ['-xz', '--strip-components=1', '-C', target], {
      input: bytes,
    });
    downloaded.push(`${name}@${version}`);
    for (const [dependency, range] of Object.entries(
      metadata.dependencies ?? {},
    ))
      queue.push([dependency, semver.minVersion(range).version]);
  }
  const router = await import(
    pathToFileURL(fixtureRequire.resolve('react-router')).href
  );
  const React = fixtureRequire('react');
  const { renderToString } = fixtureRequire('react-dom/server');
  const names = new Set();
  const types = new Set();
  const walk = directory =>
    fs
      .readdirSync(directory, { withFileTypes: true })
      .flatMap(entry =>
        entry.isDirectory()
          ? walk(path.join(directory, entry.name))
          : [path.join(directory, entry.name)],
      );
  for (const file of [
    ...walk(
      path.join(root, 'packages/runtime/plugin-runtime/src/router/runtime'),
    ),
    path.join(
      root,
      'packages/toolkit/runtime-utils/src/browser/nestedRoutes.tsx',
    ),
    path.join(root, 'tests/integration/dev-server/src/App.tsx'),
  ].filter(file => /\.tsx?$/.test(file))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(
      /import\s+(type\s+)?\{([^}]+)\}\s+from\s+['"](?:react-router|@modern-js\/runtime-utils\/router)['"]/g,
    ))
      for (let item of match[2]
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)) {
        const type = match[1] || item.startsWith('type ');
        item = item.replace(/^type\s+/, '').split(/\s+as\s+/)[0];
        (type ? types : names).add(item);
      }
  }
  for (const name of names)
    assert(name in router, `missing runtime API: ${name}`);
  const h = React.createElement;
  function Page() {
    const data = router.useLoaderData();
    return h('main', null, data.id, h(router.Link, { to: '/' }, 'Home'));
  }
  const routes = [
    {
      id: 'root',
      path: '/',
      element: h(router.Outlet),
      children: [
        {
          id: 'item',
          path: 'items/:id',
          loader: ({ params }) => ({ id: params.id }),
          element: h(Page),
        },
      ],
    },
  ];
  const memory = router.createMemoryRouter(routes, { initialEntries: ['/'] });
  try {
    await memory.navigate('/items/7');
    assert.deepEqual(memory.state.loaderData.item, { id: '7' });
    assert.match(
      renderToString(h(router.RouterProvider, { router: memory })),
      /<main>7<a[^>]*href="\/"/,
    );
  } finally {
    memory.dispose();
  }
  const handler = router.createStaticHandler(routes);
  const context = await handler.query(
    new Request('https://example.test/items/9'),
  );
  assert(!(context instanceof Response));
  assert.equal(context.loaderData.item.id, '9');
  const staticRouter = router.createStaticRouter(handler.dataRoutes, context);
  assert.match(
    renderToString(
      h(router.StaticRouterProvider, { router: staticRouter, context }),
    ),
    /<main>9/,
  );
  const redirectHandler = router.createStaticHandler([
    { path: '/', loader: () => router.redirect('/next') },
  ]);
  const redirect = await redirectHandler.query(
    new Request('https://example.test/'),
  );
  assert(redirect instanceof Response);
  assert.equal(redirect.headers.get('Location'), '/next');
  assert(
    router.isRouteErrorResponse(
      new router.UNSAFE_ErrorResponseImpl(404, 'Not Found', 'missing'),
    ),
  );
  const contract = [
    `export { ${[...names].join(', ')} } from 'react-router';`,
    `export type { ${[...types].join(', ')} } from 'react-router';`,
    `import {createBrowserRouter, createStaticHandler, RouterProvider, type RouterProviderProps} from 'react-router';`,
    `const routes = [{path: '/', loader: () => ({ok: true})}];`,
    `const browser = createBrowserRouter(routes, {basename: '/', hydrationData: {loaderData: {}}});`,
    `const provider: RouterProviderProps = {router: browser, useTransitions: true};`,
    `createStaticHandler(routes).query(new Request('https://example.test/'), {requestContext: {}});`,
    `void provider; void RouterProvider;`,
  ].join('\n');
  fs.writeFileSync(path.join(temporary, 'contract.ts'), contract);
  fs.copyFileSync(
    path.join(root, 'tests/integration/dev-server/src/App.tsx'),
    path.join(temporary, 'App.tsx'),
  );
  fs.writeFileSync(path.join(temporary, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(
    path.join(temporary, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        jsx: 'react-jsx',
        types: ['react', 'react-dom'],
      },
      files: ['contract.ts', 'App.tsx'],
    }),
  );
  const compiler = path.join(root, 'node_modules/.bin/tsc');
  const compilerVersion = execFileSync(compiler, ['--version'], {
    encoding: 'utf8',
  }).trim();
  execFileSync(compiler, ['-p', path.join(temporary, 'tsconfig.json')], {
    stdio: 'inherit',
  });
  console.log(
    JSON.stringify(
      {
        router: '8.5.1',
        compilerVersion,
        downloaded,
        runtimeExports: names.size,
        typeExports: types.size,
        passed: [
          'memory navigation and loader',
          'Link/Outlet rendering',
          'SSR loader and static provider',
          'server redirect',
          'error response identity',
          'actual dev-server App and router API typecheck',
        ],
        limits:
          'No root install, framework build, browser, MF publication or acceptance run.',
      },
      null,
      2,
    ),
  );
} finally {
  execFileSync(guardian, ['release', modules, '--owner', owner]);
  execFileSync(guardian, [
    'cleanup',
    '--only',
    modules,
    '--no-caches',
    '--apply',
  ]);
}
