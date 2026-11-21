import { strictEffectRuntimeTopologyViolation as violation } from '../src/strict-effect-runtime';

const imports = `
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import { fixtureApi } from '../shared/api.ts';
`;
const group = `const group = HttpApiBuilder.group(fixtureApi, 'fixture', h => h.handle('get', () => undefined));
const handlers = Layer.mergeAll(group);`;
const shared = `${imports}${group}
export default assembleEffectBffRuntime({api: fixtureApi, handlers});`;
const direct = `${imports}${group}
const layer = HttpApiBuilder.layer(fixtureApi).pipe(Layer.provide(handlers));
export default defineEffectBff({api: fixtureApi, layer});`;

describe('strict Effect runtime binding provenance', () => {
  test('analyzes a valid graph above 64 modules and rejects real budget overflow', () => {
    const sourceFor = (count: number) => `
${imports}
${Array.from({ length: count }, (_, index) => `import { group${index} } from './group${index}.ts';`).join('\n')}
const handlers = Layer.mergeAll(${Array.from({ length: count }, (_, index) => `group${index}`).join(', ')});
export default assembleEffectBffRuntime({ api: fixtureApi, handlers });`;
    const resolve = (specifier: string) => {
      if (specifier === '../shared/api.ts')
        return {
          id: '/fixture/shared/api.ts',
          source: 'export const fixtureApi = {};',
        };
      const match = specifier.match(/^\.\/group(\d+)\.ts$/u);
      return (
        (match && {
          id: `/fixture/api/group${match[1]}.ts`,
          source: `${imports}export const group${match[1]} = HttpApiBuilder.group(fixtureApi, 'fixture', h => h.handle('get', () => undefined));`,
          resolveImport: resolve,
        }) ||
        undefined
      );
    };
    expect(violation(sourceFor(70), resolve)).toBeUndefined();
    expect(violation(sourceFor(256), resolve)).toContain(
      'must export defineEffectBff',
    );
  });
  test('proves parameterized factories and handler-local declarations without trusting parameters as topology', () => {
    const source = `${imports}
const make = (...args: readonly [unknown]) => {
  type HandlerRequirements = { readonly dependency: unknown };
  interface RuntimeContract { readonly api: typeof fixtureApi }
  const [dependency] = args;
  const group = HttpApiBuilder.group(fixtureApi, 'fixture', handlers => {
    const handle = () => undefined;
    return handlers.handle('get', handle);
  });
  const handlers = Layer.mergeAll(group).pipe(Layer.provide(dependency));
  return assembleEffectBffRuntime({api: fixtureApi, handlers});
};
export default make(Layer.empty);`;
    expect(violation(source)).toBeUndefined();
    for (const invalid of [
      source.replace('handlers});', 'handlers: dependency});'),
      source.replace('api: fixtureApi', 'api: dependency'),
      source.replace(
        'const [dependency] = args;',
        'const [assembleEffectBffRuntime] = args;',
      ),
      source.replace(
        'return handlers.handle',
        'handlers = fake; return handlers.handle',
      ),
      source.replace(
        'return assembleEffectBffRuntime',
        'if (false) return assembleEffectBffRuntime',
      ),
      source.replace(
        'type HandlerRequirements = { readonly dependency: unknown };',
        'if (false) throw new Error("runtime branch");',
      ),
    ])
      expect(violation(invalid)).toBeDefined();
  });

  test.each([shared, direct])(
    'accepts genuine executable direct/assembled roots',
    source => {
      expect(violation(source)).toBeUndefined();
    },
  );

  test.each([
    // OntOS: published lint validators reject string and local strict-root spoofs, fixture 32.
    `${imports.replace('defineEffectBff,', 'fake as defineEffectBff,')}
const fixtureLayer = HttpApiBuilder.layer(fixtureApi).pipe(Layer.provide(fixtureHandlers));
defineEffectBff({api: fixtureApi, layer: fixtureLayer});`,
    direct.replace('export default defineEffectBff', 'defineEffectBff'),
    shared.replace('HttpApiBuilder, Layer', 'fake as HttpApiBuilder, Layer'),
    `const decoy = ${JSON.stringify(shared)}; export default fake;`,
  ])(
    'rejects spoofed, shadowed, discarded and non-executable roots',
    source => {
      expect(violation(source)).toBeDefined();
    },
  );

  test('classifies parser syntax and binder collision diagnostics as invalid source', () => {
    expect(violation('export const invalid = ;')).toBeDefined();
    // TypeScript parsing permits this import/value collision; scope crawling
    // reports it through Babel's Hub, not BABEL_PARSER_SYNTAX_ERROR.
    const duplicate = `import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import { Layer as GovernedReadLayer } from 'effect';
import { fixtureApi, governedHttpApi } from '../shared/api.ts';
const group = HttpApiBuilder.group(governedHttpApi, 'fixture', (handlers) => handlers.handle('reachable', () => undefined));
const GovernedReadLayer = {}; const handlers = Layer.mergeAll(group.pipe(GovernedReadLayer.provide(Layer.empty)));
export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });`;
    expect(violation(duplicate)).toBeDefined();
  });

  test('accepts native RPC composition and rejects transport or handler substitution', () => {
    const source = `import { defineEffectBff, HttpApi, Layer } from '@modern-js/bff-effect/effect-edge';
import { fixtureRpcGroup } from '../shared/rpc.ts';
const api = HttpApi.make('transport'); const layer = Layer.empty;
const handlers = fixtureRpcGroup.toLayer(fixtureRpcGroup.of({ get: () => undefined }));
export default defineEffectBff({ api, layer, rpc: { group: fixtureRpcGroup, layer: handlers, path: '/rpc', serialization: 'json' } });`;
    const resolve = () => ({
      id: '/fixture/shared/rpc.ts',
      source: `import { RpcGroup, Rpc } from 'effect/rpc'; export const fixtureRpcGroup = RpcGroup.make(Rpc.make('get', {}));`,
    });
    expect(violation(source, resolve)).toBeUndefined();
    for (const invalid of [
      source.replace("HttpApi.make('transport')", 'fake'),
      source.replace('const layer = Layer.empty', 'const layer = fake'),
      source.replace("path: '/rpc'", "path: '/foreign'"),
      source.replace('fixtureRpcGroup.of({ get: () => undefined })', 'fake'),
    ])
      expect(violation(invalid, resolve)).toBeDefined();
  });
  test('follows owner-local handler modules and contract aliases, not foreign contracts', () => {
    const source = `${imports}import { handlers } from './handlers.ts'; export default assembleEffectBffRuntime({api: fixtureApi, handlers});`;
    const contract = {
      id: '/fixture/shared/api.ts',
      source:
        'export const fixtureApi = {}; export const aliasApi = fixtureApi;',
    };
    const resolve = (foreign: boolean) => (specifier: string) => {
      if (specifier === '../shared/api.ts') return contract;
      if (specifier === './handlers.ts')
        return {
          id: '/fixture/api/handlers.ts',
          source: `${imports.replace('fixtureApi }', 'aliasApi as fixtureApi }')}${group.replace('const handlers', 'export const handlers')}`,
          resolveImport: () =>
            foreign ? { ...contract, id: '/foreign/shared/api.ts' } : contract,
        };
      return undefined;
    };
    expect(violation(source, resolve(false))).toBeUndefined();
    expect(violation(source, resolve(true))).toBeDefined();
  });
  test('treats a write through a const alias as a write to its source', () => {
    expect(violation(direct)).toBeUndefined();
    expect(
      violation(
        `${direct}\nconst alias = Layer;\nalias.mergeAll = () => undefined;`,
      ),
    ).toBeDefined();
    expect(
      violation(
        `${direct}\nconst first = Layer;\nconst second = (first);\nsecond.provide = () => undefined;`,
      ),
    ).toBeDefined();
  });
  test('accepts literal routes and provided service-capturing routes as transport', () => {
    const transportImports = `${imports}import { Effect, HttpRouter } from '@modern-js/bff-effect/effect-edge';
import { Authority, AuthorityLive } from './authority.ts';
`;
    const runtime = (transport: string, declarations = '') =>
      `${transportImports}${group}
${declarations}
export default assembleEffectBffRuntime({api: fixtureApi, handlers, transport: ${transport}});`;
    const route = `const route = (authority) => HttpRouter.add('*', '/proxy/*', request => authority.forward(request));`;
    const captured = `${route}
const captured = Layer.unwrap(Authority.pipe(Effect.map(route)));`;
    const valid = [
      runtime(`HttpRouter.add('GET', '/health', () => Effect.succeed('ok'))`),
      runtime('captured.pipe(Layer.provide(AuthorityLive))', captured),
      runtime(
        'unwrapped.pipe(Layer.provide(AuthorityLive))',
        `${route}
const unwrapped = Layer.unwrap(Effect.map(Authority, route));`,
      ),
    ];
    for (const source of valid) expect(violation(source)).toBeUndefined();
    const invalid = [
      // The captured service must be provided where the transport is composed.
      runtime('captured', captured),
      runtime('Layer.mergeAll(captured)', captured),
      runtime(
        'captured.pipe(Layer.provide(AuthorityLive))',
        captured.replace(
          'request => authority.forward(request)',
          'request => request',
        ),
      ),
      runtime(
        'captured.pipe(Layer.provide(AuthorityLive))',
        captured.replace("'/proxy/*'", 'path'),
      ),
      runtime(
        'captured.pipe(Layer.provide(AuthorityLive))',
        captured.replace("'*', '/proxy/*'", "'BREW', '/proxy/*'"),
      ),
      runtime(
        'captured.pipe(Layer.provide(AuthorityLive))',
        captured.replace('Effect.map(route)', 'Effect.flatMap(route)'),
      ),
      runtime(`HttpRouter.add('GET', 'health', () => Effect.succeed('ok'))`),
      runtime(`HttpRouter.add('GET', '/health', handler)`),
    ];
    for (const source of invalid) expect(violation(source)).toBeDefined();
  });
  test('rejects the removed shared-contracts assembly forwarding path', () => {
    expect(
      violation(
        shared.replace(
          "'@modern-js/bff-effect/assembly'",
          "'@fixture/shared-contracts/server/effect-bff-runtime'",
        ),
      ),
    ).toBeDefined();
  });
});

describe('canonical Effect package provenance', () => {
  const node = direct.replace(
    "import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';",
    "import { defineEffectBff } from '@modern-js/bff-effect/effect';\nimport { HttpApiBuilder } from 'effect/http-api';\nimport * as Layer from 'effect/Layer';",
  );
  test('accepts Node runtime imports split by owning module and preserves namespace aliases', () => {
    expect(violation(node)).toBeUndefined();
    const aliased = node
      .replace('defineEffectBff }', 'defineEffectBff as createRuntime }')
      .replace(
        'export default defineEffectBff(',
        'export default createRuntime(',
      )
      .replace('HttpApiBuilder }', 'HttpApiBuilder as Builder }')
      .replaceAll('HttpApiBuilder.', 'Builder.')
      .replace('import * as Layer', 'import * as RuntimeLayer')
      .replaceAll('Layer.', 'RuntimeLayer.');
    expect(violation(aliased)).toBeUndefined();
  });
  test.each([
    node.replace('import * as Layer', 'import type * as Layer'),
    node.replace("'effect/http-api'", "'@foreign/httpapi'"),
    node.replace('HttpApiBuilder }', 'fake as HttpApiBuilder }'),
    node.replace('const handlers', 'const Layer = fake; const handlers'),
    node.replace(
      "'@modern-js/bff-effect/effect'",
      "'@modern-js/plugin-bff/server'",
    ),
    `${node}\nLayer.mergeAll = () => undefined;`,
  ])('rejects non-executable or foreign Node bindings', source => {
    expect(violation(source)).toBeDefined();
  });
});

describe('native HttpRouter route declarations', () => {
  const plainBody = 'return yield* Effect.void; });';
  const recoveredBody =
    "return yield* Effect.void; }, Effect.catchTag('Unavailable', () => Effect.void));";
  const native = `
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import { Effect } from 'effect';
import { HttpRouter } from 'effect/http';
import { fixtureApi } from '../shared/api.ts';
const handlers = HttpApiBuilder.group(fixtureApi, 'fixture', h => h.handle('get', () => Effect.void));
const routePath = '/live-changes';
const serveRoute = Effect.fn('LiveChanges.serve')(function* serve() { ${plainBody}
const transport = HttpRouter.add('GET', routePath, serveRoute);
export default assembleEffectBffRuntime({ api: fixtureApi, handlers, transport });
`;
  const recovered = native.replace(plainBody, recoveredBody);

  test('accepts immutable route paths and named Effect.fn handlers with catchTag recovery', () => {
    for (const source of [
      native,
      recovered,
      native.replace("Effect.fn('LiveChanges.serve')(", 'Effect.fn('),
      native.replace(
        "const routePath = '/live-changes';",
        "const livePath = '/live-changes'; const routePath = livePath;",
      ),
      native.replace(
        'routePath, serveRoute',
        "'/live-changes', () => Effect.void",
      ),
    ])
      expect(violation(source)).toBeUndefined();
  });

  test('proves the production shape: a route module exporting a path constant and a recovered handler', () => {
    const routeModule = `import { Effect } from 'effect';
import { HttpRouter } from 'effect/http';
export const LIVE_CHANGES_PATH = '/live-changes';
const serveLiveChanges = Effect.fn('LiveChanges.serve')(
  function* serveLiveChanges(request) { return yield* Effect.succeed(request); },
  Effect.catchTag('LiveScopeUnavailable', ({ status }) => Effect.succeed(status)),
);
export const LiveChangesRouteLive = HttpRouter.add('GET', LIVE_CHANGES_PATH, serveLiveChanges);`;
    const entrySource = native
      .replace(
        "import { fixtureApi } from '../shared/api.ts';",
        "import { fixtureApi } from '../shared/api.ts';\nimport { LiveChangesRouteLive } from './live-changes/transport.ts';",
      )
      .replace(
        'handlers, transport }',
        'handlers, transport: LiveChangesRouteLive }',
      );
    const resolveWith = (source: string) => (specifier: string) =>
      specifier === './live-changes/transport.ts'
        ? { id: '/fixture/api/live-changes/transport.ts', source }
        : specifier === '../shared/api.ts'
          ? {
              id: '/fixture/shared/api.ts',
              source: 'export const fixtureApi = {};',
            }
          : undefined;
    expect(violation(entrySource, resolveWith(routeModule))).toBeUndefined();
    for (const invalid of [
      routeModule.replace(
        'export const LIVE_CHANGES_PATH',
        'export let LIVE_CHANGES_PATH',
      ),
      routeModule.replace("'/live-changes'", "'live-changes'"),
      routeModule.replace(
        "Effect.catchTag('LiveScopeUnavailable',",
        'Effect.tap(',
      ),
      `${routeModule}\nEffect.catchTag = () => undefined;`,
    ])
      expect(violation(entrySource, resolveWith(invalid))).toBeDefined();
  });

  test('rejects malformed, mutable, shadowed and cyclic route declarations', () => {
    for (const invalid of [
      native.replace("'/live-changes'", "'live-changes'"),
      native.replace("'GET', routePath", "'INVALID', routePath"),
      native.replace('routePath, serveRoute', 'routePath, {}'),
      native.replace(
        "const routePath = '/live-changes';",
        "let routePath = '/live-changes';",
      ),
      native.replace(
        'const transport =',
        "routePath = '/other'; const transport =",
      ),
      native.replace(
        'const transport =',
        'serveRoute = () => Effect.void; const transport =',
      ),
      native.replace(
        "import { Effect } from 'effect';",
        "import { fake as Effect } from 'effect';",
      ),
      native.replace('function* serve()', 'undefined, function* serve()'),
      native.replace(plainBody, 'return yield* Effect.void; }, () => ({}));'),
      native.replace(
        plainBody,
        'return yield* Effect.void; }, Effect.catchTag(tag, () => Effect.void));',
      ),
      native.replace(
        "const routePath = '/live-changes';",
        'const routePath = alias; const alias = routePath;',
      ),
      native.replace(
        'export default assembleEffectBffRuntime',
        'assembleEffectBffRuntime',
      ),
    ])
      expect(violation(invalid)).toBeDefined();
  });

  test('retains recovery callback captures with their original lexical binding', () => {
    const captured = recovered
      .replace(
        "import { Effect } from 'effect';",
        "import { Effect } from 'effect'; import { service } from './service.ts';",
      )
      .replace(
        "const transport = HttpRouter.add('GET', routePath, serveRoute);",
        `const transport = Layer.unwrap(
  Effect.map(service, value => HttpRouter.add(
    'GET', routePath,
    Effect.fn('serve')(
      function* () { return yield* Effect.fail({ _tag: 'Unavailable' }); },
      Effect.catchTag('Unavailable', () => value.serve),
    ),
  )),
).pipe(Layer.provide(Layer.empty));`,
      );
    expect(violation(captured)).toBeUndefined();
    for (const replacement of ['() => Effect.void', '(value) => value.serve'])
      expect(
        violation(captured.replace('() => value.serve', replacement)),
        replacement,
      ).toBeDefined();
  });

  test('rejects native method writes through direct, aliased, reassigned and type-wrapped receivers', () => {
    // A literal route the previous analyzer already accepted, so every write
    // below must be what rejects it.
    const literal = native.replace(
      "HttpRouter.add('GET', routePath, serveRoute)",
      "HttpRouter.add('GET', '/health', () => Effect.void)",
    );
    const withStatement = (source: string, statement: string) =>
      source.replace('const routePath', `${statement}\nconst routePath`);
    expect(violation(literal)).toBeUndefined();
    // Rebinding an alias leaves the native namespace itself untouched.
    expect(
      violation(
        withStatement(literal, 'let alias = HttpRouter; alias = undefined;'),
      ),
    ).toBeUndefined();
    for (const mutation of [
      'HttpRouter.add = () => 123;',
      '(HttpRouter as any).add = () => 123;',
      '(<any>HttpRouter).add = () => 123;',
      'HttpRouter!.add = () => 123;',
      'delete (HttpRouter as any).add;',
      'const alias = HttpRouter; alias.add = () => 123;',
      'let alias = HttpRouter; alias.add = () => 123;',
      'var alias = HttpRouter; alias.add = () => 123;',
      'let alias = HttpRouter; (alias as any).add = () => 123;',
      'let alias = HttpRouter; alias.add = () => 123; alias = undefined;',
      'let alias; alias = HttpRouter; alias.add = () => 123;',
      'const alias = true ? HttpRouter : undefined; alias.add = () => 123;',
      'const holder = { router: HttpRouter }; holder.router.add = () => 123;',
      '({ add: HttpRouter.add } = { add: () => 123 });',
      '[(HttpRouter as any).add] = [() => 123];',
      'for (HttpRouter.add of [() => 123]);',
    ])
      expect(
        violation(withStatement(literal, mutation)),
        mutation,
      ).toBeDefined();
    for (const method of ['fn', 'catchTag'])
      for (const mutation of [
        `Effect.${method} = () => 123;`,
        `const alias = Effect; alias.${method} = () => 123;`,
        `let alias = Effect; alias.${method} = () => 123;`,
        `var alias = Effect; alias.${method} = () => 123;`,
        `(Effect as any).${method} = () => 123;`,
        `let alias = Effect; (alias as any).${method} = () => 123;`,
      ])
        expect(
          violation(withStatement(recovered, mutation)),
          mutation,
        ).toBeDefined();
  });
});
