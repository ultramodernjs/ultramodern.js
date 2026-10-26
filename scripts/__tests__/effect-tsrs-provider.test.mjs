import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(
  new URL('../tsrs-dts/compiler.cjs', import.meta.url),
  'utf8',
);
const tsrsVersion = '0.20.0-ts7.1.0-beta';
const typescriptCommit = '3e9236361fa97a9e6c685f4833ac457ae2d8c50a';
const effectVersion = '0.59.0';
const tsrsPath = '/fixture/node_modules/tsrs/package.json';
const effectPath = '/fixture/node_modules/@effect/tsgo/package.json';
const nativeRoot = '/fixture/node_modules/@effect/tsgo-darwin-arm64';

function loadProvider(
  change = () => {},
  environment = {},
  host = { platform: 'darwin', arch: 'arm64' },
) {
  const documents = {
    [tsrsPath]: {
      name: 'tsrs',
      version: tsrsVersion,
      tsrs: { typescriptVersion: '7.1.0-beta', typescriptCommit },
      optionalDependencies: {
        '@tsrs/darwin-arm64': tsrsVersion,
        '@tsrs/darwin-x64': tsrsVersion,
        '@tsrs/win32-x64': tsrsVersion,
        '@tsrs/linux-x64-gnu': tsrsVersion,
        '@tsrs/linux-arm64-gnu': tsrsVersion,
        '@tsrs/linux-x64-musl': tsrsVersion,
        '@tsrs/linux-arm64-musl': tsrsVersion,
      },
    },
    [effectPath]: { name: '@effect/tsgo', version: effectVersion },
    [`${nativeRoot}/package.json`]: {
      name: '@effect/tsgo-darwin-arm64',
      version: effectVersion,
    },
    [`${nativeRoot}/lib/upstream.json`]: {
      schemaVersion: 5,
      components: {
        tsrs: {
          [tsrsVersion]: {
            gitHead: 'd197eeea709616d61930c2bd5eac048471e404b8',
            typescript: { version: '7.1.0-beta', gitHead: typescriptCommit },
          },
        },
      },
    },
  };
  const artifacts = { present: true, size: 100 };
  change(documents, artifacts);
  const fixtureRequire = name => {
    if (name === 'node:fs') {
      return {
        readFileSync(filename) {
          if (!Object.hasOwn(documents, filename)) {
            throw new Error(`Missing fixture metadata: ${filename}`);
          }
          return JSON.stringify(documents[filename]);
        },
        statSync() {
          if (!artifacts.present) throw new Error('Missing supported binary');
          return { isFile: () => true, size: artifacts.size };
        },
      };
    }
    if (name === 'node:module') return { createRequire: () => fixtureRequire };
    if (name === 'node:path') return path;
    if (name === path.join(path.dirname(tsrsPath), 'lib/platform.js')) {
      return {
        getPlatformPackageName: (os = host.platform, arch = host.arch) =>
          `@tsrs/${os}-${arch}${os === 'linux' ? (host.musl ? '-musl' : '-gnu') : ''}`,
      };
    }
    if (name === '@effect/tsgo/lib/getExePath') {
      return { default: () => '/fixture/effect-go/tsc' };
    }
    if (name === 'typescript/package.json') return { version: '7.0.2' };
    throw new Error(`Unexpected fixture require: ${name}`);
  };
  fixtureRequire.resolve = name => {
    if (name === 'tsrs/package.json') return tsrsPath;
    if (name === '@effect/tsgo/package.json') return effectPath;
    if (name === '@effect/tsgo-darwin-arm64/package.json') {
      return `${nativeRoot}/package.json`;
    }
    throw new Error(`Unexpected fixture resolution: ${name}`);
  };
  const module = { exports: {} };
  const warnings = [];
  vm.runInNewContext(source, {
    module,
    require: fixtureRequire,
    console: { warn: message => warnings.push(message) },
    process: { platform: host.platform, arch: host.arch, env: environment },
  });
  return { ...module.exports, warnings };
}

test('root provider selects the read-only metadata-bound Effect tsrs artifact', () => {
  const provider = loadProvider();
  assert.equal(
    provider.getExePath(),
    `${nativeRoot}/artifacts/tsrs/${tsrsVersion}/tsrs`,
  );
  assert.equal(provider.typescriptVersion, '7.1.0-beta');
  assert.equal(provider.typescriptCommit, typescriptCommit);
  assert.equal(provider.getCompilerPolicy('win32', 'x64').backend, 'effect-go');
  assert.equal(
    provider.getCompilerPolicy('darwin', 'x64').backend,
    'effect-go',
  );
  assert.equal(provider.getCompilerPolicy('linux', 'x64').backend, 'tsrs');
  assert.equal(provider.getCompilerPolicy('linux', 'arm64').backend, 'tsrs');
  assert.equal(
    provider.getCompilerPolicy('win32', 'arm64').backend,
    'effect-go',
  );
});

test('an undeclared tsrs host selects Effect-Go', () => {
  const provider = loadProvider(documents => {
    delete documents[tsrsPath].optionalDependencies['@tsrs/darwin-arm64'];
  });
  assert.equal(provider.getExePath(), '/fixture/effect-go/tsc');
  assert.equal(provider.typescriptVersion, '7.0.2');
});

for (const host of [
  { platform: 'win32', arch: 'x64' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'linux', arch: 'x64', musl: true },
  { platform: 'linux', arch: 'arm64', musl: true },
]) {
  test(`Effect-Go handles declared tsrs host ${host.platform}-${host.arch}${host.musl ? '-musl' : ''} without a packaged Effect tsrs replacement`, () => {
    const provider = loadProvider(undefined, {}, host);
    assert.equal(provider.getCompilerPolicy().backend, 'effect-go');
    assert.equal(provider.getExePath(), '/fixture/effect-go/tsc');
    assert.equal(provider.typescriptVersion, '7.0.2');
    assert.match(provider.warnings.join('\n'), /using Effect-Go/);
    assert.equal(provider.getExePath(), '/fixture/effect-go/tsc');
    assert.equal(provider.warnings.length, 1);
  });
}

test('an explicit compiler remains selected on an unsupported replacement host', () => {
  const provider = loadProvider(
    undefined,
    { EFFECT_TSGO_BIN: '/explicit/compiler' },
    { platform: 'win32', arch: 'x64' },
  );
  assert.equal(provider.getExePath(), '/explicit/compiler');
  assert.equal(provider.warnings.length, 0);
});

test('a new provider version requires a reviewed capability contract', () => {
  assert.throws(
    () =>
      loadProvider(documents => {
        documents[effectPath].version = '0.60.0';
      }),
    /Unreviewed Effect tsrs capability contract/,
  );
});

test('a broken supported artifact never selects Effect-Go', () => {
  const missing = loadProvider((_, artifacts) => {
    artifacts.present = false;
  });
  assert.throws(() => missing.getExePath(), /Missing supported binary/);
  const empty = loadProvider((_, artifacts) => {
    artifacts.size = 0;
  });
  assert.throws(() => empty.getExePath(), /nonempty file/);
});

test('root provider rejects mismatched native and upstream metadata', () => {
  for (const change of [
    documents => {
      documents[`${nativeRoot}/package.json`].version = '0.58.0';
    },
    documents => {
      documents[`${nativeRoot}/package.json`].name = '@effect/other-platform';
    },
    documents => {
      documents[`${nativeRoot}/lib/upstream.json`].schemaVersion = 4;
    },
    documents => {
      documents[`${nativeRoot}/lib/upstream.json`].components.tsrs[
        tsrsVersion
      ].typescript.gitHead = '0'.repeat(40);
    },
    documents => {
      delete documents[`${nativeRoot}/lib/upstream.json`].components.tsrs[
        tsrsVersion
      ].gitHead;
    },
  ]) {
    const provider = loadProvider(change);
    assert.throws(
      () => provider.getExePath(),
      /does not provide matching tsrs/,
    );
  }
});

test('root provider rejects corrupt capability and embedded TypeScript metadata', () => {
  for (const change of [
    documents => {
      documents[tsrsPath].optionalDependencies = {};
    },
    documents => {
      documents[tsrsPath].tsrs.typescriptCommit = 'not-a-commit';
    },
    documents => {
      documents[tsrsPath].tsrs.typescriptVersion = '7.0.2';
    },
  ]) {
    assert.throws(() => loadProvider(change), /Invalid tsrs platform metadata/);
  }
  assert.throws(
    () =>
      loadProvider(documents => {
        documents[tsrsPath].optionalDependencies['@tsrs/darwin-arm64'] = 'bad';
      }),
    /Native tsrs dependency does not match/,
  );
  assert.throws(
    () =>
      loadProvider(
        documents => {
          documents[tsrsPath].optionalDependencies['@tsrs/win32-x64'] = 'bad';
        },
        {},
        { platform: 'win32', arch: 'x64' },
      ),
    /Native tsrs dependency does not match/,
  );
});
