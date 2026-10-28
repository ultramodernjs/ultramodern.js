import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rs } from '@rstest/core';
import {
  resolveInstalledEffectCompiler,
  validateConfiguredEffectCompiler,
} from '../../src/build-config/internal-effect-discovery';

rs.mock('node:child_process', () => ({ execFileSync: rs.fn() }));

const tsrsVersion = '0.20.1-ts7.1.0-beta';
const effectVersion = '0.63.0';
const tsrsCommit = '3e9236361fa97a9e6c685f4833ac457ae2d8c50a';
const nativeCommit = '2bd066d87f5bafd315be9f40889d0a60b9e58e0b';
const nativeName = `@typescript/typescript-${process.platform}-${process.arch}`;
const effectName = `@effect/tsgo-${process.platform}-${process.arch}`;
const binaryName = process.platform === 'win32' ? 'tsc.exe' : 'tsc';
const tsrsBinaryName = process.platform === 'win32' ? 'tsrs.exe' : 'tsrs';

function writeFile(filename: string, content: string): void {
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, content);
}

function writeJson(filename: string, content: unknown): void {
  writeFile(filename, JSON.stringify(content));
}

function fixture(target: string) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'effect-platform-capability-')),
  );
  const owner = join(root, 'node_modules/tsrs');
  const provider = join(root, 'node_modules/@effect/tsgo');
  const platform = join(root, 'node_modules', effectName);
  const tsrsManifest = {
    name: 'tsrs',
    type: 'module',
    version: tsrsVersion,
    tsrs: { typescriptVersion: '7.1.0-beta', typescriptCommit: tsrsCommit },
    optionalDependencies: { [target]: tsrsVersion },
  };
  writeJson(join(owner, 'package.json'), tsrsManifest);
  writeFile(
    join(owner, 'lib/platform.js'),
    `export const getPlatformPackageName = () => ${JSON.stringify(target)};`,
  );
  writeJson(join(provider, 'package.json'), {
    name: '@effect/tsgo',
    version: effectVersion,
    bin: { 'effect-tsgo': 'dist/effect-tsgo.cjs' },
  });
  writeFile(
    join(provider, 'dist/effect-tsgo.cjs'),
    'throw new Error("Discovery must not execute the provider CLI");',
  );
  writeJson(join(platform, 'package.json'), {
    name: effectName,
    version: effectVersion,
  });
  const upstream = {
    schemaVersion: 5,
    tags: { typescript: { latest: '7.0.2' } },
    components: {
      typescript: {
        '7.0.2': { gitHead: nativeCommit, provider: 'typescript-go' },
      },
      tsrs: {
        [tsrsVersion]: {
          gitHead: 'd197eeea709616d61930c2bd5eac048471e404b8',
          typescript: { version: '7.1.0-beta', gitHead: tsrsCommit },
        },
      },
    },
  };
  const metadataPath = join(platform, 'lib/upstream.json');
  writeJson(metadataPath, upstream);
  writeJson(join(root, 'node_modules/typescript/package.json'), {
    name: 'typescript',
    version: '7.0.2',
    gitHead: nativeCommit,
  });
  writeJson(join(root, 'node_modules', nativeName, 'package.json'), {
    name: nativeName,
    version: '7.0.2',
    gitHead: nativeCommit,
  });
  writeFile(
    join(root, 'node_modules', nativeName, 'lib', binaryName),
    'upstream native TypeScript',
  );
  const effectGo = join(platform, 'lib', binaryName);
  const effectTsrs = join(
    platform,
    'artifacts/tsrs',
    tsrsVersion,
    tsrsBinaryName,
  );
  writeFile(effectGo, 'Effect-enabled TypeScript-Go');
  writeFile(effectTsrs, 'Effect-enabled tsrs');
  return {
    root,
    owner,
    provider,
    from: join(root, 'modern.config.ts'),
    tsrsManifest,
    metadataPath,
    upstream,
    effectGo,
    effectTsrs,
  };
}

let current: ReturnType<typeof fixture> | undefined;
beforeEach(() => {
  rs.stubEnv('TSRS_BINARY', '');
  rs.mocked(execFileSync).mockReset();
  rs.mocked(execFileSync).mockReturnValue(
    `Version 7.1.0-beta+effect-tsgo.${effectVersion} (tsrs ${tsrsVersion}, microsoft/TypeScript@${tsrsCommit.slice(0, 12)})`,
  );
});
afterEach(() => {
  if (current) rmSync(current.root, { recursive: true, force: true });
  current = undefined;
  rs.unstubAllEnvs();
  rs.restoreAllMocks();
});

test.each(['@tsrs/linux-x64-musl', '@tsrs/linux-arm64-musl'])(
  'selects real Effect-Go for declared but unsupported replacement %s',
  target => {
    current = fixture(target);
    const warning = rs.spyOn(console, 'warn').mockImplementation(() => {});
    // Even absent tsrs artifacts are irrelevant on a genuinely unsupported host.
    rmSync(current.effectTsrs);
    assert.equal(
      resolveInstalledEffectCompiler(current.from),
      current.effectGo,
    );
    assert.equal(rs.mocked(execFileSync).mock.calls.length, 0);
    assert.match(
      warning.mock.calls.flat().join('\n'),
      /does not provide a tsrs replacement.*TypeScript-Go/u,
    );
  },
);

test.each([
  '@tsrs/darwin-arm64',
  '@tsrs/darwin-x64',
  '@tsrs/win32-x64',
  '@tsrs/linux-x64-gnu',
  '@tsrs/linux-arm64-gnu',
])('selects verified Effect tsrs for supported replacement %s', target => {
  current = fixture(target);
  assert.equal(
    resolveInstalledEffectCompiler(current.from),
    current.effectTsrs,
  );
  assert.equal(rs.mocked(execFileSync).mock.calls.length, 1);
});

test.each([
  'missing-artifact',
  'empty-artifact',
  'mismatched-metadata',
  'invalid-stamp',
  'execution-failure',
])(
  'does not hide supported tsrs %s behind an available Effect-Go artifact',
  mutation => {
    current = fixture('@tsrs/darwin-arm64');
    if (mutation === 'missing-artifact') rmSync(current.effectTsrs);
    if (mutation === 'empty-artifact') writeFileSync(current.effectTsrs, '');
    if (mutation === 'mismatched-metadata') {
      current.upstream.components.tsrs[tsrsVersion].typescript.gitHead =
        '0'.repeat(40);
      writeJson(current.metadataPath, current.upstream);
    }
    if (mutation === 'invalid-stamp') {
      rs.mocked(execFileSync).mockReturnValue('Version 7.1.0-beta');
    }
    if (mutation === 'execution-failure') {
      rs.mocked(execFileSync).mockImplementation(() => {
        throw new Error('Broken supported executable');
      });
    }
    assert.throws(() => resolveInstalledEffectCompiler(current!.from));
  },
);

test.each(['@tsrs/darwin-arm64', '@tsrs/win32-x64'])(
  'does not treat mismatched declared target metadata as unsupported: %s',
  target => {
    current = fixture(target);
    current.tsrsManifest.optionalDependencies[target] = '0.0.0';
    writeJson(join(current.owner, 'package.json'), current.tsrsManifest);
    assert.throws(
      () => resolveInstalledEffectCompiler(current!.from),
      /Native tsrs target version does not match/u,
    );
  },
);

test('an undeclared upstream tsrs host selects Effect-Go', () => {
  current = fixture('@tsrs/win32-arm64');
  current.tsrsManifest.optionalDependencies = {
    '@tsrs/darwin-arm64': tsrsVersion,
  };
  writeJson(join(current.owner, 'package.json'), current.tsrsManifest);
  assert.equal(resolveInstalledEffectCompiler(current.from), current.effectGo);
});

test('a new provider version requires a reviewed capability contract', () => {
  current = fixture('@tsrs/win32-x64');
  writeJson(join(current.provider, 'package.json'), {
    name: '@effect/tsgo',
    version: '0.60.0',
    bin: { 'effect-tsgo': 'dist/effect-tsgo.cjs' },
  });
  assert.throws(
    () => resolveInstalledEffectCompiler(current!.from),
    /Unreviewed Effect tsrs capability contract/u,
  );
});

test('unsupported automatic replacement hosts still validate explicit compilers', () => {
  current = fixture('@tsrs/linux-x64-musl');
  rs.mocked(execFileSync).mockReturnValue('Version 7.0.2+effect-tsgo.0.63.0');
  validateConfiguredEffectCompiler(current.effectGo, current.from);
  rs.mocked(execFileSync).mockReturnValue('Version 7.0.2');
  assert.throws(
    () => validateConfiguredEffectCompiler(current!.effectGo, current!.from),
    /must select an Effect-enabled native compiler/u,
  );
});

test('TSRS_BINARY remains a validated candidate on an unsupported automatic replacement host', () => {
  current = fixture('@tsrs/linux-x64-musl');
  rs.stubEnv('TSRS_BINARY', current.effectTsrs);
  assert.equal(
    resolveInstalledEffectCompiler(current.from),
    current.effectTsrs,
  );
  rs.mocked(execFileSync).mockReturnValue('Version 7.1.0-beta');
  assert.throws(
    () => resolveInstalledEffectCompiler(current!.from),
    /Effect-enabled tsrs matching/u,
  );
});

test('an explicit tsrs compiler still requires matching replacement metadata', () => {
  current = fixture('@tsrs/win32-x64');
  current.upstream.components.tsrs[tsrsVersion].typescript.gitHead = '0'.repeat(
    40,
  );
  writeJson(current.metadataPath, current.upstream);
  assert.throws(
    () => validateConfiguredEffectCompiler(current!.effectTsrs, current!.from),
    /Effect replacement metadata does not match tsrs/u,
  );
});
