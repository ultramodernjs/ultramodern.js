#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readReleaseManifest } from '../../ultramodern-publish/lib/source-create-proof/release-manifest.mjs';
import {
  runChecked,
  startEphemeralRegistry,
} from '../../ultramodern-publish/lib/source-create-proof/runtime-proof/registry.mjs';
import {
  checkInstalledCohort,
  readCohort,
} from '../../ultramodern-renderers/installed-cohort.mjs';
import {
  assertCohortResolutionProvenance,
  createAcceptancePackageManagerEnv,
  resolveExactPnpmExecutable,
} from '../published-create-proof/acceptance-profile.mjs';
import {
  confinedPath,
  fileEvidence,
  materializeFixtureSources,
  ordinaryFiles,
  parseArgs,
  releaseConsumerInputs,
  sha256,
  workerOptions,
} from './contract.mjs';
import { registerOwnedRoot } from './lifecycle.mjs';
import {
  assertNativeSsrHtml,
  browserProof,
  inspectOwnedProcessGroup,
  nativeFailureProof,
  retireOwnedProcessGroup,
  startBridge,
} from './runtime.mjs';

const fixtureRoot = fileURLToPath(new URL('./fixture/', import.meta.url));
const harnessRequire = createRequire(
  new URL('../../../tests/package.json', import.meta.url),
);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function packageRoot(entry, expectedName, consumerRoot) {
  let directory = path.dirname(fs.realpathSync(entry));
  while (directory !== path.dirname(directory)) {
    const manifest = path.join(directory, 'package.json');
    if (fs.existsSync(manifest) && readJson(manifest).name === expectedName) {
      confinedPath(consumerRoot, path.relative(consumerRoot, directory));
      return { directory, manifest: readJson(manifest) };
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Installed public package root not found: ${expectedName}`);
}

export async function runCommand(
  command,
  args,
  { cwd, env, log, signal, cleanupErrors = [] },
) {
  const descriptor = fs.openSync(log, 'wx');
  const started = Date.now();
  try {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', descriptor, descriptor],
    });
    let cancellation;
    let escalation;
    let terminationFailed = false;
    const previousCleanupErrorCount = cleanupErrors.length;
    const terminate = signalName => {
      if (terminationFailed) return false;
      try {
        if (process.platform === 'win32') child.kill(signalName);
        else if (child.pid) process.kill(-child.pid, signalName);
      } catch (error) {
        if (error.code !== 'ESRCH') {
          terminationFailed = true;
          cleanupErrors.push({
            name: error.name,
            message: error.message,
            code: error.code,
            signal: signalName,
            pid: child.pid,
          });
          return false;
        }
      }
      return true;
    };
    let rejectCommand;
    const completed = new Promise((resolve, reject) => {
      rejectCommand = reject;
      child.once('error', reject);
      child.once('close', (status, terminatedBy) => {
        if (cancellation) reject(cancellation);
        else if (terminatedBy)
          reject(
            new Error(
              `Owned command terminated by ${terminatedBy}: ${args.join(' ')}`,
            ),
          );
        else resolve(status);
      });
    });
    const cancel = reason => {
      cancellation ??= reason;
      if (!terminate('SIGTERM')) rejectCommand(cancellation);
      else
        escalation ??= setTimeout(() => {
          if (!terminate('SIGKILL')) rejectCommand(cancellation);
        }, 3000);
    };
    const abort = () =>
      cancel(signal.reason ?? new Error('Owned command interrupted'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const deadline = setTimeout(
      () => cancel(new Error(`Owned command timed out: ${args.join(' ')}`)),
      10 * 60_000,
    );
    let code;
    let processGroupCleanup;
    try {
      code = await completed;
      if (code !== 0) {
        const output = fs.openSync(log, 'r');
        let tail;
        try {
          const size = fs.fstatSync(output).size;
          const bytes = Buffer.alloc(Math.min(size, 16 * 1024));
          const read = fs.readSync(
            output,
            bytes,
            0,
            bytes.length,
            size - bytes.length,
          );
          tail = bytes.subarray(0, read).toString('utf8');
        } finally {
          fs.closeSync(output);
        }
        assert.equal(code, 0, `Command failed; see ${log}\n${tail}`);
      }
    } finally {
      clearTimeout(deadline);
      clearTimeout(escalation);
      signal.removeEventListener('abort', abort);
      if (process.platform === 'win32') terminate('SIGKILL');
      else if (child.pid) {
        try {
          processGroupCleanup = terminationFailed
            ? {
                before: inspectOwnedProcessGroup(child.pid),
                signaled: false,
                previousTerminationFailure: true,
              }
            : await retireOwnedProcessGroup(child.pid);
        } catch (error) {
          terminationFailed = true;
          cleanupErrors.push({
            name: error.name,
            message: error.message,
            code: error.code,
            signal: error.cleanupSignal,
            pid: child.pid,
            exitCode: child.exitCode,
            terminatedBy: child.signalCode,
            membership: error.membership,
          });
        }
      }
    }
    assert.equal(
      cleanupErrors.length,
      previousCleanupErrorCount,
      `Owned command cleanup failed; see ${log}`,
    );
    return {
      command,
      args,
      exitCode: code,
      durationMs: Date.now() - started,
      pid: child.pid,
      ...(processGroupCleanup ? { processGroupCleanup } : {}),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function runProof(options) {
  const version = process.versions.node.split('.').map(Number);
  assert(
    version[0] > 26 || (version[0] === 26 && version[1] >= 10),
    'Node >=26.12.0 is required',
  );
  const release = readReleaseManifest({ manifestPath: options.manifestPath });
  assert.equal(release.source.commit, options.expectedSourceRevision);
  assert.equal(release.release.version, options.expectedVersion);
  const cohort = readCohort(options.manifestPath);
  fs.accessSync(options.browserExecutable, fs.constants.X_OK);
  assert(
    fs.statSync(options.storeDir).isDirectory(),
    'The existing external shared pnpm store is required',
  );
  const registration = registerOwnedRoot(options);
  const consumer = path.join(options.workDir, 'consumer');
  fs.mkdirSync(consumer);
  const inputs = releaseConsumerInputs(
    release,
    readJson(path.join(fixtureRoot, 'package.json.template')),
  );
  const fixtureSources = materializeFixtureSources({
    fixtureRoot,
    consumer,
    release,
    priorReceipt: options.priorReceipt,
  });
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    `${JSON.stringify(inputs.manifest, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(consumer, 'pnpm-workspace.yaml'),
    inputs.workspaceYaml,
  );
  const tempRoot = path.join(options.workDir, 'runtime-temp');
  fs.mkdirSync(tempRoot);
  const previousTempDirectory = process.env.TMPDIR;
  process.env.TMPDIR = tempRoot;
  const controller = new AbortController();
  let browser;
  let miniflare;
  let bridge;
  let registry;
  let failure;
  const commandCleanupErrors = [];
  let browserCleanup;
  let bridgeCleanup;
  let workerCleanup;
  let registryCleanup;
  const cleanup = () =>
    Promise.allSettled([
      browser ? (browserCleanup ??= browser.close()) : undefined,
      bridge ? (bridgeCleanup ??= bridge.close()) : undefined,
      miniflare ? (workerCleanup ??= miniflare.dispose()) : undefined,
      registry ? (registryCleanup ??= registry.stop()) : undefined,
    ]);
  const interrupt = reason => {
    controller.abort(
      reason instanceof Error
        ? reason
        : new Error('React RSC workerd proof interrupted'),
    );
    void cleanup();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const deadline = setTimeout(
    () => interrupt(new Error('React RSC workerd proof exceeded 20 minutes')),
    20 * 60_000,
  );
  const receipt = {
    schema: 'bleedingdev.ultramodern.react-rsc-workerd-proof',
    schemaVersion: 1,
    status: 'running',
    startedAt: new Date().toISOString(),
    sourceRevision: release.source.commit,
    releaseVersion: release.release.version,
    manifestPath: release.manifestPath,
    manifestSha256: release.manifestSha256,
    frameworkCohortDigest: release.cohortDigest,
    qualification:
      'actual-packed-public-consumer-workerd-native-react-rsc-browser',
    node: { executable: process.execPath, version: process.versions.node },
    owner: {
      name: options.owner,
      pid: options.ownerPid,
      root: options.workDir,
      registration,
    },
    ...fixtureSources,
    commands: [],
  };
  try {
    const checked = (command, args, config) =>
      execFileSync(command, args, {
        cwd: config.cwd,
        env: config.env,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 15_000,
      }).trim();
    const pnpm = resolveExactPnpmExecutable(
      checked,
      release.tools.pnpm,
      process.env,
      consumer,
    );
    registry = await startEphemeralRegistry({
      release,
      releaseDir: release.artifactRoot,
      rootDir: path.join(options.workDir, 'registry'),
      storeDir: options.storeDir,
      runImpl: (command, args, config) =>
        runChecked(command === 'pnpm' ? pnpm : command, args, config),
      spawnImpl: (command, args, config) =>
        spawn(command === 'pnpm' ? pnpm : command, args, config),
    });
    controller.signal.throwIfAborted();
    receipt.registry = {
      url: registry.registryUrl,
      tool: registry.tool,
      published: registry.published,
      sidecars: registry.sidecars,
    };
    const packageManagerEnv = createAcceptancePackageManagerEnv(
      options.workDir,
      registry.env,
      pnpm,
      process.env,
      { storeDir: options.storeDir },
    );
    const env = {
      ...process.env,
      ...packageManagerEnv,
      CI: 'true',
      FORCE_COLOR: '0',
      PATH: [path.dirname(process.execPath), packageManagerEnv.PATH]
        .filter(Boolean)
        .join(path.delimiter),
      npm_config_store_dir: options.storeDir,
      pnpm_config_store_dir: options.storeDir,
      npm_config_cache: path.join(options.workDir, 'npm-cache'),
      XDG_CACHE_HOME: path.join(options.workDir, 'xdg-cache'),
      TMPDIR: tempRoot,
      ULTRAMODERN_SOURCE_REVISION: release.source.commit,
      MODERNJS_DEPLOY: 'cloudflare',
      PUPPETEER_EXECUTABLE_PATH: options.browserExecutable,
    };
    for (const key of [
      'NODE_OPTIONS',
      'NODE_PATH',
      'CODESMITH_ENV',
      'MODERN_JS_VERSION',
      'MODERN_CREATE_ULTRAMODERN_FRAMEWORK_VERSION',
      'ULTRAMODERN_CREATE_BIN',
    ])
      delete env[key];
    receipt.pnpm = {
      executable: pnpm,
      version: release.tools.pnpm,
      storeDir: options.storeDir,
    };
    for (const [label, args] of [
      [
        'lockfile',
        [
          'install',
          '--lockfile-only',
          '--ignore-scripts',
          '--store-dir',
          options.storeDir,
        ],
      ],
      [
        'install',
        ['install', '--frozen-lockfile', '--store-dir', options.storeDir],
      ],
    ]) {
      receipt.commands.push(
        await runCommand(pnpm, args, {
          cwd: consumer,
          env,
          signal: controller.signal,
          cleanupErrors: commandCleanupErrors,
          log: path.join(options.workDir, `${label}.log`),
        }),
      );
    }
    controller.signal.throwIfAborted();
    receipt.cohortResolution = assertCohortResolutionProvenance(
      consumer,
      release,
      registry.registryUrl,
    );
    const require = createRequire(path.join(consumer, 'package.json'));
    const toolsArtifact = release.packages.find(
      item => item.sourceName === '@modern-js/ultramodern-app-tools',
    );
    const tools = packageRoot(
      require.resolve('@modern-js/ultramodern-app-tools'),
      toolsArtifact.targetName,
      consumer,
    );
    assert.equal(tools.manifest.version, release.release.version);
    const cli = confinedPath(tools.directory, tools.manifest.bin.ultramodern);
    for (const [label, args] of [
      ['build', ['build']],
      ['deploy', ['deploy', '--skip-build']],
    ]) {
      const commandEvidence = await runCommand(
        process.execPath,
        [cli, ...args],
        {
          cwd: consumer,
          env,
          signal: controller.signal,
          cleanupErrors: commandCleanupErrors,
          log: path.join(options.workDir, `${label}.log`),
        },
      );
      receipt.commands.push(commandEvidence);
    }
    const outputRoot = path.join(consumer, '.output');
    const wranglerPath = path.join(outputRoot, 'wrangler.json');
    const wrangler = readJson(wranglerPath);
    const optionsForWorker = workerOptions(outputRoot, wrangler);
    receipt.wrangler = fileEvidence(wranglerPath, outputRoot);
    receipt.workerModules = optionsForWorker.modules.map(module =>
      fileEvidence(module.path, outputRoot),
    );
    receipt.assets = ordinaryFiles(optionsForWorker.assets.directory).map(
      file => fileEvidence(file, outputRoot),
    );
    const publicTools = require('@modern-js/ultramodern-app-tools');
    const buildManifestPath = path.join(
      consumer,
      'dist',
      publicTools.RENDERER_BUILD_MANIFEST_FILE,
    );
    const buildManifest = publicTools.validateRendererBuildManifest(
      readJson(buildManifestPath),
      publicTools.resolveRendererProfile('react'),
    );
    assert.equal(buildManifest.sourceRevision, release.source.commit);
    receipt.rendererBuild = {
      ...fileEvidence(buildManifestPath, consumer),
      value: buildManifest,
    };
    receipt.installedCohortPackages = checkInstalledCohort({
      appRoot: consumer,
      cohort,
    });
    receipt.lockfile = fileEvidence(
      path.join(consumer, 'pnpm-lock.yaml'),
      consumer,
    );
    const generator = packageRoot(
      require.resolve('@modern-js/ultramodern-create'),
      release.createPackage.targetName,
      consumer,
    );
    assert.equal(generator.manifest.version, release.createPackage.version);
    receipt.generator = {
      name: generator.manifest.name,
      version: generator.manifest.version,
    };
    const generatorRequire = createRequire(
      path.join(generator.directory, 'package.json'),
    );
    const miniflareEntry = generatorRequire.resolve('miniflare');
    const miniflarePackage = packageRoot(miniflareEntry, 'miniflare', consumer);
    assert.equal(
      miniflarePackage.manifest.version,
      release.createPackage.packageJson.dependencies.miniflare,
    );
    receipt.miniflare = {
      name: 'miniflare',
      version: miniflarePackage.manifest.version,
      entry: path.relative(consumer, miniflareEntry),
      generator: generator.manifest.name,
    };
    const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } =
      await import(pathToFileURL(miniflareEntry).href);
    miniflare = new Miniflare(
      convertV4MiniflareOptions({
        log: new Log(LogLevel.ERROR),
        workers: [optionsForWorker],
      }),
    );
    await miniflare.ready;
    controller.signal.throwIfAborted();
    bridge = await startBridge(miniflare, wrangler.name);
    const ssr = await fetch(`${bridge.url}/composite`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
    });
    assert.equal(ssr.status, 200);
    const ssrBytes = Buffer.from(await ssr.arrayBuffer());
    receipt.ssr = {
      status: ssr.status,
      byteLength: ssrBytes.length,
      sha256: sha256(ssrBytes),
    };
    receipt.http = bridge.evidence;
    assertNativeSsrHtml(ssrBytes.toString());
    const identities = [
      ...ssrBytes
        .toString()
        .matchAll(
          /<script\b[^>]*\bid=["']ultramodern-renderer-identity["'][^>]*>([\s\S]*?)<\/script>/gu,
        ),
    ];
    assert.equal(
      identities.length,
      1,
      'Real workerd HTML must carry one built renderer identity',
    );
    const htmlIdentity = JSON.parse(identities[0][1]);
    assert.deepEqual(
      htmlIdentity,
      buildManifest.entries[htmlIdentity.entryName],
    );
    const identityHeader = ssr.headers.get('x-ultramodern-renderer-identity');
    assert(
      identityHeader,
      'Real workerd HTML must carry the owning renderer identity header',
    );
    assert.deepEqual(JSON.parse(identityHeader), htmlIdentity);
    receipt.ssr.rendererIdentity = htmlIdentity;
    const { launchOptions } = harnessRequire('./utils/launchOptions.js');
    const puppeteer = harnessRequire('puppeteer');
    browser = await puppeteer.launch({
      ...launchOptions,
      headless: true,
      dumpio: false,
      executablePath: options.browserExecutable,
      userDataDir: path.join(options.workDir, 'browser-profile'),
      args: launchOptions.args.filter(
        argument => argument !== '--disable-web-security',
      ),
    });
    controller.signal.throwIfAborted();
    receipt.browser = await browserProof(browser, bridge.url);
    receipt.nativeFailures = await nativeFailureProof(
      bridge.url,
      receipt.browser.actionId,
      controller.signal,
    );
    receipt.http = bridge.evidence;
    assert(
      !bridge.evidence.some(record => record.bridgeError),
      'Workerd HTTP bridge reported an error',
    );
    const authenticatedAgain = readReleaseManifest({
      manifestPath: options.manifestPath,
    });
    assert.equal(authenticatedAgain.manifestSha256, receipt.manifestSha256);
    assert.equal(
      authenticatedAgain.cohortDigest,
      receipt.frameworkCohortDigest,
    );
    controller.signal.throwIfAborted();
  } catch (error) {
    failure = error;
    receipt.failure = { name: error.name, message: error.message };
    if (error.browserEvidence) receipt.browserFailure = error.browserEvidence;
    if (commandCleanupErrors.length)
      receipt.failure.cleanupErrors = commandCleanupErrors;
  } finally {
    clearTimeout(deadline);
    const cleanupResults = await cleanup();
    receipt.cleanup = cleanupResults.map(result => ({
      status: result.status,
      ...(result.status === 'rejected' ? { error: result.reason.message } : {}),
    }));
    if (cleanupResults.some(result => result.status === 'rejected')) {
      failure ??= new Error('Owned workerd/browser/HTTP cleanup failed');
      receipt.failure ??= { name: failure.name, message: failure.message };
    }
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (previousTempDirectory === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTempDirectory;
    receipt.status = failure ? 'failed' : 'passed';
    receipt.completedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(options.receipt), { recursive: true });
    fs.writeFileSync(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  if (failure) throw failure;
  return receipt;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const receipt = await runProof(parseArgs(process.argv.slice(2)));
    process.stdout.write(
      `React RSC workerd proof passed for ${receipt.releaseVersion}.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
