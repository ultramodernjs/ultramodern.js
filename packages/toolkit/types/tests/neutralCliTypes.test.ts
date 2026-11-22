import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const packageRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const compilerManifest = require.resolve('typescript/package.json');
const compiler = path.resolve(
  path.dirname(compilerManifest),
  require(compilerManifest).bin.tsc,
);

function check(source: string, types: string) {
  const fixture = path.join(
    packageRoot,
    `neutral-types-${process.pid}-${Math.random().toString(16).slice(2)}.ts`,
  );
  try {
    fs.writeFileSync(fixture, source);
    const result = spawnSync(
      process.execPath,
      [
        compiler,
        '--ignoreConfig',
        '--noEmit',
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        '--target',
        'esnext',
        '--types',
        types,
        '--listFiles',
        fixture,
      ],
      { cwd: packageRoot, encoding: 'utf8' },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return result.stdout.split(/\r?\n/u).filter(Boolean);
  } finally {
    fs.rmSync(fixture, { force: true });
  }
}

describe('canonical CLI declaration contracts', () => {
  it('resolves generic metadata and server types without loading React declarations', () => {
    const graph = check(
      `
      import type { Entrypoint, Route, NestedRoute, PageRoute, SSGConfig, Merge } from './cli/base';
      import type { ServerRoute } from './server';
      import type { ServerPlugin, SSRMode } from './common';
      const entry: Entrypoint = {entryName:'index',isMainEntry:true,entry:'src/App.tsx'};
      const route: Route<string> = {type:'native',element:'module',children:[{type:'child',element:'child'}]};
      const nested: NestedRoute<string,string> = {type:'nested',origin:'file-system',component:'./page',children:[]};
      const page: PageRoute<string> = {type:'page',component:'./page',_component:'./page',children:[]};
      // @ts-expect-error the selected element contract is preserved
      const invalid: Route<string> = {type:'native',element:123};
      type Metadata = Merge<{entry:Entrypoint},{route:Route<string>}>;
      type Server = {route:ServerRoute,plugin:ServerPlugin,mode:SSRMode,ssg:SSGConfig};
      void entry; void route; void nested; void page; void invalid;
    `,
      'node',
    );
    expect(
      graph.some(file =>
        /(?:@types\/react|react(?:-dom)?\/.*\.d\.ts)/u.test(
          file.replaceAll('\\', '/'),
        ),
      ),
    ).toBe(false);
  });

  it('preserves legacy React defaults, Merge and recursive declaration merging', () => {
    check(
      `
      import type * as React from 'react';
      import type { Route, NestedRoute, PageRoute, Merge } from './cli';
      declare module './cli' { interface Route { owningAugmentation?: 'preserved' } }
      const child: NonNullable<Route['children']>[number]['owningAugmentation'] = 'preserved';
      const nestedChild: NonNullable<NestedRoute['children']>[number]['owningAugmentation'] = 'preserved';
      const pageParent: NonNullable<PageRoute['parent']>['owningAugmentation'] = 'preserved';
      const element: Route['element'] = 123;
      const component: NestedRoute['component'] = (): React.ReactElement => {throw new Error('type-only')};
      type ExistingMerge = Merge<{a:1},{b:2}>;
      void child; void nestedChild; void pageParent; void element; void component;
    `,
      'node,react',
    );
  });
});

it('accepts native development middleware error forwarding through the public server contract', () => {
  check(
    `
    import type { NextFunction, RequestHandler } from './server';
    declare const failure: unknown;
    const next: NextFunction = () => {};
    next();
    next(undefined);
    next(null);
    next(new Error('filesystem read failed'));
    next(failure);
    const middleware: RequestHandler = (_request, _response, done) => {
      queueMicrotask(() => done(new Error('asynchronous read failed')));
    };
    void middleware;
    `,
    'node',
  );
});
