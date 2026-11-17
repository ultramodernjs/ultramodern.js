import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Public-API consumers of the packed declarations. The pristine registry core
// must reject the runtime id of a flat prefix index (`$lang/`), the corrected
// core must accept it and keep trailingSlash 'never' links trimmed.
const core =
  specifier => `import { BaseRootRoute, BaseRoute } from '${specifier}';
import type { RouteIds, RouterCore, RouteToPath, ToPathOption } from '${specifier}';
const root = new BaseRootRoute({});
const lang = new BaseRoute({ getParentRoute: () => root, path: '$lang/' });
const splat = new BaseRoute({ getParentRoute: () => root, path: '$lang/$' });
const edge = new BaseRoute({ getParentRoute: () => root, path: '//b//c//' });
const routeTree = root.addChildren([lang, splat, edge]);
type Never = RouterCore<typeof routeTree, 'never', false>;
type Always = RouterCore<typeof routeTree, 'always', false>;
export const id: '/$lang/' = lang.id;
export const fullPath: '/$lang/' = lang.fullPath;
export const to: '/$lang' = lang.to;
export const edgeId: '/b/c/' = edge.id;
export const edgeTo: '/b/c' = edge.to;
export const ids: Array<RouteIds<typeof routeTree>> = ['__root__', '/$lang/', '/$lang/$', '/b/c/'];
// @ts-expect-error The trimmed id is not a runtime route id.
export const missing: RouteIds<typeof routeTree> = '/$lang';
export const never: Array<RouteToPath<Never>> = ['/', '/$lang', '/$lang/$', '/b/c'];
export const always: Array<RouteToPath<Always>> = ['/', '/$lang/', '/$lang/$/', '/b/c/'];
export const link: ToPathOption<Never, string, '/$lang'> = '/$lang';
// @ts-expect-error trailingSlash 'never' links to the trimmed target.
export const trailing: ToPathOption<Never, string, '/$lang/'> = '/$lang/';
// @ts-expect-error trailingSlash 'always' appends exactly one slash.
export const doubled: ToPathOption<Always, string, '/$lang//'> = '/$lang//';
`;
const react = `import { createRootRoute, createRoute, createRouter, linkOptions, useLoaderData, useNavigate } from '@tanstack/react-router';
const root = createRootRoute();
const lang = createRoute({ getParentRoute: () => root, path: '$lang/', loader: () => ({ home: true as const }) });
const splat = createRoute({ getParentRoute: () => root, path: '$lang/$' });
export const router = createRouter({ routeTree: root.addChildren([lang, splat]) });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
export const useHome = (): true => useLoaderData({ from: '/$lang/' }).home;
// @ts-expect-error The trimmed id is not a runtime route id.
export const useMissing = () => useLoaderData({ from: '/$lang' });
export const home = linkOptions({ to: '/$lang', params: { lang: 'en' } });
// @ts-expect-error trailingSlash 'never' links to the trimmed target.
export const trailing = linkOptions({ to: '/$lang/', params: { lang: 'en' } });
export const useGo = () => { const navigate = useNavigate(); return () => navigate({ to: '/$lang', params: { lang: 'en' } }); };
`;

export function qualifyRoutePathTypes({ consumer, tsc, typeRoots }) {
  const directory = path.join(consumer, 'route-paths');
  fs.mkdirSync(directory);
  const check = (name, mode, text) => {
    const node = mode !== 'browser';
    const file = path.join(
      directory,
      `${name}.${mode}.${mode === 'node-cjs' ? 'cts' : 'mts'}`,
    );
    fs.writeFileSync(file, text);
    const project = path.join(directory, `tsconfig.${name}.${mode}.json`);
    fs.writeFileSync(
      project,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: node ? 'NodeNext' : 'ESNext',
          moduleResolution: node ? 'NodeNext' : 'Bundler',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          types: [],
          typeRoots: [typeRoots],
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          ignoreDeprecations: '6.0',
        },
        files: [file],
      }),
    );
    const result = spawnSync(process.execPath, [tsc, '-p', project], {
      cwd: consumer,
      encoding: 'utf8',
    });
    return {
      file,
      status: result.status,
      output: result.stdout + result.stderr,
    };
  };
  for (const mode of ['browser', 'node-esm', 'node-cjs']) {
    for (const [name, text] of [
      ['core', core('@tanstack/router-core')],
      ['react', react],
    ]) {
      const result = check(name, mode, text);
      assert.equal(result.status, 0, result.output);
    }
    const vanilla = check('vanilla', mode, core('vanilla-router-core'));
    assert.notEqual(
      vanilla.status,
      0,
      'Pristine core accepted the runtime route id',
    );
    assert.match(
      vanilla.output,
      /Type '"\/\$lang"' is not assignable to type '"\/\$lang\/"'/u,
    );
    for (const line of vanilla.output.trim().split('\n'))
      if (/error TS\d+/u.test(line))
        assert(line.includes(path.basename(vanilla.file)), line);
  }
  console.log(
    'ROUTE_PATH_TYPES_PASS pristine core rejects runtime ids; corrected core and React accept ids and runtime link targets (ESM/CJS declarations)',
  );
}
