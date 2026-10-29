#!/usr/bin/env node
// Consumer: publish-bleedingdev.yml standalone sidecar qualification.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import cliKit from '../lib/cli-kit.js';
import processKit from '../lib/process-kit.js';
import { isDirectRun } from './lib/direct-run.mjs';
import { rejectInlineOptionSyntax } from './lib/option-syntax.mjs';
import { repoRoot } from './lib/prepare-bleedingdev-packages/constants.mjs';
import { assertAcceptedPublishToolchain } from './lib/prepare-bleedingdev-packages/npm-buffer-publisher.mjs';
import { inspectNpmTarball } from './lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import { packedMfSdkProbeMain } from './packed-mf-sdk-probe.mjs';
import { packedRedactProbeMain } from './packed-redact-probe.mjs';
import {
  resolveSidecarOutput,
  sidecarProfile,
  verifySidecarBundle,
  writeSidecarQualification,
} from './sidecar-bundle.mjs';
import { assertSidecarProfileDependencies } from './sidecar-profiles.mjs';

const { parseCliArgs } = cliKit;
const { createProcessEnv, killChild } = processKit;
const forkAlias = /^npm:(@bleedingdev\/[a-z0-9.-]+)@([^@]+)$/u;
const profileProbeMains = {
  'mf-sdk': packedMfSdkProbeMain,
  'tanstack-redact': packedRedactProbeMain,
};
const dependencyBlocks = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
];

export function assertQualificationToolchain(tools, command = execFileSync) {
  const version = tool =>
    String(
      command(tool, ['--version'], { encoding: 'utf8', stdio: 'pipe' }),
    ).trim();
  assertAcceptedPublishToolchain(tools, { npmVersion: version('npm') });
  assert.equal(version('pnpm'), tools.pnpm, 'Sidecar qualification pnpm drift');
}

// This registry cannot publish or proxy. Every candidate response comes from
// the buffers already authenticated by verifySidecarBundle; all other package
// metadata is fetched from npm directly through the install's default registry.
export async function startSidecarRegistry(packages) {
  // Candidate versions become available when this registry starts.
  const availableAt = new Date().toISOString();
  const accepted = new Map(
    packages.map(item => [
      item.name,
      {
        ...item,
        packageJson: JSON.parse(JSON.stringify(item.packageJson)),
        bytes: Buffer.from(item.bytes),
      },
    ]),
  );
  assert.equal(
    accepted.size,
    packages.length,
    'Duplicate sidecar registry identity',
  );
  const servedTarballs = new Set();
  let closed = false;
  let stopPromise;
  let registryUrl;
  const server = http.createServer((request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405).end();
      return;
    }
    let pathname;
    try {
      const url = new URL(request.url, registryUrl);
      if (url.search !== '') throw new Error('Query is not a candidate route');
      pathname = decodeURIComponent(url.pathname.slice(1));
    } catch {
      response.writeHead(400).end();
      return;
    }
    const item = accepted.get(pathname);
    if (item) {
      const metadata = {
        ...item.packageJson,
        dist: {
          integrity: item.integrity,
          shasum: item.shasum,
          tarball: `${registryUrl}tarballs/${encodeURIComponent(item.name)}.tgz`,
        },
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        request.method === 'HEAD'
          ? undefined
          : JSON.stringify({
              name: item.name,
              'dist-tags': { latest: item.version },
              time: {
                created: availableAt,
                modified: availableAt,
                [item.version]: availableAt,
              },
              versions: { [item.version]: metadata },
            }),
      );
      return;
    }
    const tarball =
      pathname.startsWith('tarballs/') && pathname.endsWith('.tgz')
        ? accepted.get(pathname.slice('tarballs/'.length, -'.tgz'.length))
        : null;
    if (!tarball) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': tarball.bytes.length,
    });
    if (request.method === 'GET') servedTarballs.add(tarball.name);
    response.end(request.method === 'HEAD' ? undefined : tarball.bytes);
  });
  server.once('close', () => {
    closed = true;
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  registryUrl = `http://127.0.0.1:${server.address().port}/`;
  return {
    registryUrl,
    servedTarballs,
    isClosed: () => closed,
    stop: () =>
      (stopPromise ??= new Promise((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      )),
  };
}

function installedPackageRoot(importer, dependency, expectedName) {
  let directory = path.dirname(
    createRequire(path.join(importer, 'package.json')).resolve(dependency),
  );
  for (;;) {
    const manifestPath = path.join(directory, 'package.json');
    if (
      fs.existsSync(manifestPath) &&
      JSON.parse(fs.readFileSync(manifestPath, 'utf8')).name === expectedName
    )
      return directory;
    const parent = path.dirname(directory);
    assert.notEqual(
      parent,
      directory,
      `${dependency} did not resolve to ${expectedName}`,
    );
    directory = parent;
  }
}

export function assertPackedSidecarInstall(
  workspace,
  packages,
  registryUrl,
  servedTarballs,
) {
  const lock = JSON.parse(
    fs.readFileSync(path.join(workspace, 'package-lock.json'), 'utf8'),
  );
  assert.equal(
    lock.lockfileVersion,
    3,
    'Sidecar install requires npm lockfile v3',
  );
  const accepted = new Map(packages.map(item => [item.name, item]));
  const checked = new Set();
  const checkPackage = (directory, item) => {
    const physical = fs.realpathSync(directory);
    const relative = path
      .relative(workspace, physical)
      .split(path.sep)
      .join('/');
    assert.ok(
      relative.startsWith('node_modules/'),
      `${item.name} escaped the clean installation`,
    );
    const entry = lock.packages[relative];
    assert.ok(
      entry && !entry.link,
      `${item.name} was linked instead of installed`,
    );
    assert.equal(
      entry.version,
      item.version,
      `${item.name} installed version drift`,
    );
    assert.equal(
      entry.integrity,
      item.integrity,
      `${item.name} installed integrity drift`,
    );
    assert.equal(
      entry.resolved,
      `${registryUrl}tarballs/${encodeURIComponent(item.name)}.tgz`,
      `${item.name} did not install from the accepted local tarball`,
    );
    if (checked.has(physical)) return;
    checked.add(physical);
    for (const [file, bytes] of inspectNpmTarball(item.bytes).fileContents) {
      const installedPath = path.join(physical, file);
      const stat = fs.lstatSync(installedPath);
      assert.ok(
        stat.isFile() && !stat.isSymbolicLink(),
        `${item.name}/${file} is not an installed regular file`,
      );
      assert.ok(
        fs.readFileSync(installedPath).equals(bytes),
        `${item.name}/${file} installed bytes drift`,
      );
    }
  };
  for (const item of packages) {
    assert.ok(
      servedTarballs.has(item.name),
      `${item.name} was not fetched from this run's registry`,
    );
    const directory = path.join(workspace, 'node_modules', item.name);
    checkPackage(directory, item);
    for (const block of dependencyBlocks) {
      for (const [dependency, specifier] of Object.entries(
        item.packageJson[block] ?? {},
      )) {
        const alias = forkAlias.exec(specifier);
        if (!alias) continue;
        const target = accepted.get(alias[1]);
        assert.ok(
          target && target.version === alias[2],
          `${item.name} declares an unqualified alias ${specifier}`,
        );
        checkPackage(
          installedPackageRoot(directory, dependency, target.name),
          target,
        );
      }
    }
  }
}

class QualificationProcessCleanupError extends Error {}

export function qualificationGroupHasLiveMembers(
  pid,
  {
    platform = process.platform,
    uid = process.geteuid?.(),
    kill = process.kill,
    readProcessTable = () =>
      execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,uid=,stat='], {
        encoding: 'utf8',
        timeout: 1_000,
      }),
  } = {},
) {
  let permissionError;
  try {
    kill(-pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    // Darwin excludes zombies from group signalling and reports EPERM when
    // the existing group has no signalable members. Prove closure with ps.
    if (platform !== 'darwin' || error.code !== 'EPERM') throw error;
    permissionError = error;
  }
  let live = false;
  for (const line of readProcessTable().trim().split('\n')) {
    const row = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s*$/u.exec(line);
    assert.ok(row, 'Cannot confirm qualification process-group closure');
    if (Number(row[2]) !== pid) continue;
    assert.equal(
      Number(row[3]),
      uid,
      'Qualification process group contains a foreign owner',
    );
    // Reparented zombies hold no workspace resources and cannot be killed.
    if (!row[4].startsWith('Z')) live = true;
  }
  if (live && permissionError) throw permissionError;
  return live;
}

export function runChild(
  command,
  args,
  { timeoutMs = 600_000, checkResources, signal, ...options },
) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const privateGroup = process.platform !== 'win32';
    const child = spawn(command, args, {
      ...options,
      detached: privateGroup,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let processError;
    let killTimer;
    const stop = () => {
      killChild(child, 'SIGTERM');
      killTimer ??= setTimeout(() => killChild(child, 'SIGKILL'), 5_000);
    };
    const abort = () => {
      processError ??= signal.reason;
      stop();
    };
    // Own cancellation so it signals the group before the leader can exit.
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const groupHasLiveMembers = () =>
      privateGroup && child.pid
        ? qualificationGroupHasLiveMembers(child.pid)
        : false;
    const confirmGroupClosure = async () => {
      if (!groupHasLiveMembers()) return;
      stop();
      const deadline = Date.now() + 7_000;
      while (groupHasLiveMembers()) {
        assert.ok(
          Date.now() < deadline,
          `Qualification process group ${child.pid} did not terminate`,
        );
        await new Promise(complete => setTimeout(complete, 25));
      }
    };
    child.stdout.on('data', chunk => {
      stdout = (stdout + chunk).slice(-262144);
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-262144);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const resourceTimer =
      checkResources &&
      setInterval(() => {
        try {
          checkResources();
        } catch (error) {
          processError = error;
          stop();
        }
      }, 2_000);
    child.once('error', error => {
      processError = error;
      if (child.pid) stop();
    });
    child.once('close', async (code, exitSignal) => {
      clearTimeout(timer);
      clearInterval(resourceTimer);
      signal?.removeEventListener('abort', abort);
      try {
        // The leader's pipes can close while an ignoring descendant is live.
        // Keep escalation armed until the private group has no live members.
        await confirmGroupClosure();
      } catch (error) {
        reject(
          new QualificationProcessCleanupError(
            `Cannot confirm ${command} process-group cleanup`,
            {
              cause: processError
                ? new AggregateError([processError, error])
                : error,
            },
          ),
        );
        return;
      } finally {
        clearTimeout(killTimer);
      }
      if (processError || code !== 0 || timedOut)
        reject(
          new Error(
            `${command} ${args.join(' ')} failed (${timedOut ? 'timeout' : `code ${code}, signal ${exitSignal}`})\n${stderr}\n${stdout}`,
            { cause: processError },
          ),
        );
      else resolve(stdout);
    });
  });
}

// Serialized into the installed project's own process: no repository package
// resolution, NODE_PATH, or linked dependency directory can satisfy a probe.
async function packedApiProbeMain() {
  const assert = (await import('node:assert/strict')).default;
  const fs = (await import('node:fs')).default;
  const path = (await import('node:path')).default;
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const { execFileSync } = await import('node:child_process');
  const root = fs.realpathSync(process.cwd());
  const requireInstalledPackage = createRequire(
    path.join(root, 'package.json'),
  );
  const load = name =>
    import(pathToFileURL(requireInstalledPackage.resolve(name)).href);
  const braces = requireInstalledPackage('@bleedingdev/braces');
  assert.equal(braces.compile('src/{a,b}.js'), 'src/(a|b).js');
  assert.deepEqual(braces.expand('file-{1..3}.js'), [
    'file-1.js',
    'file-2.js',
    'file-3.js',
  ]);
  assert.equal(braces.stringify(braces.parse('a/{b,c}/d')), 'a/{b,c}/d');
  assert.throws(() => braces.parse('abc', { maxLength: 2 }), SyntaxError);
  assert.deepEqual(braces.expand('{1..3}', { rangeLimit: 3 }), ['1', '2', '3']);
  assert.throws(() => braces.expand('{1..4}', { rangeLimit: 3 }), RangeError);
  const ast = depth => {
    // All three walkers visit branch nodes; expansion handles terminal text
    // without recursion, so the terminal branch keeps their depths identical.
    let node = { type: 'root', nodes: [] };
    for (let index = 0; index < depth; index += 1)
      node = { type: 'root', nodes: [node] };
    return node;
  };
  for (const method of ['compile', 'expand', 'stringify']) {
    assert.doesNotThrow(() => braces[method](ast(100)));
    assert.throws(() => braces[method](ast(101)), {
      name: 'SyntaxError',
      message: /nesting depth exceeds the maximum of 100/u,
    });
  }
  // Finite boundary inputs also exercise the parser before any walker runs.
  for (const [open, close] of [
    ['{', '}'],
    ['(', ')'],
  ]) {
    assert.throws(
      () => braces.parse(`${open.repeat(101)}x${close.repeat(101)}`),
      { name: 'SyntaxError', message: /nesting depth exceeds/u },
    );
  }

  const fixture = path.join(root, 'fixture');
  fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
  for (const file of ['a.js', 'b.ts', 'ignored.js', 'c.txt'])
    fs.writeFileSync(path.join(fixture, 'src', file), '');
  const match = requireInstalledPackage('@bleedingdev/micromatch');
  assert.deepEqual(
    match(['src/a.js', 'src/b.ts', 'src/c.txt'], 'src/*.{js,ts}'),
    ['src/a.js', 'src/b.ts'],
  );
  const glob = requireInstalledPackage('@bleedingdev/fast-glob');
  assert.deepEqual(
    (
      await glob('src/*.{js,ts}', { cwd: fixture, ignore: ['**/ignored.js'] })
    ).sort(),
    ['src/a.js', 'src/b.ts'],
  );
  const workspace = path.join(fixture, 'workspace');
  const a = { name: 'a', version: '1.0.0', dependencies: { b: 'workspace:*' } };
  const b = { name: 'b', version: '1.0.0' };
  fs.mkdirSync(workspace);
  fs.writeFileSync(
    path.join(workspace, 'pnpm-workspace.yaml'),
    "packages:\n  - 'packages/{a,b}'\n",
  );
  for (const manifest of [a, b]) {
    const directory = path.join(workspace, 'packages', manifest.name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify(manifest),
    );
  }
  const find = await load('@bleedingdev/find-workspaces');
  const options = { stopDir: fixture, cache: find.createWorkspacesCache() };
  assert.deepEqual(
    find.findWorkspacesRoot(path.join(workspace, 'packages/a'), options),
    {
      location: workspace.split(path.sep).join('/'),
      globs: ['packages/{a,b}'],
    },
  );
  const found = find.findWorkspaces(
    path.join(workspace, 'packages/a'),
    options,
  );
  assert.deepEqual(
    found
      .map(item => ({ location: item.location, package: item.package }))
      .sort((left, right) =>
        left.package.name.localeCompare(right.package.name),
      ),
    [a, b].map(manifest => ({
      location: path.join(workspace, 'packages', manifest.name),
      package: manifest,
    })),
  );
  const source = await load('@bleedingdev/rsbuild-plugin-source-build');
  const sourcePlugin = source.pluginSourceBuild();
  assert.equal(sourcePlugin.name, 'rsbuild:source-build');
  assert.equal(typeof sourcePlugin.setup, 'function');
  const base = await source.getMonorepoBaseData(
    path.join(workspace, 'packages/a'),
  );
  assert.deepEqual(
    { isMonorepo: base.isMonorepo, rootPath: base.rootPath, type: base.type },
    { isMonorepo: true, rootPath: workspace, type: 'pnpm' },
  );
  const projects = await source.getMonorepoSubProjects(base);
  assert.deepEqual(
    projects
      .map(project => ({
        name: project.name,
        dir: project.dir,
        meta: project.getMetaData(),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    [a, b].map(manifest => ({
      name: manifest.name,
      dir: path.join(workspace, 'packages', manifest.name),
      meta: manifest,
    })),
  );
  assert.deepEqual(
    projects
      .find(project => project.name === 'a')
      .getDependentProjects(projects)
      .map(project => project.name),
    ['b'],
  );

  const ultraciteDir = path.join(root, 'node_modules/@bleedingdev/ultracite');
  const ultraciteRequire = createRequire(
    path.join(ultraciteDir, 'package.json'),
  );
  const errors = [];
  const config = ultraciteRequire('jsonc-parser').parse(
    fs.readFileSync(
      requireInstalledPackage.resolve('@bleedingdev/ultracite/biome/core'),
      'utf8',
    ),
    errors,
  );
  assert.deepEqual(errors, []);
  assert.equal(config.root, false);
  assert.equal(config.linter.enabled, true);
  assert.equal(config.linter.rules.security.noGlobalEval, 'error');
  assert.equal(config.formatter.indentStyle, 'space');
  assert.equal(config.formatter.indentWidth, 2);
  assert.ok(config.files.includes.includes('!!**/node_modules'));
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ultraciteDir, 'package.json'), 'utf8'),
  );
  assert.deepEqual(manifest.bin, { ultracite: 'dist/index.js' });
  const help = execFileSync(
    process.execPath,
    [path.join(ultraciteDir, manifest.bin.ultracite), '--help'],
    { cwd: workspace, encoding: 'utf8', timeout: 5_000 },
  );
  assert.match(help, /ultracite/u);
}

export async function qualifyPackedSidecars(
  verified,
  {
    env = process.env,
    scratchRoot = env.OWNED_TEMP_DIR ?? os.tmpdir(),
    signal,
    onWorkspace,
    run = runChild,
    startRegistry = startSidecarRegistry,
  } = {},
) {
  signal?.throwIfAborted();
  const profile = verified.manifest?.profile;
  const selected = sidecarProfile(profile);
  assertSidecarProfileDependencies(profile, verified.sidecars.packages);
  const workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(scratchRoot, 'sidecar-qualification-')),
  );
  let registry;
  let releaseWorkspaceLease;
  let processesClosed = true;
  const failures = [];
  let probes;
  try {
    console.log(`Sidecar qualification scratch: ${workspace}`);
    registry = await startRegistry(verified.sidecars.packages);
    fs.writeFileSync(
      path.join(workspace, 'package.json'),
      JSON.stringify({
        private: true,
        name: 'sidecar-qualification',
        version: '0.0.0',
        dependencies: {
          ...(selected.dependencies ??
            Object.fromEntries(
              verified.sidecars.packages.map(item => [item.name, item.version]),
            )),
          ...(profile === 'parser' ? { typescript: '7.0.2' } : {}),
        },
      }),
    );
    const userConfig = path.join(workspace, 'user.npmrc');
    const globalConfig = path.join(workspace, 'global.npmrc');
    fs.writeFileSync(userConfig, '');
    fs.writeFileSync(globalConfig, '');
    fs.writeFileSync(
      path.join(workspace, '.npmrc'),
      `registry=https://registry.npmjs.org/\n@bleedingdev:registry=${registry.registryUrl}\n`,
    );
    const scrub = Object.fromEntries(
      [...new Set([...Object.keys(process.env), ...Object.keys(env)])]
        .filter(key =>
          /^(npm_config_|pnpm_|node_path$|node_options$)/iu.test(key),
        )
        .map(key => [key, undefined]),
    );
    const childEnv = createProcessEnv({
      ...scrub,
      npm_config_userconfig: userConfig,
      npm_config_globalconfig: globalConfig,
      npm_config_cache: path.join(workspace, 'npm-cache'),
      NODE_PATH: undefined,
      NODE_OPTIONS: undefined,
    });
    const assertDiskFloor = () => {
      const stats = fs.statfsSync(workspace, { bigint: true });
      assert.ok(
        stats.bavail * stats.bsize >= 8n * 1024n ** 3n,
        'Sidecar qualification requires the 8 GiB free-space reserve',
      );
    };
    assertDiskFloor();
    if (onWorkspace) {
      const dependenciesPath = path.join(workspace, 'node_modules');
      fs.mkdirSync(dependenciesPath);
      releaseWorkspaceLease = await onWorkspace(workspace, {
        dependenciesPath,
        ownerPid: process.pid,
      });
      assert.ok(
        releaseWorkspaceLease === undefined ||
          typeof releaseWorkspaceLease === 'function',
        'Workspace lease release must be callable',
      );
    }
    signal?.throwIfAborted();
    console.log(
      `Installing ${verified.sidecars.packages.length} accepted ${profile} sidecars with strict npm peer resolution`,
    );
    await run(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--strict-peer-deps',
        '--no-audit',
        '--no-fund',
        '--install-strategy=hoisted',
      ],
      {
        cwd: workspace,
        env: childEnv,
        signal,
        checkResources: assertDiskFloor,
      },
    );
    assertDiskFloor();
    assertPackedSidecarInstall(
      workspace,
      verified.sidecars.packages,
      registry.registryUrl,
      registry.servedTarballs,
    );
    await run('npm', ['ls', '--all', '--json'], {
      cwd: workspace,
      env: childEnv,
      signal,
      timeoutMs: 30_000,
    });
    const probePath = path.join(workspace, 'probe.mjs');
    fs.writeFileSync(
      probePath,
      `await (${(profileProbeMains[profile] ?? packedApiProbeMain).toString()})();\n`,
    );
    await run(
      process.execPath,
      [
        ...(profile === 'mf-sdk' ? ['--experimental-vm-modules'] : []),
        probePath,
      ],
      {
        cwd: workspace,
        env: childEnv,
        signal,
        timeoutMs: 30_000,
      },
    );
    assertPackedSidecarInstall(
      workspace,
      verified.sidecars.packages,
      registry.registryUrl,
      registry.servedTarballs,
    );
    probes = Object.fromEntries(selected.probeKeys.map(key => [key, true]));
  } catch (error) {
    failures.push(error);
    processesClosed = !(error instanceof QualificationProcessCleanupError);
  } finally {
    let registryClosed = !registry;
    try {
      await registry?.stop();
      registryClosed = true;
    } catch (error) {
      failures.push(error);
      registryClosed = registry?.isClosed?.() === true;
    }
    if (registryClosed && processesClosed) {
      try {
        await releaseWorkspaceLease?.();
        fs.rmSync(workspace, { recursive: true, force: true });
      } catch (error) {
        failures.push(
          new Error(
            `Sidecar qualification retained ${workspace} after cleanup failed`,
            { cause: error },
          ),
        );
      }
    } else {
      failures.push(
        new Error(
          `Sidecar qualification retained ${workspace} because ${registryClosed ? 'process-group' : 'registry'} closure was not confirmed`,
        ),
      );
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      'Sidecar qualification and owned cleanup failed',
    );
  return probes;
}

export async function runSidecarQualificationCli(
  argv,
  { env = process.env } = {},
) {
  rejectInlineOptionSyntax(argv, {
    valueOptions: new Set(['--out', '--receipt']),
  });
  const options = parseCliArgs(argv, {
    defaults: {
      out: path.join(repoRoot, '.modern/bleedingdev-sidecars/bundle'),
      receipt: path.join(
        repoRoot,
        '.modern/bleedingdev-sidecars/qualification.json',
      ),
    },
    options: { out: {}, receipt: {} },
  });
  options.out = resolveSidecarOutput(options.out);
  options.receipt = resolveSidecarOutput(options.receipt);
  const verified = verifySidecarBundle(options.out, { env });
  assertQualificationToolchain(verified.manifest.tools);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.once(signal, abort);
  let probes;
  try {
    probes = await qualifyPackedSidecars(verified, {
      env,
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
  } finally {
    for (const signal of signals) process.removeListener(signal, abort);
  }
  assertQualificationToolchain(verified.manifest.tools);
  assert.equal(
    verifySidecarBundle(options.out, { env }).bundleSha256,
    verified.bundleSha256,
    'Sidecar bundle changed during qualification',
  );
  return writeSidecarQualification(options.out, probes, {
    env,
    receiptPath: options.receipt,
  });
}

if (isDirectRun(import.meta.url))
  await runSidecarQualificationCli(process.argv.slice(2));
