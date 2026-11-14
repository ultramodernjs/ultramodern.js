import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { octaneTypecheckEvidenceEnv } from './octane-cli-evidence.mjs';

const hosted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' };
const phases = [
  'getConfigFileParsingDiagnostics',
  'getProgramDiagnostics',
  'getGlobalDiagnostics',
  'getSyntacticDiagnostics',
  'getBindDiagnostics',
  'getSemanticDiagnostics',
];

// Fabricated packages only: never import installed native tooling in these tests.
function fixture(t, mode = 'failure') {
  assert(process.env.OWNED_TEMP_DIR, 'Run through owned-temp-dir');
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'original-cli-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'disposable/app');
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs);
  function write(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  function pkg(name, exports = {}) {
    const directory = path.join(app, 'node_modules', name);
    write(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        type: 'module',
        exports: { './package.json': './package.json', ...exports },
      }),
    );
    return directory;
  }
  write(path.join(app, 'package.json'), '{}');
  const renderer = pkg('@modern-js/renderer-octane');
  write(
    path.join(renderer, 'dist/esm-node/typecheck.mjs'),
    `throw new Error('Never reexecute checker');`,
  );
  const tsrs = pkg('tsrs', { './sync': './sync.mjs', './fs': './fs.mjs' });
  const extensions = pkg('@modern-js/app-tools-extensions');
  for (const name of [
    '@effect/tsgo',
    '@tanstack/router-core',
    '@octanejs/tanstack-router',
    'octane',
  ])
    pkg(name);
  const events = path.join(logs, 'events.log');
  const event = `import fs from 'node:fs';
const event = value => fs.appendFileSync(${JSON.stringify(events)}, value + '\\n');`;
  const compiler = path.join(tsrs, 'fake-compiler');
  write(compiler, 'fake, never executed');
  write(
    path.join(extensions, 'dist/esm-node/build-config/index.mjs'),
    `${event}
export function resolveEffectTsrsCompiler() {
  event('metadata-after-close');
  if (${JSON.stringify(mode)} === 'metadata-error') throw new Error('fake metadata broke');
  return ${JSON.stringify(compiler)};
}`,
  );
  const config = path.join(app, '.octane-typecheck-fake.json');
  const source =
    mode === 'credentials'
      ? path.join(app, '.env.ts')
      : path.join(app, 'source.ts');
  const diagnostics = [
    { code: 2536, category: 1, text: 'first raw error', fileName: source },
    { code: 2536, category: 1, text: 'second raw error', fileName: source },
  ];
  write(
    path.join(tsrs, 'fs.mjs'),
    `${event}
event('import-fs');
export const serverFS = { useOS: Symbol('os'), noop: Symbol('noop') };
export const createFileSystemLayer = entries => Object.fromEntries(entries);`,
  );
  write(
    path.join(tsrs, 'sync.mjs'),
    `${event}
event('import-sync');
const mode = ${JSON.stringify(mode)};
const phases = ${JSON.stringify(phases)};
const config = ${JSON.stringify(config)};
const source = ${JSON.stringify(source)};
const raw = ${JSON.stringify(diagnostics)};
export class API {
  constructor(options = {}) { this.options = options; event('api'); }
  get createSnapshot() {
    return options => {
      const replay = Boolean(options.createPrograms);
      if (replay && mode === 'replay-error') throw new Error('fake replay broke');
      let checked = false;
      const program = {
        id: 'fake',
        getSourceFileNames() { event('graph'); return mode === 'bounds' ? Array(4097).fill(source) : [source]; },
        getCompilerOptions() { return { strict: true }; },
        getSourceFile(file) {
          assert(checked && !thisAPI.closed, 'capture before close, after semantics');
          assert(!file.includes('.env'), 'credential must never be read');
          event('source');
          if (mode === 'capture-error') throw new Error('fake capture broke');
          return { text: 'export const x = 1;' };
        },
        ...Object.fromEntries(phases.map(phase => [phase, () => {
          event((replay ? 'replay-' : 'original-') + phase);
          if (phase !== 'getSemanticDiagnostics') return [];
          checked = true;
          return mode === 'success' ? [] : raw;
        }])),
      };
      const thisAPI = this;
      this.program = program;
      this.methods = phases.map(phase => program[phase]);
      const project = { program, parsedCommandLine: {
        fileNames: [source], errors: [], projectReferences: mode === 'references' ? [{ path: '/ref' }] : [],
      } };
      return { getConfiguredProject: () => project, getProject: () => project,
        operation: { createdPrograms: [program] } };
    };
  }
  createSourceFileFromFile() {
    event('config');
    return { sourceFile: { text: '{}' }, dispose() { event('dispose'); } };
  }
  close() { assert(!this.closed, 'close once'); this.closed = true; event('close'); if (mode === 'close-error') throw new Error('original close failed'); }
}
if (mode === 'hook-error') Object.defineProperty(API.prototype, 'createSnapshot', {
  ...Object.getOwnPropertyDescriptor(API.prototype, 'createSnapshot'), configurable: false,
});
export const snapshotDescriptor = Object.getOwnPropertyDescriptor(API.prototype, 'createSnapshot');
function assert(value, message) { if (!value) throw new Error(message); }
`,
  );
  const bin = path.join(renderer, 'bin/octane-tsc.mjs');
  write(
    bin,
    `import assert from 'node:assert/strict';
import fs from 'node:fs';
import { API, snapshotDescriptor } from 'tsrs/sync';
const phases = ${JSON.stringify(phases)};
const api = new API();
const snapshot = api.createSnapshot({ openProjects: [${JSON.stringify(config)}] });
const program = snapshot.getConfiguredProject().program;
let raw;
try {
  for (const phase of phases) raw = program[phase]();
  console.log(raw.length ? 'ORIGINAL TS2536 twice' : 'ORIGINAL PASS');
  process.exitCode = raw.length ? 1 : 0;
} finally { api.close(); }
assert.deepEqual(phases.map(phase => program[phase]), api.methods);
assert(!Object.hasOwn(api, 'close'), 'instance close hook restored');
assert.deepEqual(Object.getOwnPropertyDescriptor(API.prototype, 'createSnapshot'), snapshotDescriptor);
fs.appendFileSync(${JSON.stringify(events)}, 'cli-ended\\n');
`,
  );
  const prefix = path.join(logs, 'original');
  const env = octaneTypecheckEvidenceEnv(app, prefix, {
    ...process.env,
    ...hosted,
    NODE_OPTIONS: '--no-warnings',
  });
  return {
    app,
    logs,
    events,
    prefix,
    env,
    bin,
    write,
    run(entry = bin, childEnv = env) {
      return spawnSync(process.execPath, [entry], {
        cwd: app,
        env: childEnv,
        encoding: 'utf8',
      });
    },
    evidence() {
      const files = fs
        .readdirSync(logs)
        .filter(name => /^original\.\d+\.log$/u.test(name));
      assert.equal(files.length, 1);
      return JSON.parse(fs.readFileSync(path.join(logs, files[0]), 'utf8'));
    },
    history() {
      return fs.existsSync(events)
        ? fs.readFileSync(events, 'utf8').trim().split('\n')
        : [];
    },
  };
}

test('only hosted environment injects --import and preserves NODE_OPTIONS', () => {
  for (const gate of [
    {},
    { GITHUB_ACTIONS: 'true' },
    { ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' },
  ])
    assert.equal(
      octaneTypecheckEvidenceEnv('/app', '/logs/original', gate),
      gate,
    );
  const env = octaneTypecheckEvidenceEnv('/app', '/logs/original', {
    ...hosted,
    NODE_OPTIONS: '--no-warnings',
  });
  assert.match(
    env.NODE_OPTIONS,
    /^--no-warnings --import="file:.*octane-cli-preload\.mjs"$/u,
  );
  assert.throws(
    () => octaneTypecheckEvidenceEnv('/app', '/app/log', hosted),
    /outlive/u,
  );
  assert.throws(
    () => octaneTypecheckEvidenceEnv('app', '/logs/log', hosted),
    /absolute/u,
  );
});

test('original failing public child captures raw diagnostics before close and retains exit 1', t => {
  const f = fixture(t);
  const child = f.run();
  assert.equal(child.status, 1, child.stderr);
  assert.equal(child.stdout, 'ORIGINAL TS2536 twice\n');
  const result = f.evidence();
  assert.equal(result.captureOrigin, 'original-public-cli');
  assert.equal(result.command.installedBin, f.bin);
  assert.equal(result.command.pid, child.pid);
  assert.equal(result.original.status, 'closed');
  assert.equal(result.original.exitCode, 1);
  assert.equal(
    result.captures[0].rawDiagnosticsByPhase.getSemanticDiagnostics.length,
    2,
  );
  assert.equal(result.captures[0].status, 'captured');
  assert.equal(
    result.replay.status,
    'graph-matched',
    JSON.stringify(result.captureError),
  );
  const history = f.history();
  assert(
    history.indexOf('original-getSemanticDiagnostics') <
      history.indexOf('config'),
  );
  assert(history.indexOf('source') < history.indexOf('close'));
  assert(
    history.indexOf('cli-ended') < history.indexOf('metadata-after-close'),
  );
  assert.equal(
    history.filter(event => event === 'original-getSemanticDiagnostics').length,
    1,
  );
  assert.equal(history.filter(event => event === 'dispose').length, 1);
  fs.rmSync(path.dirname(f.app), { recursive: true });
  assert.deepEqual(
    f.evidence(),
    result,
    'retained log survives navigation cleanup',
  );
});

test('successful public child keeps exit 0 with no graph, metadata or replay', t => {
  const f = fixture(t, 'success');
  const child = f.run();
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'ORIGINAL PASS\n');
  const result = f.evidence();
  assert.equal(result.captures[0].status, 'no-raw-semantic-failure');
  assert.equal(result.replay.status, 'not-run');
  assert.equal(result.rootReduction.attempts.length, 0);
  assert(
    !f
      .history()
      .some(event =>
        ['graph', 'source', 'config', 'metadata-after-close'].includes(event),
      ),
  );
});

for (const name of ['pnpm.cjs', 'unrelated.mjs', 'octane-tsc.mjs'])
  test(`${name} outside installed renderer does not import compiler, hook or write evidence`, t => {
    const f = fixture(t);
    const entry = path.join(f.app, name);
    f.write(entry, 'process.exitCode = 0;');
    const child = f.run(entry);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(f.history(), []);
    assert.deepEqual(fs.readdirSync(f.logs), []);
  });

for (const gate of [
  { GITHUB_ACTIONS: 'false' },
  { RUNNER_ENVIRONMENT: 'self-hosted' },
])
  test(`preloader is inert for ${JSON.stringify(gate)} even when manually inherited`, t => {
    const f = fixture(t);
    const child = f.run(f.bin, { ...f.env, ...gate });
    // The fake CLI itself imports sync; preloader must not import fs or observe.
    assert.equal(child.status, 1, child.stderr);
    assert(!f.history().includes('import-fs'));
    assert(!f.history().includes('config'));
    assert(!fs.readdirSync(f.logs).some(name => name.startsWith('original.')));
  });

for (const mode of [
  'capture-error',
  'replay-error',
  'credentials',
  'bounds',
  'references',
])
  test(`${mode} remains evidence-only, never replaces public exit 1`, t => {
    const f = fixture(t, mode);
    const child = f.run();
    assert.equal(child.status, 1, child.stderr);
    assert.equal(child.stdout, 'ORIGINAL TS2536 twice\n');
    const result = f.evidence();
    assert.equal(result.original.exitCode, 1);
    assert.equal(result.rootReduction.attempts.length, 0);
    if (mode === 'replay-error') assert.equal(result.replay.status, 'error');
    else if (mode === 'references')
      assert.equal(result.replay.status, 'capture-only');
    else assert.equal(result.captures[0].status, 'error');
    if (mode === 'credentials' || mode === 'bounds')
      assert(!f.history().includes('source'));
  });

for (const mode of ['metadata-error', 'hook-error', 'close-error'])
  test(`${mode} preserves public failure and records the gap without replay`, t => {
    const f = fixture(t, mode);
    const child = f.run();
    assert.equal(child.status, 1, child.stderr);
    assert.equal(child.stdout, 'ORIGINAL TS2536 twice\n');
    const result = f.evidence();
    assert.equal(result.original.exitCode, 1);
    assert(result.captureError || result.closeError);
    assert.equal(result.replay.status, 'not-run');
    assert.equal(result.rootReduction.attempts.length, 0);
    assert(!f.history().some(event => event.startsWith('replay-')));
  });

test('evidence write errors cannot turn success red or failure green', t => {
  for (const mode of ['success', 'failure']) {
    const f = fixture(t, mode);
    fs.rmSync(f.logs, { recursive: true });
    // Keep fake event sink available, but make the owned evidence filename unusable.
    fs.mkdirSync(f.logs);
    const child = f.run(f.bin, {
      ...f.env,
      ULTRAMODERN_OCTANE_EVIDENCE_LOG: path.join(f.logs, 'absent/log'),
    });
    assert.equal(child.status, mode === 'success' ? 0 : 1, child.stderr);
    assert(!fs.existsSync(path.join(f.logs, 'absent')));
  }
});
