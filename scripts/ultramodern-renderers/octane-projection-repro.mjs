import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureResolvedOctaneCompilerInputs } from './octane-compiler-inputs.mjs';

const phases = [
  'getConfigFileParsingDiagnostics',
  'getProgramDiagnostics',
  'getGlobalDiagnostics',
  'getSyntacticDiagnostics',
  'getBindDiagnostics',
  'getSemanticDiagnostics',
];
const maxFiles = 4096;
const maxBytes = 32 * 1024 * 1024;
const maxRootTrials = 12;
const hash = value =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const errorInfo = error => ({
  name: error?.name ?? 'Error',
  message: error?.message ?? String(error),
});

// Bind the search to the native baseline pair, not just any TS2536 result.
function routerTargets(diagnostics = []) {
  return diagnostics
    .filter(
      diagnostic =>
        diagnostic.code === 2536 &&
        /\/@tanstack\/router-core\/dist\/esm\/link\.d\.ts$/u.test(
          diagnostic.fileName?.replaceAll('\\', '/') ?? '',
        ) &&
        typeof diagnostic.text === 'string' &&
        diagnostic.text.length > 0,
    )
    .map(({ fileName, code, text }) => ({ fileName, code, text }));
}

function preservesTargets(diagnostics, targets) {
  const remaining = diagnostics.map(({ fileName, code, text }) =>
    hash({ fileName, code, text }),
  );
  return targets.every(target => {
    const index = remaining.indexOf(hash(target));
    if (index < 0) return false;
    remaining.splice(index, 1);
    return true;
  });
}

// Do not even ask a compiler to read credential-like inputs.
function allowed(file, config = false) {
  const parts = file.replaceAll('\\', '/').split('/');
  return (
    !parts.some(part => part.startsWith('.env') || part === '.npmrc') &&
    (config ? file.endsWith('.json') : /\.(?:[cm]?[jt]sx?|json)$/u.test(file))
  );
}

function graphOf(project, config) {
  const program = project.program;
  const sourceOrder = [...program.getSourceFileNames()];
  if (sourceOrder.length > maxFiles)
    throw new Error(`Source graph exceeds ${maxFiles} files`);
  const roots = [...project.parsedCommandLine.fileNames];
  if (roots.length > maxFiles)
    throw new Error(`Root graph exceeds ${maxFiles} files`);
  const compilerOptions = copy(program.getCompilerOptions());
  if (typeof config.content !== 'string')
    throw new Error('Effective config text unavailable');
  let bytes = Buffer.byteLength(config.content);
  if (bytes > maxBytes)
    throw new Error(`Effective config exceeds ${maxBytes} bytes`);
  const files = sourceOrder.map(file => {
    if (!allowed(file)) throw new Error(`Excluded source input: ${file}`);
    const content = program.getSourceFile(file)?.text;
    if (typeof content !== 'string')
      throw new Error(`Native source text unavailable: ${file}`);
    bytes += Buffer.byteLength(content);
    if (bytes > maxBytes)
      throw new Error(`Source graph exceeds ${maxBytes} bytes`);
    return {
      path: file,
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  });
  const identity = hash({ config, roots, compilerOptions, sourceOrder, files });
  return {
    identity,
    config,
    roots,
    compilerOptions,
    sourceOrder,
    files,
    bytes,
    projectReferences: copy(project.parsedCommandLine.projectReferences ?? []),
    configFileParsingDiagnostics: copy(project.parsedCommandLine.errors ?? []),
  };
}

async function installed(appRoot) {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
  )
    throw new Error('Octane projection reproduction is hosted-only');
  const inputs = await captureResolvedOctaneCompilerInputs(appRoot);
  const renderer = inputs.packages['@modern-js/renderer-octane'];
  const request = createRequire(renderer.manifest.path);
  const client = path.join(renderer.root, 'dist/esm-node/typecheck.mjs');
  return {
    inputs,
    ...(await import(pathToFileURL(client).href)),
    ...(await import(pathToFileURL(request.resolve('tsrs/sync')).href)),
    ...(await import(pathToFileURL(request.resolve('tsrs/fs')).href)),
  };
}

/**
 * Failure-only hosted diagnostic; does not replace acceptance.
 * The optional loader is a fake-only boundary for tests. No CLI entry or writes.
 */
export async function probeOctaneProjection(appRoot, load) {
  const { API, serverFS, createFileSystemLayer, checkOctaneProject, inputs } =
    load ?? (await installed(appRoot));
  const result = {
    schemaVersion: 1,
    inputs,
    wrapper: { status: 'not-run' },
    captures: [],
    replay: { status: 'not-run' },
    rootReduction: {
      status: 'skipped',
      maxTrials: maxRootTrials,
      attempts: [],
      reason:
        'Requires a complete graph-matched replay reporting both RouterCore TS2536 diagnostics.',
    },
    proofGaps: [
      'This is a diagnostic retry, not the original failed compiler process.',
      'Source contents are frozen; host package metadata, symlinks and resolution history are not. Graph identity is not full compiler-state equivalence.',
      'Observing source text may perturb native request/cache history; this cannot establish an order-dependent root cause.',
    ],
  };
  const descriptor = Object.getOwnPropertyDescriptor(
    API.prototype,
    'createSnapshot',
  );
  if (!descriptor?.get || !descriptor.configurable) {
    result.captureError = {
      message: 'Installed API lacks the supported createSnapshot getter',
    };
    return result;
  }
  const restore = [];
  const close = [];
  function hook(object, name, value) {
    const previous = Object.getOwnPropertyDescriptor(object, name);
    Object.defineProperty(object, name, {
      configurable: true,
      writable: true,
      value,
    });
    restore.push(() => {
      if (previous) Object.defineProperty(object, name, previous);
      else delete object[name];
    });
  }
  try {
    Object.defineProperty(API.prototype, 'createSnapshot', {
      ...descriptor,
      get() {
        const create = descriptor.get.call(this);
        return options => {
          const snapshot = create(options);
          if (result.captures.length >= 1) {
            result.captureError = { message: 'More than one wrapper snapshot' };
            return snapshot;
          }
          // Renderer owns these APIs; this also closes one if observation fails.
          const originalClose = this.close;
          let closed = false;
          let freeze = () => {};
          const closeOnce = () => {
            if (!closed) {
              closed = true;
              try {
                freeze();
              } finally {
                originalClose.call(this);
              }
            }
          };
          hook(this, 'close', closeOnce);
          close.push(closeOnce);
          const capture = { status: 'error', rawDiagnosticsByPhase: {} };
          result.captures.push(capture);
          try {
            const [configFile] = options.openProjects ?? [];
            if (!configFile || !allowed(configFile, true))
              throw new Error('Snapshot has no safe effective config');
            const project = snapshot.getConfiguredProject(configFile);
            if (!project) throw new Error('Effective project did not load');
            capture.openProjects = [...options.openProjects];
            // Freeze after the wrapper's diagnostic requests, before close.
            // Source fetches must not precede its semantic check.
            freeze = () => {
              try {
                // Read through this API's overlay, never the host config.
                const lease = this.createSourceFileFromFile(configFile);
                let config;
                try {
                  config = { path: configFile, content: lease.sourceFile.text };
                } finally {
                  lease.dispose();
                }
                capture.graph = graphOf(project, config);
                capture.status = 'captured';
              } catch (error) {
                capture.error = errorInfo(error);
              }
            };
            for (const phase of phases) {
              const method = project.program[phase];
              hook(project.program, phase, (...args) => {
                const diagnostics = method.apply(project.program, args);
                capture.rawDiagnosticsByPhase[phase] = copy(diagnostics);
                return diagnostics;
              });
            }
          } catch (error) {
            capture.error = errorInfo(error);
          }
          return snapshot;
        };
      },
    });
    try {
      result.wrapper = {
        status: 'checked',
        ...copy(checkOctaneProject({ project: 'tsconfig.json', cwd: appRoot })),
      };
    } catch (error) {
      result.wrapper = { status: 'error', error: errorInfo(error) };
    }
  } finally {
    Object.defineProperty(API.prototype, 'createSnapshot', descriptor);
    for (const closeOnce of close) {
      try {
        closeOnce();
      } catch (error) {
        result.closeError = errorInfo(error);
      }
    }
    for (const undo of restore.reverse()) undo();
  }
  const capture = result.captures[0];
  const graph = capture?.graph;
  if (
    !graph ||
    capture.status !== 'captured' ||
    capture.error ||
    result.captureError ||
    graph.projectReferences.length
  ) {
    result.replay = {
      status: 'capture-only',
      proofGap:
        'Replay requires one complete snapshot without project references; reference/config closure is not captured.',
    };
    return result;
  }
  // No source/config fallback, no emit/removal. Only package metadata may read
  // from the host. A mismatch below remains a mismatch, never a passing repro.
  function newReplayAPI() {
    return new API({
      cwd: appRoot,
      tsserverPath: inputs.compiler.path,
      fs: {
        readFile: file =>
          allowed(file, true) && path.basename(file) === 'package.json'
            ? serverFS.useOS
            : undefined,
        fileExists: serverFS.useOS,
        directoryExists: serverFS.useOS,
        getAccessibleEntries: serverFS.useOS,
        realpath: serverFS.useOS,
        stat: serverFS.useOS,
        writeFile: serverFS.noop,
        removeFile: serverFS.noop,
      },
    });
  }
  function replaySnapshot(api, roots) {
    return api.createSnapshot({
      fileSystem: createFileSystemLayer([
        [graph.config.path, graph.config.content],
        ...graph.files.map(file => [file.path, file.content]),
      ]),
      createPrograms: [
        {
          rootFiles: [...roots],
          compilerOptions: copy(graph.compilerOptions),
          options: {
            configFileParsingDiagnostics: copy(
              graph.configFileParsingDiagnostics,
            ),
          },
        },
      ],
    });
  }
  let api;
  try {
    api = newReplayAPI();
    const snapshot = replaySnapshot(api, graph.roots);
    const program = snapshot.operation.createdPrograms[0];
    if (!program) throw new Error('Native replay returned no program');
    // Synthetic programs expose their project through the snapshot too.
    const project = snapshot.getProject(program.id);
    if (!project) throw new Error('Native replay returned no project');
    result.replay = { status: 'checked', rawDiagnosticsByPhase: {} };
    for (const phase of phases)
      result.replay.rawDiagnosticsByPhase[phase] = copy(program[phase]());
    const actual = graphOf(project, graph.config);
    const sameGraph = actual.identity === graph.identity;
    result.replay = {
      ...result.replay,
      status: sameGraph ? 'graph-matched' : 'graph-mismatch',
      graphIdentity: actual.identity,
      expectedGraphIdentity: graph.identity,
      roots: actual.roots,
      compilerOptions: actual.compilerOptions,
      sourceOrder: actual.sourceOrder,
    };
  } catch (error) {
    result.replay = {
      ...result.replay,
      status: 'error',
      error: errorInfo(error),
    };
  } finally {
    try {
      api?.close();
    } catch (error) {
      result.replay.closeError = errorInfo(error);
    }
  }
  const capturedTargets = routerTargets(
    capture.rawDiagnosticsByPhase.getSemanticDiagnostics,
  );
  // The hosted wrapper retry passed while the matching native replay failed.
  // Its absence of errors must not prevent reduction of that native witness.
  const targets = routerTargets(
    result.replay.rawDiagnosticsByPhase?.getSemanticDiagnostics,
  );
  if (
    result.replay.status !== 'graph-matched' ||
    result.replay.closeError ||
    result.closeError ||
    result.wrapper.status !== 'checked' ||
    targets.length !== 2 ||
    new Set(targets.map(hash)).size !== 2 ||
    (capturedTargets.length > 0 && !preservesTargets(targets, capturedTargets))
  )
    return result;

  const reduction = result.rootReduction;
  delete reduction.reason;
  reduction.status = 'not-reduced';
  reduction.targets = targets;
  reduction.baselineGraphIdentity = graph.identity;
  reduction.proofGap =
    'Bounded root-removal observations only, not a fix, global minimum, deterministic root cause or compiler-state equivalence.';
  const frozenFiles = new Map(
    graph.files.map(file => [file.path, file.sha256]),
  );
  function trial(roots, kind) {
    const attempt = {
      kind,
      roots: [...roots],
      rootCount: roots.length,
      rootHash: hash(roots),
      status: 'inconclusive',
      phase: 'create-api',
      rawDiagnosticsByPhase: {},
    };
    reduction.attempts.push(attempt);
    let native;
    try {
      native = newReplayAPI();
      attempt.phase = 'create-snapshot';
      const snapshot = replaySnapshot(native, roots);
      const program = snapshot.operation.createdPrograms[0];
      if (!program) throw new Error('Native root trial returned no program');
      const project = snapshot.getProject(program.id);
      if (!project) throw new Error('Native root trial returned no project');
      for (const phase of phases) {
        attempt.phase = phase;
        attempt.rawDiagnosticsByPhase[phase] = copy(program[phase]());
      }
      attempt.phase = 'observe-graph';
      const actual = graphOf(project, graph.config);
      attempt.sourceOrder = actual.sourceOrder;
      attempt.sourceCount = actual.sourceOrder.length;
      attempt.sourceOrderHash = hash(actual.sourceOrder);
      attempt.graphIdentity = actual.identity;
      if (
        hash(actual.roots) !== hash(roots) ||
        hash(actual.compilerOptions) !== hash(graph.compilerOptions) ||
        actual.projectReferences.length ||
        hash(actual.configFileParsingDiagnostics) !==
          hash(graph.configFileParsingDiagnostics) ||
        actual.files.some(file => frozenFiles.get(file.path) !== file.sha256)
      )
        throw new Error('Root trial escaped the frozen inputs/options closure');
      attempt.status = preservesTargets(
        attempt.rawDiagnosticsByPhase.getSemanticDiagnostics,
        targets,
      )
        ? 'reproducing'
        : 'nonreproducing';
      attempt.phase = 'complete';
    } catch (error) {
      attempt.error = errorInfo(error);
    } finally {
      try {
        native?.close();
      } catch (error) {
        attempt.closeError = errorInfo(error);
        attempt.status = 'inconclusive';
      }
    }
    return attempt;
  }

  let roots = [...graph.roots];
  const attemptedRoots = new Set();
  // Coarse-to-fine contiguous removals; never reorder roots or tune options.
  for (
    let size = Math.ceil(roots.length / 2);
    size >= 1;
    size = Math.floor(size / 2)
  ) {
    for (let start = 0; start < roots.length; ) {
      if (roots.length <= 1) break;
      // Reserve a fresh confirmation for any candidate worth retaining.
      if (reduction.attempts.length + 2 > maxRootTrials) {
        reduction.stopReason = 'trial-budget';
        return result;
      }
      const candidate = roots.filter(
        (_, index) => index < start || index >= start + size,
      );
      const candidateHash = hash(candidate);
      if (!candidate.length || attemptedRoots.has(candidateHash)) {
        start += size;
        continue;
      }
      attemptedRoots.add(candidateHash);
      const observed = trial(candidate, 'removal');
      if (observed.status === 'inconclusive') {
        reduction.status = 'inconclusive';
        reduction.stopReason = 'trial-error';
        return result;
      }
      if (observed.status === 'nonreproducing') {
        start += size;
        continue;
      }
      const confirmation = trial(candidate, 'confirmation');
      if (
        confirmation.status !== 'reproducing' ||
        confirmation.graphIdentity !== observed.graphIdentity
      ) {
        reduction.status = 'inconclusive';
        reduction.stopReason = 'unconfirmed-candidate';
        return result;
      }
      roots = candidate;
      reduction.status = 'reduced-witness';
      reduction.witness = {
        roots: [...roots],
        rootCount: roots.length,
        graphIdentity: confirmation.graphIdentity,
        confirmationAttempt: reduction.attempts.length,
      };
      start = 0;
    }
  }
  reduction.stopReason =
    roots.length === 1 ? 'single-root' : 'scheduled-removals-exhausted';
  return result;
}
