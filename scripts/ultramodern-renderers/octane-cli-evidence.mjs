import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSupportedHostedJob } from './hosted-job.mjs';

const appKey = 'ULTRAMODERN_OCTANE_EVIDENCE_APP';
const logKey = 'ULTRAMODERN_OCTANE_EVIDENCE_LOG';
const errorInfo = error => ({
  name: error?.name ?? 'Error',
  message: error?.message ?? String(error),
});

/** Only the public Octane command inherits this; unrelated children stay inert. */
export function octaneTypecheckEvidenceEnv(
  appRoot,
  logPrefix,
  env = process.env,
) {
  if (!isSupportedHostedJob(env)) return env;
  if (!path.isAbsolute(appRoot) || !path.isAbsolute(logPrefix))
    throw new Error(
      'Octane evidence requires absolute app and retained log paths',
    );
  const relative = path.relative(appRoot, logPrefix);
  if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    throw new Error('Octane evidence must outlive disposable app cleanup');
  const preload = new URL('./octane-cli-preload.mjs', import.meta.url).href;
  return {
    ...env,
    [appKey]: appRoot,
    [logKey]: logPrefix,
    NODE_OPTIONS:
      `${env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}`.trim(),
  };
}

/** Production never imports or invokes the checker here. */
export async function installOctaneCliEvidence() {
  const env = process.env;
  if (!isSupportedHostedJob(env) || !env[appKey] || !env[logKey]) return;
  // pnpm and all other children must not resolve packages, import tsrs or hook.
  if (path.basename(process.argv[1] ?? '') !== 'octane-tsc.mjs') return;
  let log;
  let observer;
  let result;
  let ownsLog = false;
  try {
    const appRoot = fs.realpathSync(env[appKey]);
    const prefix = path.resolve(env[logKey]);
    const relative = path.relative(appRoot, prefix);
    if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      return;
    const request = createRequire(path.join(appRoot, 'package.json'));
    // This manifest is explicitly exported by the installed renderer.
    const manifest = fs.realpathSync(
      request.resolve('@modern-js/renderer-octane/package.json'),
    );
    const bin = fs.realpathSync(
      path.join(path.dirname(manifest), 'bin/octane-tsc.mjs'),
    );
    if (fs.realpathSync(process.argv[1]) !== bin) return;
    log = `${prefix}.${process.pid}.log`;
    const {
      octaneProjectionResult,
      observeOctaneProjection,
      replayOctaneProjection,
    } = await import('./octane-projection-repro.mjs');
    result = octaneProjectionResult();
    result.captureOrigin = 'original-public-cli';
    result.command = {
      pid: process.pid,
      ppid: process.ppid,
      executable: process.execPath,
      argv: [...process.argv],
      cwd: process.cwd(),
      installedBin: bin,
      appRoot,
    };
    result.original = { status: 'observing' };
    result.proofGaps[0] =
      'Observed the original public CLI invocation; hooks/source observation may themselves perturb native history.';
    const rendererRequire = createRequire(manifest);
    const modules = {
      ...(await import(
        pathToFileURL(rendererRequire.resolve('tsrs/sync')).href
      )),
      ...(await import(pathToFileURL(rendererRequire.resolve('tsrs/fs')).href)),
    };
    observer = observeOctaneProjection(modules.API, result, {
      failureOnly: true,
      onClose() {
        result.original.status = 'closed';
      },
    });
    let finished = false;
    process.once('exit', code => {
      if (finished) return;
      finished = true;
      observer.dispose();
      result.original.exitCode = code;
      result.replay.proofGap =
        'Process exited without beforeExit; no replay was attempted.';
      write();
    });
    process.once('beforeExit', async () => {
      if (finished) return;
      finished = true;
      const exitCode = process.exitCode;
      try {
        observer.dispose();
        result.original.exitCode = exitCode ?? 0;
        // Retain the original witness even if later native replay aborts.
        write();
        if (result.original.status !== 'closed')
          result.captureError ??= {
            message: 'Original API close was not observed',
          };
        if (
          result.captures[0]?.graph &&
          !result.captureError &&
          !result.closeError
        ) {
          // In particular, resolver --version must NOT precede the real check.
          const { captureResolvedOctaneCompilerInputs } = await import(
            './octane-compiler-inputs.mjs'
          );
          result.inputs = await captureResolvedOctaneCompilerInputs(appRoot);
          replayOctaneProjection(
            appRoot,
            { ...modules, inputs: result.inputs },
            result,
          );
        }
      } catch (error) {
        result.captureError = errorInfo(error);
      } finally {
        process.exitCode = exitCode;
        write();
      }
    });
  } catch (error) {
    observer?.dispose();
    result ??= { captureOrigin: 'original-public-cli', pid: process.pid };
    result.captureError = errorInfo(error);
    write();
  }
  function write() {
    if (!log) return;
    try {
      // The parent owns this retained directory. No app/source writes.
      fs.writeFileSync(log, `${JSON.stringify(result, null, 2)}\n`, {
        flag: ownsLog ? 'w' : 'wx',
      });
      ownsLog = true;
    } catch {
      // Evidence failure cannot replace the public CLI's output or status.
    }
  }
}
