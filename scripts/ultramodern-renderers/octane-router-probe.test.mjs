import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  diagnoseOctaneTypecheck,
  probeOctaneRouter,
  qualifyOctaneBatch,
} from './octane-router-probe.mjs';

test('batch qualification requires all eight checks, never success after a failed attempt', async () => {
  const checks = [];
  await qualifyOctaneBatch(async iteration => checks.push(iteration));
  assert.deepEqual(checks, [1, 2, 3, 4, 5, 6, 7, 8]);
  const failedChecks = [];
  const failure = new Error('TS2536');
  await assert.rejects(
    qualifyOctaneBatch(async iteration => {
      failedChecks.push(iteration);
      if (iteration === 2) throw failure;
    }),
    error => error === failure,
  );
  assert.deepEqual(failedChecks, [1, 2]);
});

test('successful typechecking does not run a diagnostic retry', async () => {
  await diagnoseOctaneTypecheck(
    async () => {},
    async () => {
      throw new Error('Must not run');
    },
  );
});

test('a passing diagnostic probe cannot turn failed acceptance green', async () => {
  const original = new Error('TS2536');
  let probes = 0;
  await assert.rejects(
    diagnoseOctaneTypecheck(
      async () => {
        throw original;
      },
      async () => {
        probes++;
      },
    ),
    error => error === original,
  );
  assert.equal(probes, 1);
});

test('probe failure retains both errors instead of replacing the acceptance failure', async () => {
  const original = new Error('TS2536');
  const diagnostic = new Error('Cannot load native project');
  await assert.rejects(
    diagnoseOctaneTypecheck(
      async () => {
        throw original;
      },
      async () => {
        throw diagnostic;
      },
    ),
    error =>
      error instanceof AggregateError &&
      error.errors[0] === original &&
      error.errors[1] === diagnostic,
  );
});

test('native discriminator uses fresh read-only APIs, an in-memory import, and retains raw errors', async t => {
  assert(process.env.OWNED_TEMP_DIR, 'Run through owned-temp-dir');
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'router-probe-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = path.join(root, 'package.json');
  fs.writeFileSync(manifest, '{}');
  const instances = [];
  const serverFS = { useOS: Symbol('OS'), noop: Symbol('noop') };
  const diagnostic = {
    code: 2536,
    text: 'native diagnostic',
    fileName: '/link.d.ts',
  };
  const load = {
    capture: async () => ({
      compiler: { path: '/selected/native', sha256: 'native-hash' },
      packages: {
        '@modern-js/renderer-octane': { manifest: { path: manifest } },
      },
    }),
    serverFS,
    API: class {
      constructor(options) {
        this.options = options;
        this.calls = [];
        instances.push(this);
      }
      createSnapshot({ openProjects: [project] }) {
        this.project = project;
        return {
          getConfiguredProject: () => ({
            program: {
              getSourceFileNames: () => ['/router-core/dist/esm/link.d.ts'],
              ...Object.fromEntries(
                [
                  'getConfigFileParsingDiagnostics',
                  'getProgramDiagnostics',
                  'getGlobalDiagnostics',
                  'getSyntacticDiagnostics',
                  'getBindDiagnostics',
                  'getSemanticDiagnostics',
                ].map(method => [
                  method,
                  () => {
                    this.calls.push(method);
                    return method === 'getSemanticDiagnostics'
                      ? [diagnostic]
                      : [];
                  },
                ]),
              ),
            },
          }),
        };
      }
      close() {
        this.closed = true;
      }
    },
  };
  const result = await probeOctaneRouter(root, load);
  assert.equal(instances.length, 4);
  assert.deepEqual(instances[0].calls, ['getSemanticDiagnostics']);
  assert.deepEqual(instances[1].calls, [
    'getConfigFileParsingDiagnostics',
    'getProgramDiagnostics',
    'getGlobalDiagnostics',
    'getSyntacticDiagnostics',
    'getBindDiagnostics',
    'getSemanticDiagnostics',
  ]);
  assert(instances.every(instance => instance.closed));
  for (const { options } of instances) {
    assert.equal(options.tsserverPath, '/selected/native');
    assert.equal(options.fs.writeFile, serverFS.noop);
    assert.equal(options.fs.removeFile, serverFS.noop);
    assert.equal(options.fs.readFile('/ordinary.ts'), serverFS.useOS);
    assert.equal(Object.keys(options.fs).length, 8);
  }
  const config = JSON.parse(
    instances[2].options.fs.readFile(instances[2].project),
  );
  assert.equal(config.extends, path.join(root, 'tsconfig.json'));
  assert.equal(config.compilerOptions.skipLibCheck, false);
  assert.match(
    instances[2].options.fs.readFile(config.files[0]),
    /@tanstack\/router-core/,
  );
  assert(!fs.existsSync(config.files[0]));
  assert(!fs.existsSync(instances[2].project));
  assert(result.observations.every(item => item.diagnostics[0] === diagnostic));
  assert(result.observations.every(item => item.routerDeclarationLoaded));
  const OriginalAPI = load.API;
  load.API = class extends OriginalAPI {
    createSnapshot(options) {
      if (options.openProjects[0] === path.join(root, 'tsconfig.json'))
        return { getConfiguredProject: () => undefined };
      return super.createSnapshot(options);
    }
  };
  const partial = await probeOctaneRouter(root, load);
  assert.equal(partial.observations[0].status, 'error');
  assert.equal(partial.observations[2].status, 'checked');
  assert(instances.every(instance => instance.closed));
});

test('successful navigation diagnostic output survives disposable workspace cleanup', async t => {
  assert(process.env.OWNED_TEMP_DIR);
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'retained-probe-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workRoot = path.join(root, 'navigation');
  const logDirectory = path.join(root, 'logs');
  fs.mkdirSync(workRoot);
  const source = fs.readFileSync(
    new URL(
      '../../tests/ultramodern-renderers/i18n/navigation-installed.mjs',
      import.meta.url,
    ),
    'utf8',
  );
  const commandSource = source.slice(
    source.indexOf('const command = async '),
    source.indexOf(
      'const generatorRoot',
      source.indexOf('const command = async '),
    ),
  );
  const command = new Function(
    'path',
    'fs',
    'workRoot',
    'witnesses',
    'runPackedNativeFederationCommand',
    'env',
    'controller',
    `${commandSource}; return command;`,
  )(
    path,
    fs,
    workRoot,
    [],
    async (_command, _args, { log }) =>
      fs.writeFileSync(log, '{"diagnostics":[{"code":2536}]}'),
    {},
    new AbortController(),
  );
  for (const label of [
    'feature-localized-navigation.octane-compiler-inputs',
    'feature-localized-navigation.octane-native-router-probe',
  ])
    await command('fake-node', [], root, label, { logDirectory });
  fs.rmSync(workRoot, { recursive: true });
  for (const label of [
    'feature-localized-navigation.octane-compiler-inputs',
    'feature-localized-navigation.octane-native-router-probe',
  ])
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(logDirectory, `${label}.log`), 'utf8'),
      ).diagnostics[0].code,
      2536,
    );
});
