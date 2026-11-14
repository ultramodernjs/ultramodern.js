import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureResolvedOctaneCompilerInputs } from './octane-compiler-inputs.mjs';
import {
  probeOctaneLiveTraversal,
  probeOctaneProjection,
} from './octane-projection-repro.mjs';

export async function qualifyOctaneBatch(typecheck) {
  for (let iteration = 1; iteration <= 8; iteration++)
    await typecheck(iteration);
}

/** Keep the original acceptance failure even when its diagnostic probe passes. */
export async function diagnoseOctaneTypecheck(typecheck, probe) {
  try {
    await typecheck();
  } catch (failure) {
    try {
      await probe();
    } catch (probeFailure) {
      throw new AggregateError(
        [failure, probeFailure],
        'Octane typecheck failed and its native diagnostic probe also failed',
      );
    }
    throw failure;
  }
}

/**
 * Discriminator, not acceptance: check Router Core through native OS reads,
 * without importing Octane or compiling TSRX projections.
 */
export async function probeOctaneRouter(appRoot, load) {
  const inputs = await (load?.capture ?? captureResolvedOctaneCompilerInputs)(
    appRoot,
  );
  const request = createRequire(
    inputs.packages['@modern-js/renderer-octane'].manifest.path,
  );
  const { API, serverFS } = load ?? {
    ...(await import(pathToFileURL(request.resolve('tsrs/sync')).href)),
    ...(await import(pathToFileURL(request.resolve('tsrs/fs')).href)),
  };
  const config = path.join(appRoot, '.octane-router-probe.json');
  const entry = path.join(appRoot, '.octane-router-probe.ts');
  if (fs.existsSync(config) || fs.existsSync(entry))
    throw new Error('Native router probe paths already exist');
  const virtual = new Map([
    [
      config,
      JSON.stringify({
        extends: path.join(appRoot, 'tsconfig.json'),
        compilerOptions: {
          noEmit: true,
          skipLibCheck: false,
          skipDefaultLibCheck: false,
        },
        files: [entry],
        include: [],
        exclude: [],
      }),
    ],
    [
      entry,
      "export type { AnyRouter, ResolveRoute } from '@tanstack/router-core';\n",
    ],
  ]);
  const options = {
    cwd: appRoot,
    tsserverPath: inputs.compiler.path,
    fs: {
      readFile: file => virtual.get(file) ?? serverFS.useOS,
      fileExists: file => (virtual.has(file) ? true : serverFS.useOS),
      directoryExists: serverFS.useOS,
      getAccessibleEntries: serverFS.useOS,
      realpath: file => (virtual.has(file) ? file : serverFS.useOS),
      stat: file =>
        virtual.has(file)
          ? {
              mode: 0o100444,
              size: Buffer.byteLength(virtual.get(file)),
              mtime: new Date(0),
            }
          : serverFS.useOS,
      writeFile: serverFS.noop,
      removeFile: serverFS.noop,
    },
  };
  const observations = [];
  for (const { project, diagnosticMode } of [
    path.join(appRoot, 'tsconfig.json'),
    config,
  ].flatMap(project =>
    ['semantic-only', 'full-pipeline'].map(diagnosticMode => ({
      project,
      diagnosticMode,
    })),
  )) {
    const api = new API(options);
    try {
      const snapshot = api.createSnapshot({ openProjects: [project] });
      const program = snapshot.getConfiguredProject(project)?.program;
      if (!program) throw new Error(`Native probe could not load ${project}`);
      const sourceFiles = program.getSourceFileNames();
      const methods =
        diagnosticMode === 'semantic-only'
          ? ['getSemanticDiagnostics']
          : [
              'getConfigFileParsingDiagnostics',
              'getProgramDiagnostics',
              'getGlobalDiagnostics',
              'getSyntacticDiagnostics',
              'getBindDiagnostics',
              'getSemanticDiagnostics',
            ];
      const diagnosticsByPhase = Object.fromEntries(
        methods.map(method => [method, program[method]()]),
      );
      observations.push({
        project,
        diagnosticMode,
        status: 'checked',
        sourceFiles,
        routerDeclarationLoaded: sourceFiles.some(file =>
          /[/\\]router-core[/\\]dist[/\\]esm[/\\]link\.d\.ts$/u.test(file),
        ),
        diagnosticsByPhase,
        diagnostics: Object.values(diagnosticsByPhase).flat(),
      });
    } catch (error) {
      // An authored TSRX-only config may have no native OS inputs. Still run
      // the independent import probe and retain both observations.
      observations.push({
        project,
        diagnosticMode,
        status: 'error',
        error: { name: error.name, message: error.message, stack: error.stack },
      });
    } finally {
      api.close();
    }
  }
  let projection;
  try {
    projection = await (load?.probeProjection ?? probeOctaneProjection)(
      appRoot,
    );
  } catch (error) {
    projection = {
      status: 'error',
      error: { name: error.name, message: error.message },
    };
  }
  let liveTraversal;
  try {
    liveTraversal = await (
      load?.probeLiveTraversal ?? probeOctaneLiveTraversal
    )(appRoot);
  } catch (error) {
    liveTraversal = {
      status: 'inconclusive',
      error: { name: error.name, message: error.message },
    };
  }
  return {
    interpretation:
      'Native OS project and isolated Router Core import; neither proves TSRX application acceptance.',
    inputs,
    observations,
    projection,
    liveTraversal,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  if (process.argv.length !== 3)
    throw new Error('Usage: node octane-router-probe.mjs <appRoot>');
  console.log(
    JSON.stringify(
      await probeOctaneRouter(fs.realpathSync(process.argv[2])),
      null,
      2,
    ),
  );
}
