import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire, SourceMap } from 'node:module';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerOwnedRoot } from '../ultramodern-production-readiness/react-rsc-worker-proof/lifecycle.mjs';

// owned-temp-dir --run router-core-mask -- node --conditions=development --test scripts/ultramodern-supply/router-core-mask.test.mjs
assert(process.env.OWNED_TEMP_DIR, 'Run through owned-temp-dir');
assert(
  process.execArgv.includes('--conditions=development'),
  'Use --conditions=development so the published router can exercise native document navigation in Node',
);

const repository = fileURLToPath(new URL('../../', import.meta.url));
const repositoryRequire = createRequire(path.join(repository, 'package.json'));
const typescript =
  process.env.ROUTER_MASK_TYPESCRIPT ??
  (() => {
    const manifestPath = repositoryRequire.resolve('typescript/package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(
      typeof manifest.bin?.tsc,
      'string',
      'The installed TypeScript package must declare its tsc binary',
    );
    return path.resolve(path.dirname(manifestPath), manifest.bin.tsc);
  })();
const directory = fs.mkdtempSync(
  path.join(process.env.OWNED_TEMP_DIR, 'router-core-mask-'),
);
const owner = `router-core-mask-${process.pid}`;
const artifacts = new Map();
const modules = new Map();
let registered = false;

// Official artifact identities recorded in the committed pnpm lockfile.
const integrities = {
  '@tanstack/router-core@1.171.37':
    '11Le36++mHNeeFIABz4C3PdTWyJ1ilOmGmANOQOypknZwC1xN674al5BUqWuimKasWane1/XSNcEx8NYNHh0+A==',
  '@tanstack/router-core@1.171.34':
    'X+19pGuuLVPvvAvPYw9v/+ktRk5cCll8AtfpBpOhDRmVgUMrfqze0467xtq8YRVVs/mmo5rVtWn/7Tp32RDBKw==',
  '@tanstack/history@1.162.5':
    'w1+YvwmTkwt5n8yUqEH3IWZ9DsmorCZW/EQ3KYHnqEgIkOZpH54NvW6/Epq3Dzb8H0ifIeYX8PExvrNLIH5FIA==',
  '@tanstack/history@1.162.4':
    'utTS5L2OkeYUzXGohL1Z8sefu1GLNOJcxe8Hd6iIdc/Xo1K1nDB2JEp4iSFhvYh33xKC9V91TxrS8qfrpoKobQ==',
  'cookie-es@3.1.1':
    'UaXxwISYJPTr9hwQxMFYZ7kNhSXboMXP+Z3TRX6f1/NyaGPfuNUZOWP1pUEb75B2HjfklIYLVRfWiFZJyC6Npg==',
  'seroval@1.6.9':
    'UeEzHwAK+yl0YLbsvROV1t5yMYEwZZ0CfKYxDvUgS2fO9Vxdf8djqVIB+OuVpuawRNPqw68LE1Du/GMsW2ZPqA==',
  'seroval-plugins@1.6.9':
    'kiDK/Tb8IWZ61WEU8pA2PDmAuw37gKph9Y77OZlD56mg0Y2g0Bg7gZ1HeHhs5d40w+nRoUq/wj08V26ilbez9g==',
};

async function fetchArtifact(identity, integrity) {
  const separator = identity.lastIndexOf('@');
  const name = identity.slice(0, separator);
  const version = identity.slice(separator + 1);
  const url = `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert(response.ok, `Cannot fetch ${identity}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(
    createHash('sha512').update(bytes).digest('base64'),
    integrity,
    `Official artifact integrity differs for ${identity}`,
  );
  const tarball = path.join(directory, `${identity.replaceAll('/', '_')}.tgz`);
  fs.writeFileSync(tarball, bytes);
  artifacts.set(identity, { name, version, tarball });
}

function extract(identity, nodeModules) {
  const { name, version, tarball } = artifacts.get(identity);
  const destination = path.join(nodeModules, name);
  fs.mkdirSync(destination, { recursive: true });
  execFileSync('tar', [
    '-xzf',
    tarball,
    '--strip-components=1',
    '-C',
    destination,
  ]);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(destination, 'package.json'), 'utf8'),
  );
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, version);
  return destination;
}

before(async () => {
  registered =
    registerOwnedRoot({
      workDir: directory,
      owner,
      ownerPid: process.pid,
    }).status === 'registered';
  const downloads = await Promise.allSettled(
    Object.entries(integrities).map(([identity, integrity]) =>
      fetchArtifact(identity, integrity),
    ),
  );
  const failures = downloads
    .filter(result => result.status === 'rejected')
    .map(result => result.reason);
  if (failures.length)
    throw new AggregateError(failures, 'Cannot authenticate router fixtures');

  for (const version of ['1.171.34', '1.171.37']) {
    const sourcePatch = path.join(
      repository,
      `patches/@tanstack__router-core@${version}.patch`,
    );
    const patchBytes = fs.readFileSync(sourcePatch);
    const patchHash = createHash('sha256').update(patchBytes).digest('hex');
    for (const state of ['baseline', 'patched']) {
      const root = path.join(directory, version, state);
      const nodeModules = path.join(root, 'node_modules');
      const packageDirectory = extract(
        `@tanstack/router-core@${version}`,
        nodeModules,
      );
      const historyVersion = version === '1.171.34' ? '1.162.4' : '1.162.5';
      extract(`@tanstack/history@${historyVersion}`, nodeModules);
      for (const dependency of [
        'cookie-es@3.1.1',
        'seroval@1.6.9',
        'seroval-plugins@1.6.9',
      ])
        extract(dependency, nodeModules);
      if (state === 'patched') {
        const manifestBefore = fs.readFileSync(
          path.join(packageDirectory, 'package.json'),
        );
        execFileSync('git', ['apply', '--whitespace=error', sourcePatch], {
          cwd: packageDirectory,
        });
        assert.deepEqual(
          fs.readFileSync(path.join(packageDirectory, 'package.json')),
          manifestBefore,
        );
      }

      const require = createRequire(path.join(root, 'package.json'));
      for (const format of ['CJS', 'ESM']) {
        const core =
          format === 'CJS'
            ? require('@tanstack/router-core')
            : await import(
                pathToFileURL(path.join(packageDirectory, 'dist/esm/index.js'))
              );
        const history =
          format === 'CJS'
            ? require('@tanstack/history')
            : await import(
                pathToFileURL(
                  path.join(nodeModules, '@tanstack/history/dist/esm/index.js'),
                )
              );
        modules.set(`${version}:${format}:${state}`, {
          core,
          history,
          patchHash,
          root,
        });
      }
    }
  }
});

after(() => {
  try {
    if (registered)
      execFileSync('disk-guardian-artifacts', [
        'release',
        directory,
        '--owner',
        owner,
      ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(
  module,
  { automatic = false, automaticSearch, history: suppliedHistory } = {},
) {
  const { core, history: historyModule } = module;
  const calls = { middleware: [], validation: [], stringify: [] };
  const middleware =
    label =>
    ({ search, next }) => {
      calls.middleware.push(label);
      const resolved = next(search);
      return { ...resolved, chain: `${resolved.chain ?? ''}${label}` };
    };
  const root = new core.BaseRootRoute({
    search: { middlewares: [middleware('root')] },
  });
  const dashboard = new core.BaseRoute({
    getParentRoute: () => root,
    path: 'dashboard',
  });
  const product = new core.BaseRoute({
    getParentRoute: () => root,
    path: 'products/$slug',
    validateSearch(search) {
      calls.validation.push('main');
      return { ...search, mode: search.mode ?? 'listing' };
    },
    search: { middlewares: [middleware('leaf')] },
  });
  const localizedProduct = new core.BaseRoute({
    getParentRoute: () => root,
    path: 'cs/produkty/$slug',
    validateSearch(search) {
      calls.validation.push('mask');
      return { ...search, mode: search.mode ?? 'public' };
    },
    search: { middlewares: [middleware('mask')] },
  });
  root.addChildren([dashboard, product, localizedProduct]);
  const history =
    suppliedHistory ??
    historyModule.createMemoryHistory({
      initialEntries: ['/store/dashboard?cart=4'],
    });
  const router = new core.RouterCore(
    {
      routeTree: root,
      history,
      isServer: true,
      origin: 'https://router.test',
      basepath: '/store',
      search: { strict: true },
      stringifySearch(search) {
        calls.stringify.push(search);
        return core.defaultStringifySearch(search);
      },
      ...(automatic
        ? {
            routeMasks: [
              {
                routeTree: root,
                from: '/products/$slug',
                to: '/cs/produkty/$slug',
                inheritSearch: true,
                hash: 'public-details',
                state: { public: true },
                ...(automaticSearch === undefined
                  ? {}
                  : { search: automaticSearch }),
              },
            ],
          }
        : {}),
    },
    () => ({
      createMutableStore: core.createNonReactiveMutableStore,
      createReadonlyStore: core.createNonReactiveReadonlyStore,
      batch: fn => fn(),
    }),
  );
  const reset = () => {
    for (const observations of Object.values(calls)) observations.length = 0;
  };
  reset();
  return { router, history, calls, reset };
}

const destination = (search = { query: 'tractor' }) => ({
  to: '/products/$slug',
  params: { slug: 'red' },
  search,
  hash: 'details',
  state: { checkout: true },
  _includeValidateSearch: true,
});

const mask = (inheritSearch = true) => ({
  to: '/cs/produkty/$slug',
  params: { slug: 'red' },
  inheritSearch,
  hash: 'public-details',
  state: { public: true },
});

function assertInherited(location, calls) {
  assert(location.maskedLocation);
  assert.strictEqual(location.maskedLocation.search, location.search);
  assert.equal(location.maskedLocation.searchStr, location.searchStr);
  assert.equal(location.search.chain, 'leafroot');
  assert.equal(location.search.mode, 'listing');
  assert.deepEqual(calls.middleware, ['root', 'leaf']);
  assert(!calls.validation.includes('mask'));
  assert.equal(calls.stringify.length, 1);
  assert.equal(location.pathname, '/products/red');
  assert.equal(location.maskedLocation.pathname, '/cs/produkty/red');
  assert.equal(location.hash, 'details');
  assert.equal(location.maskedLocation.hash, 'public-details');
  assert.equal(location.state.checkout, true);
  assert.equal(location.maskedLocation.state.public, true);
  assert.equal(
    location.maskedLocation.publicHref,
    `/store/cs/produkty/red${location.searchStr}#public-details`,
  );
}

async function documentWindow(router, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const navigations = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        set href(href) {
          navigations.push({ action: 'PUSH', href });
        },
        replace(href) {
          navigations.push({ action: 'REPLACE', href });
        },
      },
    },
  });
  try {
    router.update({ isServer: false });
    await run(navigations);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  }
}

for (const version of ['1.171.34', '1.171.37']) {
  for (const format of ['CJS', 'ESM']) {
    const label = `${version} ${format}`;
    const module = () => modules.get(`${version}:${format}:patched`);

    test(`${label}: shipped source maps embed the current TypeScript source`, () => {
      for (const state of ['baseline', 'patched']) {
        const packageDirectory = path.join(
          modules.get(`${version}:${format}:${state}`).root,
          'node_modules/@tanstack/router-core',
        );
        for (const file of ['router', 'link', 'route']) {
          const extension = format === 'CJS' ? 'cjs' : 'js';
          const map = JSON.parse(
            fs.readFileSync(
              path.join(
                packageDirectory,
                `dist/${format.toLowerCase()}/${file}.${extension}.map`,
              ),
              'utf8',
            ),
          );
          assert.equal(
            map.sourcesContent[0],
            fs.readFileSync(
              path.join(packageDirectory, `src/${file}.ts`),
              'utf8',
            ),
            `${state} ${file} source map embeds stale TypeScript`,
          );
        }
      }
    });

    test(`${label}: changed runtime source-map positions resolve to the authored TypeScript`, () => {
      const packageDirectory = path.join(
        module().root,
        'node_modules/@tanstack/router-core',
      );
      const extension = format === 'CJS' ? 'cjs' : 'js';
      const emitted = fs
        .readFileSync(
          path.join(
            packageDirectory,
            `dist/${format.toLowerCase()}/router.${extension}`,
          ),
          'utf8',
        )
        .split('\n');
      const payload = JSON.parse(
        fs.readFileSync(
          path.join(
            packageDirectory,
            `dist/${format.toLowerCase()}/router.${extension}.map`,
          ),
          'utf8',
        ),
      );
      const map = new SourceMap(payload);
      const source = payload.sourcesContent[0].split('\n');
      for (const token of [
        'dest.inheritSearch',
        'inheritedLocation.search',
        'inheritedLocation.searchStr',
      ]) {
        const line = emitted.findIndex(value => value.includes(token));
        assert(line >= 0, `Missing emitted ${token}`);
        const mapping = map.findEntry(line, emitted[line].indexOf(token));
        assert(
          mapping.originalLine >= 0,
          `Missing source position for ${token}`,
        );
        assert(
          source[mapping.originalLine].includes(token),
          `Wrong source position for ${token}: ${source[mapping.originalLine]}`,
        );
      }
    });

    test(`${label}: the official baseline lacks inherited-search support`, () => {
      const { router, calls } = fixture(
        modules.get(`${version}:${format}:baseline`),
      );
      const location = router.buildLocation({
        ...destination(),
        mask: mask(),
      });
      assert.notDeepEqual(location.maskedLocation.search, location.search);
      assert.equal(location.maskedLocation.search.chain, 'maskroot');
      assert.deepEqual(calls.middleware, ['root', 'leaf', 'root', 'mask']);
    });

    test(`${label}: the official baseline identifies native masked reload behavior`, async () => {
      const { router } = fixture(modules.get(`${version}:${format}:baseline`));
      await documentWindow(router, async navigations => {
        const options = {
          ...destination(),
          mask: mask(),
          reloadDocument: true,
        };
        const location = router.buildLocation(options);
        await router.navigate(options);
        assert.equal(navigations.length, 1);
        assert.equal(navigations[0].href, location.maskedLocation.publicHref);
        assert.notEqual(
          location.publicHref,
          location.maskedLocation.publicHref,
        );
      });
    });

    test(`${label}: explicit masks reuse resolved main search and skip mask processing`, context => {
      const { router, calls } = fixture(module());
      const location = router.buildLocation({
        ...destination(),
        mask: mask(),
      });
      assertInherited(location, calls);
      assert.equal(location.search.query, 'tractor');
      context.diagnostic(`Authenticated patch SHA-256: ${module().patchHash}`);
    });

    test(`${label}: automatic route masks reuse resolved main search`, () => {
      const { router, calls } = fixture(module(), { automatic: true });
      assertInherited(router.buildLocation(destination()), calls);
    });

    test(`${label}: inherited masks preserve native search=true and updater reads`, () => {
      const { router, history, calls, reset } = fixture(module());
      let location = router.buildLocation({
        ...destination(true),
        mask: mask(),
      });
      assertInherited(location, calls);
      assert.equal(location.search.cart, 4);

      history.push('/store/dashboard?cart=9&seed=next');
      router.updateLatestLocation();
      reset();
      let reads = 0;
      location = router.buildLocation({
        ...destination(current => {
          reads += 1;
          return { ...current, cart: current.cart + 1 };
        }),
        mask: mask(),
      });
      assertInherited(location, calls);
      assert.equal(location.search.cart, 10);
      assert.equal(location.search.seed, 'next');
      assert.equal(reads, 1);
    });

    test(`${label}: render-phase masks preserve native validation timing`, () => {
      const { router, calls, reset } = fixture(module());
      const options = { ...destination(), _includeValidateSearch: false };
      const native = router.buildLocation(options);
      reset();
      const location = router.buildLocation({ ...options, mask: mask() });
      assert.deepEqual(location.search, native.search);
      assert.strictEqual(location.maskedLocation.search, location.search);
      assert.equal(location.maskedLocation.searchStr, location.searchStr);
      assert.equal(location.search.mode, undefined);
      assert.equal(location.search.chain, 'leafroot');
      assert.deepEqual(calls.middleware, ['root', 'leaf']);
      assert.deepEqual(calls.validation, []);
      assert.equal(calls.stringify.length, 1);
    });

    test(`${label}: independent masks retain their own search middleware and validators`, () => {
      for (const inheritSearch of [undefined, false]) {
        const { router, calls } = fixture(module());
        const independentMask = {
          ...mask(inheritSearch),
          search: { query: 'public' },
        };
        if (inheritSearch === undefined) delete independentMask.inheritSearch;
        const location = router.buildLocation({
          ...destination(),
          mask: independentMask,
        });
        assert.equal(location.search.query, 'tractor');
        assert.equal(location.search.chain, 'leafroot');
        assert.equal(location.maskedLocation.search.query, 'public');
        assert.equal(location.maskedLocation.search.mode, 'public');
        assert.equal(location.maskedLocation.search.chain, 'maskroot');
        assert.deepEqual(calls.middleware, ['root', 'leaf', 'root', 'mask']);
        assert(calls.validation.includes('mask'));
        assert.equal(calls.stringify.length, 2);
      }
    });

    test(`${label}: explicit and automatic masks reject inheritSearch with search`, () => {
      for (const search of [true, false, null, {}, () => ({})]) {
        const { router } = fixture(module());
        assert.throws(
          () =>
            router.buildLocation({
              ...destination(),
              mask: { ...mask(), search },
            }),
          /inheritSearch.*search|search.*inheritSearch/iu,
        );
        const automatic = fixture(module(), {
          automatic: true,
          automaticSearch: search,
        }).router;
        assert.throws(
          () => automatic.buildLocation(destination()),
          /inheritSearch.*search|search.*inheritSearch/iu,
        );
      }
    });

    test(`${label}: installed declarations accept native masks and reject ambiguous search`, () => {
      const source = path.join(
        module().root,
        format === 'CJS' ? 'mask-types.cts' : 'mask-types.mts',
      );
      fs.writeFileSync(
        source,
        `import type { AnyRoute, AnyRouter, RouteMask, ToMaskOptions } from '@tanstack/router-core';
declare const routeTree: AnyRoute;
type Mask = ToMaskOptions<AnyRouter, string, string>;
const inherited: Mask = { to: '/cs/products', inheritSearch: true };
const independent: Mask = { to: '/cs/products', search: { query: 'tractor' } };
const explicitIndependent: Mask = { to: '/cs/products', inheritSearch: false, search: true };
// @ts-expect-error Inherited masks cannot also specify their own search.
const ambiguous: Mask = { to: '/cs/products', inheritSearch: true, search: true };
const automatic: RouteMask<AnyRoute> = { routeTree, from: '/products', to: '/cs/products', inheritSearch: true };
const automaticIndependent: RouteMask<AnyRoute> = { routeTree, from: '/products', search: { query: 'tractor' } };
// @ts-expect-error Automatic inherited masks cannot also specify their own search.
const ambiguousAutomatic: RouteMask<AnyRoute> = { routeTree, from: '/products', inheritSearch: true, search: { query: 'tractor' } };
`,
      );
      execFileSync(
        process.execPath,
        [
          typescript,
          '--noEmit',
          '--strict',
          '--module',
          'NodeNext',
          '--moduleResolution',
          'NodeNext',
          '--target',
          'ES2022',
          source,
        ],
        { cwd: module().root, timeout: 30_000, stdio: 'pipe' },
      );
    });

    test(`${label}: native document reload uses the masked public URL for push and replace`, async () => {
      const { router } = fixture(module());
      await documentWindow(router, async navigations => {
        for (const replace of [false, true]) {
          const options = {
            ...destination(),
            mask: mask(),
            reloadDocument: true,
            replace,
          };
          const expected =
            router.buildLocation(options).maskedLocation.publicHref;
          await router.navigate(options);
          assert.deepEqual(navigations.at(-1), {
            action: replace ? 'REPLACE' : 'PUSH',
            href: expected,
          });
        }
        assert.equal(navigations.length, 2);
      });
    });

    test(`${label}: native reload still blocks dangerous protocols and preserves explicit href`, async () => {
      const { router } = fixture(module());
      await documentWindow(router, async navigations => {
        const warn = console.warn;
        console.warn = () => {};
        try {
          for (const href of [
            'javascript:alert(1)',
            'data:text/html,blocked',
            'blob:https://router.test/blocked',
          ])
            await router.navigate({ href, reloadDocument: true });
        } finally {
          console.warn = warn;
        }
        assert.deepEqual(navigations, []);
        await router.navigate({
          href: 'https://external.test/products?query=tractor#details',
          replace: true,
        });
        assert.deepEqual(navigations, [
          {
            action: 'REPLACE',
            href: 'https://external.test/products?query=tractor#details',
          },
        ]);
      });
    });

    test(`${label}: the official baseline identifies native document blocker behavior`, async () => {
      const { router, history } = fixture(
        modules.get(`${version}:${format}:baseline`),
      );
      const actions = [];
      const unblock = history.block({
        async blockerFn({ action }) {
          actions.push(action);
          await Promise.resolve();
          return true;
        },
      });
      try {
        await documentWindow(router, async navigations => {
          const options = {
            ...destination(),
            reloadDocument: true,
          };
          await router.navigate(options);
          await router.navigate({ ...options, replace: true });
          assert.deepEqual(actions, ['PUSH', 'REPLACE']);
          assert.deepEqual(navigations, []);
          unblock();
          await router.navigate(options);
          assert.equal(navigations.length, 1);
        });
      } finally {
        unblock();
      }
    });

    test(`${label}: native browser history skips one before-unload prompt after an accepted document reload`, async () => {
      const handlers = new Map();
      const navigations = [];
      const unloads = [];
      const initialHref = 'https://router.test/store/dashboard?cart=4';
      const beforeUnload = () => {
        let prevented = false;
        handlers.get('beforeunload')({
          preventDefault() {
            prevented = true;
          },
        });
        return prevented;
      };
      const win = {
        document: { baseURI: initialHref },
        location: {
          pathname: '/store/dashboard',
          search: '?cart=4',
          hash: '',
          get href() {
            return initialHref;
          },
          set href(href) {
            navigations.push({ action: 'PUSH', href });
            unloads.push(beforeUnload());
          },
          replace(href) {
            navigations.push({ action: 'REPLACE', href });
            unloads.push(beforeUnload());
          },
        },
        history: {
          state: { key: 'initial', __TSR_key: 'initial', __TSR_index: 0 },
          length: 1,
          pushState() {
            assert.fail('Document navigation must not push browser history');
          },
          replaceState() {
            assert.fail('Document navigation must not replace browser history');
          },
        },
        addEventListener(name, handler) {
          handlers.set(name, handler);
        },
        removeEventListener(name) {
          handlers.delete(name);
        },
      };
      const history = module().history.createBrowserHistory({ window: win });
      const { router } = fixture(module(), { history });
      const previous = new Map(
        ['window', 'document'].map(name => [
          name,
          Object.getOwnPropertyDescriptor(globalThis, name),
        ]),
      );
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: win,
      });
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: win.document,
      });
      const actions = [];
      const unblock = history.block({
        async blockerFn({ action }) {
          actions.push(action);
          await Promise.resolve();
          return false;
        },
        enableBeforeUnload: true,
      });
      try {
        router.update({ isServer: false });
        const options = {
          ...destination(),
          mask: mask(),
          reloadDocument: true,
        };
        for (const replace of [false, true]) {
          await router.navigate({ ...options, replace });
          assert.equal(unloads.at(-1), false);
          assert.equal(beforeUnload(), true);
        }
        assert.deepEqual(actions, ['PUSH', 'REPLACE']);
        await router.navigate({ ...options, ignoreBlocker: true });
        assert.deepEqual(actions, ['PUSH', 'REPLACE']);
        assert.deepEqual(unloads, [false, false, false]);
        assert.equal(beforeUnload(), true);
        assert.deepEqual(
          navigations.map(({ action }) => action),
          ['PUSH', 'REPLACE', 'PUSH'],
        );
        const expected =
          router.buildLocation(options).maskedLocation.publicHref;
        assert(navigations.every(({ href }) => href === expected));
      } finally {
        unblock();
        history.destroy();
        for (const [name, descriptor] of previous) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else delete globalThis[name];
        }
      }
    });

    test(`${label}: native reload honors async blockers, ignoreBlocker, and unregistering`, async () => {
      const { router, history } = fixture(module());
      const actions = [];
      const unblock = history.block({
        async blockerFn({ action }) {
          actions.push(action);
          await Promise.resolve();
          return true;
        },
      });
      try {
        await documentWindow(router, async navigations => {
          const options = {
            ...destination(),
            mask: mask(),
            reloadDocument: true,
          };
          await router.navigate(options);
          await router.navigate({ ...options, replace: true });
          assert.deepEqual(navigations, []);
          assert.deepEqual(actions, ['PUSH', 'REPLACE']);
          const expected =
            router.buildLocation(options).maskedLocation.publicHref;
          await router.navigate({ ...options, ignoreBlocker: true });
          assert.deepEqual(navigations, [{ action: 'PUSH', href: expected }]);
          assert.deepEqual(actions, ['PUSH', 'REPLACE']);
          unblock();
          await router.navigate({ ...options, replace: true });
          assert.deepEqual(navigations, [
            { action: 'PUSH', href: expected },
            { action: 'REPLACE', href: expected },
          ]);
          assert.deepEqual(actions, ['PUSH', 'REPLACE']);
        });
      } finally {
        unblock();
      }
    });
  }
}
