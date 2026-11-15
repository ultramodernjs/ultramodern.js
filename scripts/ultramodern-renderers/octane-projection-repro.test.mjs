import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  observeOctaneProjection,
  octaneProjectionResult,
  probeOctaneLiveTraversal,
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

test('both default loaders admit Depot GHA but reject generic or malformed self-hosted context before installed loading', async () => {
  const keys = ['GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'RUNNER_NAME'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.GITHUB_ACTIONS = 'true';
    process.env.RUNNER_ENVIRONMENT = 'self-hosted';
    for (const probe of [probeOctaneProjection, probeOctaneLiveTraversal]) {
      process.env.RUNNER_NAME = 'depot-control-123';
      // A nonexistent app reaches filesystem validation, never a real compiler.
      await assert.rejects(probe('/not-an-installed-depot-app'), {
        code: 'ENOENT',
      });
      for (const name of ['', 'generic', 'depot-', 'depot-control\n']) {
        process.env.RUNNER_NAME = name;
        await assert.rejects(
          probe('/not-an-installed-depot-app'),
          /hosted-only/u,
        );
      }
    }
  } finally {
    for (const key of keys)
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
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

// Live traversal controls below are fake-only: no installed compiler loading.
const livePair = ['first actual index error', 'second actual index error'].map(
  text => ({
    code: 2536,
    category: 1,
    text,
    fileName: '/app/node_modules/@tanstack/router-core/dist/esm/link.d.ts',
    pos: 123,
    end: 145,
    relatedInformation: [{ code: 12, text: 'keep me' }],
  }),
);
const liveUnrelated = {
  code: 9999,
  text: 'keep unrelated raw failure',
  category: 1,
};
const liveDigest = value =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

function liveFixture(settings = {}) {
  const instances = [];
  const programs = [];
  const roots = ['/app/z.ts', '/app/a.ts'];
  const sources = [...roots].reverse();
  const refs = [
    { path: '/ref-one/tsconfig.json' },
    { path: '/ref-two/tsconfig.json' },
  ];
  const originals = [];
  class API {
    constructor() {
      this.index = instances.length;
      this.calls = [];
      this.closes = 0;
      instances.push(this);
    }
    get createSnapshot() {
      return options => {
        this.open = structuredClone(options);
        const config = `/app/.octane-typecheck-00000000-0000-4000-8000-${String(this.index).padStart(12, '0')}.json`;
        assert.deepEqual(options, { openProjects: [config] });
        const configs = [config, '/config/extends.json'];
        if (settings.credentialConfig) configs.push('/app/.env.secret.json');
        this.config = config;
        this.finished = false;
        const program = {
          getSourceFileNames: () => {
            this.calls.push('file-list');
            if (settings.changedSourceOrder && this.index === 1)
              return [...sources].reverse();
            if (settings.driftSourceOrder && this.finished)
              return [...sources].reverse();
            return settings.tooManyFiles
              ? Array.from({ length: 4096 }, (_, i) => `/app/f${i}.ts`)
              : [
                  ...sources,
                  ...(settings.credentialSource ? ['/app/.env.ts'] : []),
                ];
          },
          getCompilerOptions: () => ({
            strict: true,
            configFilePath: config,
            ...(settings.changedOptions && this.index === 1
              ? { noCheck: true }
              : {}),
          }),
          getConfigFileNames: () => {
            assert(this.finished, 'config list after later wrapper semantics');
            return settings.missingConfigList ? configs.slice(1) : configs;
          },
          getConfigSourceFile: file => {
            assert(this.finished && !this.closes);
            assert(!file.includes('.env'), 'reject credential before fetch');
            this.calls.push(`config:${file}`);
            if (settings.missingConfig && file.endsWith('extends.json'))
              return undefined;
            return {
              text:
                file === config
                  ? JSON.stringify({
                      files: roots,
                      references: refs,
                      extends: '/config/extends.json',
                      ...(settings.configPathText
                        ? { unrelatedPath: `${config}.backup` }
                        : {}),
                    })
                  : `{"compilerOptions":{"strict":true},"virtualOverlayOnly":${settings.changedConfig && this.index === 1 ? 'false' : 'true'}}`,
            };
          },
          getSourceFile: file => {
            assert(
              this.finished && !this.closes,
              'source text after all diagnostics before close',
            );
            assert(!file.includes('.env'), 'reject credential before fetch');
            this.calls.push(`text:${file}`);
            if (settings.captureThrow) throw new Error('source fetch failed');
            if (settings.sourceConfigPath !== undefined)
              return {
                text: `export type UnrelatedPath = ${JSON.stringify(config + settings.sourceConfigPath)};\n`,
              };
            return {
              text: settings.tooManyBytes
                ? 'x'.repeat(16 * 1024 * 1024)
                : `// ${file} ${settings.changedSource && this.index === 1 ? 'changed' : 'stable'} ${settings.arbitraryUuid ? `00000000-0000-4000-8000-${String(this.index).padStart(12, '0')}` : ''}\n`,
            };
          },
          ...Object.fromEntries(
            phases.map(phase => [
              phase,
              files => {
                this.calls.push(files ? ['ordered', [...files]] : phase);
                if (
                  settings.throwPhase === phase &&
                  (!settings.orderedThrow || files)
                )
                  throw new Error(`failed ${phase}`);
                if (phase === 'getSemanticDiagnostics' && files) {
                  assert.equal(
                    this.ordered,
                    undefined,
                    'one ordered request per owner',
                  );
                  this.ordered = [...files];
                  if (settings.diagnostics)
                    return settings.diagnostics(this.index);
                  return [
                    ...(settings.mode === 'both' ||
                    (settings.mode !== 'neither' && this.index === 0)
                      ? livePair
                      : []),
                    liveUnrelated,
                  ];
                }
                if (phase === 'getGlobalDiagnostics') {
                  assert(this.ordered, 'ordered request precedes real globals');
                  return [{ code: 77, text: 'real globals retained' }];
                }
                if (phase === 'getSemanticDiagnostics') {
                  this.finished = true;
                  return [liveUnrelated];
                }
                return [];
              },
            ]),
          ),
        };
        programs.push(program);
        originals.push(phases.map(phase => program[phase]));
        const project = {
          currentDirectory:
            settings.changedCwd && this.index === 1 ? '/elsewhere' : '/app',
          program,
          parsedCommandLine: {
            fileNames:
              settings.changedRoots && this.index === 1
                ? [...roots].reverse()
                : roots,
            projectReferences:
              settings.changedRefs && this.index === 1 ? refs.slice(1) : refs,
            errors: [],
          },
        };
        return {
          getConfiguredProject: file => {
            assert.equal(file, config, 'never open reference projects');
            return project;
          },
          getProjects: () => [
            project,
            {
              currentDirectory: '/ref-one',
              parsedCommandLine: {
                fileNames: ['/ref-one/only.ts'],
                projectReferences: [],
              },
            },
            {
              currentDirectory: '/ref-two',
              parsedCommandLine: {
                fileNames: ['/ref-two/only.ts'],
                projectReferences: [],
              },
            },
          ],
        };
      };
    }
    createSourceFileFromFile() {
      assert.fail(
        'live config capture must use snapshot program, not independent host parsing',
      );
    }
    close() {
      assert.equal(++this.closes, 1);
      if (settings.closeThrow) throw new Error('close failed');
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    API.prototype,
    'createSnapshot',
  );
  const load = {
    API,
    checkOctaneProject(options) {
      assert.deepEqual(options, { project: 'tsconfig.json', cwd: '/app' });
      const api = new API();
      try {
        if (settings.beforeSnapshotThrow)
          throw new Error('wrapper early failure');
        const config = `/app/.octane-typecheck-00000000-0000-4000-8000-${String(api.index).padStart(12, '0')}.json`;
        const snapshot = api.createSnapshot({ openProjects: [config] });
        const program = snapshot.getConfiguredProject(config).program;
        const diagnostics = phases.flatMap(phase => program[phase]());
        if (settings.wrapperThrow) throw new Error('wrapper failed');
        return { diagnostics, files: roots };
      } finally {
        api.close();
      }
    },
  };
  function cleanup() {
    assert.equal(
      instances.length,
      2,
      'exactly two fresh owners/wrapper invocations',
    );
    assert(
      instances.every(api => api.closes === 1),
      'each API closes exactly once',
    );
    assert(
      instances.every(api => api.close === API.prototype.close),
      'no instance close hook leaks',
    );
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(API.prototype, 'createSnapshot'),
      descriptor,
    );
    for (const [i, program] of programs.entries())
      assert.deepEqual(
        phases.map(phase => program[phase]),
        originals[i],
        'no diagnostic hook leaks',
      );
  }
  return { load, instances, roots, sources, refs, cleanup };
}

test('live reference-aware orders preserve real wrapper opening and retain raw phases/config overlays', async () => {
  const f = liveFixture();
  const result = await probeOctaneLiveTraversal('/app', f.load);
  f.cleanup();
  assert.equal(result.status, 'live-target-pair-order-dependent');
  assert.deepEqual(
    result.targets,
    livePair.map(({ fileName, code, text }) => ({ fileName, code, text })),
  );
  assert.equal(
    result.arms[0].visibleInputs.identity,
    result.arms[1].visibleInputs.identity,
  );
  for (const [i, arm] of result.arms.entries()) {
    const order = i ? [...f.sources].reverse() : f.sources;
    assert.deepEqual(arm.fileOrder, order);
    assert.equal(arm.fileOrderHash, liveDigest(order));
    assert.deepEqual(arm.visibleInputs.roots, f.roots);
    assert.deepEqual(arm.visibleInputs.projectReferences, f.refs);
    assert.deepEqual(
      arm.loadedProjects.map(project => project.roots),
      [f.roots, ['/ref-one/only.ts'], ['/ref-two/only.ts']],
    );
    assert.equal(arm.visibleInputs.openProjects.length, 1);
    assert.equal(arm.visibleInputs.currentDirectory, '/app');
    assert.match(
      arm.visibleInputs.configs[1].content,
      /"virtualOverlayOnly":true/u,
    );
    assert.equal(arm.visibleInputs.configs.length, 2);
    assert.deepEqual(arm.orderedSemanticDiagnostics, [
      ...(i ? [] : livePair),
      liveUnrelated,
    ]);
    assert.deepEqual(arm.rawDiagnosticsByPhase.getSemanticDiagnostics, [
      liveUnrelated,
    ]);
    assert.deepEqual(arm.rawDiagnosticsByPhase.getGlobalDiagnostics, [
      { code: 77, text: 'real globals retained' },
    ]);
    assert.deepEqual(arm.wrapper.diagnostics, [
      { code: 77, text: 'real globals retained' },
      liveUnrelated,
    ]);
    assert.deepEqual(f.instances[i].calls.slice(0, 9), [
      'getConfigFileParsingDiagnostics',
      'getProgramDiagnostics',
      'file-list',
      ['ordered', order],
      'getGlobalDiagnostics',
      'getSyntacticDiagnostics',
      'getBindDiagnostics',
      'getSemanticDiagnostics',
      'file-list',
    ]);
  }
  assert(result.proofGaps.some(gap => /BEFORE.*may perturb/u.test(gap)));
  assert(result.proofGaps.some(gap => /closure is not proven/u.test(gap)));
});

for (const mode of ['both', 'neither'])
  test(`agreeing ${mode} does not establish absence of nondeterminism`, async () => {
    const f = liveFixture({ mode });
    const result = await probeOctaneLiveTraversal('/app', f.load);
    f.cleanup();
    assert.equal(result.status, 'no-target-pair-difference');
    assert(
      result.proofGaps.some(gap =>
        /inconclusive about nondeterminism/u.test(gap),
      ),
    );
  });

test('reverse-only target pair is also order dependent', async () => {
  const f = liveFixture({
    diagnostics: index => (index === 1 ? livePair : []),
  });
  const result = await probeOctaneLiveTraversal('/app', f.load);
  f.cleanup();
  assert.equal(result.status, 'live-target-pair-order-dependent');
  assert.deepEqual(
    result.arms.map(arm => arm.targetPairPresent),
    [false, true],
  );
});

for (const [name, diagnostics] of [
  ['one target', index => (index === 0 ? livePair.slice(0, 1) : [])],
  ['duplicate target', () => [livePair[0], livePair[0]]],
  [
    'different target texts',
    index => livePair.map(item => ({ ...item, text: `${item.text} ${index}` })),
  ],
]) {
  test(`${name} cannot substitute for one unique exact target pair`, async () => {
    const f = liveFixture({ diagnostics });
    const result = await probeOctaneLiveTraversal('/app', f.load);
    f.cleanup();
    assert.equal(result.status, 'inconclusive');
    assert.match(result.reason, /unique observed/u);
    assert.deepEqual(
      result.arms.map(arm => arm.orderedSemanticDiagnostics),
      [diagnostics(0), diagnostics(1)],
    );
  });
}

for (const suffix of ['', '.backup'])
  test(`generated config path inside source text (${suffix || 'exact'}) stays byte-significant`, async () => {
    const f = liveFixture({ sourceConfigPath: suffix });
    const result = await probeOctaneLiveTraversal('/app', f.load);
    f.cleanup();
    assert.notEqual(
      result.arms[0].visibleInputs.files[0].sha256,
      result.arms[1].visibleInputs.files[0].sha256,
    );
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.reason, 'visible-input-mismatch');
  });

for (const setting of [
  'changedOptions',
  'changedSource',
  'changedConfig',
  'changedCwd',
  'changedRefs',
  'changedRoots',
  'changedSourceOrder',
  'arbitraryUuid',
  'configPathText',
])
  test(`changed visible input ${setting} is inconclusive (only generated UUID is normalized)`, async () => {
    const f = liveFixture({ [setting]: true });
    const result = await probeOctaneLiveTraversal('/app', f.load);
    f.cleanup();
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.reason, 'visible-input-mismatch');
  });

for (const setting of [
  'credentialSource',
  'credentialConfig',
  'missingConfig',
  'missingConfigList',
  'tooManyFiles',
  'tooManyBytes',
  'captureThrow',
  'closeThrow',
  'wrapperThrow',
  'beforeSnapshotThrow',
  'driftSourceOrder',
])
  test(`live ${setting} retains error and cannot classify order dependence`, async () => {
    const f = liveFixture({ [setting]: true });
    const result = await probeOctaneLiveTraversal('/app', f.load);
    f.cleanup();
    assert.equal(result.status, 'inconclusive');
    assert(
      result.arms.every(arm => arm.error || arm.captureError || arm.closeError),
    );
    if (setting === 'tooManyBytes')
      assert.match(result.arms[0].captureError.message, /33554432 bytes/u);
    if (setting === 'tooManyFiles')
      assert.match(result.arms[0].captureError.message, /4096 files/u);
  });

test('default live loader is hosted-only before any installed package/compiler loading', async () => {
  const old = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = 'false';
  try {
    await assert.rejects(
      probeOctaneLiveTraversal('/does/not/exist'),
      /hosted-only/u,
    );
  } finally {
    if (old === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = old;
  }
});

for (const [throwPhase, orderedThrow] of [
  ['getSemanticDiagnostics', true],
  ['getGlobalDiagnostics', false],
  ['getProgramDiagnostics', false],
])
  test(`throwing ${orderedThrow ? 'ordered-semantics' : throwPhase} preserves phase, skips text capture and restores hooks`, async () => {
    const f = liveFixture({ throwPhase, orderedThrow });
    const result = await probeOctaneLiveTraversal('/app', f.load);
    f.cleanup();
    assert.equal(result.status, 'inconclusive');
    for (const arm of result.arms) {
      assert.equal(
        arm.errorPhase,
        orderedThrow ? 'ordered-semantics' : throwPhase,
      );
      assert.equal(arm.captureStatus, 'incomplete');
      assert.match(arm.error.message, /failed/u);
    }
    assert(
      f.instances.every(
        api =>
          !api.calls.some(
            call => typeof call === 'string' && /^(text|config):/u.test(call),
          ),
      ),
    );
  });
