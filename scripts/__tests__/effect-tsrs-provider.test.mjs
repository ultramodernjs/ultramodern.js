import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(
  new URL('../tsrs-dts/compiler.cjs', import.meta.url),
  'utf8',
);
const tsrsVersion = '0.25.0-ts7.1.0-beta';
const typescriptCommit = '3e9236361fa97a9e6c685f4833ac457ae2d8c50a';
const effectVersion = '0.69.0';
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
        '@tsrs/win32-arm64': tsrsVersion,
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
            gitHead: '0f82b670e4ff861840b1315f8610816229e73e3a',
            typescript: { version: '7.1.0-beta', gitHead: typescriptCommit },
          },
        },
      },
    },
  };
  const artifacts = { present: true, size: 100, owned: { kind: 'absent' } };
  change(documents, artifacts);
  const fixtureRequire = name => {
    if (
      name ===
      '../../packages/solutions/app-tools-extensions/compiler/resolve.cjs'
    ) {
      return {
        resolveOwnedEffectCompiler(options) {
          assert.equal(options.from, '/fixture/scripts/tsrs-dts/compiler.cjs');
          if (artifacts.owned instanceof Error) throw artifacts.owned;
          if (artifacts.owned.kind === 'owned') {
            for (const candidate of [
              environment.EFFECT_TSGO_BIN,
              environment.TSRS_BINARY,
            ]) {
              if (candidate && candidate !== artifacts.owned.executable)
                throw new Error('Override escapes owned identity');
            }
          }
          return artifacts.owned;
        },
      };
    }
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
    __filename: '/fixture/scripts/tsrs-dts/compiler.cjs',
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
  assert.equal(provider.getCompilerPolicy('win32', 'x64').backend, 'tsrs');
  assert.equal(provider.getCompilerPolicy('darwin', 'x64').backend, 'tsrs');
  assert.equal(provider.getCompilerPolicy('linux', 'x64').backend, 'tsrs');
  assert.equal(provider.getCompilerPolicy('linux', 'arm64').backend, 'tsrs');
  assert.equal(provider.getCompilerPolicy('win32', 'arm64').backend, 'tsrs');
});

test('an undeclared tsrs host selects Effect-Go', () => {
  const provider = loadProvider(documents => {
    delete documents[tsrsPath].optionalDependencies['@tsrs/darwin-arm64'];
  });
  assert.equal(provider.getExePath(), '/fixture/effect-go/tsc');
  assert.equal(provider.typescriptVersion, '7.0.2');
});

for (const host of [
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
    { platform: 'linux', arch: 'x64', musl: true },
  );
  assert.equal(provider.getExePath(), '/explicit/compiler');
  assert.equal(provider.warnings.length, 0);
});

test('the previous provider cannot reuse the newly reviewed capability contract', () => {
  assert.throws(
    () =>
      loadProvider(documents => {
        documents[effectPath].version = '0.67.0';
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

test('root provider prefers source payload without official platform metadata', () => {
  const executable = '/fixture/owned/tsrs';
  const provider = loadProvider((documents, artifacts) => {
    artifacts.owned = {
      kind: 'owned',
      executable,
      distribution: 'ultramodern-effect-tsrs',
    };
    delete documents[`${nativeRoot}/package.json`];
    delete documents[`${nativeRoot}/lib/upstream.json`];
    artifacts.present = false;
  });
  assert.equal(provider.getExePath(), executable);
  assert.equal(
    provider.getCompilerPolicy().distribution,
    'ultramodern-effect-tsrs',
  );
  assert.equal(provider.typescriptVersion, '7.1.0-beta');
});

test('root provider never falls back from a malformed owned payload', () => {
  assert.throws(
    () =>
      loadProvider((_, artifacts) => {
        artifacts.owned = new Error('Invalid owned manifest');
      }),
    /Invalid owned manifest/,
  );
});

for (const variable of ['EFFECT_TSGO_BIN', 'TSRS_BINARY']) {
  test(`root provider keeps ${variable} bound to owned identity`, () => {
    const executable = '/fixture/owned/tsrs';
    const change = (_, artifacts) => {
      artifacts.owned = {
        kind: 'owned',
        executable,
        distribution: 'ultramodern-effect-tsrs',
      };
    };
    assert.equal(
      loadProvider(change, { [variable]: executable }).getExePath(),
      executable,
    );
    assert.throws(
      () => loadProvider(change, { [variable]: '/outside/compiler' }),
      /escapes owned identity/,
    );
  });
}

test('launcher keeps exact Effect/tsrs/TypeScript stamp validation for owned selection', () => {
  const launcherSource = readFileSync(
    new URL('../with-effect-tsrs.mjs', import.meta.url),
    'utf8',
  )
    .replace(/^import .+;\n/gm, '')
    .replaceAll(
      'import.meta.url',
      JSON.stringify('file:///fixture/scripts/with-effect-tsrs.mjs'),
    );
  const good = `Version 7.1.0-beta+effect-tsgo.${effectVersion} (tsrs ${tsrsVersion}, microsoft/TypeScript@${typescriptCommit.slice(0, 12)})`;
  for (const [stamp, expectedStatus] of [
    [good, 0],
    [good.replace(effectVersion, '0.66.0'), 1],
    [good.replace(tsrsVersion, '0.20.0-ts7.1.0-beta'), 1],
    [good.replace(typescriptCommit.slice(0, 12), '0'.repeat(12)), 1],
    ['Version 7.1.0-beta', 1],
  ]) {
    const calls = [];
    const finished = new Error('launcher exited');
    const executable = '/fixture/owned/tsrs';
    let status;
    assert.throws(
      () =>
        vm.runInNewContext(launcherSource, {
          compilerProvider: {
            getExePath: () => executable,
            getCompilerPolicy: () => ({
              backend: 'tsrs',
              distribution: 'ultramodern-effect-tsrs',
            }),
            effectVersion,
            tsrsVersion,
            typescriptCommit,
          },
          spawnSync: (file, args, options) => {
            calls.push({ file, args, options });
            return { status: 0, stdout: stamp };
          },
          dirname: path.dirname,
          join: path.join,
          fileURLToPath: value => new URL(value).pathname,
          console: { error() {} },
          process: {
            argv: [
              'node',
              '/fixture/scripts/with-effect-tsrs.mjs',
              '--version',
            ],
            env: {},
            platform: 'darwin',
            pid: 1,
            exit: value => {
              status = value;
              throw finished;
            },
          },
        }),
      error => error === finished,
    );
    assert.equal(status, expectedStatus);
    assert.equal(calls.length, expectedStatus === 0 ? 2 : 1);
    if (expectedStatus === 0)
      assert.equal(calls[1].options.env.EFFECT_TSGO_BIN, executable);
  }
});
