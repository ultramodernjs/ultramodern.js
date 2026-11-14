import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureResolvedOctaneCompilerInputs } from './octane-compiler-inputs.mjs';

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
      "export type { AnyRouter, ResolveRoute, ResolveToParams } from '@tanstack/router-core';\n",
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
  for (const project of [path.join(appRoot, 'tsconfig.json'), config]) {
    const api = new API(options);
    try {
      const snapshot = api.createSnapshot({ openProjects: [project] });
      const program = snapshot.getConfiguredProject(project)?.program;
      if (!program) throw new Error(`Native probe could not load ${project}`);
      observations.push({
        project,
        sourceFiles: program.getSourceFileNames(),
        diagnostics: program.getSemanticDiagnostics(),
      });
    } finally {
      api.close();
    }
  }
  return {
    interpretation:
      'Native OS project and isolated Router Core import; neither proves TSRX application acceptance.',
    inputs,
    observations,
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
