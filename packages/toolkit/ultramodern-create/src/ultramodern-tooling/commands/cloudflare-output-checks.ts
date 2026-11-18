import { availableParallelism } from 'node:os';
import { finished } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';
import type { CloudflareOutputVerifierResult } from '@modern-js/app-tools-extensions/cloudflare-output-verifier';

export interface CloudflareOutputCheckTarget {
  label: string;
  outputDirectory: string;
}

type TargetCheck = { stdout: string; stderr: string } & (
  | { result: CloudflareOutputVerifierResult }
  | { error: unknown }
);

// Runs as CommonJS in its own thread, so each target's worker bundle is
// imported into a fresh isolate, as in a per-app `--app` check.
const CHECK_ONE_TARGET = `
const { parentPort, workerData } = require('node:worker_threads');
require(workerData.verifierPath)
  .verifyCloudflareOutput({ outputDirectory: workerData.outputDirectory, importWorker: true })
  .then(result => parentPort.postMessage({ result }), error => parentPort.postMessage({ error }));
`;

// Resolves once the thread has exited and its output is collected. The thread
// is never terminated early: that drops output it has not flushed yet.
const checkTargetInThread = (
  verifierPath: string,
  target: CloudflareOutputCheckTarget,
) =>
  new Promise<TargetCheck>(resolve => {
    const worker = new Worker(CHECK_ONE_TARGET, {
      eval: true,
      stdout: true,
      stderr: true,
      workerData: { verifierPath, outputDirectory: target.outputDirectory },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    worker.stdout.on('data', chunk => stdout.push(chunk));
    worker.stderr.on('data', chunk => stderr.push(chunk));
    let posted:
      | { result: CloudflareOutputVerifierResult }
      | { error: unknown }
      | undefined;
    let threadFailure: { error: unknown } | undefined;
    worker.on('message', message => {
      posted = message;
    });
    // An uncaught error or a non-zero exit fails the check even after a result
    // was posted (a timer or rejection left behind by the imported worker), as
    // it ended the process when the checks ran in it.
    worker.on('error', error => {
      threadFailure ??= { error };
    });
    worker.on('exit', code => {
      void Promise.allSettled([
        finished(worker.stdout),
        finished(worker.stderr),
      ]).then(() =>
        resolve({
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
          ...(threadFailure ??
            (code !== 0 || posted === undefined
              ? {
                  error: new Error(
                    `Cloudflare output check of ${target.label} exited with code ${code}${posted === undefined ? ' before it returned a result' : ''}.`,
                  ),
                }
              : posted)),
        }),
      );
    });
  });

// One target check parses its worker bundles with Babel and imports its server
// entry: about 1.7 s of one core, a few small file reads, no child process.
// That work holds the JS thread, so checks overlap only in separate threads,
// and one thread per core keeps the cores busy without queueing for CPU.
// Threads start in target order.
const checkTargetsSideBySide = (
  verifierPath: string,
  targets: CloudflareOutputCheckTarget[],
) => {
  let free = Math.min(targets.length, availableParallelism());
  const waiting: Array<() => void> = [];
  const slot = async () => {
    if (free > 0) {
      free--;
      return;
    }
    await new Promise<void>(resolve => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      free++;
    }
  };
  return targets.map(async target => {
    await slot();
    try {
      return await checkTargetInThread(verifierPath, target);
    } finally {
      release();
    }
  });
};

/**
 * Checks every target side by side with the verifier at `verifierPath` and
 * prints each target's output and verdict in target order. Returns whether a
 * target failed. When a check throws, the targets before it are reported and
 * its error is thrown once every check has ended, as one after another would.
 */
export async function reportCloudflareOutputChecks(
  verifierPath: string,
  targets: CloudflareOutputCheckTarget[],
) {
  const checks = checkTargetsSideBySide(verifierPath, targets);
  let failed = false;
  for (const [index, target] of targets.entries()) {
    const check = await checks[index];
    process.stdout.write(check.stdout);
    process.stderr.write(check.stderr);
    if ('error' in check) {
      await Promise.all(checks);
      throw check.error;
    }
    const { result } = check;
    if (result.ok) {
      console.log(`[ultramodern] Cloudflare output verified: ${target.label}`);
    } else {
      failed = true;
      console.error(`[ultramodern] Cloudflare output failed: ${target.label}`);
      for (const issue of result.issues) {
        console.error(
          `- ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ''}`,
        );
      }
    }
  }
  return failed;
}
