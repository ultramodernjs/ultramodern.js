import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  observeOctaneProjection,
  octaneProjectionResult,
  probeOctaneProjection,
  replayOctaneProjection,
} from './octane-projection-repro.mjs';

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
  {
    throwWrapper,
    throwCapture,
    throwReplay,
    mismatch,
    references,
    targetPair,
    wrapperPasses,
    rootCount = 2,
    replayDiagnostics,
    trialDiagnostics,
    throwTrialPhase,
    throwTrialClose,
    escapeTrial,
    trialSourceOrder,
    trialSourceText,
    mutateTrialInputs,
    orderedDiagnostics,
    orderedError,
    orderedMismatch,
    orderedCloseError,
  } = {},
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
  for (let i = 2; i < rootCount; i++) {
    const file = path.join(root, `extra-${i}.ts`);
    roots.push(file);
    sourceOrder.push(file);
    contents.set(file, `export const extra${i} = ${i};\n`);
  }
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
  const targetFile = path.join(
    root,
    'node_modules/@tanstack/router-core/dist/esm/link.d.ts',
  );
  const nativeDiagnostics = targetPair
    ? [
        'first synthetic RouterCore index error',
        'second synthetic RouterCore index error',
      ].map(text => ({ ...nativeDiagnostic, fileName: targetFile, text }))
    : [nativeDiagnostic];
  if (targetPair) {
    sourceOrder.push(targetFile);
    contents.set(targetFile, '// Fake RouterCore declaration source\n');
  }
  const instances = [];
  const programs = [];
  let leases = 0;
  const serverFS = { useOS: Symbol('OS'), noop: Symbol('noop') };
  function projectFor(replay, snapshotOptions) {
    const trial = instances.length - 2;
    const trialRoots = snapshotOptions.createPrograms?.[0].rootFiles;
    const instance = instances.at(-1);
    let semanticChecked = false;
    const program = {
      id: replay ? 'synthetic' : configPath,
      getSourceFileNames: () => {
        if (instance.ordered && orderedMismatch)
          return [...sourceOrder].reverse();
        if (mismatch && replay) return [...sourceOrder].reverse();
        const order =
          trial > 0
            ? sourceOrder.filter(
                file => !roots.includes(file) || trialRoots.includes(file),
              )
            : sourceOrder;
        return trial > 0 && trialSourceOrder
          ? trialSourceOrder({ trial, order })
          : order;
      },
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
          text:
            trial > 0 && trialSourceText
              ? trialSourceText({ trial, file })
              : replay
                ? snapshotOptions.fileSystem.files[file]
                : contents.get(file),
        };
      },
      getCompilerOptions: () =>
        trial > 0
          ? {
              ...snapshotOptions.createPrograms[0].compilerOptions,
              ...(escapeTrial ? { noCheck: true } : {}),
            }
          : compilerOptions,
      ...Object.fromEntries(
        phases.map(phase => [
          phase,
          (...args) => {
            instance.calls ??= [];
            instance.calls.push([phase, ...args]);
            if (trial > 0 && phase === throwTrialPhase)
              throw new Error('trial phase broke');
            if (phase === 'getSemanticDiagnostics') {
              semanticChecked = true;
              if (Array.isArray(args[0])) {
                instance.ordered = true;
                if (orderedError) throw new Error('ordered request broke');
                return orderedDiagnostics
                  ? orderedDiagnostics(args[0], nativeDiagnostics)
                  : nativeDiagnostics;
              }
              if (!replay && wrapperPasses) return [];
              if (trial > 0 && trialDiagnostics)
                return trialDiagnostics({
                  roots: trialRoots,
                  trial,
                  diagnostics: nativeDiagnostics,
                });
              return replay && replayDiagnostics
                ? replayDiagnostics(nativeDiagnostics)
                : nativeDiagnostics;
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
        if (replay && instances.length > 2) {
          const settings = options.createPrograms[0];
          assert.notEqual(settings.rootFiles, roots);
          assert.notEqual(settings.compilerOptions, compilerOptions);
          if (mutateTrialInputs) {
            settings.rootFiles.reverse();
            settings.compilerOptions.strict = false;
          }
          if (throwTrialPhase === 'create-snapshot')
            throw new Error('trial snapshot broke');
        }
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
      if (this.ordered && orderedCloseError)
        throw new Error('ordered close broke');
      if (throwTrialClose && instances.indexOf(this) > 1)
        throw new Error('trial close broke');
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
        return {
          files: roots,
          diagnostics: wrapperPasses ? [] : [mappedDiagnostic],
        };
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
    nativeDiagnostics,
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

for (const [name, options] of [
  ['missing pair', {}],
  ['graph mismatch', { targetPair: true, mismatch: true }],
  ['capture error', { targetPair: true, throwCapture: true }],
  ['replay error', { targetPair: true, throwReplay: true }],
  ['references', { targetPair: true, references: true }],
  ['wrapper error', { targetPair: true, throwWrapper: true }],
  [
    'replay lost one target',
    {
      targetPair: true,
      replayDiagnostics: diagnostics => diagnostics.slice(0, 1),
    },
  ],
  [
    'replay changed target text',
    {
      targetPair: true,
      replayDiagnostics: diagnostics =>
        diagnostics.map(diagnostic => ({ ...diagnostic, text: 'different' })),
    },
  ],
])
  test(`root reduction skips ${name} without opening trial APIs`, async t => {
    const f = fixture(t, options);
    const result = await probeOctaneProjection(f.root, f.load);
    f.checkCleanup();
    assert.equal(result.rootReduction.status, 'skipped');
    assert.deepEqual(result.rootReduction.attempts, []);
    assert(f.instances.length <= 2);
  });

for (const [name, change] of [
  ['one captured target', diagnostics => diagnostics.pop()],
  [
    'duplicate captured target',
    diagnostics => {
      diagnostics[1] = { ...diagnostics[0] };
    },
  ],
  [
    'unrelated TS2536 file',
    diagnostics => {
      diagnostics[1].fileName = '/other/link.d.ts';
    },
  ],
  [
    'non-TS2536 captured error',
    diagnostics => {
      diagnostics[1].code = 1000;
    },
  ],
])
  test(`root reduction skips ${name} even when replay matches`, async t => {
    const f = fixture(t, { targetPair: true });
    change(f.nativeDiagnostics);
    const result = await probeOctaneProjection(f.root, f.load);
    f.checkCleanup();
    assert.equal(result.replay.status, 'graph-matched');
    assert.equal(result.rootReduction.status, 'skipped');
    assert.deepEqual(result.rootReduction.attempts, []);
    assert.equal(f.instances.length, 2);
  });

test('reduces a failing native replay even when the wrapper retry passed', async t => {
  const f = fixture(t, {
    targetPair: true,
    wrapperPasses: true,
    rootCount: 5,
  });
  const result = await probeOctaneProjection(f.root, f.load);
  f.checkCleanup();
  assert.deepEqual(result.wrapper.diagnostics, []);
  assert.deepEqual(
    result.captures[0].rawDiagnosticsByPhase.getSemanticDiagnostics,
    [],
  );
  assert.equal(result.replay.status, 'graph-matched');
  assert.deepEqual(
    result.replay.rawDiagnosticsByPhase.getSemanticDiagnostics,
    f.nativeDiagnostics,
  );
  assert.equal(result.rootReduction.status, 'reduced-witness');
  assert.equal(result.rootReduction.witness.rootCount, 1);
});

test('retains a smaller witness only after a fresh exact-pair confirmation', async t => {
  const f = fixture(t, { targetPair: true, rootCount: 5 });
  const originalRoots = [...f.roots];
  const originalOptions = structuredClone(f.compilerOptions);
  const originalOrder = [...f.sourceOrder];
  const result = await probeOctaneProjection(f.root, f.load);
  f.checkCleanup();
  const reduction = result.rootReduction;
  assert.equal(reduction.status, 'reduced-witness');
  assert.deepEqual(
    reduction.targets,
    f.nativeDiagnostics.map(({ fileName, code, text }) => ({
      fileName,
      code,
      text,
    })),
  );
  assert.equal(reduction.witness.rootCount, 1);
  const confirmation =
    reduction.attempts[reduction.witness.confirmationAttempt - 1];
  const removal = reduction.attempts[reduction.witness.confirmationAttempt - 2];
  assert.equal(confirmation.kind, 'confirmation');
  assert.equal(removal.kind, 'removal');
  assert.equal(confirmation.status, 'reproducing');
  assert.deepEqual(confirmation.roots, removal.roots);
  assert.deepEqual(reduction.witness.roots, confirmation.roots);
  assert.equal(confirmation.graphIdentity, removal.graphIdentity);
  assert.equal(f.instances.length, reduction.attempts.length + 2);
  for (const attempt of reduction.attempts) {
    assert.deepEqual(
      attempt.roots,
      originalRoots.filter(file => attempt.roots.includes(file)),
      'Candidate roots retain their original order',
    );
    assert(attempt.rootCount < originalRoots.length);
    assert.equal(attempt.phase, 'complete');
    assert.equal(attempt.sourceCount, attempt.sourceOrder.length);
    assert.match(attempt.sourceOrderHash, /^[a-f0-9]{64}$/u);
    assert.match(attempt.rootHash, /^[a-f0-9]{64}$/u);
  }
  for (const api of f.instances.slice(2)) {
    assert.equal(api.options.tsserverPath, '/effect-enabled-tsrs');
    assert.equal(api.options.fs.writeFile, f.load.serverFS.noop);
    assert.equal(api.options.fs.removeFile, f.load.serverFS.noop);
    assert.equal(api.options.fs.readFile('/not-captured.ts'), undefined);
    assert.equal(api.options.fs.readFile('/.env/package.json'), undefined);
    assert.deepEqual(
      api.snapshotOptions.createPrograms[0].compilerOptions,
      originalOptions,
    );
    assert.deepEqual(
      api.snapshotOptions.fileSystem.files,
      f.instances[1].snapshotOptions.fileSystem.files,
    );
    assert.notEqual(
      api.snapshotOptions.createPrograms[0].compilerOptions,
      result.captures[0].graph.compilerOptions,
    );
  }
  assert.deepEqual(f.roots, originalRoots);
  assert.deepEqual(f.compilerOptions, originalOptions);
  assert.deepEqual(f.sourceOrder, originalOrder);
  assert.deepEqual(result.captures[0].graph.roots, originalRoots);
  assert.deepEqual(result.captures[0].graph.sourceOrder, originalOrder);
  assert.deepEqual(result.captures[0].graph.compilerOptions, originalOptions);
  for (const record of [result.captures[0], result.replay])
    assert.deepEqual(
      record.rawDiagnosticsByPhase.getSemanticDiagnostics,
      f.nativeDiagnostics,
    );
  assert.equal(result.replay.status, 'graph-matched');
  assert.match(reduction.proofGap, /not a fix, global minimum/u);
});

for (const [name, change] of [
  ['empty diagnostics', () => []],
  ['one target only', diagnostics => diagnostics.slice(0, 1)],
  ['duplicate first target', diagnostics => [diagnostics[0], diagnostics[0]]],
  [
    'different text',
    diagnostics => diagnostics.map(d => ({ ...d, text: 'other' })),
  ],
  [
    'different file',
    diagnostics =>
      diagnostics.map(d => ({ ...d, fileName: '/other/link.d.ts' })),
  ],
  [
    'different code',
    diagnostics => diagnostics.map(d => ({ ...d, code: 1000 })),
  ],
])
  test(`does not accept ${name} as a reduced witness`, async t => {
    const f = fixture(t, {
      targetPair: true,
      trialDiagnostics: ({ diagnostics }) => change(diagnostics),
    });
    const result = await probeOctaneProjection(f.root, f.load);
    f.checkCleanup();
    const reduction = result.rootReduction;
    assert.equal(reduction.status, 'not-reduced');
    assert.equal(reduction.witness, undefined);
    assert.equal(reduction.attempts.length, 2);
    assert(
      reduction.attempts.every(attempt => attempt.status === 'nonreproducing'),
    );
    assert(reduction.attempts.every(attempt => attempt.kind === 'removal'));
  });

test('stops after twelve fresh trials, including confirmations', async t => {
  const f = fixture(t, {
    targetPair: true,
    rootCount: 17,
    trialDiagnostics: ({ trial, diagnostics }) =>
      trial <= 2 || trial >= 11 ? diagnostics : [],
  });
  const result = await probeOctaneProjection(f.root, f.load);
  f.checkCleanup();
  assert.equal(result.rootReduction.maxTrials, 12);
  assert.equal(result.rootReduction.attempts.length, 12);
  assert.equal(result.rootReduction.stopReason, 'trial-budget');
  assert.equal(f.instances.length, 14);
  assert.equal(result.rootReduction.witness.confirmationAttempt, 12);
});

test('nonreproducing removals exhaust the budget without a witness or green retry', async t => {
  const f = fixture(t, {
    targetPair: true,
    rootCount: 17,
    trialDiagnostics: () => [],
  });
  const result = await probeOctaneProjection(f.root, f.load);
  f.checkCleanup();
  assert.equal(result.rootReduction.status, 'not-reduced');
  assert.equal(result.rootReduction.stopReason, 'trial-budget');
  assert.equal(result.rootReduction.witness, undefined);
  assert.equal(result.rootReduction.attempts.length, 11);
  assert.equal(f.instances.length, 13);
});

test('an intermittent candidate is inconclusive, never retried until green', async t => {
  const f = fixture(t, {
    targetPair: true,
    trialDiagnostics: ({ trial, diagnostics }) =>
      trial === 1 ? diagnostics : [],
  });
  const result = await probeOctaneProjection(f.root, f.load);
  f.checkCleanup();
  const reduction = result.rootReduction;
  assert.equal(reduction.status, 'inconclusive');
  assert.equal(reduction.stopReason, 'unconfirmed-candidate');
  assert.equal(reduction.witness, undefined);
  assert.deepEqual(
    reduction.attempts.map(({ kind, status }) => [kind, status]),
    [
      ['removal', 'reproducing'],
      ['confirmation', 'nonreproducing'],
    ],
  );
  assert.equal(result.replay.status, 'graph-matched');
  assert.deepEqual(
    result.replay.rawDiagnosticsByPhase.getSemanticDiagnostics,
    f.nativeDiagnostics,
  );
});

test('a previously nonreproducing subset is not retried after other reductions', async t => {
  const f = fixture(t, {
    targetPair: true,
    rootCount: 5,
    trialDiagnostics: ({ trial, roots, diagnostics }) =>
      trial > 2 && roots.length >= 3 ? diagnostics : [],
  });
  const result = await probeOctaneProjection(f.root, f.load);
  f.checkCleanup();
  const removals = result.rootReduction.attempts.filter(
    attempt => attempt.kind === 'removal',
  );
  assert.equal(
    new Set(removals.map(attempt => attempt.rootHash)).size,
    removals.length,
  );
  assert.equal(result.rootReduction.status, 'reduced-witness');
  assert.equal(result.rootReduction.witness.rootCount, 3);
});

for (const phase of ['create-snapshot', ...phases])
  test(`trial error in ${phase} retains evidence and closes the API`, async t => {
    const f = fixture(t, { targetPair: true, throwTrialPhase: phase });
    const result = await probeOctaneProjection(f.root, f.load);
    f.checkCleanup();
    const reduction = result.rootReduction;
    assert.equal(reduction.status, 'inconclusive');
    assert.equal(reduction.attempts.length, 1);
    assert.equal(reduction.attempts[0].phase, phase);
    assert.match(reduction.attempts[0].error.message, /trial .*broke/u);
    assert.equal(result.replay.status, 'graph-matched');
  });

test('a close error is inconclusive and retains the trial diagnostics', async t => {
  const f = fixture(t, { targetPair: true, throwTrialClose: true });
  const result = await probeOctaneProjection(f.root, f.load);
  f.checkCleanup();
  assert.equal(result.rootReduction.status, 'inconclusive');
  const [attempt] = result.rootReduction.attempts;
  assert.equal(attempt.status, 'inconclusive');
  assert.match(attempt.closeError.message, /trial close broke/u);
  assert.deepEqual(
    attempt.rawDiagnosticsByPhase.getSemanticDiagnostics,
    f.nativeDiagnostics,
  );
});

test('a trial outside the frozen options closure is inconclusive', async t => {
  const f = fixture(t, { targetPair: true, escapeTrial: true });
  const result = await probeOctaneProjection(f.root, f.load);
  f.checkCleanup();
  assert.equal(result.rootReduction.status, 'inconclusive');
  const [attempt] = result.rootReduction.attempts;
  assert.equal(attempt.phase, 'observe-graph');
  assert.match(attempt.error.message, /frozen inputs\/options closure/u);
  assert.equal(result.rootReduction.witness, undefined);
  assert.equal(result.captures[0].graph.compilerOptions.noCheck, false);
});

test('changed source contents cannot become a reduced witness', async t => {
  const f = fixture(t, {
    targetPair: true,
    trialSourceText: () => '// not the captured bytes\n',
  });
  const result = await probeOctaneProjection(f.root, f.load);
  f.checkCleanup();
  assert.equal(result.rootReduction.status, 'inconclusive');
  assert.match(
    result.rootReduction.attempts[0].error.message,
    /frozen inputs\/options closure/u,
  );
  assert.equal(result.rootReduction.witness, undefined);
});

test('native trial mutation cannot change the original graph or options', async t => {
  const f = fixture(t, {
    targetPair: true,
    rootCount: 5,
    mutateTrialInputs: true,
  });
  const originalRoots = [...f.roots];
  const originalOptions = structuredClone(f.compilerOptions);
  const result = await probeOctaneProjection(f.root, f.load);
  f.checkCleanup();
  assert.equal(result.rootReduction.status, 'inconclusive');
  assert.deepEqual(result.captures[0].graph.roots, originalRoots);
  assert.deepEqual(result.captures[0].graph.compilerOptions, originalOptions);
  assert.deepEqual(result.replay.roots, originalRoots);
  assert.deepEqual(result.replay.compilerOptions, originalOptions);
  assert.deepEqual(f.roots, originalRoots);
  assert.deepEqual(f.compilerOptions, originalOptions);
});

test('sensitive trial source names are rejected before source observation', async t => {
  const f = fixture(t, {
    targetPair: true,
    trialSourceOrder: () => ['/.env.private.ts'],
  });
  const result = await probeOctaneProjection(f.root, f.load);
  f.checkCleanup();
  assert.equal(result.rootReduction.status, 'inconclusive');
  assert.match(
    result.rootReduction.attempts[0].error.message,
    /Excluded source input/u,
  );
  assert.equal(result.rootReduction.witness, undefined);
});

test('fresh confirmation must reproduce the same reduced source graph', async t => {
  const f = fixture(t, {
    targetPair: true,
    rootCount: 5,
    trialSourceOrder: ({ trial, order }) =>
      trial === 2 ? [...order].reverse() : order,
  });
  const result = await probeOctaneProjection(f.root, f.load);
  f.checkCleanup();
  const reduction = result.rootReduction;
  assert.equal(reduction.status, 'inconclusive');
  assert.equal(reduction.stopReason, 'unconfirmed-candidate');
  assert.equal(reduction.attempts.length, 2);
  assert(reduction.attempts.every(attempt => attempt.status === 'reproducing'));
  assert.notEqual(
    reduction.attempts[0].sourceOrderHash,
    reduction.attempts[1].sourceOrderHash,
  );
  assert.equal(reduction.witness, undefined);
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

test('original observation reuses native reduction without a second wrapper call', t => {
  const f = fixture(t, { targetPair: true, rootCount: 5 });
  const result = {
    ...octaneProjectionResult(),
    captureOrigin: 'original-public-cli',
    inputs: f.load.inputs,
    original: { status: 'observing' },
  };
  const observer = observeOctaneProjection(f.load.API, result, {
    failureOnly: true,
    onClose() {
      result.original.status = 'closed';
    },
  });
  f.load.checkOctaneProject({ project: 'tsconfig.json', cwd: f.root });
  observer.dispose();
  // Any attempt to call the wrapper from the replay must fail this test.
  f.load.checkOctaneProject = () => {
    throw new Error('Never retry original wrapper');
  };
  replayOctaneProjection(f.root, f.load, result);
  f.checkCleanup();
  assert.equal(result.wrapper.status, 'not-run');
  assert.equal(result.original.status, 'closed');
  assert.equal(result.rootReduction.status, 'reduced-witness');
  assert.equal(result.rootReduction.witness.rootCount, 1);
});

function replayOriginal(f) {
  const result = {
    ...octaneProjectionResult(),
    captureOrigin: 'original-public-cli',
    inputs: f.load.inputs,
    original: { status: 'observing', exitCode: 1 },
  };
  const observer = observeOctaneProjection(f.load.API, result, {
    failureOnly: true,
    onClose() {
      result.original.status = 'closed';
    },
  });
  f.load.checkOctaneProject({ project: 'tsconfig.json', cwd: f.root });
  observer.dispose();
  f.load.checkOctaneProject = () => {
    throw new Error('Never retry original wrapper');
  };
  return replayOctaneProjection(f.root, f.load, result);
}

test('two fixed cold traversal arms run even when baseline native replay passes', t => {
  const f = fixture(t, {
    targetPair: true,
    replayDiagnostics: () => [],
    orderedDiagnostics: (files, diagnostics) =>
      files[0].endsWith('a.ts') ? diagnostics : [],
  });
  const originalOrder = [...f.sourceOrder];
  const originalRoots = [...f.roots];
  const result = replayOriginal(f);
  f.checkCleanup();
  assert.equal(
    result.traversalComparison.status,
    'target-pair-order-dependent',
  );
  assert.equal(result.traversalComparison.arms.length, 2);
  assert.deepEqual(
    result.traversalComparison.arms.map(arm => arm.targetPairPresent),
    [true, false],
  );
  const arms = f.instances.filter(instance => instance.ordered);
  assert.equal(arms.length, 2);
  assert.equal(f.instances.length, 4, 'Original + baseline + exactly two arms');
  for (const [index, instance] of arms.entries()) {
    const ordered = instance.calls.find(
      ([phase, files]) =>
        phase === 'getSemanticDiagnostics' && Array.isArray(files),
    );
    assert.deepEqual(
      ordered[1],
      index === 0 ? originalOrder : [...originalOrder].reverse(),
    );
    const firstGlobal = instance.calls.findIndex(
      ([phase]) => phase === 'getGlobalDiagnostics',
    );
    assert(firstGlobal > instance.calls.indexOf(ordered));
    assert.equal(
      instance.calls.filter(
        ([phase, files]) =>
          phase === 'getSemanticDiagnostics' && Array.isArray(files),
      ).length,
      1,
    );
    assert.deepEqual(
      instance.snapshotOptions.createPrograms[0].rootFiles,
      originalRoots,
    );
    assert.equal(instance.options.fs.writeFile, f.load.serverFS.noop);
    assert.equal(instance.options.fs.removeFile, f.load.serverFS.noop);
  }
  assert.deepEqual(f.sourceOrder, originalOrder);
  assert.deepEqual(f.roots, originalRoots);
  assert.equal(result.original.exitCode, 1);
  assert.equal(result.replay.status, 'graph-matched');
  assert.deepEqual(
    result.replay.rawDiagnosticsByPhase.getSemanticDiagnostics,
    [],
  );
  assert.deepEqual(
    result.captures[0].rawDiagnosticsByPhase.getSemanticDiagnostics,
    f.nativeDiagnostics,
  );
  assert.equal(result.rootReduction.status, 'skipped');
});

for (const diagnostics of ['both-fail', 'both-pass'])
  test(`agreeing traversal arms (${diagnostics}) stop without permutation search`, t => {
    const f = fixture(t, {
      targetPair: true,
      replayDiagnostics: () => [],
      orderedDiagnostics: (_files, raw) =>
        diagnostics === 'both-fail' ? raw : [],
    });
    const result = replayOriginal(f);
    f.checkCleanup();
    assert.equal(
      result.traversalComparison.status,
      'no-target-pair-difference',
    );
    assert.equal(f.instances.length, 4);
    assert.equal(result.rootReduction.attempts.length, 0);
  });

for (const failure of ['orderedError', 'orderedMismatch', 'orderedCloseError'])
  test(`traversal ${failure} stays inconclusive and retains original failure`, t => {
    const f = fixture(t, {
      targetPair: true,
      replayDiagnostics: () => [],
      [failure]: true,
    });
    const result = replayOriginal(f);
    f.checkCleanup();
    assert.equal(result.traversalComparison.status, 'inconclusive');
    assert.equal(result.traversalComparison.arms.length, 2);
    assert.equal(f.instances.length, 4);
    assert.equal(result.original.exitCode, 1);
    assert.deepEqual(
      result.captures[0].rawDiagnosticsByPhase.getSemanticDiagnostics,
      f.nativeDiagnostics,
    );
  });

test('a diagnostic retry does not launch the original-process traversal experiment', async t => {
  const f = fixture(t, { targetPair: true, replayDiagnostics: () => [] });
  const result = await probeOctaneProjection(f.root, f.load);
  f.checkCleanup();
  assert.equal(result.traversalComparison, undefined);
  assert.equal(f.instances.length, 2);
});
