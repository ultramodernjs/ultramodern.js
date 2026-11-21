import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as t from '@babel/types';
import { createSharedApi } from '../../ultramodern-create/src/ultramodern-workspace/api/shared';
import { runMicroVerticalApiCheckCli } from '../src/cli/microvertical-api-check';
import {
  checkMicroVerticalApiBoundaries,
  checkMicroVerticalApiConsumerFiles,
  createModuleGraph,
  type GraphValue,
  type MicroVerticalApiBaselineExpectation,
  type MicroVerticalApiSourceRule,
  type ModuleGraphHop,
  microVerticalApiBaselineViolation,
} from '../src/microvertical-api-boundary';

const baseline = '@modern-js/bff-effect/microvertical-api';
const exportsSource = `export const MicroVerticalBuildMarkerSchema = {}; export const MicroVerticalReadinessSchema = {}; export const createMicroVerticalOperationContext = input => input;`;
const contract = `import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import { MicroVerticalBuildMarkerSchema, MicroVerticalReadinessSchema, createMicroVerticalOperationContext } from '${baseline}';
export const catalogMarkerSchema = MicroVerticalBuildMarkerSchema;
export const catalogReadinessSchema = MicroVerticalReadinessSchema;
export const catalogFoundationApi = HttpApi.make('CatalogFoundationApi').add(HttpApiGroup.make('foundation').add(HttpApiEndpoint.get('readiness', '/catalog/readiness', { success: catalogReadinessSchema })));
export const catalogApi = HttpApi.make('CatalogApi').addHttpApi(catalogFoundationApi);
export const catalogOperationContexts = { readiness: createMicroVerticalOperationContext({method: 'GET', operationId: 'CatalogApi:/catalog/readiness', routePath: '/catalog/readiness'}) } as const;
export const catalogApiContract = { apiPrefix: '/catalog-api', basePath: '/catalog-api/catalog', ownerId: 'catalog', readinessPath: '/catalog-api/catalog/readiness' } as const;`;
/** A sub-API whose group uses every non-endpoint Effect combinator. */
const prefixedSearchApi =
  () => `import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { CatalogAnnotation, CatalogAuthMiddleware } from '../middleware.ts';
export const catalogSearchApi = HttpApi.make('CatalogSearchApi').add(
  HttpApiGroup.make('catalogSearch')
    .add(HttpApiEndpoint.post('execute', '/catalog/search', { success: Schema.Unknown }))
    .middleware(CatalogAuthMiddleware)
    .prefix('/search')
    .annotate(CatalogAnnotation, 'value'),
);`;
const pascal = (name: string) =>
  `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
/** A root contract that composes two sub-APIs from sibling modules. */
const composed = contract.replace(
  `export const catalogApi = HttpApi.make('CatalogApi').addHttpApi(catalogFoundationApi);`,
  `import { catalogSearchApi } from './apis/catalog-search.ts';
import { catalogCommandsApi } from './commands';
export const catalogApi = HttpApi.make('CatalogApi').addHttpApi(catalogFoundationApi).addHttpApi(catalogSearchApi).addHttpApi(catalogCommandsApi);`,
);
const entry = `import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge'; import { catalogApi } from '../shared/api.ts'; const handlers = HttpApiBuilder.group(catalogApi, 'foundation', h => h.handle('readiness', () => undefined)); const layer = HttpApiBuilder.layer(catalogApi).pipe(Layer.provide(handlers)); export default defineEffectBff({api: catalogApi, layer});`;
let root: string;
let owner: string;
let file: string;
let expectation: MicroVerticalApiBaselineExpectation;
const write = (file: string, source: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-tools-api-boundary-'));
  owner = path.join(root, 'node_modules/@modern-js/bff-effect');
  write(
    path.join(owner, 'package.json'),
    JSON.stringify({
      name: '@modern-js/bff-effect',
      type: 'module',
      exports: {
        './microvertical-api': {
          types: './types.d.ts',
          import: './index.js',
          require: './index.js',
        },
      },
    }),
  );
  write(path.join(owner, 'index.js'), exportsSource);
  file = path.join(root, 'verticals/catalog/shared/api.ts');
  write(file, contract);
  write(
    path.join(root, 'apps/shell/package.json'),
    JSON.stringify({ name: '@fixture/shell' }),
  );
  write(
    path.join(root, 'verticals/catalog/package.json'),
    JSON.stringify({
      name: '@fixture/catalog',
      exports: {
        './api': './shared/api.ts',
        './api/client': './src/api/catalog-client.ts',
      },
    }),
  );
  write(
    path.join(root, 'topology/reference-topology.json'),
    JSON.stringify({
      shell: {
        id: 'shell',
        kind: 'shell',
        path: 'apps/shell',
        package: '@fixture/shell',
      },
      verticals: [
        {
          id: 'catalog',
          path: 'verticals/catalog',
          kind: 'vertical',
          package: '@fixture/catalog',
          api: {},
        },
      ],
    }),
  );
  write(path.join(root, 'verticals/catalog/api/index.ts'), entry);
  write(
    path.join(root, 'verticals/catalog/src/api/catalog-client.ts'),
    `import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client'; import { catalogApi } from '../../shared/api'; export const client = makeEffectHttpApiClient(catalogApi);`,
  );
  expectation = {
    additionalPaths: {},
    apiPrefix: '/catalog-api',
    basePath: '/catalog-api/catalog',
    ownerId: 'catalog',
    readinessPath: '/catalog-api/catalog/readiness',
    effectClientPackage: '@modern-js/bff-effect/effect-client',
    baselinePackage: baseline,
    baselinePackageDirectory: owner,
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const validate = (source = contract) => {
  write(file, source);
  return microVerticalApiBaselineViolation('catalog', file, expectation);
};

const subApi = (
  exportName: string,
  group: string,
  route: string,
  routeExpression = `'${route}'`,
) => `import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
export const ${exportName} = HttpApi.make('${pascal(exportName)}').add(HttpApiGroup.make('${group}').add(HttpApiEndpoint.post('execute', ${routeExpression}, { success: Schema.Unknown })));`;

test('composes sub-APIs declared in sibling modules', () => {
  // A named import with an explicit `.ts` specifier, plus an extension-less
  // directory import whose index re-exports a third module: the shapes a
  // consumer reaches for when a root API outgrows one file.
  write(
    path.join(root, 'verticals/catalog/shared/apis/catalog-search.ts'),
    subApi('catalogSearchApi', 'catalogSearch', '/catalog/search'),
  );
  write(
    path.join(root, 'verticals/catalog/shared/commands/catalog-commands.ts'),
    subApi('catalogCommandsApi', 'catalogCommands', '/catalog/commands'),
  );
  write(
    path.join(root, 'verticals/catalog/shared/commands/index.ts'),
    `export { catalogCommandsApi } from './catalog-commands.ts';`,
  );
  expect(validate(composed)).toBeUndefined();
});

test('still rejects a composed identifier it cannot resolve', () => {
  write(
    path.join(root, 'verticals/catalog/shared/apis/catalog-search.ts'),
    subApi('catalogSearchApi', 'catalogSearch', '/catalog/search'),
  );
  // `./commands` is never created, so `catalogCommandsApi` stays unresolved.
  expect(validate(composed)).toContain('bounded native endpoint declarations');
});

test('resolves a public shared workspace export under an arbitrary scope', () => {
  write(
    path.join(root, 'pnpm-workspace.yaml'),
    'packages:\n  - packages/*\n  - verticals/*\n',
  );
  const shared = path.join(root, 'packages/contracts');
  write(
    path.join(shared, 'package.json'),
    JSON.stringify({
      name: '@domain/shared-contracts',
      exports: {
        './catalog': {
          'modern:source': './src/catalog.ts',
          import: './dist/catalog.js',
        },
      },
    }),
  );
  write(
    path.join(shared, 'src/catalog.ts'),
    `export { catalogSearchApi } from './catalog-search.ts';`,
  );
  write(
    path.join(shared, 'src/catalog-search.ts'),
    subApi('catalogSearchApi', 'catalogSearch', '/catalog/search'),
  );
  const link = path.join(root, 'node_modules/@domain/shared-contracts');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(shared, link);
  write(
    path.join(root, 'verticals/catalog/shared/commands/index.ts'),
    subApi('catalogCommandsApi', 'catalogCommands', '/catalog/commands'),
  );
  const publicSource = composed.replace(
    "'./apis/catalog-search.ts'",
    "'@domain/shared-contracts/catalog'",
  );
  expect(validate(publicSource)).toBeUndefined();
  expect(validate(publicSource.replace("/catalog'", "/private'"))).toContain(
    'bounded native endpoint declarations',
  );
  expect(
    validate(
      publicSource.replace(
        "'@domain/shared-contracts/catalog'",
        "'@domain/shared-contracts/src/catalog-search'",
      ),
    ),
  ).toContain('bounded native endpoint declarations');
});

test('source rules receive the resolved re-export chain across packages', async () => {
  write(
    path.join(root, 'pnpm-workspace.yaml'),
    'packages:\n  - packages/*\n  - verticals/*\n',
  );
  const shared = path.join(root, 'packages/contracts');
  write(
    path.join(shared, 'package.json'),
    JSON.stringify({
      name: '@domain/shared-contracts',
      exports: { './catalog': { 'modern:source': './src/catalog.ts' } },
    }),
  );
  write(
    path.join(shared, 'src/catalog.ts'),
    `export { catalogSearchApi } from './catalog-search.ts';`,
  );
  write(
    path.join(shared, 'src/catalog-search.ts'),
    subApi('catalogSearchApi', 'catalogSearch', '/catalog/search'),
  );
  fs.mkdirSync(path.join(root, 'node_modules/@domain'), { recursive: true });
  fs.symlinkSync(
    shared,
    path.join(root, 'node_modules/@domain/shared-contracts'),
  );
  write(
    path.join(root, 'verticals/catalog/shared/commands/index.ts'),
    subApi('catalogCommandsApi', 'catalogCommands', '/catalog/commands'),
  );
  write(
    file,
    composed.replace(
      "'./apis/catalog-search.ts'",
      "'@domain/shared-contracts/catalog'",
    ),
  );
  const real = fs.realpathSync(root);
  const hops = (chain: readonly ModuleGraphHop[]) =>
    chain.map(
      hop =>
        `${path.relative(real, hop.path).split(path.sep).join('/')}#${hop.name}`,
    );
  const seen: string[][] = [];
  const traceSearchApi: MicroVerticalApiSourceRule = ({
    file: checked,
    module,
    graph,
  }) => {
    if (checked !== 'verticals/catalog/shared/api.ts') return [];
    const search = graph.resolve(module, 'catalogSearchApi', 'local');
    if (search?.kind !== 'declaration') return ['catalogSearchApi unresolved'];
    const httpApi = graph.resolve(search.module, 'HttpApi', 'local');
    seen.push([checked], hops(search.chain));
    return httpApi?.kind === 'external'
      ? [`${httpApi.name} from ${httpApi.specifier} via ${hops(httpApi.chain)}`]
      : ['HttpApi must end at its package'];
  };
  const result = checkMicroVerticalApiConsumerFiles({
    workspaceRoot: root,
    baselinePackageDirectory: owner,
    sourceRules: [traceSearchApi],
  });
  expect(result.toolErrors).toEqual([]);
  expect(seen).toEqual([
    ['verticals/catalog/shared/api.ts'],
    [
      'verticals/catalog/shared/api.ts#catalogSearchApi',
      'packages/contracts/src/catalog.ts#catalogSearchApi',
      'packages/contracts/src/catalog-search.ts#catalogSearchApi',
    ],
  ]);
  expect(result.diagnostics).toEqual([
    'verticals/catalog/shared/api.ts: HttpApi from effect/http-api via packages/contracts/src/catalog-search.ts#HttpApi',
  ]);

  // A private subpath the package does not export ends the chain unresolved.
  const publicContract = fs.readFileSync(file, 'utf8');
  write(
    file,
    publicContract.replace(
      "'@domain/shared-contracts/catalog'",
      "'@domain/shared-contracts/src/catalog-search'",
    ),
  );
  expect(
    checkMicroVerticalApiConsumerFiles({
      workspaceRoot: root,
      baselinePackageDirectory: owner,
      sourceRules: [traceSearchApi],
    }).diagnostics,
  ).toContain('verticals/catalog/shared/api.ts: catalogSearchApi unresolved');

  // A rule that does not return an array of messages is a tool failure, not a pass.
  const stringRule = (() => '') as unknown as MicroVerticalApiSourceRule;
  expect(
    checkMicroVerticalApiConsumerFiles({
      workspaceRoot: root,
      baselinePackageDirectory: owner,
      sourceRules: [stringRule],
    }).toolErrors.join('\n'),
  ).toContain('must return an array of violation messages');

  // The CLI loads rules from a module; their messages are consumer violations.
  write(file, publicContract);
  const cli = (rules: string) =>
    runMicroVerticalApiCheckCli(['--workspace-root', root, '--rules', rules]);
  const passing = path.join(root, 'passing-rules.mjs');
  const failing = path.join(root, 'failing-rules.mjs');
  const malformed = path.join(root, 'malformed-rules.mjs');
  write(passing, `export default [() => []];`);
  write(failing, `export default [() => ['consumer rule ran']];`);
  write(malformed, `export default () => [];`);
  expect(await cli(passing)).toBe(0);
  expect(await cli(failing)).toBe(1);
  expect(await cli(malformed)).toBe(2);
});

/** An HttpApi schema rule written the way a consumer would, on the graph alone. */
const unconstrainedSchemas: MicroVerticalApiSourceRule = ({
  module,
  graph,
}) => {
  const forbidden = ({ kind, ...value }: GraphValue) =>
    kind === 'external' &&
    'specifier' in value &&
    ['Any', 'Unknown'].includes(
      value.specifier === 'effect/Schema'
        ? value.name
        : value.name === 'Schema'
          ? (value.members[0] ?? '')
          : '',
    );
  const messages: string[] = [];
  t.traverseFast(module.file, node => {
    if (
      t.isCallExpression(node) &&
      graph
        .evaluate(module, node.callee)
        .some(
          value =>
            value.kind === 'external' &&
            value.name === 'HttpApiEndpoint' &&
            value.members.length === 1,
        ) &&
      node.arguments.some(argument =>
        graph.reachable(module, argument).some(forbidden),
      )
    )
      messages.push(`unconstrained schema at line ${node.loc?.start.line}`);
  });
  return messages;
};

test('source rules follow destructuring, returns and member writes in every source file', () => {
  write(
    path.join(root, 'pnpm-workspace.yaml'),
    'packages:\n  - packages/*\n  - verticals/*\n',
  );
  const shared = path.join(root, 'packages/contracts');
  write(
    path.join(shared, 'package.json'),
    JSON.stringify({
      name: '@domain/shared-contracts',
      exports: { './schemas': { 'modern:source': './src/schemas.ts' } },
    }),
  );
  // A namespace import, a function return and an export alias across packages.
  write(
    path.join(shared, 'src/schemas.ts'),
    `import * as S from 'effect/Schema';
const unknown = () => { return S.Unknown; };
export { unknown as loose };
export const strict = S.String;`,
  );
  // Every source file is checked, not only API contracts.
  write(
    path.join(shared, 'src/endpoints.ts'),
    `import { HttpApiEndpoint } from 'effect/http-api';
import { Schema } from 'effect';
export const probe = HttpApiEndpoint.get('probe', '/probe', { success: Schema.Any });`,
  );
  fs.mkdirSync(path.join(root, 'node_modules/@domain'), { recursive: true });
  fs.symlinkSync(
    shared,
    path.join(root, 'node_modules/@domain/shared-contracts'),
  );
  const endpoints = path.join(
    root,
    'verticals/catalog/src/contracts/endpoints.ts',
  );
  write(
    endpoints,
    `import { HttpApiEndpoint } from 'effect/http-api';
import { Schema } from 'effect';
import { loose, strict } from '@domain/shared-contracts/schemas';
const { get } = HttpApiEndpoint;
const bodies = { search: Schema.String };
bodies.search = Schema.Struct({ q: loose() });
export const search = get('search', '/search', { success: bodies.search });
function endpointFactory() { return HttpApiEndpoint.post; }
export const create = endpointFactory()('create', '/create', { payload: Schema.Struct({ ...{ name: strict } }) });
let fallback = Schema.String;
fallback = Schema.Unknown;
export const remove = HttpApiEndpoint.del('remove', '/remove', { error: fallback });`,
  );
  const result = checkMicroVerticalApiConsumerFiles({
    workspaceRoot: root,
    baselinePackageDirectory: owner,
    sourceRules: [unconstrainedSchemas],
  });
  expect(result.toolErrors).toEqual([]);
  expect(result.diagnostics).toEqual([
    'verticals/catalog/src/contracts/endpoints.ts: unconstrained schema at line 7',
    'verticals/catalog/src/contracts/endpoints.ts: unconstrained schema at line 12',
    'packages/contracts/src/endpoints.ts: unconstrained schema at line 3',
  ]);

  // Evaluation reports each value path; the destructured factory is external.
  const graph = createModuleGraph();
  const module = graph.module(endpoints);
  const exported = (name: string) => {
    const resolved = graph.resolve(module, name, 'export');
    if (resolved?.kind !== 'declaration') throw new Error(name);
    return resolved.expression as t.CallExpression;
  };
  const externals = (values: readonly GraphValue[]) =>
    values.map(value =>
      value.kind === 'external'
        ? `${value.specifier}:${[value.name, ...value.members].join('.')}`
        : value.kind,
    );
  expect(externals(graph.evaluate(module, exported('search').callee))).toEqual([
    'effect/http-api:HttpApiEndpoint.get',
  ]);
  expect(externals(graph.evaluate(module, exported('create').callee))).toEqual([
    'effect/http-api:HttpApiEndpoint.post',
  ]);
  // The initializer and the later member write are both possible values.
  const success = (exported('search').arguments[2] as t.ObjectExpression)
    .properties[0] as t.ObjectProperty;
  expect(externals(graph.evaluate(module, success.value))).toEqual([
    'effect:Schema.String',
    'node',
  ]);
  // A mutated binding is never a resolved `const` declaration.
  expect(graph.resolve(module, 'bodies', 'local')).toBeUndefined();

  // Alias chains deeper than the nesting budget end unresolved, not in a stack overflow.
  const deep = path.join(root, 'verticals/catalog/src/contracts/deep.ts');
  write(
    deep,
    `import { Schema } from 'effect';\nexport const a0 = Schema.Unknown;\n${Array.from(
      { length: 5000 },
      (_, index) => `const a${index + 1} = a${index};`,
    ).join('\n')}\nexport const last = [a5000];`,
  );
  const deepModule = graph.module(deep);
  const last = graph.resolve(deepModule, 'last', 'export');
  if (last?.kind !== 'declaration') throw new Error('last');
  expect(externals(graph.evaluate(deepModule, last.expression))).toEqual([
    'node',
  ]);
  expect(
    new Set(externals(graph.reachable(deepModule, last.expression))),
  ).toEqual(new Set(['unresolved']));

  // Star-export and re-export cycles fall through to the module that exports the name.
  const barrels = path.join(root, 'verticals/catalog/src/barrels');
  write(
    path.join(barrels, 'a.ts'),
    `export * from './b.ts';\nexport * from './c.ts';`,
  );
  write(
    path.join(barrels, 'b.ts'),
    `export * from './a.ts';\nexport { looped } from './d.ts';`,
  );
  write(
    path.join(barrels, 'c.ts'),
    `import { Schema } from 'effect';\nexport const target = Schema.Unknown;`,
  );
  write(path.join(barrels, 'd.ts'), `export { looped } from './b.ts';`);
  write(
    path.join(barrels, 'use.ts'),
    `import { target, looped } from './a.ts';\nexport const both = [target, looped];`,
  );
  const use = graph.module(path.join(barrels, 'use.ts'));
  const both = graph.resolve(use, 'both', 'export');
  if (both?.kind !== 'declaration') throw new Error('both');
  expect(externals(graph.reachable(use, both.expression))).toEqual([
    'unresolved',
    'effect:Schema.Unknown',
  ]);

  // Globals and recursive values are opaque: rules see `unresolved`, never nothing.
  const opaque = path.join(root, 'verticals/catalog/src/contracts/opaque.ts');
  write(
    opaque,
    `const recursive = () => recursive();\nexport const global = { success: GlobalSchema };\nexport const loop = recursive();`,
  );
  const opaqueModule = graph.module(opaque);
  for (const name of ['global', 'loop']) {
    const declared = graph.resolve(opaqueModule, name, 'export');
    if (declared?.kind !== 'declaration') throw new Error(name);
    expect(
      new Set(externals(graph.reachable(opaqueModule, declared.expression))),
    ).toEqual(new Set(['unresolved']));
  }

  // Whole objects reach member writes; dynamic keys and value-less functions stay
  // possible; bundler-style imports reach JavaScript sources.
  write(
    path.join(root, 'verticals/catalog/src/contracts/helper.js'),
    `import { Schema } from 'effect';\nexport const fromJs = Schema.Unknown;`,
  );
  write(
    path.join(root, 'verticals/catalog/src/contracts/indexed/index.mjs'),
    `import { Schema } from 'effect';\nexport const fromIndex = Schema.Any;`,
  );
  const view = path.join(root, 'verticals/catalog/src/contracts/view.tsx');
  write(
    view,
    `import { Forbidden } from 'forbidden-ui';\nimport * as ui from 'other-ui';\nexport const view = <div><Forbidden /><ui.Card /></div>;`,
  );
  const viewModule = graph.module(view);
  const rendered = graph.resolve(viewModule, 'view', 'export');
  if (rendered?.kind !== 'declaration') throw new Error('view');
  expect(externals(graph.reachable(viewModule, rendered.expression))).toEqual([
    'other-ui:Card',
    'forbidden-ui:Forbidden',
  ]);
  const cjs = path.join(root, 'verticals/catalog/src/contracts/legacy.cjs');
  write(
    cjs,
    `const { HttpApiEndpoint } = require('effect/http-api');\nconst Schema = require('effect').Schema;\nexports.probe = [HttpApiEndpoint.get, Schema.Any];`,
  );
  write(
    path.join(root, 'verticals/catalog/src/contracts/endpoint-helper.cjs'),
    `const { HttpApiEndpoint } = require('effect/http-api');\nexports.get = HttpApiEndpoint.get;\nexports.api = {};\nexports.api.post = HttpApiEndpoint.post;\nexports.lazy ??= HttpApiEndpoint.patch;\nObject.assign(module.exports, { assigned: HttpApiEndpoint.trace });\nconst api = module.exports;\napi.viaAlias = HttpApiEndpoint.head;\napi.nested = {};\nconst nested = api.nested;\nnested.deep = HttpApiEndpoint.options;\nmodule.exports.schemas = { loose: require('effect').Schema.Unknown };`,
  );
  write(
    path.join(root, 'verticals/catalog/src/contracts/whole.cjs'),
    `module.exports = { json: require('effect').Schema.Json };\nmodule.exports.extra = require('effect').Schema.Never;`,
  );
  const consumer = path.join(
    root,
    'verticals/catalog/src/contracts/consumer.cjs',
  );
  write(
    consumer,
    `const { get, schemas } = require('./endpoint-helper.cjs');\nmodule.exports = [get, schemas.loose, require('./endpoint-helper.cjs').api.post, require('./whole.cjs'), require('./endpoint-helper.cjs').lazy, require('./endpoint-helper.cjs').viaAlias, require('./endpoint-helper.cjs').nested.deep, require('./endpoint-helper.cjs').assigned];`,
  );
  const consumerModule = graph.module(consumer);
  const consumerExport = consumerModule.file.program.body.at(
    -1,
  ) as t.ExpressionStatement;
  // `exports.api = {}` has no `post` of its own, so that path is also unresolved.
  expect(
    new Set(
      externals(
        graph.reachable(
          consumerModule,
          (consumerExport.expression as t.AssignmentExpression).right,
        ),
      ),
    ),
  ).toEqual(
    new Set([
      'unresolved',
      'effect/http-api:HttpApiEndpoint.post',
      'effect:Schema.Unknown',
      'effect/http-api:HttpApiEndpoint.get',
      'effect:Schema.Json',
      'effect:Schema.Never',
      'effect/http-api:HttpApiEndpoint.patch',
      'effect/http-api:HttpApiEndpoint.head',
      'effect/http-api:HttpApiEndpoint.options',
      'effect/http-api:HttpApiEndpoint.trace',
    ]),
  );
  const cjsModule = graph.module(cjs);
  const exportsWrite = cjsModule.file.program.body.at(
    -1,
  ) as t.ExpressionStatement;
  expect(
    externals(
      graph.reachable(
        cjsModule,
        (exportsWrite.expression as t.AssignmentExpression).right,
      ),
    ),
  ).toEqual(['effect:Schema.Any', 'effect/http-api:HttpApiEndpoint.get']);
  write(
    path.join(root, 'verticals/catalog/src/contracts/default-export.cjs'),
    `module.exports = require('effect').Schema.Record;`,
  );
  write(
    path.join(root, 'verticals/catalog/src/contracts/explicit-default.cjs'),
    `exports.default = require('effect').Schema.Json;`,
  );
  // After `module.exports` is replaced, `exports` is a stale object.
  write(
    path.join(root, 'verticals/catalog/src/contracts/detached-exports.cjs'),
    `module.exports = { get: require('effect').Schema.String };\nexports.get = require('effect').Schema.Any;`,
  );
  write(
    path.join(root, 'verticals/catalog/src/contracts/reattached-exports.cjs'),
    `module.exports = exports = {};\nexports.get = require('effect').Schema.Any;`,
  );
  write(
    path.join(root, 'verticals/catalog/src/contracts/rebound-exports.cjs'),
    `exports.get = require('effect').Schema.String;\nexports = {};\nexports.get = require('effect').Schema.Any;`,
  );
  write(
    path.join(root, 'verticals/catalog/src/contracts/reattached-chain.cjs'),
    `module.exports = {};\nexports = module.exports = {};\nexports.get = require('effect').Schema.Any;`,
  );
  write(
    path.join(root, 'verticals/catalog/src/contracts/reattached-later.cjs'),
    `module.exports = {};\nexports = module.exports;\nexports.get = require('effect').Schema.Any;`,
  );
  const shapes = path.join(root, 'verticals/catalog/src/contracts/shapes.ts');
  write(
    shapes,
    `import { Schema } from 'effect';
import { fromJs } from './helper';
import { fromIndex } from './indexed';
import * as helperNamespace from './helper';
import cjsDefault from './default-export.cjs';
const key = 'other';
const options = {};
options.success = Schema.Unknown;
const empty = () => {};
export const whole = [options];
export const computed = { success: Schema.String, [key]: Schema.Any }.success;
export const none = empty();
export const js = [fromJs, fromIndex];
const aliased = {};
const alias = aliased as Record<string, unknown>;
alias.success = Schema.Unknown;
export const viaAlias = [aliased];
const maybe = (flag: boolean) => { if (flag) return Schema.String; };
export const fallthrough = maybe(true);
const dynamicKeys = {};
dynamicKeys[key] = Schema.Any;
export const dynamicWhole = [dynamicKeys];
export const dynamicRead = dynamicKeys.success;
const table = { success: Schema.String };
export const opaqueRead = [table[key], empty().success];
export const keyed = table[String(Schema.Unknown)];
const nested = { success: {} };
const { success: inner } = nested;
inner.schema = Schema.Unknown;
export const viaDestructured = [nested];
const config = { success: {} };
const deepAlias = config.success;
deepAlias.schema = Schema.Unknown;
export const viaMember = [config];
const patterned = { success: Schema.String };
({ success: patterned.success } = { success: Schema.Unknown });
export const viaPattern = patterned.success;
const branches = { first: {}, second: {} };
let branch = branches.first;
branch = branches.second;
branch.schema = Schema.Unknown;
export const viaSecond = [branches.second];
const tree = { child: { child: {} } };
let cursor = tree.child;
cursor = cursor.child;
export const walked = [tree];
export const numeric = ({ 0: Schema.String })[0];
const chosen = { success: Schema.String };
const either = Math.random() > 0.5 ? chosen : branches;
either.success = Schema.Unknown;
export const viaConditional = [chosen];
const source = {};
const { api: { get: fallbackGet } = { get: Schema.Any } } = source;
export const defaulted = fallbackGet;
const keyedConfig = { success: {} };
const keyedAlias = keyedConfig[key];
keyedAlias.schema = Schema.Unknown;
export const viaKeyedAlias = [keyedConfig];
const mark = (_value: unknown) => (target: unknown) => target;
@mark(Schema.Unknown) class Decorated {}
export const decorated = Decorated;
export const getter = { get endpoint() { return Schema.Any; } }.endpoint;
const dotted = { 'a.b': {}, a: { b: {} } };
let dottedAlias = dotted['a.b'];
dottedAlias = dotted.a.b;
dottedAlias.schema = Schema.Unknown;
export const viaDotted = [dotted.a.b];
let factory;
export const assigned = (factory = Schema.Any);
const logical = { success: {} };
let logicalAlias: typeof logical | undefined;
logicalAlias ??= logical;
logicalAlias.success = Schema.Unknown;
export const viaLogical = [logical];
const defaultSource = { success: {} };
const { value: defaultAlias = defaultSource } = {} as { value?: typeof defaultSource };
defaultAlias.success = Schema.Unknown;
export const viaDefault = [defaultSource];
const hopConfig = { success: {} };
const hopFirst = hopConfig[key];
const hopSecond = hopFirst;
hopSecond.schema = Schema.Unknown;
export const viaHops = [hopConfig];
const [arrayGet, ...arrayRest] = [Schema.Any, Schema.String];
export const fromArray = arrayGet;
export const fromRest = arrayRest;
export const viaNamespace = { ...helperNamespace };
const looped = { success: Schema.String };
for (looped.success of [Schema.Unknown]) {}
export const viaLoop = looped.success;
const asyncFactory = async () => Schema.Any;
export const awaited = async () => (await asyncFactory());
const returnedConfig = { success: {} };
function getConfig() { return returnedConfig; }
const returnedAlias = getConfig();
returnedAlias.success = Schema.Unknown;
export const viaReturn = [returnedConfig];
const iifeConfig = { success: {} };
const iifeAlias = (() => iifeConfig)();
iifeAlias.success = Schema.Unknown;
export const viaIife = [iifeConfig];
const methodConfig = { success: {} };
const holder = { get() { return methodConfig; } };
const methodAlias = holder.get();
methodAlias.success = Schema.Unknown;
export const viaMethod = [methodConfig];
function shadowed(require: (id: string) => { Schema: unknown }) { return require('effect').Schema; }
export const lexicalRequire = shadowed;
const generic = <T,>() => Schema.Any;
const specialized = generic<void>;
export const instantiated = specialized();
const stored = { success: {} };
const storage = { stored };
storage.stored.success = Schema.Unknown;
export const viaStorage = [stored];
const indirectConfig = { success: {} };
const getIndirect = () => indirectConfig;
const indirect = getIndirect;
const indirectAlias = indirect();
indirectAlias.success = Schema.Unknown;
export const viaIndirect = [indirectConfig];
let lazyEndpoint;
lazyEndpoint ??= Schema.Any;
export const viaLogicalInit = lazyEndpoint;
const identity = <T,>(value: T) => value;
export const viaIdentity = identity(Schema.Any);
let patternGet;
({ patternGet } = { patternGet: Schema.Any });
export const viaPatternAssign = patternGet;
const original = { success: Schema.String };
const copy = { ...original };
copy.success = Schema.Unknown;
export const viaCopy = original.success;
export const viaCjsDefault = cjsDefault;
const pick = ({ picked } = { picked: Schema.Any }) => picked;
export const viaPatternParam = pick();
export const viaPatternArgument = pick({ picked: Schema.String });
export const viaDynamicImport = async () => (await import('effect')).Schema.Unknown;
const heldOptions = { success: {} };
const heldBy = { heldOptions };
const extracted = heldBy.heldOptions;
extracted.success = Schema.Unknown;
export const viaExtracted = [heldOptions];
const unwrapOptions = { success: {} };
const unwrap = ({ value }: { value: typeof unwrapOptions }) => value;
const unwrapped = unwrap({ value: unwrapOptions });
unwrapped.success = Schema.Unknown;
export const viaUnwrap = [unwrapOptions];
const methodTarget = { success: {} };
const setter = { set(value: typeof methodTarget) { value.success = Schema.Unknown; } };
setter.set(methodTarget);
export const viaMethodArgument = [methodTarget];
const optionalTarget = { success: {} };
const optionalSet: ((value: typeof optionalTarget) => void) | undefined = value => { value.success = Schema.Unknown; };
optionalSet?.(optionalTarget);
export const viaOptionalCall = [optionalTarget];
const inlineTarget = { success: {} };
((value: typeof inlineTarget) => { value.success = Schema.Unknown; })(inlineTarget);
export const viaInlineCall = [inlineTarget];
const aliasTarget = { success: {} };
const mutate = (value: typeof aliasTarget) => { value.success = Schema.Unknown; };
const indirectMutate = mutate;
indirectMutate(aliasTarget);
export const viaCalleeAlias = [aliasTarget];
const spreadTarget = { success: {} };
mutate(...[spreadTarget]);
export const viaSpreadArgument = [spreadTarget];
const literalTarget = { success: {} };
({ set(value: typeof literalTarget) { value.success = Schema.Unknown; } }).set(literalTarget);
export const viaLiteralMethod = [literalTarget];
const select = (factory: unknown, retry: boolean): unknown =>
  retry ? select(Schema.Any, false) : factory;
export const viaRecursion = select(Schema.String, true);
let lazyFactory: unknown;
export const viaLogicalExpression = (lazyFactory ??= Schema.Any);
class Setter { set(value: { success: unknown }) { value.success = Schema.Unknown; } }
const instanceTarget = { success: {} };
const setterInstance = new Setter();
setterInstance.set(instanceTarget);
export const viaInstance = [instanceTarget];
export const viaExplicitDefault = require('./explicit-default.cjs').default;
const heldTarget = { success: {} };
const heldHelper = { mutate };
heldHelper.mutate(heldTarget);
export const viaHeldFunction = [heldTarget];
const assignTarget = { success: Schema.String };
Object.assign(assignTarget, { success: Schema.Unknown });
export const viaObjectAssign = assignTarget.success;
const optionalAssignTarget = { success: Schema.String };
Object?.assign(optionalAssignTarget, { success: Schema.Json });
export const viaOptionalObjectAssign = optionalAssignTarget.success;
const defined = { success: Schema.String };
Object.defineProperty(defined, 'success', { value: Schema.Unknown });
export const viaDefineProperty = defined.success;
const calledTarget = { success: {} };
mutate.call(undefined, calledTarget);
export const viaFunctionCall = [calledTarget];
const returnedByCall = { success: {} };
function getReturned() { return returnedByCall; }
const calledAlias = getReturned.call(null);
calledAlias.success = Schema.Unknown;
export const viaReturnedCall = [returnedByCall];
export const viaCallCallee = identity.call(null, Schema.Any);
export const viaBound = Schema.Any.bind(null);
const boundIdentity = identity.bind(null, Schema.Any);
export const viaBoundArgument = boundIdentity();
const firstOf = <A, B>(first: A, _second: B) => first;
const secondOf = <A, B>(_first: A, second: B) => second;
export const viaTwiceBound = firstOf.bind(null, Schema.String).bind(null)(Schema.Unknown);
export const viaBoundThenCalled = secondOf.bind(null, Schema.String)(Schema.Unknown);
export const viaDetachedExports = require('./detached-exports.cjs').get;
export const viaReattachedExports = require('./reattached-exports.cjs').get;
export const viaReattachedLater = require('./reattached-later.cjs').get;
export const viaReattachedChain = require('./reattached-chain.cjs').get;
export const viaReboundExports = require('./rebound-exports.cjs').get;
const spreadCopyTarget = { success: {} };
const spreadCopySource = { inner: spreadCopyTarget };
const spreadCopy = { ...spreadCopySource };
spreadCopy.inner.success = Schema.Unknown;
export const viaSpreadCopy = [spreadCopyTarget];
const computedSetterKey = 'set';
const computedSetter = { [computedSetterKey](value: { success: unknown }) { value.success = Schema.Unknown; } };
const computedSetterTarget = { success: {} };
computedSetter.set(computedSetterTarget);
export const viaComputedMethod = [computedSetterTarget];
const capture = <T,>(value: T) => () => value;
const overridden = { ...{ picked: Schema.Any }, picked: Schema.String };
export const viaOverriddenSpread = overridden.picked;
const spreadOverride = { picked: Schema.Any, ...{ picked: Schema.String } };
export const viaSpreadOverride = spreadOverride.picked;
const reflected = <T,>(value: T) => value;
export const viaReflectApply = Reflect.apply(reflected, null, [Schema.Json]);
const spreadKey = 'picked';
const computedSpreadOverride = { picked: Schema.Any, ...{ [spreadKey]: Schema.String } };
export const viaComputedSpreadOverride = computedSpreadOverride.picked;
class StaticHolder {
  static picked = Schema.Any;
  static pick() { return Schema.Unknown; }
}
export const viaStaticField = StaticHolder.picked;
const StaticExpression = class { static picked = Schema.Json; };
class Redefined { static picked = Schema.Any; static picked = Schema.String; }
class StaticAccessor { static accessor picked = Schema.Unknown; }
export const viaStaticAccessor = StaticAccessor.picked;
export const viaRedefinedStatic = Redefined.picked;
const restFirst = (...items: unknown[]) => items[1];
export const viaRestParameter = restFirst(Schema.String, Schema.Unknown);
const methodKey = 'picked';
export const viaConstantPropertyKey = { [methodKey]: Schema.Json }.picked;
export const viaStaticExpression = StaticExpression.picked;
export const viaStaticMethod = StaticHolder.pick();
const heldInContainer = { success: Schema.String };
const extractedHolder = [heldInContainer];
const extractedAlias = extractedHolder.at(0);
extractedAlias.success = Schema.Unknown;
export const viaContainerMethod = heldInContainer.success;
const { String: _string, ...restSchema } = Schema;
export const viaObjectRest = [restSchema.Any, restSchema.String];
const constantKey = 'Unknown';
export const viaConstantKey = Schema[constantKey];
export const viaConcatenatedKey = Schema['A' + \`ny\`];
export const viaClosure = capture(Schema.Any)();
const namedCall = { call: Schema.Any };
export const viaNamedCall = namedCall.call;
const spreadMethods = { set(value: { success: unknown }) { value.success = Schema.Unknown; } };
const spreadHelper = { ...spreadMethods };
const spreadMethodTarget = { success: {} };
spreadHelper.set(spreadMethodTarget);
export const viaSpreadMethod = [spreadMethodTarget];
const chainedTarget = { success: {} };
let chainedTemporary;
const chainedAlias = (chainedTemporary = chainedTarget);
chainedAlias.success = Schema.Unknown;
export const viaChainedAssignment = [chainedTarget];
export const viaApply = identity.apply(null, [Schema.Any]);`,
  );
  const shapesModule = graph.module(shapes);
  const shape = (name: string) => {
    const declared = graph.resolve(shapesModule, name, 'export');
    if (declared?.kind !== 'declaration') throw new Error(name);
    return declared.expression;
  };
  expect(externals(graph.reachable(shapesModule, shape('whole')))).toEqual([
    'effect:Schema.Unknown',
  ]);
  // A `const` computed key names exactly one member.
  expect(externals(graph.evaluate(shapesModule, shape('computed')))).toEqual([
    'effect:Schema.String',
  ]);
  expect(externals(graph.evaluate(shapesModule, shape('none')))).toEqual([
    'unresolved',
  ]);
  expect(externals(graph.reachable(shapesModule, shape('viaAlias')))).toEqual([
    'effect:Schema.Unknown',
  ]);
  expect(externals(graph.evaluate(shapesModule, shape('fallthrough')))).toEqual(
    ['unresolved', 'effect:Schema.String'],
  );
  expect(
    externals(graph.reachable(shapesModule, shape('dynamicWhole'))),
  ).toEqual(['effect:Schema.Any']);
  expect(externals(graph.evaluate(shapesModule, shape('dynamicRead')))).toEqual(
    ['unresolved', 'unresolved', 'effect:Schema.Any'],
  );
  expect(
    new Set(externals(graph.reachable(shapesModule, shape('opaqueRead')))),
  ).toEqual(new Set(['unresolved', 'effect:Schema.String']));
  expect(
    externals(graph.reachable(shapesModule, shape('viaDestructured'))),
  ).toEqual(['effect:Schema.Unknown']);
  expect(externals(graph.reachable(shapesModule, shape('viaMember')))).toEqual([
    'effect:Schema.Unknown',
  ]);
  expect(externals(graph.evaluate(shapesModule, shape('viaPattern')))).toEqual([
    'effect:Schema.String',
    'effect:Schema.Unknown',
  ]);
  expect(externals(graph.reachable(shapesModule, shape('viaSecond')))).toEqual([
    'effect:Schema.Unknown',
  ]);
  // A self-referential alias is cut off by the alias budget, never a hang.
  expect(
    new Set(externals(graph.reachable(shapesModule, shape('walked')))),
  ).toEqual(new Set(['unresolved']));
  expect(externals(graph.evaluate(shapesModule, shape('numeric')))).toEqual([
    'effect:Schema.String',
  ]);
  expect(
    externals(graph.reachable(shapesModule, shape('viaConditional'))),
  ).toEqual(['effect:Schema.Unknown', 'effect:Schema.String']);
  expect(externals(graph.evaluate(shapesModule, shape('defaulted')))).toContain(
    'effect:Schema.Any',
  );
  expect(
    externals(graph.reachable(shapesModule, shape('viaKeyedAlias'))),
  ).toContain('unresolved');
  expect(
    externals(graph.reachable(shapesModule, shape('decorated'))),
  ).toContain('effect:Schema.Unknown');
  for (const name of ['viaLogical', 'viaDefault'])
    expect(externals(graph.reachable(shapesModule, shape(name)))).toContain(
      'effect:Schema.Unknown',
    );
  expect(externals(graph.reachable(shapesModule, shape('viaHops')))).toContain(
    'unresolved',
  );
  expect(externals(graph.reachable(shapesModule, shape('viaReturn')))).toEqual([
    'effect:Schema.Unknown',
  ]);
  expect(
    graph.resolve(shapesModule, 'returnedConfig', 'local'),
  ).toBeUndefined();
  expect(
    externals(graph.evaluate(shapesModule, shape('viaLogicalInit'))),
  ).toEqual(['effect:Schema.Any']);
  expect(externals(graph.evaluate(shapesModule, shape('viaIdentity')))).toEqual(
    ['effect:Schema.Any'],
  );
  expect(
    externals(graph.evaluate(shapesModule, shape('viaPatternAssign'))),
  ).toEqual(['effect:Schema.Any']);
  expect(
    externals(graph.evaluate(shapesModule, shape('viaCjsDefault'))),
  ).toEqual(['effect:Schema.Record']);
  expect(
    externals(graph.evaluate(shapesModule, shape('viaPatternParam'))),
  ).toEqual(['effect:Schema.Any']);
  expect(
    externals(graph.evaluate(shapesModule, shape('viaPatternArgument'))),
  ).toEqual(['effect:Schema.String', 'effect:Schema.Any']);
  const dynamicImport = shape('viaDynamicImport') as t.ArrowFunctionExpression;
  expect(externals(graph.evaluate(shapesModule, dynamicImport.body))).toEqual([
    'effect:Schema.Unknown',
  ]);
  for (const name of [
    'viaExtracted',
    'viaUnwrap',
    'viaMethodArgument',
    'viaOptionalCall',
    'viaInlineCall',
    'viaCalleeAlias',
    'viaLiteralMethod',
    'viaHeldFunction',
    'viaFunctionCall',
    'viaReturnedCall',
    'viaSpreadMethod',
    'viaChainedAssignment',
  ])
    expect(externals(graph.reachable(shapesModule, shape(name)))).toEqual([
      'effect:Schema.Unknown',
    ]);
  // A spread copy is a new object: replacing its slot leaves the original.
  expect(externals(graph.evaluate(shapesModule, shape('viaCopy')))).toEqual([
    'effect:Schema.String',
  ]);
  expect(
    externals(graph.reachable(shapesModule, shape('viaSpreadArgument'))),
  ).toContain('unresolved');
  expect(
    new Set(
      externals(graph.evaluate(shapesModule, shape('viaLogicalExpression'))),
    ),
  ).toEqual(new Set(['effect:Schema.Any']));
  expect(
    externals(graph.reachable(shapesModule, shape('viaInstance'))),
  ).toContain('unresolved');
  expect(
    externals(graph.evaluate(shapesModule, shape('viaExplicitDefault'))),
  ).toEqual(['effect:Schema.Json']);
  expect(
    externals(graph.evaluate(shapesModule, shape('viaObjectAssign'))),
  ).toEqual(['effect:Schema.String', 'effect:Schema.Unknown']);
  expect(
    externals(graph.evaluate(shapesModule, shape('viaOptionalObjectAssign'))),
  ).toEqual(['effect:Schema.String', 'effect:Schema.Json']);
  expect(
    new Set(
      externals(graph.evaluate(shapesModule, shape('viaDefineProperty'))),
    ),
  ).toEqual(new Set(['effect:Schema.String', 'unresolved']));
  // `call`/`bind` evaluate as the function they invoke.
  expect(
    externals(graph.evaluate(shapesModule, shape('viaCallCallee'))),
  ).toEqual(['effect:Schema.Any']);
  expect(externals(graph.evaluate(shapesModule, shape('viaBound')))).toEqual([
    'effect:Schema.Any',
  ]);
  // Arguments captured by `bind` reach later calls, before their own.
  expect(
    externals(graph.evaluate(shapesModule, shape('viaBoundArgument'))),
  ).toEqual(['effect:Schema.Any']);
  expect(
    externals(graph.evaluate(shapesModule, shape('viaTwiceBound'))),
  ).toEqual(['effect:Schema.String']);
  expect(
    externals(graph.evaluate(shapesModule, shape('viaBoundThenCalled'))),
  ).toEqual(['effect:Schema.Unknown']);
  expect(
    externals(graph.evaluate(shapesModule, shape('viaDetachedExports'))),
  ).toEqual(['effect:Schema.String']);
  // `exports = module.exports` reattaches `exports` after a replacement.
  expect(
    externals(graph.evaluate(shapesModule, shape('viaReattachedLater'))),
  ).toContain('effect:Schema.Any');
  // An object rest reads its source, except the keys the pattern names.
  expect(
    new Set(externals(graph.reachable(shapesModule, shape('viaObjectRest')))),
  ).toEqual(new Set(['effect:Schema.Any', 'unresolved']));
  // Constant computed keys read the member they spell.
  expect(
    externals(graph.evaluate(shapesModule, shape('viaConstantKey'))),
  ).toEqual(['effect:Schema.Unknown']);
  expect(
    externals(graph.evaluate(shapesModule, shape('viaConcatenatedKey'))),
  ).toEqual(['effect:Schema.Any']);
  // A later property overrides the same key from an earlier spread.
  expect(
    externals(graph.evaluate(shapesModule, shape('viaOverriddenSpread'))),
  ).toEqual(['effect:Schema.String']);
  expect(
    externals(graph.evaluate(shapesModule, shape('viaSpreadOverride'))),
  ).toEqual(['effect:Schema.String']);
  expect(
    externals(graph.evaluate(shapesModule, shape('viaComputedSpreadOverride'))),
  ).toEqual(['effect:Schema.String']);
  // `Reflect.apply` runs the function with its literal argument list.
  expect(
    externals(graph.evaluate(shapesModule, shape('viaReflectApply'))),
  ).toContain('effect:Schema.Json');
  // Static class members are read from the class body.
  expect(
    externals(graph.evaluate(shapesModule, shape('viaStaticField'))),
  ).toEqual(['effect:Schema.Any']);
  expect(
    externals(graph.evaluate(shapesModule, shape('viaStaticMethod'))),
  ).toEqual(['effect:Schema.Unknown']);
  expect(
    externals(graph.evaluate(shapesModule, shape('viaStaticExpression'))),
  ).toEqual(['effect:Schema.Json']);
  expect(
    externals(graph.evaluate(shapesModule, shape('viaRedefinedStatic'))),
  ).toEqual(['effect:Schema.String']);
  expect(
    externals(graph.evaluate(shapesModule, shape('viaStaticAccessor'))),
  ).toEqual(['effect:Schema.Unknown']);
  // A rest parameter is the array of the remaining arguments.
  expect(
    externals(graph.evaluate(shapesModule, shape('viaRestParameter'))),
  ).toEqual(['effect:Schema.Unknown']);
  expect(
    externals(graph.evaluate(shapesModule, shape('viaConstantPropertyKey'))),
  ).toEqual(['effect:Schema.Json']);
  // A value extracted through a container method may be written through.
  expect(
    new Set(
      externals(graph.evaluate(shapesModule, shape('viaContainerMethod'))),
    ),
  ).toEqual(new Set(['effect:Schema.String', 'unresolved']));
  expect(
    externals(graph.evaluate(shapesModule, shape('viaReattachedChain'))),
  ).toContain('effect:Schema.Any');
  // A spread copy holds a nested value at the depth its source held it.
  expect(
    externals(graph.reachable(shapesModule, shape('viaSpreadCopy'))),
  ).not.toEqual([]);
  // Rebinding `exports` detaches it; the module still exports the first write.
  expect(
    externals(graph.evaluate(shapesModule, shape('viaReboundExports'))),
  ).toEqual(['effect:Schema.String']);
  // A method with a constant computed key runs like a named one.
  expect(
    externals(graph.reachable(shapesModule, shape('viaComputedMethod'))),
  ).toContain('effect:Schema.Unknown');
  // A returned closure keeps the parameters of the call that created it.
  expect(
    externals(graph.evaluate(shapesModule, shape('viaClosure'))),
  ).toContain('effect:Schema.Any');
  // Node picks the export pattern with the longest prefix, not the last one.
  const patterned = path.join(root, 'packages/patterned');
  write(
    path.join(patterned, 'package.json'),
    JSON.stringify({
      name: '@domain/patterned',
      exports: { './foo/*': './src/safe.ts', './*/bar': './src/unsafe.ts' },
    }),
  );
  write(
    path.join(patterned, 'src/safe.ts'),
    `import { Schema } from 'effect';\nexport const picked = Schema.String;`,
  );
  write(
    path.join(patterned, 'src/unsafe.ts'),
    `import { Schema } from 'effect';\nexport const picked = Schema.Any;`,
  );
  fs.symlinkSync(patterned, path.join(root, 'node_modules/@domain/patterned'));
  const patternConsumer = path.join(
    root,
    'verticals/catalog/src/contracts/pattern-consumer.ts',
  );
  write(patternConsumer, `export { picked } from '@domain/patterned/foo/bar';`);
  const patternModule = graph.module(patternConsumer);
  const picked = graph.resolve(patternModule, 'picked', 'export');
  if (picked?.kind !== 'declaration') throw new Error('picked');
  expect(externals(graph.evaluate(picked.module, picked.expression))).toEqual([
    'effect:Schema.String',
  ]);
  // `this` writes outside a constructor and container callbacks may mutate
  // a value in ways the graph does not follow.
  for (const [name, source] of [
    [
      'this-write.ts',
      `import { Schema } from 'effect';
const target = { success: Schema.String };
function mutate(this: { success: unknown }) { this.success = Schema.Unknown; }
mutate.call(target);
export const read = target.success;`,
    ],
    [
      'for-of-write.ts',
      `import { Schema } from 'effect';
const target = { success: Schema.String };
for (const value of [target]) value.success = Schema.Unknown;
export const read = target.success;`,
    ],
    [
      'reverse-write.ts',
      `import { Schema } from 'effect';
const target = { success: Schema.String };
const holder = [target];
const alias = holder.reverse()[0];
alias.success = Schema.Unknown;
export const read = target.success;`,
    ],
    [
      'tagged-template-write.ts',
      `import { Schema } from 'effect';
const target = { success: Schema.String };
function mutate(_strings: TemplateStringsArray, value: { success: unknown }) { value.success = Schema.Unknown; }
mutate\`\${target}\`;
export const read = target.success;`,
    ],
    [
      'setter-write.ts',
      `import { Schema } from 'effect';
const target = { success: Schema.String };
const helper = { set value(next: { success: unknown }) { next.success = Schema.Unknown; } };
helper.value = target;
export const read = target.success;`,
    ],
    [
      'global-pipeline-write.ts',
      `import { Schema } from 'effect';
const target = { success: Schema.String };
await Promise.resolve(target).then(value => { value.success = Schema.Unknown; });
export const read = target.success;`,
    ],
    [
      'object-assign-source-write.ts',
      `import { Schema } from 'effect';
const target = { success: Schema.String };
const holder: { value?: { success: unknown } } = {};
Object.assign(holder, { value: target });
holder.value!.success = Schema.Unknown;
export const read = target.success;`,
    ],
    [
      'reflect-set-write.ts',
      `import { Schema } from 'effect';
const target = { success: Schema.String };
const holder: { value?: { success: unknown } } = {};
Reflect.set(holder, 'value', target);
holder.value!.success = Schema.Unknown;
export const read = target.success;`,
    ],
    [
      'static-field-write.ts',
      `import { Schema } from 'effect';
const target = { success: Schema.String };
class Holder { static value = target; }
Holder.value.success = Schema.Unknown;
export const read = target.success;`,
    ],
    [
      'static-field-expression-write.ts',
      `import { Schema } from 'effect';
const target = { success: Schema.String };
const Holder = class { static value = target; };
Holder.value.success = Schema.Unknown;
export const read = target.success;`,
    ],
    [
      'instance-field-write.ts',
      `import { Schema } from 'effect';
const target = { success: Schema.String };
class Holder { value = target; }
new Holder().value.success = Schema.Unknown;
export const read = target.success;`,
    ],
    [
      'jsx-prop-write.tsx',
      `import { Schema } from 'effect';
const target = { success: Schema.String };
const Mutator = ({ value }: { value: { success: unknown } }) => { value.success = Schema.Unknown; return null; };
export const element = <Mutator value={target} />;
export const read = target.success;`,
    ],
    [
      'yield-write.ts',
      `import { Schema } from 'effect';
const target = { success: Schema.String };
function* values() { yield target; }
const [alias] = values();
alias!.success = Schema.Unknown;
export const read = target.success;`,
    ],
    [
      'constructor-receiver-write.ts',
      `import { Schema } from 'effect';
const target = { success: Schema.String };
class Mutator {
  value: { success: unknown };
  constructor(value: { success: unknown }) { this.value = value; this.value.success = Schema.Unknown; }
}
new Mutator(target);
export const read = target.success;`,
    ],
    [
      'callback-write.ts',
      `import { Schema } from 'effect';
const target = { success: Schema.String };
[target].forEach(value => { value.success = Schema.Unknown; });
export const read = target.success;`,
    ],
  ] as const) {
    const file = path.join(root, 'verticals/catalog/src/contracts', name);
    write(file, source);
    const opaque = graph.module(file);
    const read = (opaque.file.program.body.at(-1) as t.ExportNamedDeclaration)
      .declaration as t.VariableDeclaration;
    expect(
      new Set(externals(graph.evaluate(opaque, read.declarations[0].init!))),
      name,
    ).toContain('unresolved');
  }
  // A built-in method returning its receiver hands back the value itself.
  const valueOfWrite = path.join(
    root,
    'verticals/catalog/src/contracts/value-of-write.ts',
  );
  write(
    valueOfWrite,
    `import { Schema } from 'effect';
const target = { success: Schema.String };
const alias = target.valueOf();
alias.success = Schema.Unknown;
export const read = target.success;`,
  );
  const valueOfModule = graph.module(valueOfWrite);
  const valueOfRead = (
    valueOfModule.file.program.body.at(-1) as t.ExportNamedDeclaration
  ).declaration as t.VariableDeclaration;
  expect(
    new Set(
      externals(
        graph.evaluate(valueOfModule, valueOfRead.declarations[0].init!),
      ),
    ),
  ).toEqual(new Set(['effect:Schema.String', 'effect:Schema.Unknown']));
  // Static members of an anonymous default class are read through imports.
  const defaultClass = path.join(
    root,
    'verticals/catalog/src/contracts/default-class.ts',
  );
  write(
    defaultClass,
    `import { Schema } from 'effect';\nexport default class { static picked = Schema.Unknown; }`,
  );
  const defaultClassConsumer = path.join(
    root,
    'verticals/catalog/src/contracts/default-class-consumer.ts',
  );
  write(
    defaultClassConsumer,
    `import Picked from './default-class';\nexport const picked = Picked.picked;`,
  );
  const defaultClassModule = graph.module(defaultClassConsumer);
  const pickedFromClass = graph.resolve(defaultClassModule, 'picked', 'export');
  if (pickedFromClass?.kind !== 'declaration') throw new Error('picked');
  expect(
    externals(graph.evaluate(defaultClassModule, pickedFromClass.expression)),
  ).toEqual(['effect:Schema.Unknown']);
  // A write through a computed receiver may reach any escaped object.
  const returnedReceiver = path.join(
    root,
    'verticals/catalog/src/contracts/returned-receiver.ts',
  );
  write(
    returnedReceiver,
    `import { Schema } from 'effect';
const target = { success: Schema.String };
const getTarget = () => target;
getTarget().success = Schema.Unknown;
export const read = target.success;`,
  );
  const receiverModule = graph.module(returnedReceiver);
  // The module is mutated through an unknown receiver, so nothing resolves.
  expect(graph.resolve(receiverModule, 'read', 'export')).toBeUndefined();
  const receiverRead = (
    receiverModule.file.program.body.at(-1) as t.ExportNamedDeclaration
  ).declaration as t.VariableDeclaration;
  expect(
    new Set(
      externals(
        graph.evaluate(receiverModule, receiverRead.declarations[0].init!),
      ),
    ),
  ).toEqual(new Set(['effect:Schema.String', 'unresolved']));
  // `module.exports = exports = {}` keeps later `exports` writes live.
  expect(
    externals(graph.evaluate(shapesModule, shape('viaReattachedExports'))),
  ).toContain('effect:Schema.Any');
  expect(
    externals(graph.evaluate(shapesModule, shape('viaNamedCall'))),
  ).toEqual(['effect:Schema.Any']);
  expect(externals(graph.evaluate(shapesModule, shape('viaApply')))).toEqual([
    'effect:Schema.Any',
  ]);
  // Each recursive call binds its own arguments.
  expect(
    new Set(externals(graph.evaluate(shapesModule, shape('viaRecursion')))),
  ).toEqual(
    new Set(['unresolved', 'effect:Schema.Any', 'effect:Schema.String']),
  );
  // A holder written below the stored value is opaque.
  expect(
    externals(graph.reachable(shapesModule, shape('viaStorage'))),
  ).toContain('unresolved');
  // Calls through a `const` alias of the function are followed.
  expect(
    externals(graph.reachable(shapesModule, shape('viaIndirect'))),
  ).toEqual(['effect:Schema.Unknown']);
  for (const name of ['viaIife', 'viaMethod'])
    expect(externals(graph.reachable(shapesModule, shape(name)))).toEqual([
      'effect:Schema.Unknown',
    ]);
  const shadowedFn = shapesModule.file.program.body.find(
    statement =>
      t.isFunctionDeclaration(statement) && statement.id?.name === 'shadowed',
  ) as t.FunctionDeclaration;
  const shadowedReturn = shadowedFn.body.body[0] as t.ReturnStatement;
  expect(
    externals(graph.evaluate(shapesModule, shadowedReturn.argument!)),
  ).toEqual(['unresolved']);
  expect(
    externals(graph.evaluate(shapesModule, shape('instantiated'))),
  ).toEqual(['effect:Schema.Any']);
  expect(externals(graph.evaluate(shapesModule, shape('viaLoop')))).toEqual([
    'effect:Schema.String',
    'unresolved',
  ]);
  const awaitedFn = shape('awaited') as t.ArrowFunctionExpression;
  expect(externals(graph.evaluate(shapesModule, awaitedFn.body))).toEqual([
    'effect:Schema.Any',
  ]);
  expect(externals(graph.evaluate(shapesModule, shape('fromArray')))).toEqual([
    'effect:Schema.Any',
  ]);
  expect(externals(graph.evaluate(shapesModule, shape('fromRest')))).toEqual([
    'unresolved',
  ]);
  expect(
    externals(graph.reachable(shapesModule, shape('viaNamespace'))),
  ).toEqual(['unresolved', 'effect:Schema.Unknown']);
  expect(externals(graph.evaluate(shapesModule, shape('assigned')))).toEqual([
    'effect:Schema.Any',
  ]);
  expect(externals(graph.evaluate(shapesModule, shape('getter')))).toEqual([
    'effect:Schema.Any',
  ]);
  expect(externals(graph.reachable(shapesModule, shape('viaDotted')))).toEqual([
    'effect:Schema.Unknown',
  ]);
  // Writes through any alias make the original a mutated, unresolved const.
  for (const name of ['config', 'nested', 'aliased', 'chosen', 'keyedConfig'])
    expect(graph.resolve(shapesModule, name, 'local')).toBeUndefined();
  expect(externals(graph.reachable(shapesModule, shape('keyed')))).toContain(
    'effect:Schema.Unknown',
  );
  expect(externals(graph.reachable(shapesModule, shape('js')))).toEqual([
    'effect:Schema.Any',
    'effect:Schema.Unknown',
  ]);

  // Unparseable sources are consumer violations for source rules.
  write(endpoints, 'export const broken = ;');
  expect(
    checkMicroVerticalApiConsumerFiles({
      workspaceRoot: root,
      baselinePackageDirectory: owner,
      sourceRules: [unconstrainedSchemas],
    }).diagnostics,
  ).toContainEqual(
    expect.stringMatching(
      /^verticals\/catalog\/src\/contracts\/endpoints\.ts: source rules need parseable source/u,
    ),
  );
});

test('rejects private cross-owner paths and export cycles', () => {
  write(
    path.join(root, 'verticals/foreign/shared/api.ts'),
    subApi('catalogSearchApi', 'catalogSearch', '/catalog/search'),
  );
  write(
    path.join(root, 'verticals/catalog/shared/commands/index.ts'),
    subApi('catalogCommandsApi', 'catalogCommands', '/catalog/commands'),
  );
  expect(
    validate(
      composed.replace(
        "'./apis/catalog-search.ts'",
        "'../../foreign/shared/api.ts'",
      ),
    ),
  ).toContain('bounded native endpoint declarations');
  write(
    path.join(root, 'verticals/catalog/shared/apis/catalog-search.ts'),
    "export { catalogSearchApi } from './cycle.ts';",
  );
  write(
    path.join(root, 'verticals/catalog/shared/apis/cycle.ts'),
    "export { catalogSearchApi } from './catalog-search.ts';",
  );
  expect(validate(composed)).toContain('bounded native endpoint declarations');
});

test('still rejects an unbounded endpoint reached through an import', () => {
  write(
    path.join(root, 'verticals/catalog/shared/apis/catalog-search.ts'),
    // A computed route path is not a bounded endpoint identity, and importing
    // the declaration must not launder that.
    `const searchRoute = ['/catalog', 'search'].join('/');\n${subApi(
      'catalogSearchApi',
      'catalogSearch',
      '/catalog/search',
      'searchRoute',
    )}`,
  );
  write(
    path.join(root, 'verticals/catalog/shared/commands/catalog-commands.ts'),
    subApi('catalogCommandsApi', 'catalogCommands', '/catalog/commands'),
  );
  write(
    path.join(root, 'verticals/catalog/shared/commands/index.ts'),
    `export { catalogCommandsApi } from './catalog-commands.ts';`,
  );
  expect(validate(composed)).toContain('bounded native endpoint declarations');
});

test('resolves immutable top-level const route paths in the endpoint module only', () => {
  const searchModule = path.join(
    root,
    'verticals/catalog/shared/apis/catalog-search.ts',
  );
  const searchApi = (declaration: string) =>
    `${declaration}\n${subApi('catalogSearchApi', 'catalogSearch', '/catalog/search', 'CATALOG_SEARCH_PATH')}`;
  write(
    path.join(root, 'verticals/catalog/shared/commands/index.ts'),
    subApi('catalogCommandsApi', 'catalogCommands', '/catalog/commands'),
  );
  // `searchPath` only matches the route the alias actually names.
  const withSearchPath = composed.replace(
    `readinessPath: '/catalog-api/catalog/readiness' } as const;`,
    `readinessPath: '/catalog-api/catalog/readiness', searchPath: '/catalog-api/catalog/search' } as const;`,
  );
  const check = (declaration: string, source = withSearchPath) => {
    write(searchModule, searchApi(declaration));
    return validate(source);
  };
  for (const valid of [
    "const CATALOG_SEARCH_PATH = '/catalog/search';",
    "export const CATALOG_SEARCH_PATH = '/catalog/search' as const;",
    "const SEARCH = '/catalog/search';\nconst CATALOG_SEARCH_PATH = SEARCH;",
  ])
    expect(check(valid), valid).toBeUndefined();
  expect(check("const CATALOG_SEARCH_PATH = '/catalog/other';")).toBeDefined();
  for (const invalid of [
    '',
    "let CATALOG_SEARCH_PATH = '/catalog/search';",
    'const CATALOG_SEARCH_PATH = catalogSearchPath();',
    'const CATALOG_SEARCH_PATH = `/catalog/search`;',
    'const CATALOG_SEARCH_PATH = catalogRoutes.search;',
    'const CATALOG_SEARCH_PATH = SEARCH;\nconst SEARCH = CATALOG_SEARCH_PATH;',
    // Another module's constant is not the endpoint module's own declaration.
    "import { CATALOG_SEARCH_PATH } from '../routes.ts';",
  ]) {
    write(
      path.join(root, 'verticals/catalog/shared/routes.ts'),
      "export const CATALOG_SEARCH_PATH = '/catalog/search';",
    );
    expect(check(invalid), invalid).toContain(
      'bounded native endpoint declarations',
    );
  }
});

test('rejects runtime Schema.Unknown-family access but not type-only references', () => {
  const schemaMessage = 'must use concrete request, response and error schemas';
  const modules = 'verticals/catalog/api/modules';
  const violations = () =>
    checkMicroVerticalApiBoundaries({ workspaceRoot: root })
      .diagnostics.filter(diagnostic => diagnostic.includes(schemaMessage))
      .sort();
  write(
    path.join(root, modules, 'type-only.ts'),
    `import { Schema } from 'effect';
type Unparsed = typeof Schema.Unknown.Type;
type Loose = typeof Schema.Any;
export const keep = (value: Unparsed, loose: Loose) => [value, loose];
// Schema.Unknown in a comment, and 'Schema.Any' in a string, are not access.
export const label = 'Schema.Any';`,
  );
  expect(violations()).toEqual([]);
  const runtime: Record<string, string> = {
    'any.ts': 'export const schema = Schema.Any;',
    'computed.ts': "export const schema = Schema['Unknown'];",
    'template.ts': 'export const schema = Schema[`Any`];',
    'json.ts': 'export const schema = Schema.UnknownFromJsonString;',
    'optional.ts': 'export const schema = Schema?.Unknown;',
    'typeof-value.ts': 'export const kind = typeof Schema.Unknown;',
    'unknown.ts':
      "import { Schema } from 'effect';\nexport const schema = Schema.Unknown.pipe(Schema.brand('x'));",
    'jsx.tsx': 'export const view = <Schema.Unknown />;',
    'import-equals.ts':
      "import { Schema } from 'effect';\nimport Loose = Schema.Any;\nexport const schema = Loose;",
  };
  for (const [name, source] of Object.entries(runtime))
    write(path.join(root, modules, name), source);
  expect(violations()).toEqual(
    Object.keys(runtime)
      .map(name => `${modules}/${name}: ${schemaMessage}`)
      .sort(),
  );
});

test('accepts Effect combinators that add no endpoints, and applies prefix', () => {
  write(
    path.join(root, 'verticals/catalog/shared/apis/catalog-search.ts'),
    prefixedSearchApi(),
  );
  write(
    path.join(root, 'verticals/catalog/shared/commands/catalog-commands.ts'),
    subApi('catalogCommandsApi', 'catalogCommands', '/catalog/commands'),
  );
  write(
    path.join(root, 'verticals/catalog/shared/commands/index.ts'),
    `export { catalogCommandsApi } from './catalog-commands.ts';`,
  );
  // `searchPath` only matches a route the traversal actually prefixed, so this
  // fails if `.prefix` were merely tolerated and not applied.
  expect(
    validate(
      composed.replace(
        `readinessPath: '/catalog-api/catalog/readiness' } as const;`,
        `readinessPath: '/catalog-api/catalog/readiness', searchPath: '/catalog-api/search/catalog/search' } as const;`,
      ),
    ),
  ).toBeUndefined();
});

test('accepts a root API annotated with parse options', () => {
  const rootApi = `export const catalogApi = HttpApi.make('CatalogApi').addHttpApi(catalogFoundationApi);`;
  expect(
    validate(
      contract.replace(
        rootApi,
        `export const catalogApi = HttpApi.make('CatalogApi').addHttpApi(catalogFoundationApi).annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' });`,
      ),
    ),
  ).toBeUndefined();
  expect(
    validate(
      contract.replace(
        rootApi,
        `export const catalogApi = HttpApi.make('CatalogApi').annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' }).addHttpApi(catalogFoundationApi);`,
      ),
    ),
  ).toContain('explicitly compose its readiness foundation API');
  expect(
    validate(
      contract.replace(
        rootApi,
        `export const catalogApi = HttpApi.make('CatalogApi').addHttpApi(catalogFoundationApi).annotate(HttpApi.ParseOptions);`,
      ),
    ),
  ).toContain('explicitly compose its readiness foundation API');
});

test('follows a flat variadic add whose spread names generated groups', () => {
  // The generator rewrites a groups module whole; the root composes the
  // foundation group and spreads that list in one `add`.
  const generated = path.join(
    root,
    'verticals/catalog/shared/generated/groups.ts',
  );
  write(
    path.join(root, 'verticals/catalog/shared/groups/search.ts'),
    `import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
export const searchGroup = HttpApiGroup.make('search').add(HttpApiEndpoint.post('reindex', '/catalog/search/reindex', { success: Schema.String }));`,
  );
  write(
    path.join(root, 'verticals/catalog/shared/groups/commands.ts'),
    `import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
export const commandsGroup = HttpApiGroup.make('commands').add(HttpApiEndpoint.post('archive', '/catalog/commands/archive', { success: Schema.String }), HttpApiEndpoint.post('restore', '/catalog/commands/restore', { success: Schema.String }));`,
  );
  write(
    generated,
    `import { commandsGroup } from '../groups/commands.ts';
import { searchGroup } from '../groups/search.ts';
export const generatedGroups = [commandsGroup, searchGroup] as const;`,
  );
  const flat = contract
    .replace(
      `export const catalogFoundationApi = HttpApi.make('CatalogFoundationApi').add(HttpApiGroup.make('foundation').add(`,
      `import { generatedGroups } from './generated/groups.ts';
export const catalogFoundationGroup = HttpApiGroup.make('foundation').add(`,
    )
    .replace(
      `{ success: catalogReadinessSchema })));`,
      `{ success: catalogReadinessSchema }));
export const catalogFoundationApi = HttpApi.make('CatalogFoundationApi').add(catalogFoundationGroup);`,
    )
    .replace(
      `HttpApi.make('CatalogApi').addHttpApi(catalogFoundationApi);`,
      `HttpApi.make('CatalogApi').add(catalogFoundationGroup, ...generatedGroups).annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' });`,
    )
    .replace(
      'readiness: createMicroVerticalOperationContext',
      "reindex: createMicroVerticalOperationContext({method: 'POST', operationId: 'CatalogApi:search:reindex', routePath: '/catalog/search/reindex'}), restore: createMicroVerticalOperationContext({method: 'POST', operationId: 'CatalogApi:commands:restore', routePath: '/catalog/commands/restore'}), readiness: createMicroVerticalOperationContext",
    );
  expect(validate(flat)).toBeUndefined();

  // Every group behind the spread is traversed, not only the first.
  write(
    generated,
    `import { commandsGroup } from '../groups/commands.ts';
export const generatedGroups = [commandsGroup] as const;`,
  );
  expect(validate(flat)).toContain('operation map');

  // A spread that is not a resolvable array literal fails closed.
  for (const groups of [
    `export const generatedGroups = makeGroups();`,
    `import { missingGroup } from '../groups/missing.ts';
export const generatedGroups = [missingGroup];`,
    `export const generatedGroups = [, ];`,
  ]) {
    write(generated, groups);
    expect(validate(flat)).toContain('bounded native endpoint declarations');
  }

  // The flat root must still lead with the foundation group itself.
  write(generated, `export const generatedGroups = [];`);
  const decoy = flat.replace(
    'export const catalogApi =',
    `const decoyGroup = HttpApiGroup.make('foundation').add(HttpApiEndpoint.get('readiness', '/catalog/readiness', { success: catalogReadinessSchema }));
export const catalogApi =`,
  );
  expect(
    validate(
      decoy.replace(
        '.add(catalogFoundationGroup, ...generatedGroups)',
        '.add(decoyGroup, ...generatedGroups)',
      ),
    ),
  ).toContain('explicitly compose its readiness foundation API');
  expect(
    validate(
      flat.replace(
        '.add(catalogFoundationGroup, ...generatedGroups)',
        '.add(...generatedGroups, catalogFoundationGroup)',
      ),
    ),
  ).toContain('explicitly compose its readiness foundation API');
});

test('still rejects a chain combinator Effect does not define', () => {
  write(
    path.join(root, 'verticals/catalog/shared/apis/catalog-search.ts'),
    prefixedSearchApi().replace(
      `.annotate(CatalogAnnotation, 'value')`,
      '.decorate(CatalogAnnotation)',
    ),
  );
  write(
    path.join(root, 'verticals/catalog/shared/commands/catalog-commands.ts'),
    subApi('catalogCommandsApi', 'catalogCommands', '/catalog/commands'),
  );
  write(
    path.join(root, 'verticals/catalog/shared/commands/index.ts'),
    `export { catalogCommandsApi } from './catalog-commands.ts';`,
  );
  expect(validate(composed)).toContain('bounded native endpoint declarations');
});

test('resolves a generated client that composes per-operation modules', () => {
  const clientFile = path.join(
    root,
    'verticals/catalog/src/api/catalog-client.ts',
  );
  write(
    path.join(root, 'verticals/catalog/src/api/catalog-search-client.ts'),
    `import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client'; import { catalogApi } from '../../shared/api.ts'; export const searchClient = makeEffectHttpApiClient(catalogApi);`,
  );
  // The aggregate module re-exports the operation clients instead of calling
  // the factory itself; the governed surface is still fully present.
  write(
    clientFile,
    `export { searchClient } from './catalog-search-client.ts';`,
  );
  expect(
    checkMicroVerticalApiConsumerFiles({ workspaceRoot: root }).diagnostics,
  ).toEqual([]);

  write(clientFile, `export const client = undefined;`);
  expect(
    checkMicroVerticalApiConsumerFiles({
      workspaceRoot: root,
    }).diagnostics.join('\n'),
  ).toContain('must call makeEffectHttpApiClient(...)');
});

test('parses .ts as TypeScript without JSX and .tsx with JSX', () => {
  write(
    path.join(root, 'verticals/catalog/modern.config.ts'),
    `const whenEnabled = <Configuration>(enabled: boolean, configuration: Configuration) =>\n  enabled ? configuration : undefined;\nexport default whenEnabled(true, {});\n`,
  );
  write(
    path.join(root, 'verticals/catalog/src/components/catalog-widget.tsx'),
    `export default function CatalogWidget() {\n  return <span>catalog</span>;\n}\n`,
  );
  expect(
    checkMicroVerticalApiConsumerFiles({
      workspaceRoot: root,
    }).diagnostics.join('\n'),
  ).not.toContain('invalid source syntax');
});

test('checks consumer composition without inspecting framework implementation', () => {
  expect(validate()).toBeUndefined();
  expect(
    validate(
      contract
        .replace(
          '= MicroVerticalBuildMarkerSchema;',
          '= Schema.Struct({...MicroVerticalBuildMarkerSchema.fields});',
        )
        .replace(
          '= MicroVerticalReadinessSchema;',
          '= Schema.Struct({...MicroVerticalReadinessSchema.fields, marker: catalogMarkerSchema});',
        ),
    ),
  ).toBeUndefined();
});
test.each([
  ["ownerId: 'catalog'", "ownerId: 'foreign'", 'metadata'],
  ["method: 'GET'", "method: 'POST'", 'operation map'],
  [
    "operationId: 'CatalogApi:/catalog/readiness'",
    "operationId: 'ForeignApi:/catalog/readiness'",
    'operation map',
  ],
  [
    '.addHttpApi(catalogFoundationApi)',
    '.add(catalogFoundationApi)',
    'compose',
  ],
  ['success: catalogReadinessSchema', 'success: Schema.Unknown', 'foundation'],
  [
    '= MicroVerticalBuildMarkerSchema;',
    '= Schema.Struct({...MicroVerticalBuildMarkerSchema.fields, version: Schema.String});',
    'build marker',
  ],
  [
    '= MicroVerticalReadinessSchema;',
    '= Schema.Struct({...MicroVerticalReadinessSchema.fields, status: Schema.String, marker: catalogMarkerSchema});',
    'readiness schema',
  ],
  [
    'MicroVerticalReadinessSchema, createMicroVerticalOperationContext }',
    'fake as MicroVerticalReadinessSchema, createMicroVerticalOperationContext }',
    'exact baseline',
  ],
  [
    "from '@modern-js/bff-effect/microvertical-api'",
    "from 'foreign'",
    'exact baseline',
  ],
])('rejects %s', (before, after, reason) =>
  expect(validate(contract.replace(before, after))).toContain(reason),
);
test('additional metadata remains caller-owned', () => {
  expectation = {
    ...expectation,
    additionalPaths: { searchPath: '/catalog-api/catalog/search' },
  };
  expect(validate()).toBeUndefined();
  expect(
    validate(
      contract.replace(
        "ownerId: 'catalog'",
        "searchPath: '/catalog-api/catalog/search', ownerId: 'catalog'",
      ),
    ),
  ).toBeUndefined();
  expect(
    validate(
      contract.replace(
        "ownerId: 'catalog'",
        "searchPath: '/foreign', ownerId: 'catalog'",
      ),
    ),
  ).toContain('metadata');
});
test('accepts bounded barrels but rejects foreign, renamed, ambiguous and cyclic exports', () => {
  write(path.join(owner, 'index.js'), "export * from './barrel.js';");
  write(
    path.join(owner, 'barrel.js'),
    "export { MicroVerticalBuildMarkerSchema, MicroVerticalReadinessSchema, createMicroVerticalOperationContext } from './owner.js';",
  );
  write(path.join(owner, 'owner.js'), exportsSource);
  expect(validate()).toBeUndefined();
  for (const source of [
    "export * from 'foreign';",
    "export * from './owner.js'; const fake = {}; export { fake as MicroVerticalReadinessSchema };",
    "export * from './owner.js'; export * from './decoy.js';",
    "export * from './index.js';",
  ]) {
    write(path.join(owner, 'barrel.js'), source);
    write(path.join(owner, 'decoy.js'), exportsSource);
    expect(validate()).toContain('exact framework owner');
  }
});
test('rejects nested package decoys and escaping symlinks, accepts owner symlink', () => {
  const nested = path.join(
    root,
    'verticals/catalog/node_modules/@modern-js/bff-effect',
  );
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.symlinkSync(owner, nested);
  expect(validate()).toBeUndefined();
  fs.unlinkSync(nested);
  fs.cpSync(owner, nested, { recursive: true });
  const mismatch = validate();
  expect(mismatch).toContain('exact framework owner');
  expect(mismatch).toContain(`selected owner ${fs.realpathSync(owner)}`);
  expect(mismatch).toContain(`consumer resolves ${fs.realpathSync(nested)}`);
  fs.rmSync(nested, { recursive: true });
  write(path.join(root, 'outside.js'), exportsSource);
  fs.rmSync(path.join(owner, 'index.js'));
  fs.symlinkSync(path.join(root, 'outside.js'), path.join(owner, 'index.js'));
  expect(validate()).toContain('exact framework owner');
});
test('consumer syntax and binding errors are violations; owner parser failures throw', () => {
  expect(validate(`${contract}\nexport const invalid = ;`)).toContain(
    'valid TypeScript syntax',
  );
  expect(validate(`${contract}\nconst Schema = {};`)).toContain(
    'valid TypeScript syntax',
  );
  expect(validate(`${contract}\ncatalogApi = foreign;`)).toContain(
    'valid TypeScript syntax',
  );
  // A member write changes a validated export without reassigning it.
  expect(
    validate(`${contract}\n(catalogApiContract as any).ownerId = 'other';`),
  ).toContain('contract bindings must be immutable');
  expect(
    validate(
      `${contract}\nObject.assign(catalogApiContract, { ownerId: 'x' });`,
    ),
  ).toContain('contract bindings must be immutable');
  expect(
    validate(`${contract}\ndelete (catalogApiContract as any).ownerId;`),
  ).toContain('contract bindings must be immutable');
  write(path.join(owner, 'index.js'), 'export const = ;');
  expect(() => validate()).toThrow();
});
test('full and files phases both report a clean workspace', () => {
  expect(
    checkMicroVerticalApiBoundaries({ workspaceRoot: root }),
  ).toMatchObject({ diagnostics: [], toolErrors: [] });
  expect(
    checkMicroVerticalApiConsumerFiles({ workspaceRoot: root }),
  ).toMatchObject({ diagnostics: [], toolErrors: [] });
  write(
    path.join(root, 'verticals/catalog/api/index.ts'),
    entry.replace('export default defineEffectBff', 'defineEffectBff'),
  );
  expect(
    checkMicroVerticalApiBoundaries({ workspaceRoot: root }).diagnostics.join(
      '\n',
    ),
  ).toContain('verticals/catalog/api/index.ts');
  expect(
    checkMicroVerticalApiConsumerFiles({ workspaceRoot: root }).diagnostics,
  ).toEqual([]);
});
test('defaults to each app native owner while an explicit owner stays exact', () => {
  write(file, contract);
  const appDirectory = path.join(root, 'verticals/catalog');
  const ordersDirectory = path.join(root, 'verticals/orders');
  fs.cpSync(appDirectory, ordersDirectory, { recursive: true });
  for (const relative of [
    'package.json',
    'shared/api.ts',
    'api/index.ts',
    'src/api/catalog-client.ts',
  ]) {
    const target = path.join(ordersDirectory, relative);
    write(
      target,
      fs
        .readFileSync(target, 'utf8')
        .replaceAll('catalog', 'orders')
        .replaceAll('Catalog', 'Orders'),
    );
  }
  fs.renameSync(
    path.join(ordersDirectory, 'src/api/catalog-client.ts'),
    path.join(ordersDirectory, 'src/api/orders-client.ts'),
  );
  const appOwners = [appDirectory, ordersDirectory].map(directory => {
    const installed = path.join(
      directory,
      'node_modules/@modern-js/bff-effect',
    );
    fs.cpSync(owner, installed, { recursive: true });
    return installed;
  });
  const options = {
    workspaceRoot: root,
    configuredApps: ['catalog', 'orders'].map(id => ({
      id,
      path: `verticals/${id}`,
      kind: 'vertical' as const,
      api: {},
    })),
  };
  for (const check of [
    checkMicroVerticalApiBoundaries,
    checkMicroVerticalApiConsumerFiles,
  ]) {
    expect(check(options)).toMatchObject({ diagnostics: [], toolErrors: [] });
    const constrained = check({ ...options, baselinePackageDirectory: owner });
    expect(constrained.toolErrors).toEqual([]);
    expect(
      constrained.diagnostics.filter(message =>
        message.includes('exact framework owner'),
      ),
    ).toHaveLength(2);
    write(path.join(appOwners[1]!, 'index.js'), 'export const unrelated = {};');
    expect(check(options).diagnostics.join('\n')).toContain(
      'verticals/orders/shared/api.ts: MicroVertical baseline imports must resolve the exact framework owner',
    );
    write(path.join(appOwners[1]!, 'index.js'), exportsSource);
  }
});

test('config errors and missing owners fail closed as tool failures', () => {
  write(
    path.join(root, 'topology/reference-topology.json'),
    JSON.stringify({
      shell: { id: 'shell', kind: 'shell', package: '@fixture/shell' },
      verticals: [],
    }),
  );
  expect(
    checkMicroVerticalApiConsumerFiles({ workspaceRoot: root }).toolErrors.join(
      '\n',
    ),
  ).toContain('explicit workspace path');
  write(
    path.join(root, 'topology/reference-topology.json'),
    JSON.stringify({
      shell: {
        id: 'shell',
        kind: 'shell',
        path: 'apps/shell',
        package: '@foreign/shell',
      },
      verticals: [],
    }),
  );
  expect(
    checkMicroVerticalApiConsumerFiles({ workspaceRoot: root }).toolErrors.join(
      '\n',
    ),
  ).toContain('package name must match topology');
  write(path.join(root, 'topology/reference-topology.json'), '{');
  expect(
    checkMicroVerticalApiBoundaries({ workspaceRoot: root }).toolErrors.length,
  ).toBe(1);
  expect(
    checkMicroVerticalApiBoundaries({
      workspaceRoot: root,
      configuredApps: [{ path: '../escape', kind: 'vertical' }],
    }).toolErrors.length,
  ).toBe(1);
  fs.rmSync(owner, { recursive: true });
  expect(
    checkMicroVerticalApiBoundaries({
      workspaceRoot: root,
      baselinePackageDirectory: owner,
      configuredApps: [
        { path: 'verticals/catalog', kind: 'vertical', api: {} },
      ],
    }).toolErrors.join('\n'),
  ).toContain('verticals/catalog');
});
test('CLI distinguishes success, consumer and infrastructure failures', async () => {
  expect(await runMicroVerticalApiCheckCli(['--workspace-root', root])).toBe(0);
  write(file, contract.replace("ownerId: 'catalog'", "ownerId: 'foreign'"));
  expect(await runMicroVerticalApiCheckCli(['--workspace-root', root])).toBe(1);
  write(path.join(root, 'topology/reference-topology.json'), '{');
  expect(await runMicroVerticalApiCheckCli(['--workspace-root', root])).toBe(2);
  expect(await runMicroVerticalApiCheckCli(['--workspace-root'])).toBe(2);
});
test('UI-only units reject API surfaces', () => {
  const result = checkMicroVerticalApiConsumerFiles({
    workspaceRoot: root,
    configuredApps: [
      {
        path: 'verticals/catalog',
        kind: 'vertical',
        surfaceProfile: 'ui-only',
      },
    ],
  });
  expect(result.toolErrors).toEqual([]);
  expect(result.diagnostics.join('\n')).toContain('unit has no API surface');
});

test('API-only units resolve a callable app-owned client from the public export', () => {
  const topologyPath = path.join(root, 'topology/reference-topology.json');
  const topology = JSON.parse(fs.readFileSync(topologyPath, 'utf8'));
  topology.verticals[0].surfaceProfile = 'api-only';
  write(topologyPath, JSON.stringify(topology));
  fs.rmSync(path.join(root, 'verticals/catalog/src'), { recursive: true });
  const clientPath = path.join(
    root,
    'verticals/catalog/shared/catalog-client.ts',
  );
  write(
    clientPath,
    `import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client'; import { catalogApi } from './api'; export const client = makeEffectHttpApiClient(catalogApi);`,
  );
  const packagePath = path.join(root, 'verticals/catalog/package.json');
  const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  manifest.exports['./api/client'] = './shared/catalog-client.ts';
  write(packagePath, JSON.stringify(manifest));

  const check = () => checkMicroVerticalApiBoundaries({ workspaceRoot: root });
  expect(check()).toEqual({
    diagnostics: [],
    toolErrors: [],
    topologyFilesAnalyzed: 1,
  });

  manifest.exports['./api/client'] = './shared/missing-client.ts';
  write(packagePath, JSON.stringify(manifest));
  expect(check().diagnostics.join('\n')).toContain('invalid API client export');
  manifest.exports['./api/client'] = './shared/catalog-client.ts';
  write(packagePath, JSON.stringify(manifest));

  const authoredClient = path.join(
    root,
    'verticals/catalog/src/api/public-catalog.ts',
  );
  write(
    authoredClient,
    `import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client'; import { catalogApi } from '../../shared/api'; export const client = makeEffectHttpApiClient(catalogApi);`,
  );
  manifest.exports['./api/client'] = './src/api/public-catalog.ts';
  write(packagePath, JSON.stringify(manifest));
  expect(check().diagnostics).toEqual([]);

  manifest.exports['./api/client'] = undefined;
  write(packagePath, JSON.stringify(manifest));
  expect(check().diagnostics.join('\n')).toContain('invalid API client export');
  manifest.exports['./api/client'] = './src/api/public-catalog.ts';
  write(packagePath, JSON.stringify(manifest));

  manifest.exports['./api/client'] = '../foreign-client.ts';
  write(packagePath, JSON.stringify(manifest));
  expect(check().diagnostics.join('\n')).toContain('invalid API client export');
  manifest.exports['./api/client'] = './src/api/public-catalog.ts';
  write(packagePath, JSON.stringify(manifest));

  const foreignClient = path.join(root, 'verticals/foreign-client.ts');
  write(foreignClient, fs.readFileSync(authoredClient, 'utf8'));
  const symlinkClient = path.join(
    root,
    'verticals/catalog/src/api/foreign-client.ts',
  );
  fs.symlinkSync(foreignClient, symlinkClient);
  manifest.exports['./api/client'] = './src/api/foreign-client.ts';
  write(packagePath, JSON.stringify(manifest));
  expect(check().diagnostics.join('\n')).toContain('invalid API client export');
  manifest.exports['./api/client'] = './src/api/public-catalog.ts';
  write(packagePath, JSON.stringify(manifest));

  write(authoredClient, `export { client } from '../../../foreign-client.ts';`);
  expect(check().toolErrors.join('\n')).toContain(
    'consumer module closure escapes its owner',
  );
  write(authoredClient, fs.readFileSync(foreignClient, 'utf8'));

  write(
    authoredClient,
    fs
      .readFileSync(authoredClient, 'utf8')
      .replace("'../../shared/api'", "'../../shared/rpc'"),
  );
  expect(check().toolErrors.join('\n')).toContain(
    'unresolved relative dependency',
  );
});

test('legacy operation mappings are explicit and business-agnostic', () => {
  const source = contract.replace(
    'readiness: createMicroVerticalOperationContext',
    "reindex: createMicroVerticalOperationContext({method: 'POST', operationId: 'CatalogApi:catalog:reindex', routePath: '/catalog/reindex'}), readiness: createMicroVerticalOperationContext",
  );
  expect(validate(source)).toContain('operation map');
  expectation = {
    ...expectation,
    operationPaths: { 'CatalogApi:catalog:reindex': '/catalog/reindex' },
  };
  expect(validate(source)).toBeUndefined();
  expect(
    validate(
      source.replace("routePath: '/catalog/reindex'", "routePath: '/foreign'"),
    ),
  ).toContain('operation map');
});

test('explicit owner directory supports isolated installation but cannot override consumer identity', () => {
  const result = checkMicroVerticalApiBoundaries({
    workspaceRoot: root,
    baselinePackageDirectory: owner,
  });
  expect(result.toolErrors).toEqual([]);
  expect(result.diagnostics).toEqual([]);
  const fake = path.join(root, 'fake-owner');
  fs.cpSync(owner, fake, { recursive: true });
  expect(
    checkMicroVerticalApiBoundaries({
      workspaceRoot: root,
      baselinePackageDirectory: fake,
    }).diagnostics.join('\n'),
  ).toContain('exact framework owner');
});
test('classifies RPC surfaces and validates native RPC topology', () => {
  write(
    path.join(root, 'verticals/catalog/package.json'),
    JSON.stringify({
      name: '@fixture/catalog',
      exports: {
        './api': './shared/rpc.ts',
        './api/rpc-client': './src/api/catalog-rpc-client.ts',
      },
    }),
  );
  fs.rmSync(file);
  fs.rmSync(path.join(root, 'verticals/catalog/src/api/catalog-client.ts'));
  write(
    path.join(root, 'verticals/catalog/shared/rpc.ts'),
    `import { Rpc, RpcGroup } from 'effect/rpc'; import { Schema } from '@modern-js/bff-effect/effect-client'; export const CatalogRpcGroup = RpcGroup.make(Rpc.make('ping', { success: Schema.Struct({}) }));`,
  );
  write(
    path.join(root, 'verticals/catalog/src/api/catalog-rpc-client.ts'),
    `import { Effect, makeEffectRpcClient } from '@modern-js/bff-effect/effect-client'; import { CatalogRpcGroup } from '../../shared/rpc.ts'; export const client = makeEffectRpcClient(CatalogRpcGroup);`,
  );
  write(
    path.join(root, 'verticals/catalog/api/index.ts'),
    `import { defineEffectBff, Effect, HttpApi, Layer } from '@modern-js/bff-effect/effect-edge'; import { CatalogRpcGroup } from '../shared/rpc.ts'; const CatalogRpcLayer = CatalogRpcGroup.toLayer(CatalogRpcGroup.of({ ping: () => undefined })); const apiRuntime = defineEffectBff({api: HttpApi.make('CatalogRpcApi'), layer: Layer.empty, rpc: { group: CatalogRpcGroup, layer: CatalogRpcLayer, path: '/rpc', serialization: 'json' }}); export default apiRuntime;`,
  );
  const result = checkMicroVerticalApiBoundaries({
    workspaceRoot: root,
    configuredApps: [
      { path: 'verticals/catalog', kind: 'vertical', api: { protocol: 'rpc' } },
    ],
  });
  expect(result).toEqual({
    diagnostics: [],
    toolErrors: [],
    topologyFilesAnalyzed: 1,
  });
  const packagePath = path.join(root, 'verticals/catalog/package.json');
  const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  manifest.exports['./api/rpc-client'] = './shared/public-rpc-client.ts';
  write(packagePath, JSON.stringify(manifest));
  write(
    path.join(root, 'verticals/catalog/shared/public-rpc-client.ts'),
    `import { Effect, makeEffectRpcClient } from '@modern-js/bff-effect/effect-client'; import { CatalogRpcGroup } from './rpc.ts'; export const client = makeEffectRpcClient(CatalogRpcGroup);`,
  );
  expect(
    checkMicroVerticalApiBoundaries({
      workspaceRoot: root,
      configuredApps: [
        {
          path: 'verticals/catalog',
          kind: 'vertical',
          api: { protocol: 'rpc' },
        },
      ],
    }).diagnostics,
  ).toEqual([]);
  manifest.exports['./api/client'] = './src/api/catalog-client.ts';
  write(packagePath, JSON.stringify(manifest));
  expect(
    checkMicroVerticalApiConsumerFiles({
      workspaceRoot: root,
      configuredApps: [
        {
          path: 'verticals/catalog',
          kind: 'vertical',
          api: { protocol: 'rpc' },
        },
      ],
    }).diagnostics.join('\n'),
  ).toContain('forbidden opposite protocol client export');
});

test.each(['catalog', 'checkout'])(
  'preserves actual generated %s public operation IDs without config copies',
  stem => {
    const service = {
      id: stem,
      api: { consumedBy: [], prefix: `/${stem}-api`, stem },
    };
    const generated = createSharedApi(service, { scope: 'fixture' });
    write(file, generated);
    const expected = {
      ...expectation,
      apiPrefix: `/${stem}-api`,
      basePath: `/${stem}-api/${stem}`,
      ownerId: stem,
      readinessPath: `/${stem}-api/${stem}/readiness`,
    };
    expect(
      microVerticalApiBaselineViolation(stem, file, expected),
    ).toBeUndefined();
    const operationId =
      stem === 'checkout'
        ? 'CheckoutApi:checkout:getCart'
        : 'CatalogApi:catalog:list';
    write(file, generated.replace(operationId, `${operationId}Wrong`));
    expect(microVerticalApiBaselineViolation(stem, file, expected)).toContain(
      'operation map',
    );
    write(file, generated.replace("method: 'POST'", "method: 'GET'"));
    expect(microVerticalApiBaselineViolation(stem, file, expected)).toContain(
      'operation map',
    );
    write(
      file,
      generated.replace(`routePath: '/${stem}'`, "routePath: '/foreign'"),
    );
    expect(microVerticalApiBaselineViolation(stem, file, expected)).toContain(
      'operation map',
    );
    if (stem === 'checkout') {
      write(
        file,
        generated.replace(
          "checkoutCartPath: '/checkout-api/checkout/cart'",
          "checkoutCartPath: '/checkout-api/checkout/cartoon'",
        ),
      );
      expect(microVerticalApiBaselineViolation(stem, file, expected)).toContain(
        'metadata',
      );
    }
  },
);

test('infers non-cart operations only from reachable named native endpoint groups', () => {
  const source = contract
    .replace(
      'export const catalogApi =',
      "const searchEndpoint = HttpApiEndpoint.post('reindex', '/catalog/search/reindex', { success: Schema.String }); const searchGroup = HttpApiGroup.make('search').add(searchEndpoint); export const catalogApi =",
    )
    .replace(
      '.addHttpApi(catalogFoundationApi);',
      '.addHttpApi(catalogFoundationApi).add(searchGroup);',
    )
    .replace(
      'readiness: createMicroVerticalOperationContext',
      "reindex: createMicroVerticalOperationContext({method: 'POST', operationId: 'CatalogApi:search:reindex', routePath: '/catalog/search/reindex'}), readiness: createMicroVerticalOperationContext",
    )
    .replace(
      "ownerId: 'catalog'",
      "searchPath: '/catalog-api/catalog/search', ownerId: 'catalog'",
    );
  expect(validate(source)).toBeUndefined();
  for (const [before, after] of [
    ["method: 'POST'", "method: 'GET'"],
    [
      "routePath: '/catalog/search/reindex'",
      "routePath: '/catalog/search/missing'",
    ],
    ['CatalogApi:search:reindex', 'CatalogApi:catalog:reindex'],
    ["HttpApiEndpoint.post('reindex'", "HttpApiEndpoint.post('decoy'"],
    [
      "searchPath: '/catalog-api/catalog/search'",
      "searchPath: '/catalog-api/catalog/sear'",
    ],
    ['.add(searchGroup)', ''],
  ])
    expect(validate(source.replace(before, after))).toBeDefined();
  // A correct-looking but disconnected endpoint must not lend identity to a connected wrong verb.
  expect(
    validate(
      source.replace(
        "HttpApiEndpoint.post('reindex'",
        "HttpApiEndpoint.get('reindex'",
      ) +
        "\nconst disconnected = HttpApiEndpoint.post('reindex', '/catalog/search/reindex', {success: Schema.String});",
    ),
  ).toContain('operation map');
});

test('every configured and topology app must declare a known kind', () => {
  const check = (configuredApps?: readonly { path: string; kind: string }[]) =>
    checkMicroVerticalApiConsumerFiles({
      workspaceRoot: root,
      ...(configuredApps ? { configuredApps } : {}),
    }).toolErrors.join('\n');
  expect(
    check([{ path: 'verticals/catalog' } as { path: string; kind: string }]),
  ).toContain('verticals/catalog: invalid kind');
  expect(check([{ path: 'verticals/catalog', kind: 'portal' }])).toContain(
    'verticals/catalog: invalid kind',
  );
  const topologyPath = path.join(root, 'topology/reference-topology.json');
  const topology = JSON.parse(fs.readFileSync(topologyPath, 'utf8'));
  delete topology.verticals[0].kind;
  write(topologyPath, JSON.stringify(topology));
  expect(check()).toContain('verticals/catalog: invalid kind');
});

test('module graph resolves exact lexical references and unbound globals', () => {
  const modulePath = path.join(root, 'verticals/catalog/src/lexical.ts');
  write(
    modulePath,
    `import * as contract from '../shared/api.ts';
const api = contract.catalogApi;
export const outer = api;
export function inner() { const api = 'shadow'; return api; }
const loader = require;
export const loaded = require('./x');
export function local(require: (id: string) => unknown) { return require('./y'); }`,
  );
  const graph = createModuleGraph();
  const module = graph.module(modulePath);
  const identifiers: t.Identifier[] = [];
  t.traverseFast(module.file, node => {
    if (t.isIdentifier(node)) identifiers.push(node);
  });
  // Declaration and reference of the module `api`, then of the shadowing one.
  const resolvedApis = identifiers
    .filter(node => node.name === 'api')
    .map(node => {
      const binding = graph.resolveReference(module, node);
      return binding?.kind === 'declaration' ? binding.expression.type : 'none';
    });
  expect(resolvedApis).toEqual([
    'MemberExpression',
    'MemberExpression',
    'StringLiteral',
    'StringLiteral',
  ]);
  const namespaceMember = (() => {
    let found: t.MemberExpression | undefined;
    t.traverseFast(module.file, node => {
      if (
        t.isMemberExpression(node) &&
        t.isIdentifier(node.object, { name: 'contract' })
      )
        found = node;
    });
    return found!;
  })();
  const resolved = graph.resolveReference(module, namespaceMember);
  expect(resolved?.kind).toBe('declaration');
  expect(
    resolved?.kind === 'declaration' &&
      resolved.module.path === fs.realpathSync(file),
  ).toBe(true);
  const requires = identifiers.filter(node => node.name === 'require');
  // `const loader = require` and `require('./x')` read the global; the
  // parameter and its call are bound.
  expect(requires.map(node => graph.isUnboundReference(module, node))).toEqual([
    true,
    true,
    false,
    false,
  ]);
});

test('client closures follow runtime dependencies and fail closed', () => {
  const clientPath = path.join(
    root,
    'verticals/catalog/src/api/catalog-client.ts',
  );
  const factory = path.join(root, 'verticals/catalog/src/api/factory.ts');
  write(
    factory,
    `import { makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client'; import { catalogApi } from '../../shared/api'; export const make = () => makeEffectHttpApiClient(catalogApi);`,
  );
  const check = (source: string) => {
    write(clientPath, source);
    return checkMicroVerticalApiConsumerFiles({ workspaceRoot: root });
  };
  const head = `import { Effect } from '@modern-js/bff-effect/effect-client';`;
  // `import()` and the global `require()` reach the composed factory.
  for (const load of [
    `export const client = import('./factory.ts');`,
    `export const client = require('./factory.ts');`,
  ])
    expect(check(`${head} ${load}`)).toMatchObject({
      diagnostics: [],
      toolErrors: [],
    });
  // A type-only import is not a runtime dependency, so it is not followed.
  expect(
    check(
      `${head} import type { Missing } from './missing.ts'; export type { Gone } from './gone.ts'; export const client = import('./factory.ts');`,
    ),
  ).toMatchObject({ diagnostics: [], toolErrors: [] });
  expect(
    check(`${head} export const client = './factory.ts';`).diagnostics.join(
      '\n',
    ),
  ).toContain('must call makeEffectHttpApiClient(...)');
  // A locally bound `require` is an ordinary function.
  expect(
    check(
      `${head} import './factory.ts'; const require = (name: string) => name; export const client = require(name);`,
    ).toolErrors,
  ).toEqual([]);
  for (const [source, error] of [
    [
      `${head} export const client = import('./missing.ts');`,
      'unresolved relative dependency',
    ],
    [
      `${head} export const client = import(name);`,
      'nonliteral runtime dependency',
    ],
    [
      `${head} export const client = require(name);`,
      'nonliteral runtime dependency',
    ],
    [
      `${head} export { client } from '../../../../packages/escape.ts';`,
      'escapes its owner',
    ],
  ] as const) {
    if (source.includes('escape.ts'))
      write(path.join(root, 'packages/escape.ts'), 'export const client = 1;');
    expect(check(source).toolErrors.join('\n')).toContain(error);
  }
});

test('client closures enforce depth and module budgets', () => {
  const directory = path.join(root, 'verticals/catalog/src/api');
  const chain = (length: number) => {
    for (let index = 0; index < length; index += 1)
      write(
        path.join(directory, `step-${index}.ts`),
        index + 1 < length ? `export * from './step-${index + 1}.ts';` : '',
      );
    write(
      path.join(directory, 'catalog-client.ts'),
      `import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client'; import { catalogApi } from '../../shared/api'; export * from './step-0.ts'; export const client = makeEffectHttpApiClient(catalogApi);`,
    );
    return checkMicroVerticalApiConsumerFiles({ workspaceRoot: root })
      .toolErrors;
  };
  expect(chain(100)).toEqual([]);
  expect(chain(130).join('\n')).toContain('import-depth analysis budget');
});

test('two spellings of one module resolve to the same contract', () => {
  fs.symlinkSync(
    path.join(root, 'verticals/catalog/shared'),
    path.join(root, 'verticals/catalog/src/contract'),
  );
  write(
    path.join(root, 'verticals/catalog/src/api/catalog-client.ts'),
    `import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client'; import { catalogApi } from '../contract/api.ts'; export const client = makeEffectHttpApiClient(catalogApi);`,
  );
  expect(
    checkMicroVerticalApiConsumerFiles({ workspaceRoot: root }),
  ).toMatchObject({ diagnostics: [], toolErrors: [] });
});

test('source rules get one graph per source file', () => {
  const graphs = new Map<string, unknown>();
  const rule: MicroVerticalApiSourceRule = ({ file, graph }) => {
    graphs.set(file, graph);
    return [];
  };
  const second: MicroVerticalApiSourceRule = ({ file, graph }) =>
    graphs.get(file) === graph ? [] : ['rules saw different graphs'];
  expect(
    checkMicroVerticalApiConsumerFiles({
      workspaceRoot: root,
      sourceRules: [rule, second],
    }),
  ).toMatchObject({ diagnostics: [], toolErrors: [] });
  expect(graphs.size).toBeGreaterThan(1);
  expect(new Set(graphs.values()).size).toBe(graphs.size);
});

describe('Shell apps are selected by kind, not by path', () => {
  const shellRoot = () => path.join(root, 'apps/portal');
  beforeEach(() => {
    const topologyPath = path.join(root, 'topology/reference-topology.json');
    const topology = JSON.parse(fs.readFileSync(topologyPath, 'utf8'));
    topology.shell = {
      id: 'portal',
      kind: 'shell',
      path: 'apps/portal',
      package: '@fixture/portal',
    };
    write(topologyPath, JSON.stringify(topology));
  });
  const shell = (exports: Record<string, unknown>, files = {}) => {
    write(
      path.join(shellRoot(), 'package.json'),
      JSON.stringify({ name: '@fixture/portal', exports }),
    );
    for (const [file, source] of Object.entries(files))
      write(path.join(shellRoot(), file), source as string);
    return checkMicroVerticalApiConsumerFiles({ workspaceRoot: root });
  };
  const foreign =
    "Shell public exports must not expose another owner's API client";

  test('rejects client registries and the ./api/clients export', () => {
    const result = shell(
      { './api/clients': './src/api/vertical-clients.ts' },
      {
        'src/api/vertical-clients.ts': `export * from '@fixture/catalog/api/client';`,
      },
    );
    const output = result.diagnostics.join('\n');
    expect(output).toContain('apps/portal/src/api/vertical-clients.ts');
    expect(output).toContain('./api/clients exports are forbidden');
  });

  test('accepts UI-only public exports and its own client', () => {
    expect(
      shell(
        {
          '.': './src/index.ts',
          './components/*': './src/components/*.tsx',
          './styles.css': './src/styles.css',
        },
        {
          'src/index.ts': `export const title = 'Portal'; export type { CatalogClient } from '@fixture/catalog/api/client';`,
          'src/components/card.tsx': 'export const Card = () => null;',
          'src/styles.css': '',
        },
      ),
    ).toMatchObject({ diagnostics: [], toolErrors: [] });
  });

  test.each([
    [
      'a direct re-export',
      `export { client } from '@fixture/catalog/api/client';`,
    ],
    ['a star re-export', `export * from '@fixture/catalog/api/client';`],
    [
      'a namespace re-export',
      `export * as catalog from '@fixture/catalog/api/client';`,
    ],
    [
      'an object that holds the client',
      `import { client } from '@fixture/catalog/api/client'; export const clients = { catalog: client };`,
    ],
    [
      'a function that returns the client',
      `import * as catalog from '@fixture/catalog/api/client'; export function clients() { return catalog.client; }`,
    ],
    [
      'a client the Shell builds from a foreign contract',
      `import { makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client'; import { catalogApi } from '@fixture/catalog/api'; export const client = makeEffectHttpApiClient(catalogApi);`,
    ],
    [
      'an unresolved foreign client specifier',
      `export { client } from '@fixture/unknown/api/rpc-client';`,
    ],
  ])('rejects %s', (_name, source) => {
    expect(
      shell({ '.': './src/index.ts' }, { 'src/index.ts': source }).diagnostics,
    ).toContain(`apps/portal/src/index.ts: ${foreign}`);
  });

  test('inspects every file a wildcard export publishes', () => {
    const result = shell(
      { './features/*': { import: './src/features/*.ts' } },
      {
        'src/features/home.ts': 'export const home = 1;',
        'src/features/catalog.ts': `export { client } from '@fixture/catalog/api/client';`,
      },
    );
    expect(result.diagnostics).toEqual([
      `apps/portal/src/features/catalog.ts: ${foreign}`,
    ]);
  });

  test('rejects exports that escape the Shell', () => {
    expect(
      shell({ '.': '../catalog/src/index.ts' }).diagnostics.join('\n'),
    ).toContain('invalid Shell public source export');
  });
});

describe('clients are built from their own API contract', () => {
  const clientPath = () =>
    path.join(root, 'verticals/catalog/src/api/catalog-client.ts');
  const own =
    'Effect.gen(function* () { return yield* makeEffectHttpApiClient(catalogApi); })';
  const head = `import { Effect, HttpApi, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client'; import { identity } from 'effect'; import { catalogApi, catalogFoundationApi } from '../../shared/api';`;
  const check = (body: string) => {
    write(clientPath(), `${head}\n${body}`);
    return checkMicroVerticalApiConsumerFiles({ workspaceRoot: root })
      .diagnostics;
  };
  const violation =
    'verticals/catalog/src/api/catalog-client.ts: must construct the client from its own API contract';

  test.each([
    ['the exported root API', `export const client = ${own};`],
    [
      'an API the root composes',
      'export const client = makeEffectHttpApiClient(catalogFoundationApi);',
    ],
    [
      'aliases and identity pipes',
      'const api = catalogApi.pipe(identity); const alias = api; export const client = makeEffectHttpApiClient(alias.pipe(identity), { baseUrl: "/" });',
    ],
    [
      'a sub-API declared in a sibling contract module',
      `import { catalogSearchApi } from '../../shared/apis/catalog-search.ts'; export const client = makeEffectHttpApiClient(catalogSearchApi);`,
    ],
  ])('accepts %s', (_name, body) => {
    write(
      path.join(root, 'verticals/catalog/shared/apis/catalog-search.ts'),
      subApi('catalogSearchApi', 'catalogSearch', '/catalog/search'),
    );
    write(
      file,
      contract.replace(
        `export const catalogApi = HttpApi.make('CatalogApi').addHttpApi(catalogFoundationApi);`,
        `import { catalogSearchApi } from './apis/catalog-search.ts';
export const catalogApi = HttpApi.make('CatalogApi').addHttpApi(catalogFoundationApi).addHttpApi(catalogSearchApi);`,
      ),
    );
    expect(check(body)).toEqual([]);
  });

  test.each([
    [
      'an API built in the client module',
      `export const client = makeEffectHttpApiClient(HttpApi.make('Foreign'));`,
    ],
    [
      'an API the contract package declares but never composes',
      `import { strayApi } from '../../shared/stray.ts'; export const client = makeEffectHttpApiClient(strayApi);`,
    ],
    [
      'another owner contract',
      `import { ordersApi } from '@fixture/orders/api'; export const client = makeEffectHttpApiClient(ordersApi);`,
    ],
    [
      'an API supplied by the caller',
      `${'export const client = Effect.succeed(makeEffectHttpApiClient(catalogApi));'} export const make = (api) => makeEffectHttpApiClient(api);`,
    ],
    [
      'a pipe alias the client module may mutate',
      'const api = catalogApi.pipe(identity); export let swapped = 1; swapped = 2; const mapped = catalogApi.pipe((value) => value); export const client = makeEffectHttpApiClient(api);',
    ],
  ])('rejects %s', (_name, body) => {
    write(
      path.join(root, 'verticals/catalog/shared/stray.ts'),
      `import { HttpApi } from '@modern-js/bff-effect/effect-client'; export const strayApi = HttpApi.make('Stray');`,
    );
    expect(check(body)).toContain(violation);
  });

  test('a split client is checked in every composed module', () => {
    write(
      path.join(root, 'verticals/catalog/src/api/foreign.ts'),
      `import { HttpApi, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client'; export const foreign = makeEffectHttpApiClient(HttpApi.make('Foreign'));`,
    );
    expect(
      check(
        `export { foreign } from './foreign.ts'; export const client = ${own};`,
      ),
    ).toContain(
      'verticals/catalog/src/api/foreign.ts: must construct the client from its own API contract',
    );
  });

  test('an RPC client must receive the exported RPC group', () => {
    const packagePath = path.join(root, 'verticals/catalog/package.json');
    write(
      packagePath,
      JSON.stringify({
        name: '@fixture/catalog',
        exports: {
          './api': './shared/rpc.ts',
          './api/rpc-client': './src/api/catalog-rpc-client.ts',
        },
      }),
    );
    fs.rmSync(file);
    write(
      path.join(root, 'verticals/catalog/shared/rpc.ts'),
      `import { Rpc, RpcGroup } from 'effect/rpc'; import { Schema } from '@modern-js/bff-effect/effect-client'; export const CatalogRpcGroup = RpcGroup.make(Rpc.make('ping', { success: Schema.Struct({}) })); export const OtherRpcGroup = RpcGroup.make(Rpc.make('pong', { success: Schema.Struct({}) }));`,
    );
    const rpcClient = (group: string) => {
      write(
        path.join(root, 'verticals/catalog/src/api/catalog-rpc-client.ts'),
        `import { Effect, makeEffectRpcClient } from '@modern-js/bff-effect/effect-client'; import { CatalogRpcGroup, OtherRpcGroup } from '../../shared/rpc.ts'; const group = ${group}; export const client = makeEffectRpcClient(group, { url: '/rpc' });`,
      );
      return checkMicroVerticalApiConsumerFiles({
        workspaceRoot: root,
        configuredApps: [
          {
            path: 'verticals/catalog',
            kind: 'vertical',
            api: { protocol: 'rpc' },
          },
        ],
      }).diagnostics.join('\n');
    };
    expect(rpcClient('CatalogRpcGroup')).not.toContain('own API contract');
    expect(rpcClient('OtherRpcGroup')).toContain(
      'catalog-rpc-client.ts: must construct the client from its own API contract',
    );
  });
});
