#!/usr/bin/env node
// Packed-release acceptance: the renderer fixture apps, rebuilt from a packed
// cohort the way a user gets them, must pass the same behavior specs as the
// workspace apps.
//
//   /Users/satan/bin/owned-temp-dir --run renderer-release -- \
//     node scripts/ultramodern-renderers/release.mjs \
//       (--version <x.y.z-ultramodern.N> | --cohort-dir <dir>) \
//       [--renderers react,solid,octane] [--with worker,rsc,mf]
//       [--browser-dependency-root <existing installed Playwright owner>]
//       [--required-features --native-inputs <authenticated native archive inputs.json>]
//       [--tractor-source <tractor demo checkout> [--tractor-revision <rev>]]
//
// For each renderer: generate a workspace with the packed create CLI,
// (Solid, Octane) build and serve its untouched starter, put the
// tests/integration/renderer-<r> app into its shell, install from a local
// registry under the strict release-age policy, recapture the shell's delivery
// unit from the fixture config (sync-delivery-unit), check the installed cohort is
// the packed bytes, typecheck, and run the specs. Solid and Octane also install
// an ordinary fixture outside the generated topology to prove portable Node
// deployment; this does not qualify the generated shell's release envelope.
// Native Module Federation proofs separately install the host and remote from
// the candidate cohort. Then the React runners in scripts/ultramodern-production-readiness: worker
// custom entries and RSC on workerd, Module Federation lifecycle, and (with
// --tractor-source, a Tractor repository containing the pinned
// scripts/ultramodern-publish/tractor-baseline-revision) the Tractor
// downstream adoption of that exact baseline, or of --tractor-revision (any
// revision of the source checkout, e.g. a local adoption commit) when given.
// Prints a PASS/FAIL/SKIP table and exits 1 on any failure.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { assertAcceptanceReceipt } from '../ultramodern-production-readiness/published-create-proof/acceptance-receipt.mjs';
import { releaseAgeExemptions } from '../ultramodern-production-readiness/published-create-proof/release-age-audit.mjs';
import { runWorkerDispatchProbe } from '../ultramodern-production-readiness/renderer-worker-lifecycle-proof/probe.mjs';
import { readReleaseManifest } from '../ultramodern-publish/lib/source-create-proof/release-manifest.mjs';
import { startEphemeralRegistry } from '../ultramodern-publish/lib/source-create-proof/runtime-proof/registry.mjs';
import { defaultReleaseAgePolicyPath } from '../ultramodern-publish/run-release-acceptance.mjs';
import { resolveBrowserDependencyRoot } from './browser-dependencies.mjs';
import {
  assertRendererFeatureRow,
  rendererAcceptanceRegistryUrl,
  rendererFeatureBinding,
  writeRendererFeatureReceipt,
} from './feature-gates.mjs';
import { checkInstalledCohort, readCohort } from './installed-cohort.mjs';
import { runPackedNativeFederationGeneratedProof } from './native-federation-generated.mjs';
import {
  installedBin,
  runPackedNativeFederationProof,
} from './native-federation-packed.mjs';
import {
  assertReleaseAgeExclusionsUnchanged,
  captureReleaseAgeExclusions,
} from './release-age-policy.mjs';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const allRenderers = ['react', 'solid', 'octane'];
const allRunners = ['worker', 'rsc', 'mf'];

const { values: opts } = parseArgs({
  options: {
    version: { type: 'string' },
    'cohort-dir': { type: 'string' },
    renderers: { type: 'string', default: allRenderers.join(',') },
    with: { type: 'string', default: allRunners.join(',') },
    'tractor-source': { type: 'string' },
    'tractor-revision': { type: 'string' },
    'browser-executable': { type: 'string' },
    'browser-dependency-root': { type: 'string' },
    'work-dir': { type: 'string' },
    'required-features': { type: 'boolean', default: false },
    'native-inputs': { type: 'string' },
    'acceptance-mode': { type: 'string', default: 'source' },
    'acceptance-receipt': { type: 'string' },
    'source-feature-receipt': { type: 'string' },
    'source-acceptance-receipt': { type: 'string' },
    'feature-receipt': { type: 'string' },
    'run-identity': { type: 'string' },
    'registry-url': { type: 'string', default: 'https://registry.npmjs.org/' },
  },
});
const renderers = opts.renderers.split(',').map(name => name.trim());
for (const renderer of renderers)
  if (!allRenderers.includes(renderer))
    throw new Error(`Unknown renderer ${renderer}`);
const runners = opts.with
  .split(',')
  .map(name => name.trim())
  .filter(Boolean);
for (const runner of runners)
  if (!allRunners.includes(runner)) throw new Error(`Unknown runner ${runner}`);
if (!opts.version === !opts['cohort-dir'])
  throw new Error('Pass exactly one of --version or --cohort-dir');
if (opts['tractor-revision'] && !opts['tractor-source'])
  throw new Error('--tractor-revision needs --tractor-source');
if (!['source', 'published'].includes(opts['acceptance-mode']))
  throw new Error('--acceptance-mode must be source or published');
if (opts['required-features']) {
  for (const option of [
    'cohort-dir',
    'native-inputs',
    'acceptance-receipt',
    'feature-receipt',
    'run-identity',
  ])
    if (!opts[option]) throw new Error(`--required-features needs --${option}`);
  if (!['solid', 'octane'].every(renderer => renderers.includes(renderer)))
    throw new Error('Required renderer features need Solid and Octane');
  if (
    opts['acceptance-mode'] === 'published' &&
    (!opts['source-feature-receipt'] || !opts['source-acceptance-receipt'])
  )
    throw new Error(
      'Published renderer features need --source-feature-receipt',
    );
}

const workDir = fs.realpathSync(
  opts['work-dir'] ??
    process.env.OWNED_TEMP_DIR ??
    fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-release-')),
);
// Children must not inherit a NODE_PATH from another checkout, and need a
// canonical TMPDIR (/var/folders is a symlink).
delete process.env.NODE_PATH;
process.env.TMPDIR = `${workDir}/`;
const logs = path.join(workDir, 'logs');
fs.mkdirSync(logs, { recursive: true });

const children = new Set();
const nativeFederationCancellation = new AbortController();
let activeNativeFederation;
let registry;
let releaseForAgePolicy;
async function stopAll() {
  for (const child of children) child.kill('SIGTERM');
  await registry?.stop?.();
}
/** Runs a command, logging to logs/<log>.log; rejects with the log tail. */
function sh(command, args, { cwd = root, env = process.env, log }) {
  const file = path.join(logs, `${log}.log`);
  const releaseAgeBaseline =
    path.basename(command) === 'pnpm' && args[0] === 'install'
      ? captureReleaseAgeExclusions(cwd, { release: releaseForAgePolicy })
      : undefined;
  return new Promise((resolve, reject) => {
    const out = fs.openSync(file, 'w');
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', out, out],
    });
    fs.closeSync(out);
    children.add(child);
    child.once('error', reject);
    child.once('close', code => {
      children.delete(child);
      if (code === 0) {
        try {
          if (releaseAgeBaseline)
            assertReleaseAgeExclusionsUnchanged(releaseAgeBaseline);
          return resolve();
        } catch (error) {
          return reject(error);
        }
      }
      const tail = fs.readFileSync(file, 'utf8').trim().split('\n');
      reject(
        new Error(
          `${path.basename(command)} ${args.join(' ')} exited ${code} (${file})\n${tail.slice(-25).join('\n')}`,
        ),
      );
    });
  });
}

const results = [];

// A bare `assert(value)` reports only "The expression evaluated to a falsy
// value". Name the failing assertion by its source location and lines.
function assertionSource(error) {
  const frame = /(?:file:\/\/)?(\/[^\s():]+):(\d+):\d+/u.exec(
    String(error.stack ?? '')
      .split('\n')
      .slice(1)
      .join('\n'),
  );
  if (!frame) return undefined;
  const [, file, line] = frame;
  const at = Number(line);
  let excerpt = [];
  try {
    excerpt = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .slice(Math.max(0, at - 3), at + 2)
      .map((text, index) => {
        const number = Math.max(1, at - 2) + index;
        return `${number === at ? '>' : ' '} ${number} | ${text}`;
      });
  } catch {}
  return {
    location: `${path.relative(root, file)}:${at}`,
    excerpt: excerpt.join('\n'),
  };
}

function describeFailure(error) {
  const failures = [
    error,
    ...(error instanceof AggregateError ? error.errors : []),
  ];
  const sources = failures
    .filter(item => item?.code === 'ERR_ASSERTION')
    .map(assertionSource)
    .filter(Boolean);
  const message = String(error?.message ?? error).split('\n')[0];
  return {
    summary: sources.length ? `${sources[0].location}: ${message}` : message,
    detail: [
      ...failures.map(item => String(item?.stack ?? item)),
      ...sources.map(
        ({ location, excerpt }) => `Assertion at ${location}\n${excerpt}`,
      ),
    ].join('\n'),
  };
}

/** Runs one table row. Returns false (and runs nothing) once `when` fails. */
async function step(name, body, when = true) {
  if (!when) {
    results.push({ name, status: 'SKIP', seconds: 0, error: '' });
    return false;
  }
  const started = performance.now();
  process.stdout.write(`[release] ${name} ...\n`);
  try {
    await body();
    results.push({ name, status: 'PASS', seconds: 0, error: '' });
    return true;
  } catch (error) {
    const { summary, detail } = describeFailure(error);
    results.push({ name, status: 'FAIL', error: summary });
    process.stdout.write(`[release] ${name} FAIL\n${detail}\n`);
    return false;
  } finally {
    results.at(-1).seconds = (performance.now() - started) / 1000;
  }
}

function table() {
  const rows = results.map(r => [
    r.name,
    r.status,
    r.seconds.toFixed(0),
    r.error.slice(0, 120),
  ]);
  const widths = [0, 1, 2].map(i =>
    Math.max(...rows.map(row => row[i].length)),
  );
  return rows
    .map(row =>
      row
        .map((cell, i) => (i < 3 ? cell.padEnd(widths[i]) : cell))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/** Copies authored fixture source into an operation-owned app directory. */
function copyFixtureSource(appRoot, renderer) {
  const fixture = path.join(root, 'tests/integration', `renderer-${renderer}`);
  fs.rmSync(path.join(appRoot, 'src'), { recursive: true, force: true });
  fs.cpSync(path.join(fixture, 'src'), path.join(appRoot, 'src'), {
    recursive: true,
  });
  for (const file of ['modern.config.ts', 'tsconfig.json'])
    fs.copyFileSync(path.join(fixture, file), path.join(appRoot, file));
  return readJson(path.join(fixture, 'package.json'));
}

function resolveFixtureDependencies(deps, release, written = {}) {
  const cohort = new Map(
    release.packages.map(item => [
      item.sourceName,
      `npm:${item.targetName}@${item.version}`,
    ]),
  );
  return Object.fromEntries(
    Object.entries(deps ?? {}).map(([name, spec]) => {
      if (written[name]) return [name, written[name]];
      if (spec.startsWith('workspace:')) {
        if (!cohort.has(name)) throw new Error(`${name} is not in the cohort`);
        return [name, cohort.get(name)];
      }
      return [name, spec];
    }),
  );
}

/** The generated shell keeps its metadata and generator-written dependencies. */
function overlayFixture(appRoot, renderer, release) {
  const app = copyFixtureSource(appRoot, renderer);
  const generated = readJson(path.join(appRoot, 'package.json'));
  const written = { ...generated.dependencies, ...generated.devDependencies };
  writeJson(path.join(appRoot, 'package.json'), {
    ...generated,
    dependencies: {
      ...generated.dependencies,
      ...resolveFixtureDependencies(app.dependencies, release, written),
    },
    devDependencies: {
      ...generated.devDependencies,
      ...resolveFixtureDependencies(app.devDependencies, release, written),
      typescript: written.typescript,
    },
  });
}

/** Resolves the create CLI the generated workspace installed (an npm: alias). */
function installedCreateBin(workspace) {
  const packageRoot = fs.realpathSync(
    path.join(workspace, 'node_modules/@modern-js/ultramodern-create'),
  );
  const { bin } = readJson(path.join(packageRoot, 'package.json'));
  return path.join(packageRoot, bin['ultramodern-create']);
}

/** A free local port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Builds and serves the generated app before the fixture replaces it: the
 * untouched starter must build, and its server must answer / with the
 * renderer's own markup.
 */
async function checkStarter(appRoot, renderer, env) {
  const bin = installedBin(appRoot);
  await sh(process.execPath, [bin, 'build'], {
    cwd: appRoot,
    env: { ...env, NODE_ENV: 'production' },
    log: `${renderer}-starter-build`,
  });
  const port = await freePort();
  const out = fs.openSync(
    path.join(logs, `${renderer}-starter-serve.log`),
    'w',
  );
  const server = spawn(process.execPath, [bin, 'serve'], {
    cwd: appRoot,
    env: { ...env, NODE_ENV: 'production', PORT: String(port) },
    stdio: ['ignore', out, out],
  });
  fs.closeSync(out);
  children.add(server);
  try {
    const deadline = Date.now() + 60_000;
    let response;
    while (!response) {
      if (server.exitCode !== null)
        throw new Error(`serve exited ${server.exitCode}`);
      response = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { accept: 'text/html' },
      }).catch(() => undefined);
      if (!response) {
        if (Date.now() > deadline) throw new Error('serve did not start');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    const html = await response.text();
    if (response.status !== 200)
      throw new Error(`GET / answered ${response.status}`);
    for (const marker of [
      `data-renderer="${renderer}"`,
      'data-testid="native-route"',
    ])
      if (!html.includes(marker)) throw new Error(`GET / lacks ${marker}`);
  } finally {
    server.kill('SIGTERM');
    children.delete(server);
  }
}

/** Chrome for the runners: --browser-executable, then puppeteer's own. */
function browserExecutable() {
  if (opts['browser-executable'])
    return path.resolve(opts['browser-executable']);
  if (process.env.PUPPETEER_EXECUTABLE_PATH)
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  // The same Playwright Chromium the shared renderer specs launch.
  const executable = createRequire(path.join(playwrightRoot(), 'package.json'))(
    'playwright-core',
  ).chromium.executablePath();
  if (!fs.existsSync(executable))
    throw new Error(
      `Playwright Chromium is not installed at ${executable}; run \`pnpm --dir tests exec playwright install chromium\``,
    );
  return executable;
}

/** A directory that resolves the workspace's playwright-core (MF runner). */
function playwrightRoot() {
  return resolveBrowserDependencyRoot(
    opts['browser-dependency-root'] ?? path.join(root, 'tests'),
  );
}

async function main() {
  let cohortDir = opts['cohort-dir'] && path.resolve(opts['cohort-dir']);
  // The publish preparer only writes under .modern/bleedingdev-publish; a
  // cohort this run builds is removed again when the run ends.
  let ownedCohortRoot;
  let release;
  let cohort;
  let storeDir;
  let createRoot;
  let acceptanceRegistryUrl;
  const apps = {};
  const env = { ...process.env };
  try {
    await step('cohort', async () => {
      if (!cohortDir) {
        ownedCohortRoot = path.join(
          root,
          '.modern/bleedingdev-publish/build',
          `renderer-release-${opts.version}`,
        );
        fs.rmSync(ownedCohortRoot, { recursive: true, force: true });
        cohortDir = path.join(ownedCohortRoot, 'build');
        await sh('pnpm', ['ultramodern:build-bleedingdev-publish'], {
          log: 'cohort-build',
        });
        await sh(
          'pnpm',
          [
            'ultramodern:prepare-bleedingdev-publish',
            '--',
            '--version',
            opts.version,
            '--scope',
            'bleedingdev',
            '--prefix',
            'modern-js-',
            '--tag',
            'latest',
            '--include-sidecars',
            '--out',
            cohortDir,
          ],
          { log: 'cohort-prepare' },
        );
      }
      release = readReleaseManifest({
        manifestPath: path.join(cohortDir, 'manifest.json'),
      });
      cohort = readCohort(release.manifestPath);
      releaseForAgePolicy = release;
    });

    let createBin;
    await step(
      'registry + create install',
      async () => {
        storeDir = execFileSync('pnpm', ['store', 'path'], {
          cwd: workDir,
          encoding: 'utf8',
        }).trim();
        registry =
          opts['acceptance-mode'] === 'published'
            ? {
                env: {
                  npm_config_registry: new URL(opts['registry-url']).href,
                  pnpm_config_registry: new URL(opts['registry-url']).href,
                },
              }
            : await startEphemeralRegistry({
                release,
                releaseDir: cohortDir,
                rootDir: path.join(workDir, 'registry'),
                storeDir,
              });
        acceptanceRegistryUrl = rendererAcceptanceRegistryUrl(
          opts['acceptance-mode'],
          {
            sourceRegistry: registry,
            publishedRegistryUrl: opts['registry-url'],
          },
        );
        // Strict release-age policy; only our own cohort is exempt.
        Object.assign(env, registry.env, {
          npm_config_store_dir: storeDir,
          pnpm_config_minimum_release_age: '1440',
          pnpm_config_minimum_release_age_strict: 'true',
          pnpm_config_minimum_release_age_ignore_missing_time: 'false',
          pnpm_config_minimum_release_age_exclude: JSON.stringify(
            releaseAgeExemptions(release, {
              policyPath: defaultReleaseAgePolicyPath,
            }),
          ),
        });
        createRoot = path.join(workDir, 'create');
        fs.mkdirSync(createRoot);
        const { targetName, version } = release.createPackage;
        writeJson(path.join(createRoot, 'package.json'), {
          private: true,
          dependencies: { [targetName]: version },
        });
        const { allowBuilds } = parseYaml(
          fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
        );
        fs.writeFileSync(
          path.join(createRoot, 'pnpm-workspace.yaml'),
          stringifyYaml({
            packages: ['.'],
            allowBuilds,
            minimumReleaseAge: 1440,
            minimumReleaseAgeStrict: true,
            minimumReleaseAgeIgnoreMissingTime: false,
          }),
        );
        await sh('pnpm', ['install'], {
          cwd: createRoot,
          env,
          log: 'create-install',
        });
        const packageRoot = path.join(createRoot, 'node_modules', targetName);
        checkInstalledCohort({ appRoot: createRoot, cohort });
        createBin = path.join(
          packageRoot,
          readJson(path.join(packageRoot, 'package.json')).bin[
            'ultramodern-create'
          ],
        );
      },
      Boolean(release),
    );

    for (const renderer of renderers) {
      const workspace = path.join(workDir, `app-${renderer}`);
      let appRoot;
      let ready = await step(
        `${renderer} generate`,
        async () => {
          await sh(
            process.execPath,
            [createBin, workspace, '--renderer', renderer, '--no-agents-md'],
            { cwd: workDir, env, log: `${renderer}-generate` },
          );
          const topology = readJson(
            path.join(workspace, 'topology/reference-topology.json'),
          );
          appRoot = path.join(workspace, topology.shell.path);
        },
        Boolean(createBin),
      );
      if (renderer !== 'react')
        ready = await step(
          `${renderer} starter`,
          async () => {
            await sh('pnpm', ['install'], {
              cwd: workspace,
              env,
              log: `${renderer}-starter-install`,
            });
            await checkStarter(appRoot, renderer, env);
          },
          ready,
        );
      ready = await step(
        `${renderer} overlay`,
        async () => overlayFixture(appRoot, renderer, release),
        ready,
      );
      ready = await step(
        `${renderer} install`,
        () =>
          sh('pnpm', ['install'], {
            cwd: workspace,
            env,
            log: `${renderer}-install`,
          }),
        ready,
      );
      // The fixture config replaces the one the generator captured the shell's
      // entries from (the starter names its main entry `main`, the fixture
      // keeps the default `index`). A user who edits modern.config that way
      // recaptures the delivery unit with the installed create CLI; so do we.
      ready = await step(
        `${renderer} sync delivery unit`,
        () =>
          sh(
            process.execPath,
            [
              installedCreateBin(workspace),
              'ultramodern',
              'sync-delivery-unit',
            ],
            { cwd: workspace, env, log: `${renderer}-sync` },
          ),
        ready,
      );
      ready = await step(
        `${renderer} installed = packed`,
        async () => {
          checkInstalledCohort({ appRoot, cohort });
        },
        ready,
      );
      if (ready) apps[renderer] = { workspace, appRoot };
      let nodeDeployRoot;
      if (renderer !== 'react')
        ready = await step(
          `${renderer} node fixture`,
          async () => {
            nodeDeployRoot = path.join(workDir, `node-${renderer}`);
            for (let ancestor = workDir; ; ancestor = path.dirname(ancestor)) {
              for (const entry of [
                'node_modules',
                'topology/reference-topology.json',
              ])
                if (fs.existsSync(path.join(ancestor, entry)))
                  throw new Error(
                    `Ordinary Node fixture requires an isolated work directory; found ${path.join(ancestor, entry)}`,
                  );
              if (ancestor === path.dirname(ancestor)) break;
            }
            fs.mkdirSync(nodeDeployRoot);
            const app = copyFixtureSource(nodeDeployRoot, renderer);
            writeJson(path.join(nodeDeployRoot, 'package.json'), {
              ...app,
              dependencies: resolveFixtureDependencies(
                app.dependencies,
                release,
              ),
              devDependencies: {
                ...resolveFixtureDependencies(app.devDependencies, release),
                typescript: readJson(
                  path.join(appRoot, 'node_modules/typescript/package.json'),
                ).version,
              },
            });
            const { allowBuilds } = parseYaml(
              fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
            );
            fs.writeFileSync(
              path.join(nodeDeployRoot, 'pnpm-workspace.yaml'),
              stringifyYaml({
                packages: ['.'],
                allowBuilds,
                packageImportMethod: 'clone-or-copy',
                minimumReleaseAge: 1440,
                minimumReleaseAgeStrict: true,
                minimumReleaseAgeIgnoreMissingTime: false,
              }),
            );
            await sh('pnpm', ['install'], {
              cwd: nodeDeployRoot,
              env,
              log: `${renderer}-node-install`,
            });
            checkInstalledCohort({ appRoot: nodeDeployRoot, cohort });
          },
          ready,
        );
      await step(
        `${renderer} typecheck`,
        () =>
          sh(
            process.execPath,
            ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
            {
              cwd: appRoot,
              env,
              log: `${renderer}-typecheck`,
            },
          ),
        ready,
      );
      // The specs build and serve the app with its installed bin.
      await step(
        `${renderer} specs`,
        () =>
          sh(
            process.execPath,
            [
              'node_modules/@rstest/core/bin/rstest.js',
              'run',
              '-c',
              'tests/rstest.config.mts',
              `integration/renderer-${renderer}/`,
            ],
            {
              env: {
                ...process.env,
                RENDERER_TARGET_DIR: appRoot,
                RENDERER_TARGET_BIN: installedBin(appRoot),
                ...(nodeDeployRoot
                  ? {
                      RENDERER_NODE_DEPLOY_DIR: nodeDeployRoot,
                      RENDERER_NODE_DEPLOY_BIN: installedBin(nodeDeployRoot),
                    }
                  : {}),
              },
              log: `${renderer}-specs`,
            },
          ),
        ready,
      );
    }

    // The React runners need a browser, the shared store and the release.
    const owner = `renderer-release-${process.pid}`;
    const proof = (name, script, extraArgs = () => [], enabled = true) =>
      step(
        name,
        async () => {
          const dir = path.join(workDir, name);
          await sh(
            process.execPath,
            [
              path.join(
                root,
                'scripts/ultramodern-production-readiness',
                script,
              ),
              '--manifest',
              release.manifestPath,
              '--expected-source-revision',
              release.source.commit,
              '--expected-version',
              release.release.version,
              '--store-dir',
              storeDir,
              '--work-dir',
              dir,
              '--receipt',
              path.join(dir, 'receipt.json'),
              '--browser-executable',
              browserExecutable(),
              '--owner',
              owner,
              '--owner-pid',
              String(process.pid),
              ...extraArgs(),
            ],
            { env, log: name },
          );
        },
        Boolean(storeDir) && runners.includes(name) && enabled,
      );
    await step(
      'worker',
      async () => {
        const dir = path.join(workDir, 'worker');
        fs.mkdirSync(dir);
        const receipt = await runWorkerDispatchProbe({
          workDir: dir,
          receiptPath: path.join(dir, 'receipt.json'),
          binding: {
            sourceRevision: cohort.sourceRevision,
            releaseVersion: cohort.release.version,
            manifestSha256: cohort.manifestSha256,
            frameworkCohortDigest: cohort.cohortDigest,
          },
          artifacts: {
            manifestPath: cohort.manifestPath,
            sourceRevision: cohort.sourceRevision,
            manifestSha256: cohort.manifestSha256,
            cohortDigest: cohort.cohortDigest,
          },
          qualifiedNode: process.execPath,
          applicationRoot: apps.react.appRoot,
          consumerRoot: apps.react.workspace,
          // pnpm links node_modules/<name> to its store copy; the probe
          // authenticates the generator's real package directory.
          generatorPackageRoot: fs.realpathSync(
            path.join(
              createRoot,
              'node_modules',
              release.createPackage.targetName,
            ),
          ),
          generatorConsumerRoot: createRoot,
          owner,
          ownerPid: process.pid,
          env,
        });
        if (receipt.status !== 'passed')
          throw new Error(receipt.error?.message ?? 'worker probe failed');
      },
      Boolean(apps.react) && runners.includes('worker'),
    );
    await proof('rsc', 'react-rsc-worker-proof/main.mjs');
    await proof(
      'mf',
      'renderer-mf-lifecycle-proof/index.mjs',
      () => [
        '--qualified-node',
        process.execPath,
        '--pnpm-executable',
        execFileSync('which', ['pnpm'], { encoding: 'utf8' }).trim(),
        '--browser-dependency-root',
        playwrightRoot(),
      ],
      renderers.includes('react'),
    );
    const nativeInputs = opts['native-inputs']
      ? readJson(path.resolve(opts['native-inputs']))
      : undefined;
    const nativeArchiveContext = renderer =>
      renderer === 'octane' && nativeInputs ? { nativeInputs } : {};
    const nativeFederationProofs = [
      {
        label: 'mf',
        folder: 'mf',
        run: runPackedNativeFederationProof,
        context: renderer => ({
          contextExtras: nativeArchiveContext(renderer),
        }),
      },
      {
        label: 'generated mf',
        folder: 'generated-mf',
        run: runPackedNativeFederationGeneratedProof,
        context: renderer => ({
          ...nativeArchiveContext(renderer),
          generatorConsumerRoot: createRoot,
          browserDependencyRoot: playwrightRoot(),
          browserExecutable: browserExecutable(),
        }),
      },
    ];
    for (const renderer of renderers.filter(name => name !== 'react'))
      for (const nativeProof of nativeFederationProofs)
        await step(
          `${renderer} ${nativeProof.label}`,
          async () => {
            const { allowBuilds } = parseYaml(
              fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
            );
            activeNativeFederation = nativeProof.run({
              ...nativeProof.context(renderer),
              renderer,
              consumerRoot: apps[renderer].appRoot,
              manifestPath: release.manifestPath,
              pnpmExecutable: execFileSync('which', ['pnpm'], {
                encoding: 'utf8',
              }).trim(),
              workDir: path.join(workDir, `${nativeProof.folder}-${renderer}`),
              log: path.join(logs, `${renderer}-${nativeProof.folder}.log`),
              env,
              signal: nativeFederationCancellation.signal,
              allowBuilds,
            });
            try {
              await activeNativeFederation;
            } finally {
              activeNativeFederation = undefined;
            }
          },
          Boolean(apps[renderer]) && runners.includes('mf'),
        );
    if (opts['required-features']) {
      const rows = {};
      const binding = rendererFeatureBinding(cohort);
      for (const [row, renderer, module, exported] of [
        [
          'localized-navigation',
          'octane',
          './native-localized-navigation.mjs',
          'runPackedLocalizedNavigationProof',
        ],
        [
          'generated-solid',
          'solid',
          './native-solid-generated.mjs',
          'runPackedGeneratedSolidProof',
        ],
        [
          'dev-refresh',
          'octane',
          './native-federation-dev.mjs',
          'runPackedNativeFederationDevProof',
        ],
        [
          'prebuilt-worker',
          'octane',
          './native-federation-worker.mjs',
          'runPackedNativeFederationWorkerProof',
        ],
        [
          'generated-worker',
          'octane',
          './native-federation-generated-worker.mjs',
          'runPackedNativeFederationGeneratedWorkerProof',
        ],
      ]) {
        await step(row, async () => {
          if (!apps[renderer])
            throw new Error(
              `The installed ${renderer} consumer is unavailable`,
            );
          const { allowBuilds } = parseYaml(
            fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
          );
          const run = (await import(module))[exported];
          if (typeof run !== 'function')
            throw new Error(`${row} has no installed proof entrypoint`);
          activeNativeFederation = run({
            renderer,
            ...(renderer === 'octane' && nativeInputs ? { nativeInputs } : {}),
            consumerRoot: apps[renderer].appRoot,
            generatorConsumerRoot: createRoot,
            acceptanceMode: opts['acceptance-mode'],
            registryUrl: acceptanceRegistryUrl,
            storeDir,
            browserDependencyRoot:
              row === 'localized-navigation'
                ? path.join(root, 'tests')
                : playwrightRoot(),
            browserExecutable: browserExecutable(),
            manifestPath: release.manifestPath,
            pnpmExecutable: execFileSync('which', ['pnpm'], {
              encoding: 'utf8',
            }).trim(),
            workDir: path.join(workDir, `feature-${row}`),
            log: path.join(logs, `feature-${row}.log`),
            receiptPath: path.join(logs, `feature-${row}.receipt.json`),
            binding,
            env,
            signal: nativeFederationCancellation.signal,
            allowBuilds,
          });
          try {
            rows[row] = assertRendererFeatureRow(
              row,
              await activeNativeFederation,
              binding,
              { evidenceRoot: logs },
            );
          } finally {
            activeNativeFederation = undefined;
          }
        });
      }
      await step('renderer feature acceptance receipt', async () => {
        assertAcceptanceReceipt(
          readJson(path.resolve(opts['acceptance-receipt'])),
          {
            release,
            expectedMode: opts['acceptance-mode'],
            runIdentity: opts['run-identity'],
          },
        );
        if (opts['acceptance-mode'] === 'published') {
          assertAcceptanceReceipt(
            readJson(path.resolve(opts['source-acceptance-receipt'])),
            {
              release,
              expectedMode: 'source',
              runIdentity: opts['run-identity'],
            },
          );
        }
        writeRendererFeatureReceipt({
          receiptPath: path.resolve(opts['feature-receipt']),
          registryUrl: acceptanceRegistryUrl,
          evidenceRoot: logs,
          sourceAcceptanceReceiptPath:
            opts['source-acceptance-receipt'] &&
            path.resolve(opts['source-acceptance-receipt']),
          rows,
          binding,
          mode: opts['acceptance-mode'],
          runIdentity: opts['run-identity'],
          acceptanceReceiptPath: path.resolve(opts['acceptance-receipt']),
          sourceFeatureReceiptPath:
            opts['source-feature-receipt'] &&
            path.resolve(opts['source-feature-receipt']),
        });
      });
    }
    await step(
      'tractor',
      async () => {
        // Accept the pinned Tractor baseline the CI lane checks out (or the
        // explicitly requested revision), not whatever the source checkout
        // happens to have at HEAD.
        const source = path.resolve(opts['tractor-source']);
        const revision = opts['tractor-revision']
          ? execFileSync(
              'git',
              [
                '-C',
                source,
                'rev-parse',
                '--verify',
                `${opts['tractor-revision']}^{commit}`,
              ],
              { encoding: 'utf8' },
            ).trim()
          : fs
              .readFileSync(
                path.join(
                  root,
                  'scripts/ultramodern-publish/tractor-baseline-revision',
                ),
                'utf8',
              )
              .trim();
        if (!/^[0-9a-f]{40}$/u.test(revision))
          throw new Error(`Invalid Tractor baseline revision: ${revision}`);
        const clone = path.join(workDir, 'tractor');
        const git = (...args) =>
          execFileSync('git', args, { stdio: ['ignore', 'ignore', 'inherit'] });
        git('clone', '--quiet', '--no-checkout', source, clone);
        git('-C', clone, 'fetch', '--quiet', '--no-tags', source, revision);
        git('-C', clone, 'checkout', '--quiet', '--detach', revision);
        await sh(
          process.execPath,
          [
            path.join(
              root,
              'scripts/ultramodern-production-readiness/run-tractor-downstream-acceptance.mjs',
            ),
            '--mode',
            'source',
            '--manifest',
            release.manifestPath,
            '--store-dir',
            storeDir,
            '--workspace',
            clone,
            '--out',
            path.join(workDir, 'tractor-report.json'),
          ],
          { env, log: 'tractor' },
        );
      },
      Boolean(release && opts['tractor-source']),
    );
  } finally {
    await stopAll();
    if (ownedCohortRoot)
      fs.rmSync(ownedCohortRoot, { recursive: true, force: true });
  }
  const failed = results.some(r => r.status === 'FAIL');
  process.stdout.write(
    `\n${table()}\n\nlogs: ${logs}\n${failed ? 'FAILED' : 'PASSED'}\n`,
  );
  return failed ? 1 : 0;
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.once(signal, () => {
    nativeFederationCancellation.abort(
      new Error(`Renderer release received ${signal}`),
    );
    Promise.resolve(activeNativeFederation)
      .catch(() => {})
      .then(stopAll)
      .finally(() => process.exit(130));
  });

process.exitCode = await main();
