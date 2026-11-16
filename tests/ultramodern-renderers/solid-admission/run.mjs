import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  assertNativePackageGraph,
  prepareRendererPackages,
} from './packages.mjs';
import { createAdmissionProcessScope } from './processes.mjs';

const execute = promisify(execFile);
const fixtureSource = fileURLToPath(new URL('./fixture/', import.meta.url));
const directoryArgument = process.argv.indexOf('--fixture-directory');
const existingDirectory =
  directoryArgument >= 0 ? process.argv[directoryArgument + 1] : undefined;
const deferredOnly = process.argv.includes('--deferred-only');
const owner = 'modernjs-dnpv3.11-solid-admission';
const guardian = path.join(os.homedir(), 'bin/disk-guardian-artifacts');
const ownedTemporaryDirectory = path.join(os.homedir(), 'bin/owned-temp-dir');
const processes = createAdmissionProcessScope();
const executeOwned = processes.execute;
const registered = new Map();
const sourceRestores = [];
let browser;
let directory;
let ownsDirectory = false;
let packageDigests;
let admissionReport;
let primaryFailure;
let primaryFailed = false;
const cleanupFailures = [];

async function exists(filename) {
  return access(filename).then(
    () => true,
    () => false,
  );
}

async function lifecycleCommand(command, args) {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      return await execute(command, args, {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      if (
        !/lock/iu.test(`${error.stdout ?? ''}${error.stderr ?? ''}`) ||
        Date.now() >= deadline
      )
        throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

async function register(filename, kind) {
  if (!ownsDirectory) return;
  if (!(await exists(guardian))) return;
  await lifecycleCommand(guardian, [
    'register',
    filename,
    '--owner',
    owner,
    '--kind',
    kind,
    '--owner-pid',
    String(process.pid),
  ]);
  registered.set(filename, kind);
}

function start(command, args) {
  return processes.start(command, args, { cwd: directory });
}

async function waitForHost(url, process) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    processes.signal.throwIfAborted();
    if (process.admissionResult().failure)
      throw process.admissionResult().failure;
    if (process.exitCode !== null || process.signalCode !== null)
      throw new Error(process.output());
    if (
      await fetch(url, {
        signal: AbortSignal.any([processes.signal, AbortSignal.timeout(1000)]),
      }).then(
        response => response.ok,
        () => false,
      )
    )
      return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Admission host did not become ready: ${process.output()}`);
}

async function stop(child) {
  await processes.stop(child);
}

async function runHydrationSuite(suite) {
  const tests = fileURLToPath(new URL(`./${suite}.test.mjs`, import.meta.url));
  const result = await executeOwned(
    ownedTemporaryDirectory,
    [
      '--run',
      `solid-${suite}`,
      '--',
      process.execPath,
      ...(suite === 'deferred-hydration' ? [] : ['--test']),
      tests,
    ],
    {
      cwd: directory,
      env: { ...process.env, ULTRAMODERN_SOLID_FIXTURE_DIRECTORY: directory },
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  process.stderr.write(result.stdout);
  process.stderr.write(result.stderr);
}

const interruptBrowser = () => {
  void browser?.close().catch(() => {});
};
processes.signal.addEventListener('abort', interruptBrowser);

async function digestTree(root) {
  const hash = createHash('sha256');
  async function visit(current) {
    for (const name of (await readdir(current, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const filename = path.join(current, name.name);
      if (name.isDirectory()) await visit(filename);
      else if (name.isFile()) {
        hash.update(path.relative(root, filename));
        hash.update(await readFile(filename));
      }
    }
  }
  await visit(root);
  return hash.digest('hex');
}

try {
  if (existingDirectory) {
    directory = path.resolve(existingDirectory);
  } else {
    directory = (await exists(ownedTemporaryDirectory))
      ? (
          await lifecycleCommand(ownedTemporaryDirectory, [
            'ultramodern-solid-admission',
            '24',
          ])
        ).stdout.trim()
      : await mkdtemp(path.join(os.tmpdir(), 'ultramodern-solid-admission-'));
    ownsDirectory = true;
    await cp(fixtureSource, directory, { recursive: true });
    await cp(
      path.join(directory, 'package.template.json'),
      path.join(directory, 'package.json'),
    );
    await register(directory, 'temp');
    await writeFile(
      path.join(directory, '.npmrc'),
      'package-import-method=clone-or-copy\n',
    );
    packageDigests = await prepareRendererPackages(
      directory,
      process.env.ULTRAMODERN_PNPM ?? 'pnpm',
      executeOwned,
    );
    process.stderr.write(
      `${JSON.stringify({
        phase: 'solid-admission-packages-captured',
        processId: process.pid,
        fixtureDirectory: directory,
        packageDigests,
      })}\n`,
    );
    await mkdir(path.join(directory, 'node_modules'), { recursive: true });
    await register(path.join(directory, 'node_modules'), 'dependencies');
    process.stderr.write(
      `${JSON.stringify({
        phase: 'solid-admission-isolated-install-started',
        processId: process.pid,
        fixtureDirectory: directory,
      })}\n`,
    );
    const install = await executeOwned(
      process.env.ULTRAMODERN_PNPM ?? 'pnpm',
      ['install', '--reporter', 'append-only'],
      {
        cwd: directory,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    process.stderr.write(install.stdout);
    process.stderr.write(install.stderr);
    process.stderr.write(
      `${JSON.stringify({
        phase: 'solid-admission-isolated-install-completed',
        processId: process.pid,
        exitCode: 0,
      })}\n`,
    );
    // pnpm replaces its empty directory. Refresh the task-owned inode lease.
    await register(path.join(directory, 'node_modules'), 'dependencies');
  }
  const packageGraph = await assertNativePackageGraph(directory);
  await executeOwned(
    process.env.ULTRAMODERN_PNPM ?? 'pnpm',
    ['peers', 'check'],
    {
      cwd: directory,
      maxBuffer: 4 * 1024 * 1024,
    },
  );

  try {
    await executeOwned(
      process.env.ULTRAMODERN_PNPM ?? 'pnpm',
      ['exec', 'tsc', '--project', 'tsconfig.json'],
      {
        cwd: directory,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  } catch (error) {
    throw new Error(
      `Solid admission requires a clean native TypeScript declaration closure.\n${error.stdout ?? ''}${error.stderr ?? ''}`,
      { cause: error },
    );
  }
  if (deferredOnly) {
    process.stderr.write(
      `${JSON.stringify({
        gate: 'solid-managed-deferred-diagnostic',
        status: 'running',
        packageDigests,
        packageGraph,
      })}\n`,
    );
    await runHydrationSuite('deferred-hydration');
    admissionReport = {
      gate: 'solid-managed-deferred-diagnostic',
      scope: 'packed managed data, native SSR and native browser hydration',
      fullNativeAdmission: false,
      node: process.version,
      packageDigests,
      packageGraph,
      managedDeferredHydrationTests: true,
    };
  } else {
    const resolve = createRequire(path.join(directory, 'package.json'));
    const { chromium } = resolve('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const dev = start(process.env.ULTRAMODERN_PNPM ?? 'pnpm', [
      'exec',
      'rsbuild',
      'dev',
    ]);
    await waitForHost('http://localhost:4193/', dev);
    await page.goto('http://localhost:4193/');
    await page.getByRole('button', { name: 'Stable 0' }).click();
    await page.getByRole('button', { name: 'Count 0' }).click();
    const before = await page.evaluate(() => ({
      timeOrigin: performance.timeOrigin,
      cleanup: globalThis.__solidCleanup ?? 0,
      loaderCalls: globalThis.__loaderCalls ?? 0,
      matches: globalThis.__solidRouter.state.matches.map(match => ({
        id: match.id,
        status: match.status,
        loaderData: match.loaderData,
      })),
    }));
    const counterPath = path.join(directory, 'src/Counter.tsx');
    const counterSource = await readFile(counterPath, 'utf8');
    sourceRestores.push([counterPath, counterSource]);
    await writeFile(
      counterPath,
      counterSource.replace('>Count {count()}', '>Edited {count()}'),
    );
    await page.getByRole('button', { name: 'Edited 0' }).waitFor();
    const after = await page.evaluate(() => ({
      timeOrigin: performance.timeOrigin,
      cleanup: globalThis.__solidCleanup ?? 0,
      stableCleanup: globalThis.__stableCleanup ?? 0,
      stableText: document.getElementById('stable-count').textContent,
      loaderCalls: globalThis.__loaderCalls ?? 0,
      matches: globalThis.__solidRouter.state.matches.map(match => ({
        id: match.id,
        status: match.status,
        loaderData: match.loaderData,
      })),
    }));
    assert.equal(
      after.timeOrigin,
      before.timeOrigin,
      'HMR reloaded the document',
    );
    assert.equal(
      after.cleanup,
      before.cleanup + 1,
      'Edited component cleanup must run once',
    );
    assert.equal(
      after.stableText,
      'Stable 1',
      'HMR lost unaffected component state',
    );
    assert.equal(
      after.stableCleanup,
      0,
      'HMR disposed an unaffected component',
    );
    assert.equal(
      after.loaderCalls,
      before.loaderCalls,
      'HMR repeated an unaffected native route loader',
    );
    assert.deepEqual(
      after.matches,
      before.matches,
      'HMR lost native router match state',
    );
    await page.getByRole('link', { name: 'Second page' }).click();
    await page.getByText('Native navigation works').waitFor();
    assert.equal(new URL(page.url()).pathname, '/second');
    assert.deepEqual(errors, []);
    await stop(dev);
    await writeFile(counterPath, counterSource);

    await mkdir(path.join(directory, 'dist'), { recursive: true });
    await register(path.join(directory, 'dist'), 'build');
    const build = await executeOwned(
      process.env.ULTRAMODERN_PNPM ?? 'pnpm',
      ['exec', 'rsbuild', 'build'],
      {
        cwd: directory,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    process.stderr.write(build.stdout);
    process.stderr.write(build.stderr);
    assert.doesNotMatch(
      build.stdout + build.stderr,
      /Critical dependency|Can't resolve|build failed/,
    );
    const server = await import(
      pathToFileURL(path.join(directory, 'dist/server/index.js')).href
    );
    const streaming = await server.probeStreaming();
    assert.deepEqual(streaming, {
      earlyShell: true,
      completeCleanup: 1,
      abortCleanup: 1,
      lateWrites: 0,
    });

    const host = start(process.execPath, ['host.mjs']);
    await waitForHost('http://localhost:4194/', host);
    await page.goto('http://localhost:4194/');
    await page.waitForFunction(() => globalThis.__solidDispose);
    await page.getByRole('button', { name: 'Lazy 0' }).click();
    const hydration = await page.evaluate(() => ({
      sameNode: globalThis.__hydratedSameNode,
      loaderCalls: globalThis.__loaderCalls ?? 0,
      lazyText: document.getElementById('lazy-count').textContent,
      nativeModules: Object.keys(globalThis._$HY?.modules ?? {}).length,
    }));
    assert.equal(hydration.sameNode, true, 'Hydration replaced server DOM');
    assert.equal(
      hydration.loaderCalls,
      0,
      'Hydration ran the native loader twice',
    );
    assert.equal(hydration.lazyText, 'Lazy 1');
    assert.ok(
      hydration.nativeModules > 0,
      'Hydration did not adopt a native lazy module',
    );
    await page.getByRole('link', { name: 'Second page' }).click();
    await page.getByText('Native navigation works').waitFor();
    assert.deepEqual(errors, []);
    const deepLinkHtml = await fetch('http://localhost:4194/second').then(
      response => {
        assert.equal(response.status, 200);
        return response.text();
      },
    );
    assert.match(deepLinkHtml, /Native navigation works/);
    assert.doesNotMatch(deepLinkHtml, /Count 0/);
    await page.reload();
    await page.getByText('Native navigation works').waitFor();
    await page.waitForFunction(() => globalThis.__solidDispose);
    assert.equal(await page.evaluate(() => globalThis.__loaderCalls ?? 0), 0);
    assert.deepEqual(errors, []);

    for (const suite of ['binding-hydration', 'deferred-hydration']) {
      await runHydrationSuite(suite);
    }

    admissionReport = {
      gate: 'solid-native-admission',
      scope: 'native package, compiler, router and hydration mechanics',
      publicConfigurationPipeline: 'requires the separate production-host gate',
      node: process.version,
      runtime: packageGraph.versions['solid-js'],
      router: '@modern-js/renderer-solid@3.8.3',
      routerCore: packageGraph.versions['@tanstack/router-core'],
      history: '1.162.5',
      compiler: packageGraph.versions['@solidjs/compiler'],
      packageDigests,
      packageGraph,
      artifactDigest: await digestTree(path.join(directory, 'dist')),
      hmr: {
        documentReload: false,
        editedComponentState: 'reset',
        unaffectedComponentState: 'preserved',
        unaffectedRouterState: 'preserved',
        cleanupCount: 1,
      },
      streaming,
      hydration,
      nativeNavigation: true,
      nativeSsrDeepLink: true,
      nativeHydrationBoundaryTests: true,
      managedDeferredHydrationTests: true,
    };
  }
} catch (error) {
  primaryFailure = error;
  primaryFailed = true;
} finally {
  const clean = async operation => {
    try {
      await operation();
    } catch (error) {
      cleanupFailures.push(error);
    }
  };
  processes.signal.removeEventListener('abort', interruptBrowser);
  await clean(() => processes.dispose());
  await clean(() => browser?.close());
  for (const [filename, source] of sourceRestores)
    await clean(() => writeFile(filename, source));
  if (ownsDirectory && directory) {
    for (const [filename, kind] of [...registered.entries()].reverse()) {
      await clean(async () => {
        // Owned installers/builders may have replaced a registered directory.
        await register(filename, kind);
        await lifecycleCommand(guardian, [
          'release',
          filename,
          '--owner',
          owner,
        ]);
      });
    }
    await clean(() => rm(directory, { recursive: true, force: true }));
  }
}
if (cleanupFailures.length)
  throw new AggregateError(
    primaryFailed ? [primaryFailure, ...cleanupFailures] : cleanupFailures,
    'Solid admission failed to clean all owned resources',
  );
if (primaryFailed) throw primaryFailure;
console.log(JSON.stringify(admissionReport, null, 2));
