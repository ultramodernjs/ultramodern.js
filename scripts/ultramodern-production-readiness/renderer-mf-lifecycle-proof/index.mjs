#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSupportedNodeVersion } from '../../ultramodern-node-policy/check-node-version.mjs';
import { readReleaseManifest } from '../../ultramodern-publish/lib/source-create-proof/release-manifest.mjs';
import {
  runChecked,
  startEphemeralRegistry,
} from '../../ultramodern-publish/lib/source-create-proof/runtime-proof/registry.mjs';
import {
  assertCohortResolutionProvenance,
  createAcceptancePackageManagerEnv,
} from '../published-create-proof/acceptance-profile.mjs';
import { createAcceptanceWorkspaceEnv } from '../published-create-proof/process.mjs';
import { parseYamlFile } from '../published-create-proof/release-age-audit.mjs';
import { registerOwnedRoot } from '../react-rsc-worker-proof/lifecycle.mjs';
import { runCommand } from '../react-rsc-worker-proof/main.mjs';
import {
  browserEndpointFailureProof,
  browserLifecycleProof,
} from './browser.mjs';
import {
  consumerInputs,
  fileEvidence,
  parseArgs,
  validateOptions,
  writeJson,
} from './contract.mjs';
import { materializeFixture } from './fixtures.mjs';
import {
  launchServer,
  overlapAndAbortProof,
  ready,
  recoveryTimeoutProof,
  reservePort,
  startControlServer,
  waitFor,
} from './runtime.mjs';

function installedPackage(requireApp, specifier, expectedName) {
  let directory = path.dirname(fs.realpathSync(requireApp.resolve(specifier)));
  for (;;) {
    const filename = path.join(directory, 'package.json');
    if (fs.existsSync(filename)) {
      const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (manifest.name === expectedName) return { directory, manifest };
    }
    const parent = path.dirname(directory);
    assert.notEqual(
      parent,
      directory,
      `Installed package owner missing: ${expectedName}`,
    );
    directory = parent;
  }
}

export async function runProof(provided) {
  const options = validateOptions({
    ...provided,
    manifestPath: provided.manifestPath ?? provided.artifacts?.manifestPath,
    expectedSourceRevision:
      provided.expectedSourceRevision ?? provided.binding?.sourceRevision,
    expectedVersion:
      provided.expectedVersion ?? provided.binding?.releaseVersion,
  });
  assert.equal(
    fs.realpathSync(options.qualifiedNode),
    fs.realpathSync(process.execPath),
    'Run this producer with its qualified Node executable',
  );
  assertSupportedNodeVersion();
  const release = readReleaseManifest({ manifestPath: options.manifestPath });
  assert.equal(release.source.commit, options.expectedSourceRevision);
  assert.equal(release.release.version, options.expectedVersion);
  if (options.binding) {
    assert.equal(release.manifestSha256, options.binding.manifestSha256);
    assert.equal(release.cohortDigest, options.binding.frameworkCohortDigest);
  }
  fs.accessSync(options.browserExecutable, fs.constants.X_OK);
  assert(
    fs.statSync(options.storeDir).isDirectory(),
    'Use the existing external pnpm store',
  );
  const registration = registerOwnedRoot(options);
  const consumer = path.join(options.workDir, 'consumer');
  fs.mkdirSync(consumer);
  const logs = path.join(options.workDir, 'logs');
  fs.mkdirSync(logs);
  const inputs = consumerInputs(release);
  const controller = new AbortController();
  const abort = reason =>
    controller.abort(
      reason instanceof Error
        ? reason
        : new Error('Native MF lifecycle proof interrupted'),
    );
  const forwardedAbort = () => abort(options.signal.reason);
  options.signal?.addEventListener('abort', forwardedAbort, { once: true });
  if (options.signal?.aborted) forwardedAbort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const deadline = setTimeout(
    () => abort(new Error('Native MF lifecycle proof exceeded 25 minutes')),
    25 * 60_000,
  );
  const handles = [];
  const cleanupErrors = [];
  let registry;
  let control;
  let browser;
  let failure;
  const receipt = {
    schema: 'bleedingdev.ultramodern.renderer-mf-lifecycle-proof',
    schemaVersion: 1,
    status: 'running',
    startedAt: new Date().toISOString(),
    sourceRevision: release.source.commit,
    releaseVersion: release.release.version,
    manifestPath: release.manifestPath,
    manifestSha256: release.manifestSha256,
    frameworkCohortDigest: release.cohortDigest,
    qualification:
      'actual-packed-public-native-React-MF-SSR-hydration-lifecycle',
    node: { executable: options.qualifiedNode, version: process.versions.node },
    owner: {
      name: options.owner,
      pid: options.ownerPid,
      root: options.workDir,
      registration,
    },
    nativeDependency: inputs.nativeDependency,
    commands: [],
    builds: {},
    serverCleanup: [],
  };
  const command = async (executable, args, label, cwd, env) => {
    const result = await runCommand(executable, args, {
      cwd,
      env,
      signal: controller.signal,
      cleanupErrors,
      log: path.join(logs, `${label}.log`),
    });
    receipt.commands.push(result);
    return result;
  };
  try {
    assert.equal(
      execFileSync(options.pnpmExecutable, ['--version'], {
        encoding: 'utf8',
        timeout: 15_000,
      }).trim(),
      release.tools.pnpm,
    );
    if (!options.registryUrl) {
      registry = await startEphemeralRegistry({
        release,
        releaseDir: release.artifactRoot,
        rootDir: path.join(options.workDir, 'registry'),
        storeDir: options.storeDir,
        runImpl: (executable, args, config) =>
          runChecked(
            executable === 'pnpm' ? options.pnpmExecutable : executable,
            args,
            config,
          ),
        spawnImpl: (executable, args, config) =>
          spawn(
            executable === 'pnpm' ? options.pnpmExecutable : executable,
            args,
            config,
          ),
      });
      receipt.registry = {
        url: registry.registryUrl,
        tool: registry.tool,
        published: registry.published,
        sidecars: registry.sidecars,
      };
    } else
      receipt.registry = {
        url: options.registryUrl,
        qualification: 'caller-owned-authenticated-cohort-registry',
      };
    const registryUrl = registry?.registryUrl ?? options.registryUrl;
    const registryEnv = registry?.env ?? options.env ?? {};
    const packageEnv = createAcceptancePackageManagerEnv(
      options.workDir,
      registryEnv,
      options.pnpmExecutable,
      process.env,
      { storeDir: options.storeDir },
    );
    const env = createAcceptanceWorkspaceEnv(
      {
        ...process.env,
        ...options.env,
        ...packageEnv,
        CI: 'true',
        FORCE_COLOR: '0',
        PATH: [path.dirname(options.qualifiedNode), packageEnv.PATH]
          .filter(Boolean)
          .join(path.delimiter),
        npm_config_store_dir: options.storeDir,
        pnpm_config_store_dir: options.storeDir,
        npm_config_package_import_method: 'clone-or-copy',
        pnpm_config_package_import_method: 'clone-or-copy',
        npm_config_cache: path.join(options.workDir, 'npm-cache'),
        XDG_CACHE_HOME: path.join(options.workDir, 'xdg-cache'),
        TMPDIR: path.join(options.workDir, 'runtime-temp'),
        ULTRAMODERN_SOURCE_REVISION: release.source.commit,
      },
      { mode: registry ? 'source' : 'published', release, registryEnv },
    );
    fs.mkdirSync(env.TMPDIR);
    for (const name of [
      'NODE_OPTIONS',
      'NODE_PATH',
      'CODESMITH_ENV',
      'MODERN_JS_VERSION',
      'MODERN_CREATE_ULTRAMODERN_FRAMEWORK_VERSION',
      'ULTRAMODERN_CREATE_BIN',
      'MODERNJS_DEPLOY',
    ])
      delete env[name];
    const ports = Object.fromEntries(
      await Promise.all(
        ['host', 'healthy', 'fragile'].map(async role => [
          role,
          await reservePort(),
        ]),
      ),
    );
    assert.equal(new Set(Object.values(ports)).size, 3);
    const origins = Object.fromEntries(
      Object.entries(ports).map(([role, port]) => [
        role,
        `http://127.0.0.1:${port}`,
      ]),
    );
    control = await startControlServer(origins);
    const fixture = materializeFixture({
      consumer,
      inputs,
      origins,
      ports,
      controlOrigin: control.url,
      release,
    });
    const policy = parseYamlFile(path.join(consumer, 'pnpm-workspace.yaml'));
    receipt.installPolicy = {
      minimumReleaseAge: policy.minimumReleaseAge,
      minimumReleaseAgeStrict: policy.minimumReleaseAgeStrict,
      minimumReleaseAgeIgnoreMissingTime:
        policy.minimumReleaseAgeIgnoreMissingTime,
      minimumReleaseAgeExclude: policy.minimumReleaseAgeExclude,
      trustPolicy: policy.trustPolicy,
      trustPolicyIgnoreAfter: policy.trustPolicyIgnoreAfter,
      pmOnFail: env.pnpm_config_pm_on_fail,
      sourceCandidateTrustPolicyExclude: JSON.parse(
        env.pnpm_config_trust_policy_exclude ?? '[]',
      ),
    };
    receipt.fixture = fixture.fixture;
    receipt.origins = { ...origins, control: control.url };
    receipt.workspaceInputs = ['package.json', 'pnpm-workspace.yaml'].map(
      file => fileEvidence(path.join(consumer, file), consumer),
    );
    await command(
      options.pnpmExecutable,
      [
        'install',
        '--lockfile-only',
        '--ignore-scripts',
        '--store-dir',
        options.storeDir,
      ],
      'lockfile',
      consumer,
      env,
    );
    await command(
      options.pnpmExecutable,
      [
        'install',
        '--frozen-lockfile',
        '--store-dir',
        options.storeDir,
        '--strict-peer-dependencies',
      ],
      'install',
      consumer,
      env,
    );
    receipt.cohortResolution = assertCohortResolutionProvenance(
      consumer,
      release,
      registryUrl,
    );
    receipt.lockfile = fileEvidence(
      path.join(consumer, 'pnpm-lock.yaml'),
      consumer,
    );
    const cli = {};
    for (const role of ['healthy', 'fragile', 'host']) {
      const root = fixture.roots[role];
      const requireApp = createRequire(path.join(root, 'package.json'));
      const sdkArtifact = release.packages.find(
        item => item.sourceName === '@modern-js/ultramodern-app-tools',
      );
      assert(sdkArtifact);
      const sdk = installedPackage(
        requireApp,
        '@modern-js/ultramodern-app-tools',
        sdkArtifact.targetName,
      );
      assert.equal(sdk.manifest.version, release.release.version);
      cli[role] = path.resolve(sdk.directory, sdk.manifest.bin.ultramodern);
      await command(
        options.qualifiedNode,
        [cli[role], 'build'],
        `${role}-build`,
        root,
        env,
      );
      const inputFile = path.join(
        options.workDir,
        `${role}-metadata-input.json`,
      );
      const outputFile = path.join(options.workDir, `${role}-metadata.json`);
      writeJson(inputFile, {
        consumer,
        root,
        role,
        manifestPath: options.manifestPath,
        expectedSourceRevision: options.expectedSourceRevision,
        manifestUrl:
          role === 'host'
            ? `${origins.host}/mf-manifest.json`
            : `${control.url}/manifest/${role}.json`,
      });
      await command(
        options.qualifiedNode,
        [
          fileURLToPath(new URL('./metadata.mjs', import.meta.url)),
          inputFile,
          outputFile,
        ],
        `${role}-metadata`,
        root,
        env,
      );
      receipt.builds[role] = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
      if (role !== 'host') {
        const handle = launchServer(options.qualifiedNode, cli[role], {
          cwd: root,
          env: { ...env, NODE_ENV: 'production', PORT: String(ports[role]) },
          log: path.join(logs, `${role}-serve.log`),
          signal: controller.signal,
        });
        handles.push(handle);
        await ready(
          handle,
          `${origins[role]}/mf-manifest.json`,
          controller.signal,
        );
      }
    }
    const projectedCss = [];
    const seenCss = new Set();
    for (const remote of receipt.builds.host.manifest.value.remotes) {
      const role = ['healthy', 'fragile'].find(role =>
        remote.entry.includes(`/manifest/${role}.json`),
      );
      assert(
        role,
        'Every configured native remote must bind one actual built remote manifest',
      );
      const urls = receipt.builds[role].css.urls;
      assert(
        urls.length > 0,
        `Actual built ${role} remote must own CSS assets`,
      );
      for (const url of urls)
        if (!seenCss.has(url)) {
          seenCss.add(url);
          projectedCss.push(url);
        }
    }
    control.expectedRemoteCss = projectedCss;
    receipt.expectedRemoteCss = projectedCss;
    const requireBrowser = createRequire(
      path.join(options.browserDependencyRoot, 'package.json'),
    );
    const { chromium } = requireBrowser('playwright-core');
    receipt.browserDriver = {
      package: fileEvidence(
        fs.realpathSync(requireBrowser.resolve('playwright-core/package.json')),
        options.browserDependencyRoot,
      ),
      executable: options.browserExecutable,
      version: requireBrowser('playwright-core/package.json').version,
    };
    browser = await chromium.launch({
      executablePath: options.browserExecutable,
      headless: true,
    });
    const startHost = async label => {
      const handle = launchServer(options.qualifiedNode, cli.host, {
        cwd: fixture.roots.host,
        env: { ...env, NODE_ENV: 'production', PORT: String(ports.host) },
        log: path.join(logs, `host-${label}-serve.log`),
        signal: controller.signal,
      });
      handles.push(handle);
      // /away renders no remote and cannot warm the native runtime entry cache.
      await ready(handle, `${origins.host}/away`, controller.signal);
      return handle;
    };
    let host = await startHost('valid');
    receipt.requestLifecycle = await overlapAndAbortProof(
      origins.host,
      control,
      controller.signal,
    );
    receipt.browserLifecycle = await browserLifecycleProof(
      browser,
      origins.host,
      { expectedRemoteCss: projectedCss },
    );
    receipt.serverCleanup.push(await host.stop());
    await waitFor(
      () => control.pendingConnectionCount === 0,
      'all valid native resources settled',
      { signal: controller.signal },
    );
    control.setMode('valid');
    host = await startHost('timeout');
    // /away finishes the native production CSS collector's normal warmup while
    // no React.lazy remote is rendered. Its 30s cache keeps collector fetches
    // separate from the fresh runtime's initial503 and bounded recovery fetches.
    control.setMode('timeout');
    receipt.serverRecoveryTimeout = await recoveryTimeoutProof(
      origins.host,
      control,
      controller.signal,
    );
    receipt.serverCleanup.push(await host.stop());
    await waitFor(
      () => control.pendingConnectionCount === 0,
      'all bounded native recovery requests closed',
      { signal: controller.signal },
    );
    control.setMode('valid');
    host = await startHost('endpoint-failure');
    control.setMode('endpoint-failure');
    receipt.browserEndpointFailure = await browserEndpointFailureProof(
      browser,
      origins.host,
      { expectedRemoteCss: projectedCss },
    );
    receipt.serverCleanup.push(await host.stop());
    const current = readReleaseManifest({ manifestPath: options.manifestPath });
    assert.equal(current.manifestSha256, receipt.manifestSha256);
    assert.equal(current.cohortDigest, receipt.frameworkCohortDigest);
    for (const role of ['host', 'healthy', 'fragile'])
      for (const item of fixture.fixture[role])
        assert.deepEqual(
          fileEvidence(path.join(consumer, item.path), consumer),
          item,
          'Authored native fixture input changed during qualification',
        );
    controller.signal.throwIfAborted();
  } catch (error) {
    failure = error;
    receipt.failure = {
      name: error.name,
      message: error.message,
      ...(cleanupErrors.length ? { cleanupErrors } : {}),
    };
  } finally {
    clearTimeout(deadline);
    const cleanup = await Promise.allSettled([
      ...handles.map(handle => handle.stop()),
      browser?.close(),
      control?.close(),
      registry?.stop(),
    ]);
    receipt.cleanup = cleanup.map(result =>
      result.status === 'fulfilled'
        ? { status: 'fulfilled', value: result.value }
        : { status: 'rejected', error: result.reason.message },
    );
    receipt.http = control?.evidence;
    receipt.nativeTerminals = control?.terminals;
    if (cleanup.some(result => result.status === 'rejected')) {
      failure ??= new Error('Owned native MF proof cleanup failed');
      receipt.failure ??= { name: failure.name, message: failure.message };
    }
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    options.signal?.removeEventListener('abort', forwardedAbort);
    receipt.status = failure ? 'failed' : 'passed';
    receipt.completedAt = new Date().toISOString();
    receipt.retainedArtifacts = {
      root: options.workDir,
      owner: options.owner,
      ownerPid: options.ownerPid,
      qualification:
        'caller-owned-until-receipt-review-and-explicit-artifact-release',
    };
    writeJson(options.receiptPath, receipt);
  }
  if (failure) throw failure;
  return receipt;
}

export const runFederationLifecycleProof = runProof;

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const receipt = await runProof(parseArgs(process.argv.slice(2)));
    process.stdout.write(
      `Native React MF lifecycle proof passed for ${receipt.releaseVersion}.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
