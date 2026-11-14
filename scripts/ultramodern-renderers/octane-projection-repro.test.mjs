import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { probeOctaneProjection } from './octane-projection-repro.mjs';

const phases = [
  'getConfigFileParsingDiagnostics',
  'getProgramDiagnostics',
  'getGlobalDiagnostics',
  'getSyntacticDiagnostics',
  'getBindDiagnostics',
  'getSemanticDiagnostics',
];

function fixture(
  t,
  { throwWrapper, throwCapture, throwReplay, mismatch, references } = {},
) {
  assert(process.env.OWNED_TEMP_DIR, 'Run through owned-temp-dir');
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'projection-repro-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, '.octane-typecheck-virtual.json');
  const projected = path.join(root, 'z.tsrx.tsx');
  const ordinary = path.join(root, 'a.ts');
  const roots = [projected, ordinary];
  // Root order and program order are deliberately different.
  const sourceOrder = [ordinary, projected];
  const contents = new Map([
    [ordinary, 'export const a = 1;\n'],
    [projected, 'export const z: number = "projected";\n'],
  ]);
  const compilerOptions = {
    module: 200,
    moduleResolution: 100,
    strict: true,
    noEmit: true,
    noCheck: false,
    skipLibCheck: false,
    skipDefaultLibCheck: false,
    configFilePath: configPath,
  };
  const config = JSON.stringify({ files: roots, compilerOptions });
  const nativeDiagnostic = {
    code: 2536,
    text: 'native error, not a mapped wrapper error',
    category: 1,
    fileName: projected,
    pos: 9,
    end: 12,
    relatedInformation: [{ code: 1, text: 'retained related diagnostic' }],
  };
  const mappedDiagnostic = {
    ...nativeDiagnostic,
    fileName: projected.slice(0, -4),
    text: 'mapped wrapper error',
  };
  const instances = [];
  const programs = [];
  let leases = 0;
  const serverFS = { useOS: Symbol('OS'), noop: Symbol('noop') };
  function projectFor(replay, snapshotOptions) {
    let semanticChecked = false;
    const program = {
      id: replay ? 'synthetic' : configPath,
      getSourceFileNames: () =>
        mismatch && replay ? [...sourceOrder].reverse() : sourceOrder,
      getSourceFile: file => {
        assert(
          semanticChecked,
          'Source observation must follow semantic diagnostics',
        );
        assert(!file.includes('.env'), 'Sensitive source must never be read');
        assert(
          !instances.at(-1).closed,
          'Source must be frozen while API is alive',
        );
        if (throwCapture && !replay) throw new Error('capture broke');
        return {
          text: replay
            ? snapshotOptions.fileSystem.files[file]
            : contents.get(file),
        };
      },
      getCompilerOptions: () => compilerOptions,
      ...Object.fromEntries(
        phases.map(phase => [
          phase,
          () => {
            if (phase === 'getSemanticDiagnostics') {
              semanticChecked = true;
              return [nativeDiagnostic];
            }
            return [];
          },
        ]),
      ),
    };
    programs.push({ program, methods: phases.map(phase => program[phase]) });
    return {
      program,
      parsedCommandLine: {
        fileNames: replay ? snapshotOptions.createPrograms[0].rootFiles : roots,
        errors: [],
        projectReferences: references
          ? [{ path: '/reference/tsconfig.json' }]
          : [],
      },
    };
  }
  class API {
    constructor(options) {
      this.options = options;
      instances.push(this);
    }
    get createSnapshot() {
      return options => {
        const replay = Boolean(options.createPrograms);
        this.snapshotOptions = options;
        if (replay && throwReplay) throw new Error('replay broke');
        const project = projectFor(replay, options);
        return {
          getConfiguredProject: file => {
            assert.equal(file, configPath);
            return project;
          },
          getProject: () => project,
          operation: { createdPrograms: [project.program] },
        };
      };
    }
    createSourceFileFromFile(file) {
      assert.equal(file, configPath);
      leases++;
      return {
        sourceFile: { text: config },
        dispose: () => leases--,
      };
    }
    close() {
      assert(!this.closed, 'API must close exactly once');
      this.closed = true;
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    API.prototype,
    'createSnapshot',
  );
  const load = {
    API,
    serverFS,
    inputs: { compiler: { path: '/effect-enabled-tsrs', sha256: 'pinned' } },
    createFileSystemLayer: entries => ({
      kind: 'layer',
      files: Object.fromEntries(entries),
    }),
    checkOctaneProject(options) {
      assert.deepEqual(options, { project: 'tsconfig.json', cwd: root });
      const api = new API({ cwd: root });
      try {
        const snapshot = api.createSnapshot({ openProjects: [configPath] });
        const program = snapshot.getConfiguredProject(configPath).program;
        for (const phase of phases) program[phase]();
        if (throwWrapper)
          throw new Error('wrapper broke after native diagnostics');
        return { files: roots, diagnostics: [mappedDiagnostic] };
      } finally {
        api.close();
      }
    },
  };
  return {
    root,
    load,
    instances,
    programs,
    descriptor,
    contents,
    configPath,
    config,
    roots,
    compilerOptions,
    sourceOrder,
    nativeDiagnostic,
    mappedDiagnostic,
    checkCleanup() {
      assert.deepEqual(
        Object.getOwnPropertyDescriptor(API.prototype, 'createSnapshot'),
        descriptor,
      );
      assert(instances.every(api => api.closed));
      assert.equal(leases, 0);
      for (const { program, methods } of programs)
        assert.deepEqual(
          phases.map(phase => program[phase]),
          methods,
        );
      assert.deepEqual(
        fs.readdirSync(root),
        [],
        'No disk projection/config writes',
      );
    },
  };
}

test('freezes actual virtual contents/options/root order and retains native and mapped errors separately', async t => {
  const f = fixture(t);
  const result = await probeOctaneProjection(f.root, f.load);
  f.checkCleanup();
  assert.equal(f.instances.length, 2);
  const graph = result.captures[0].graph;
  assert.deepEqual(graph.roots, f.roots);
  assert.deepEqual(graph.sourceOrder, f.sourceOrder);
  assert.deepEqual(graph.compilerOptions, f.compilerOptions);
  assert.deepEqual(graph.config, { path: f.configPath, content: f.config });
  assert.deepEqual(
    graph.files.map(file => [file.path, file.content]),
    f.sourceOrder.map(file => [file, f.contents.get(file)]),
  );
  for (const file of graph.files)
    assert.equal(
      file.sha256,
      createHash('sha256').update(file.content).digest('hex'),
    );
  const replay = f.instances[1];
  assert.equal(replay.options.tsserverPath, '/effect-enabled-tsrs');
  assert.equal(replay.options.fs.writeFile, f.load.serverFS.noop);
  assert.equal(replay.options.fs.removeFile, f.load.serverFS.noop);
  assert.equal(replay.options.fs.readFile('/missing.ts'), undefined);
  assert.equal(replay.options.fs.readFile('/.env'), undefined);
  assert.equal(replay.options.fs.readFile('/.env/package.json'), undefined);
  assert.equal(replay.options.fs.readFile('/.npmrc'), undefined);
  assert.equal(
    replay.options.fs.readFile('/dep/package.json'),
    f.load.serverFS.useOS,
  );
  assert.deepEqual(replay.snapshotOptions.createPrograms[0].rootFiles, f.roots);
  assert.deepEqual(
    replay.snapshotOptions.createPrograms[0].compilerOptions,
    f.compilerOptions,
  );
  assert.equal(replay.snapshotOptions.fileSystem.files[f.configPath], f.config);
  assert.equal(result.replay.status, 'graph-matched');
  assert.equal(result.replay.graphIdentity, graph.identity);
  assert.deepEqual(result.wrapper.diagnostics, [f.mappedDiagnostic]);
  assert.deepEqual(result.replay.rawDiagnosticsByPhase.getSemanticDiagnostics, [
    f.nativeDiagnostic,
  ]);
  assert.deepEqual(
    result.captures[0].rawDiagnosticsByPhase.getSemanticDiagnostics,
    [f.nativeDiagnostic],
  );
  assert.match(
    result.proofGaps.join(' '),
    /not full compiler-state equivalence/u,
  );
  assert.doesNotThrow(() => JSON.stringify(result));
});

for (const failure of ['throwWrapper', 'throwCapture', 'throwReplay'])
  test(`restores hooks and closes APIs when ${failure}`, async t => {
    const f = fixture(t, { [failure]: true });
    const result = await probeOctaneProjection(f.root, f.load);
    f.checkCleanup();
    if (failure === 'throwWrapper') {
      assert.equal(result.wrapper.status, 'error');
      assert.match(result.wrapper.error.message, /wrapper broke/u);
      assert.deepEqual(
        result.captures[0].rawDiagnosticsByPhase.getSemanticDiagnostics,
        [f.nativeDiagnostic],
      );
    } else if (failure === 'throwCapture') {
      assert.equal(result.captures[0].status, 'error');
      assert.equal(result.replay.status, 'capture-only');
      assert.deepEqual(result.wrapper.diagnostics, [f.mappedDiagnostic]);
    } else {
      assert.equal(result.replay.status, 'error');
      assert.match(result.replay.error.message, /replay broke/u);
    }
  });

test('a changed source order is not accepted as the same graph', async t => {
  const f = fixture(t, { mismatch: true });
  const result = await probeOctaneProjection(f.root, f.load);
  f.checkCleanup();
  assert.equal(result.replay.status, 'graph-mismatch');
  assert.notEqual(
    result.replay.graphIdentity,
    result.captures[0].graph.identity,
  );
  assert.deepEqual(result.replay.rawDiagnosticsByPhase.getSemanticDiagnostics, [
    f.nativeDiagnostic,
  ]);
});

test('project references remain capture-only with an explicit proof gap', async t => {
  const f = fixture(t, { references: true });
  const result = await probeOctaneProjection(f.root, f.load);
  f.checkCleanup();
  assert.equal(f.instances.length, 1);
  assert.equal(result.replay.status, 'capture-only');
  assert.match(result.replay.proofGap, /reference\/config closure/u);
});

test('sensitive source names are rejected before reading their contents', async t => {
  const f = fixture(t);
  f.sourceOrder.unshift(path.join(f.root, '.env.private.ts'));
  const result = await probeOctaneProjection(f.root, f.load);
  f.checkCleanup();
  assert.equal(result.replay.status, 'capture-only');
  assert.match(result.captures[0].error.message, /Excluded source input/u);
  assert.equal(result.captures[0].graph, undefined);
  assert.deepEqual(
    result.captures[0].rawDiagnosticsByPhase.getSemanticDiagnostics,
    [f.nativeDiagnostic],
  );
});

test('over-budget graphs are capture-only, never truncated replay inputs', async t => {
  const f = fixture(t);
  f.sourceOrder.push(...Array(4096).fill('/extra.ts'));
  const result = await probeOctaneProjection(f.root, f.load);
  f.checkCleanup();
  assert.equal(result.replay.status, 'capture-only');
  assert.match(result.captures[0].error.message, /exceeds 4096 files/u);
  assert.equal(result.captures[0].graph, undefined);
});

test('default loader rejects local use before resolving or importing a compiler', async () => {
  const before = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = 'false';
  try {
    await assert.rejects(
      probeOctaneProjection('/not-an-installed-app'),
      /hosted-only/u,
    );
  } finally {
    if (before === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = before;
  }
});
