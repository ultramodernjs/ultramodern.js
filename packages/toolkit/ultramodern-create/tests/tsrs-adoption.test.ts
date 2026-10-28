import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { yaml } from '@modern-js/utils';
import { generateUltramodernWorkspace } from '../src/ultramodern-workspace';
import { shellApp } from '../src/ultramodern-workspace/descriptors';
import {
  createAppPackage,
  createRootPackageJson,
} from '../src/ultramodern-workspace/package-json';
import { ULTRAMODERN_WORKSPACE_POLICY } from '../src/ultramodern-workspace/policy';
import type {
  JsonValue,
  ResolvedPackageSource,
} from '../src/ultramodern-workspace/types';
import {
  BOOTSTRAP_RELEASE_AGE_EXCEPTIONS,
  COMPILER_TRUST_EXCEPTIONS,
  EFFECT_RUNTIME_RELEASE_AGE_EXCEPTIONS,
  EFFECT_TSGO_VERSION,
  EFFECT_VERSION,
  TSRS_VERSION,
  TYPESCRIPT_VERSION,
} from '../src/ultramodern-workspace/versions';
import { GENERATED_POSTINSTALL_SCRIPT } from '../src/ultramodern-workspace/workspace-script-plan';

function record(value: JsonValue) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, JsonValue>;
}

test.each(['workspace', 'install'] as const)(
  '%s manifests use one exact compiler cohort for every renderer',
  strategy => {
    const source = {
      strategy,
      modernPackageVersion: '3.8.3',
    } satisfies ResolvedPackageSource;
    assert.equal(TSRS_VERSION, '0.20.1-ts7.1.0-beta');
    assert.equal(EFFECT_TSGO_VERSION, '0.63.0');
    assert.equal(EFFECT_VERSION, '4.0.7');
    assert.equal(TYPESCRIPT_VERSION, '7.0.2');
    for (const renderer of ['react', 'solid', 'octane', 'none'] as const) {
      const app =
        renderer === 'none'
          ? { ...shellApp, surfaceProfile: 'api-only' as const }
          : { ...shellApp, renderer };
      const root = record(
        createRootPackageJson('tsrs-cohort', source, [], undefined, [], app),
      );
      const generatedApp = record(
        createAppPackage('tsrs-cohort', app, source, false),
      );
      for (const manifest of [root, generatedApp]) {
        const dependencies = record(manifest.devDependencies);
        assert.equal(dependencies.tsrs, TSRS_VERSION);
        assert.equal(dependencies['@effect/tsgo'], EFFECT_TSGO_VERSION);
        assert.equal(dependencies.typescript, TYPESCRIPT_VERSION);
        // This alias still supplies the native AST API to tooling, not tsrs.
        assert.equal(
          dependencies['@typescript/native'],
          'npm:typescript@7.0.2',
        );
      }
      assert.equal(
        record(root.scripts).postinstall,
        GENERATED_POSTINSTALL_SCRIPT,
      );
    }
    const producer = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'),
    );
    assert.equal(producer.dependencies.tsrs, TSRS_VERSION);
    assert.equal(producer.dependencies['@effect/tsgo'], EFFECT_TSGO_VERSION);
    assert.equal(producer.dependencies.typescript, TYPESCRIPT_VERSION);
  },
);

test('compiler adoption preserves strict supply-chain and diagnostic policies', () => {
  const policy = ULTRAMODERN_WORKSPACE_POLICY.pnpm;
  assert.equal(policy.minimumReleaseAge, 1440);
  assert.equal(policy.minimumReleaseAgeStrict, true);
  assert.equal(policy.minimumReleaseAgeIgnoreMissingTime, false);
  assert.equal(policy.trustPolicy, 'no-downgrade');
  assert.equal(policy.blockExoticSubdeps, true);
  assert.equal(policy.strictDepBuilds, true);
  const require = createRequire(import.meta.url);
  const compilerExceptions = ['tsrs', '@effect/tsgo'].flatMap(name => {
    const manifest = JSON.parse(
      fs.readFileSync(require.resolve(`${name}/package.json`), 'utf8'),
    );
    if (name === 'tsrs') {
      assert.equal(manifest.tsrs.typescriptVersion, '7.1.0-beta');
      assert.match(manifest.tsrs.typescriptCommit, /^[a-f\d]{40}$/u);
      assert.notEqual(manifest.tsrs.typescriptVersion, TYPESCRIPT_VERSION);
    }
    return [
      `${name}@${manifest.version}`,
      ...Object.entries(manifest.optionalDependencies).map(
        ([platform, version]) => `${platform}@${version}`,
      ),
    ];
  });
  assert.deepEqual(
    policy.minimumReleaseAgeExclude,
    [...compilerExceptions, ...EFFECT_RUNTIME_RELEASE_AGE_EXCEPTIONS].sort(),
  );
  assert.deepEqual(policy.trustPolicyExclude, COMPILER_TRUST_EXCEPTIONS);
  const producer = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'),
  );
  assert.deepEqual(
    producer.ultramodern.bootstrapReleaseAgeExclude,
    EFFECT_RUNTIME_RELEASE_AGE_EXCEPTIONS,
  );
  assert.equal(policy.minimumReleaseAgeExclude.length, 18);
  assert(
    policy.minimumReleaseAgeExclude.every(
      selector =>
        !selector.includes('*') &&
        !selector.includes('^') &&
        !selector.includes('>'),
    ),
  );
  const diagnosticPolicy = fs.readFileSync(
    path.resolve(__dirname, '../templates/tsconfig.base.json'),
    'utf8',
  );
  assert.doesNotMatch(
    diagnosticPolicy,
    /ignoreEffect(?:Errors|Warnings)InTscExitCode"\s*:\s*true/u,
  );
});

test('fresh workspace YAML admits only exact reviewed compiler and runtime releases', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'um-tsrs-policy-'));
  try {
    const workspace = path.join(root, 'workspace');
    await generateUltramodernWorkspace({
      targetDir: workspace,
      packageName: 'compiler-policy',
      modernVersion: '3.8.3',
      generateAgentFiles: false,
      enableTailwind: false,
      packageSource: { strategy: 'workspace' },
    });
    const policy = yaml.load(
      fs.readFileSync(path.join(workspace, 'pnpm-workspace.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    assert.deepEqual(
      policy.minimumReleaseAgeExclude,
      BOOTSTRAP_RELEASE_AGE_EXCEPTIONS,
    );
    assert.equal(policy.minimumReleaseAge, 1440);
    assert.equal(policy.minimumReleaseAgeStrict, true);
    assert.equal(policy.minimumReleaseAgeIgnoreMissingTime, false);
    assert.equal(policy.trustPolicy, 'no-downgrade');
    assert.deepEqual(policy.trustPolicyExclude, COMPILER_TRUST_EXCEPTIONS);
    assert.deepEqual(
      policy.ultramodernManagedCompilerTrustExclusions,
      COMPILER_TRUST_EXCEPTIONS,
    );
    assert.equal(policy.blockExoticSubdeps, true);
    assert.equal(policy.strictDepBuilds, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeExecutable(file: string, source: string) {
  fs.writeFileSync(file, `#!${process.execPath}\n${source}`, {
    mode: 0o755,
  });
}

test.skipIf(process.platform === 'win32').each([0, 37])(
  'postinstall checks the compiler before skills and preserves exit %s',
  status => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'um-tsrs-install-'));
    try {
      const log = path.join(root, 'commands.jsonl');
      writeExecutable(
        path.join(root, 'ultramodern-create'),
        `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (${status} !== 0) console.error('Effect compiler unavailable');
process.exit(${status});
`,
      );
      const result = spawnSync(GENERATED_POSTINSTALL_SCRIPT, {
        cwd: root,
        shell: true,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}`,
        },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, status, result.stderr);
      assert.deepEqual(
        fs
          .readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map(line => JSON.parse(line)),
        [
          ['ultramodern', 'compiler-prepare'],
          ...(status === 0
            ? [['ultramodern', 'skills', 'install', '--postinstall']]
            : []),
        ],
      );
      if (status !== 0)
        assert.match(result.stderr, /Effect compiler unavailable/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

const typecheckScript = path.resolve(
  __dirname,
  '../templates/workspace-scripts/ultramodern-typecheck.mjs',
);

test.skipIf(process.platform === 'win32').each([
  {
    args: ['--build', 'tsconfig.json'],
    expected: [
      '--build',
      'tsconfig.json',
      '--pretty',
      'false',
      '--stopBuildOnErrors',
    ],
    status: 0,
    assignment: undefined,
  },
  {
    args: ['--project', 'apps/shell/tsconfig.json', '--skipLibCheck'],
    expected: [
      '--project',
      'apps/shell/tsconfig.json',
      '--noEmit',
      '--pretty',
      'false',
      '--skipLibCheck',
    ],
    status: 1,
    assignment: 'locality',
  },
  {
    args: ['--emit', '--project', 'packages/shared/tsconfig.json'],
    expected: [
      '--project',
      'packages/shared/tsconfig.json',
      '--pretty',
      'false',
    ],
    status: 2,
    assignment: 'go',
  },
  {
    args: ['--build', 'tsconfig.json'],
    expected: [
      '--build',
      'tsconfig.json',
      '--pretty',
      'false',
      '--stopBuildOnErrors',
    ],
    status: 143,
    assignment: 'go',
  },
])(
  'installed typecheck forwards $args without build-mode custom flags',
  ({ args, expected, status, assignment }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'um-tsrs-args-'));
    try {
      const compiler = path.join(root, 'compiler.cjs');
      const log = path.join(root, 'compiler.json');
      writeExecutable(
        compiler,
        `if (process.argv[2] === '--version') {
  console.log('Version 7.0.2+effect-tsgo.0.63.0');
  process.exit(0);
}
require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({
  args: process.argv.slice(2),
  assignment: process.env.TSRS_CHECKER_ASSIGNMENT,
  inherited: process.env.ULTRAMODERN_TEST_TOOLCHAIN,
  cwd: process.cwd()
}));
if (${status} === 143) process.kill(process.pid, 'SIGTERM');
else process.exit(${status});
`,
      );
      const result = spawnSync(process.execPath, [typecheckScript, ...args], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          EFFECT_TSGO_BIN: compiler,
          ULTRAMODERN_WORKSPACE_ROOT: root,
          ULTRAMODERN_TEST_TOOLCHAIN: 'preserved',
          TSRS_CHECKER_ASSIGNMENT: assignment,
        },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, status, result.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')), {
        args: expected,
        assignment: assignment || 'locality',
        inherited: 'preserved',
        cwd: fs.realpathSync(root),
      });
      assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
