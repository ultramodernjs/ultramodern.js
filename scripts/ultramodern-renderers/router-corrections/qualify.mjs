import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { qualifyRoutePathTypes } from './route-path-consumer.mjs';

// Run the same behavior suites against the emitted package, not a source alias.
export function qualify({
  root,
  pkg,
  reconstructed,
  here,
  run,
  register,
  disk,
}) {
  const consumer = path.join(root, 'consumer');
  fs.mkdirSync(consumer);
  run('pnpm', ['pack', '--pack-destination', consumer], reconstructed);
  const tarball = fs.readdirSync(consumer).find(name => name.endsWith('.tgz'));
  assert(tarball);
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        packageManager: 'pnpm@11.21.0',
        dependencies: {
          '@tanstack/router-core': `file:./${tarball}`,
          'vanilla-router-core': 'file:../upstream.tgz',
          '@tanstack/react-router': '1.170.46',
          '@tanstack/history': '1.162.5',
          react: '19.3.1',
          'react-dom': '19.3.1',
          // React declarations for the route path public-API consumer.
          '@types/react': '19.3.0',
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(consumer, 'pnpm-workspace.yaml'),
    `packageImportMethod: clone-or-copy\noverrides:\n  '@tanstack/router-core': 'file:./${tarball}'\n`,
  );
  // The override binds React's identical 1.171.39 dependency to this local
  // correction archive; it does not change a version or silence a peer check.
  disk();
  register(path.join(consumer, 'node_modules'), 'dependencies');
  run(
    'pnpm',
    [
      'install',
      '--ignore-scripts',
      '--store-dir',
      '/Users/satan/.local/share/pnpm/store',
      '--config.package-import-method=clone-or-copy',
    ],
    consumer,
  );
  register(path.join(consumer, 'node_modules'), 'dependencies');
  const require = createRequire(path.join(consumer, 'package.json'));
  const packageDir = path.dirname(
    require.resolve('@tanstack/router-core/package.json'),
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'))).version,
    '1.171.39',
  );
  for (const format of ['esm', 'cjs']) {
    const target = path.join(pkg, 'tests', `packed-${format}`);
    fs.mkdirSync(target);
    const extension = format === 'esm' ? 'js' : 'cjs';
    const files = [
      ...fs
        .readdirSync(path.join(here, 'tests'))
        .filter(file => !file.includes('test-d')),
      'routerTestUtils.ts',
    ];
    for (const file of files) {
      let text = fs.readFileSync(path.join(pkg, 'tests', file), 'utf8');
      text = text.replace(
        /(['"])\.\.\/src(?:\/([^'"]+))?\1/g,
        (_, quote, subpath) => {
          const relative = subpath ?? 'index';
          return `${quote}${path.join(packageDir, 'dist', format, `${relative}.${extension}`)}${quote}`;
        },
      );
      fs.writeFileSync(path.join(target, file), text);
    }
    run(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--typecheck.enabled=false',
        `packed-${format}`,
      ],
      pkg,
    );
  }
  fs.copyFileSync(
    path.join(here, 'packed-counterexamples.mjs'),
    path.join(consumer, 'packed-counterexamples.mjs'),
  );
  for (const format of ['esm', 'cjs'])
    run(
      process.execPath,
      [
        '--conditions=development',
        path.join(consumer, 'packed-counterexamples.mjs'),
        format,
      ],
      consumer,
    );
  const tsc = path.join(pkg, 'node_modules/typescript/bin/tsc');
  for (const mode of ['browser', 'node-esm', 'node-cjs']) {
    const node = mode !== 'browser';
    const suffix = mode === 'node-cjs' ? 'cts' : 'mts';
    const file = path.join(consumer, `consumer.${mode}.${suffix}`);
    fs.writeFileSync(
      file,
      `import { mergeHeaders } from '@tanstack/router-core/ssr/client';
import { transformReadableStreamWithRouter } from '@tanstack/router-core/ssr/server';
import type { AnyRouter, NavigateOptions, RouteMask } from '@tanstack/router-core';
declare const router: AnyRouter;
const readable: ReadableStream<Uint8Array> = transformReadableStreamWithRouter(router, new ReadableStream<string>());
const headers: Headers = mergeHeaders({ 'content-length': 42, cookie: ['a=b'] });
const mask: NavigateOptions = { to: '/items', mask: { to: '/en/items', inheritSearch: true } };
// @ts-expect-error Inherited masks cannot also supply a search reducer.
const invalid: NavigateOptions = { to: '/items', mask: { to: '/en/items', inheritSearch: true, search: true } };
void readable; void headers; void mask; void invalid;
${
  node
    ? `import { Readable } from 'node:stream';
import { transformPipeableStreamWithRouter } from '@tanstack/router-core/ssr/server.node';
const output: Readable = transformPipeableStreamWithRouter(router, Readable.from(['<html></html>'])); void output;`
    : ''
}
`,
    );
    fs.writeFileSync(
      path.join(consumer, `tsconfig.${mode}.json`),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: node ? 'NodeNext' : 'ESNext',
          moduleResolution: node ? 'NodeNext' : 'Bundler',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          types: node ? ['node'] : [],
          typeRoots: [path.join(pkg, 'node_modules/@types')],
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          ignoreDeprecations: '6.0',
        },
        files: [file],
      }),
    );
    run(
      process.execPath,
      [tsc, '-p', path.join(consumer, `tsconfig.${mode}.json`)],
      consumer,
    );
  }
  qualifyRoutePathTypes({
    consumer,
    tsc,
    typeRoots: path.join(pkg, 'node_modules/@types'),
  });
  for (const condition of ['node', 'browser', 'workerd', 'worker']) {
    for (const format of ['module', 'commonjs']) {
      const code =
        format === 'module'
          ? `import * as api from '@tanstack/router-core/ssr/server'; const resolved=import.meta.resolve('@tanstack/router-core/ssr/server');`
          : `const api=require('@tanstack/router-core/ssr/server'); const resolved=require.resolve('@tanstack/router-core/ssr/server');`;
      run(
        process.execPath,
        [
          `--conditions=${condition}`,
          `--input-type=${format}`,
          '-e',
          `${code} if (!resolved.includes('/ssr/server${condition === 'node' ? '.node' : ''}.${format === 'module' ? 'js' : 'cjs'}')) throw new Error(resolved); if (typeof api.transformReadableStreamWithRouter !== 'function') throw new Error('missing Web adapter'); if (${condition === 'node'} && typeof api.transformPipeableStreamWithRouter !== 'function') throw new Error('missing Node adapter');`,
        ],
        consumer,
      );
    }
  }
  run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {RouterCore} from '@tanstack/router-core'; import {createRouter,createRootRoute,createRoute,createMemoryHistory} from '@tanstack/react-router'; const root=createRootRoute(); const page=createRoute({getParentRoute:()=>root,path:'/',loader:()=>42}); const router=createRouter({routeTree:root.addChildren([page]),history:createMemoryHistory(),isServer:true}); await router.load(); if(!(router instanceof RouterCore)) throw new Error('React used a different core authority'); if(router.state.matches.at(-1).loaderData!==42) throw new Error('React consumer failed');`,
    ],
    consumer,
  );
  console.log(
    'PACKED_QUALIFICATION_PASS source suites x CJS/ESM, browser/Node declarations, route path types, 8 conditional entrypoints, React 1.170.46 + history 1.162.5',
  );
}
