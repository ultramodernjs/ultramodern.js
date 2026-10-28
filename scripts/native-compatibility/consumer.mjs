import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatorTestTempParent } from '../../tests/utils/generatorTestTemp.mjs';
import { parsePnpmLockfile } from '../lib/parse-pnpm-lockfile.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureRoot = path.join(
  repoRoot,
  'tests/integration/native-compatibility/fixture',
);

// The mainline commit, rather than the patch-equivalent non-ancestor v3.8.2 tag,
// is also the fixed reference used by the fork divergence gate.
export const upstreamCommit = 'eded841256a7cffdaa622e3889fc83407debd3e4';
const upstreamPackages = {
  '@modern-js/app-tools': 'packages/solutions/app-tools/package.json',
  '@modern-js/runtime': 'packages/runtime/plugin-runtime/package.json',
  '@modern-js/plugin-bff': 'packages/cli/plugin-bff/package.json',
  '@modern-js/server-runtime': 'packages/server/server-runtime/package.json',
};

export async function readNativeErrorBody(
  response,
  controller,
  { timeoutMs = 5000, maxBytes = 65_536 } = {},
) {
  if (!response.body) {
    controller.abort();
    return '';
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let bytes = 0;
  let note = '';
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => {
      note = `Diagnostic body timed out after ${timeoutMs}ms`;
      controller.abort();
      resolve(undefined);
    }, timeoutMs);
  });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (!chunk || chunk.done) break;
      const value = chunk.value.subarray(0, maxBytes - bytes);
      bytes += value.byteLength;
      body += decoder.decode(value, { stream: true });
      if (bytes >= maxBytes) {
        note = `Diagnostic body truncated at ${maxBytes} bytes`;
        break;
      }
    }
  } catch (error) {
    note ||= `Diagnostic body read failed: ${error.message}`;
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Cancellation must not hold up the original HTTP status assertion.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  body += decoder.decode();
  return note ? `${body}\n[${note}]` : body;
}

export function upstreamDependencies(
  readGit = args =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }),
) {
  assert.equal(
    readGit(['rev-parse', `${upstreamCommit}^{commit}`]).trim(),
    upstreamCommit,
  );
  return Object.fromEntries(
    Object.entries(upstreamPackages).map(([name, manifestPath]) => {
      const manifest = JSON.parse(
        readGit(['show', `${upstreamCommit}:${manifestPath}`]),
      );
      assert.equal(
        manifest.name,
        name,
        `Pinned upstream package identity: ${manifestPath}`,
      );
      assert.match(
        manifest.version,
        /^\d+\.\d+\.\d+$/,
        `Pinned upstream version: ${name}`,
      );
      return [name, manifest.version];
    }),
  );
}

let pinnedFrameworkCohort;
function upstreamOverrides() {
  if (pinnedFrameworkCohort) return pinnedFrameworkCohort;
  const manifests = execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', upstreamCommit, '--', 'packages'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(file => file.endsWith('/package.json'));
  pinnedFrameworkCohort = {};
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(
      execFileSync('git', ['show', `${upstreamCommit}:${manifestPath}`], {
        cwd: repoRoot,
        encoding: 'utf8',
      }),
    );
    if (manifest.name?.startsWith('@modern-js/') && !manifest.private) {
      assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
      pinnedFrameworkCohort[manifest.name] = manifest.version;
    }
  }
  return pinnedFrameworkCohort;
}

export function packedOverrides(manifest) {
  const overrides = {};
  for (const [name, packed] of Object.entries({
    ...manifest.packages,
    ...manifest.sidecars,
  })) {
    assert.equal(
      createHash('sha256')
        .update(fs.readFileSync(packed.tarball))
        .digest('hex'),
      packed.integrity,
      `Packed prerequisite changed after preparation: ${name}`,
    );
    if (name.startsWith('@modern-js/'))
      overrides[name] = `file:${packed.tarball}`;
  }
  for (const edge of manifest.edges ?? []) {
    const packed = manifest.sidecars?.[edge.target];
    assert.equal(
      packed?.version,
      edge.version,
      `Missing packed sidecar: ${edge.target}@${edge.version}`,
    );
    overrides[`${edge.name}@${edge.spec}`] = `file:${packed.tarball}`;
  }
  for (const name of Object.keys(upstreamPackages)) {
    assert.ok(overrides[name], `Missing packed native prerequisite: ${name}`);
  }
  return overrides;
}

export function assertConsumerLockfile(source, target) {
  const lock = parsePnpmLockfile(source);
  const references = [
    ...Object.keys(lock.packages ?? {}),
    ...Object.keys(lock.snapshots ?? {}),
  ];
  const collectValues = value => {
    if (typeof value === 'string') references.push(value);
    else if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) collectValues(nested);
    }
  };
  collectValues(lock);
  if (target === 'upstream') {
    assert.ok(
      references.every(value => !value.includes('@bleedingdev/')),
      'Upstream baseline must not consume fork packages',
    );
    assert.ok(
      references.every(
        value => !/(?:^|@)(?:file:|link:|workspace:)/.test(value),
      ),
      'Upstream baseline must use published artifacts',
    );
  } else {
    assert.ok(
      Object.keys(lock.packages ?? {}).every(
        name => !name.startsWith('@bleedingdev/') || name.includes('@file:'),
      ),
      'Fork sidecars must come from this build',
    );
  }
}

export function assertInstalledConsumer(appDir, target, dependencies) {
  const consumer = fs.realpathSync.native(appDir);
  for (const [name, version] of Object.entries(dependencies)) {
    const packageDir = fs.realpathSync.native(
      path.join(appDir, 'node_modules', name),
    );
    assert.ok(
      packageDir.startsWith(`${consumer}${path.sep}`),
      `${name} resolved outside the isolated consumer`,
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
    );
    assert.equal(manifest.name, name);
    if (target === 'upstream') assert.equal(manifest.version, version);
    for (const block of ['dependencies', 'optionalDependencies']) {
      assert.ok(
        Object.values(manifest[block] ?? {}).every(
          spec => !spec.startsWith('workspace:'),
        ),
        `${name} leaked workspace protocol into its installed artifact`,
      );
    }
  }
  assertConsumerLockfile(
    fs.readFileSync(path.join(appDir, 'pnpm-lock.yaml'), 'utf8'),
    target,
  );
  for (const name of Object.keys(dependencies)) {
    const entry = execFileSync(
      process.execPath,
      ['-e', 'console.log(require.resolve(process.argv[1]))', name],
      { cwd: appDir, env: { ...process.env, NODE_PATH: '' }, encoding: 'utf8' },
    ).trim();
    const resolved = fs.realpathSync.native(entry);
    assert.ok(
      resolved.startsWith(`${consumer}${path.sep}`),
      `${name} entry escaped the consumer`,
    );
    assert.ok(
      resolved.split(path.sep).includes('dist'),
      `${name} selected framework source instead of its built entry`,
    );
  }
}

function guardian(args) {
  if (process.platform !== 'darwin') return;
  // Guardian inspection can hold the shared lock for up to 120 seconds.
  const deadline = Date.now() + 150_000;
  while (true) {
    try {
      execFileSync(
        process.env.DISK_GUARDIAN_ARTIFACTS ?? 'disk-guardian-artifacts',
        args,
        { stdio: 'pipe' },
      );
      return;
    } catch (error) {
      const messages = [
        error.stdout?.toString().trim(),
        error.stderr?.toString().trim(),
      ].filter(Boolean);
      const lockContention =
        error.status === 1 &&
        messages.some(message => {
          try {
            const record = JSON.parse(message);
            return (
              record.status === 'failed' &&
              record.reason === 'another maintenance operation holds the lock'
            );
          } catch {
            return false;
          }
        });
      const remaining = deadline - Date.now();
      if (lockContention && remaining > 0) {
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          Math.min(remaining, 100 + Math.floor(Math.random() * 100)),
        );
        continue;
      }
      const output = messages.join('\n');
      throw new Error(`${error.message}${output ? `\n${output}` : ''}`, {
        cause: error,
      });
    }
  }
}

function terminate(child, signal) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) {
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'pipe',
      });
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function stopChild(child) {
  const closed =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise(resolve => child.once('close', resolve));
  terminate(child, 'SIGTERM');
  const timer = setTimeout(() => terminate(child, 'SIGKILL'), 5000);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
    // A CLI may exit before its compiler/server descendants. Its dedicated
    // process group still belongs to this consumer until all are stopped.
    terminate(child, 'SIGKILL');
  }
}

async function waitForPort(child, port, output) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Native CLI exited before listening on ${port}: ${child.exitCode ?? child.signalCode}\n${output()}`,
      );
    }
    const connected = await new Promise(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const finish = ready => {
        socket.destroy();
        resolve(ready);
      };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.setTimeout(500, () => finish(false));
    });
    if (connected) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(
    `Native CLI did not listen on ${port} within 240s\n${output()}`,
  );
}

/** This operation owns every byte below its unique root; ambient fixtures and
 * the external pnpm content store are never removed by this cleanup. */
export function createNativeConsumer(
  target,
  { tempDir = generatorTestTempParent(repoRoot) } = {},
) {
  assert.ok(['upstream', 'fork'].includes(target));
  const createdRoot = fs.mkdtempSync(
    path.join(tempDir, `modern-native-${target}-`),
  );
  // Windows TEMP can use a DOS short name. One native canonical root prevents
  // module resolvers from treating short and long spellings as distinct files.
  const root = fs.realpathSync.native(createdRoot);
  const appDir = path.join(root, 'app');
  const owner = `native-compatibility-${process.pid}-${path.basename(root)}`;
  const artifacts = [];
  const children = new Set();
  const commandOutputs = [];
  let cleaned = false;
  const remove = () => {
    if (cleaned) return;
    for (const artifact of artifacts) {
      guardian(['release', artifact, '--owner', owner]);
      guardian(['cleanup', '--only', artifact, '--no-caches', '--apply']);
    }
    fs.rmSync(root, { recursive: true, force: true });
    cleaned = true;
    process.off('exit', onExit);
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  };
  const cleanup = async () => {
    const results = await Promise.allSettled([...children].map(stopChild));
    const failures = results
      .filter(result => result.status === 'rejected')
      .map(result => result.reason);
    if (failures.length)
      throw new AggregateError(
        failures,
        `Cannot release live native consumer: ${root}`,
      );
    children.clear();
    remove();
  };
  const onExit = () => {
    for (const child of children) terminate(child, 'SIGKILL');
    remove();
  };
  const onInterrupt = () => {
    void cleanup().finally(() => process.exit(130));
  };
  const onTerminate = () => {
    void cleanup().finally(() => process.exit(143));
  };
  process.once('exit', onExit);
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    fs.cpSync(fixtureRoot, appDir, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'owner.json'),
      `${JSON.stringify({ owner, pid: process.pid })}\n`,
    );
    const pinned = upstreamDependencies();
    const manifest =
      target === 'fork'
        ? JSON.parse(
            fs.readFileSync(
              process.env.MODERN_TEST_PACKAGE_MANIFEST ?? '',
              'utf8',
            ),
          )
        : undefined;
    const overrides = manifest
      ? packedOverrides(manifest)
      : upstreamOverrides();
    const dependencies =
      target === 'upstream'
        ? pinned
        : Object.fromEntries(
            Object.keys(pinned).map(name => [name, overrides[name]]),
          );
    fs.writeFileSync(
      path.join(appDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'native-modern-contract-consumer',
          private: true,
          dependencies: {
            ...dependencies,
            react: '19.2.8',
            'react-dom': '19.2.8',
          },
          // The audited upstream BFF compiler loads TypeScript 5 separately
          // from its native browser checker. The fork uses TypeScript 7.
          devDependencies:
            target === 'fork'
              ? { typescript: '7.0.2' }
              : {
                  typescript: '5.9.3',
                  '@typescript/native-preview': '7.0.0-dev.20260707.2',
                },
        },
        null,
        2,
      )}\n`,
    );
    // JSON is valid YAML. The workspace boundary prevents pnpm from reading
    // the fork's aliases, patches, peer settings, or store-local source links.
    fs.writeFileSync(
      path.join(appDir, 'pnpm-workspace.yaml'),
      `${JSON.stringify(
        {
          packages: [],
          packageImportMethod: 'clone-or-copy',
          strictPeerDependencies: false,
          ...(manifest
            ? {
                overrides,
                allowBuilds: manifest.allowBuilds,
                minimumReleaseAgeExclude: manifest.minimumReleaseAgeExclude,
              }
            : {
                overrides,
                allowBuilds: {
                  '@swc/core': true,
                  esbuild: true,
                  'core-js': true,
                },
              }),
        },
        null,
        2,
      )}\n`,
    );
    for (const [name, kind] of [
      ['node_modules', 'dependencies'],
      ['dist', 'build'],
    ]) {
      const artifact = path.join(appDir, name);
      fs.mkdirSync(artifact);
      guardian([
        'register',
        artifact,
        '--owner',
        owner,
        '--owner-pid',
        String(process.pid),
        '--grace-hours',
        '24',
        '--kind',
        kind,
      ]);
      artifacts.push(artifact);
    }
    const installStarted = Date.now();
    try {
      execFileSync('pnpm', ['install', '--no-frozen-lockfile'], {
        cwd: appDir,
        env: { ...process.env, NODE_PATH: '', CI: 'true' },
        encoding: 'utf8',
        timeout: 300_000,
        stdio: 'pipe',
      });
    } catch (error) {
      throw new Error(
        [
          `Native ${target} consumer install failed after ${Date.now() - installStarted}ms in ${appDir}: ${error.message}`,
          `stdout:\n${error.stdout ?? ''}`,
          `stderr:\n${error.stderr ?? ''}`,
        ].join('\n'),
        { cause: error },
      );
    }
    assertInstalledConsumer(appDir, target, dependencies);
    console.log(
      `[native-compatibility] ${target}: ${target === 'upstream' ? upstreamCommit : 'built fork artifacts'}`,
    );
    const startCommand = (args, env) => {
      const child = spawn(
        process.execPath,
        [
          path.join(appDir, 'node_modules/@modern-js/app-tools/bin/modern.js'),
          ...args,
        ],
        {
          cwd: appDir,
          detached: process.platform !== 'win32',
          env: { ...process.env, NODE_PATH: '', ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      children.add(child);
      let output = '';
      commandOutputs.push(() => `[modern ${args.join(' ')}]\n${output}`);
      child.stdout.on('data', chunk => {
        output += chunk;
      });
      child.stderr.on('data', chunk => {
        output += chunk;
      });
      const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(
                `Native CLI ${args.join(' ')} failed: ${code ?? signal}\n${output}`,
              ),
            );
        });
      });
      // A long-lived server's exit is observed by waitForPort and explicit
      // requests; attaching a handler prevents unhandled rejection on stop.
      void exited.catch(() => {});
      return { child, exited, output: () => output };
    };
    return {
      root,
      appDir,
      cleanup,
      diagnostics: () =>
        `Consumer root: ${createdRoot}\nNative root: ${root}\n${commandOutputs
          .map(output => output())
          .join('\n')}`,
      async build(mode) {
        const { child, exited } = startCommand(['build'], {
          NODE_ENV: 'production',
          NATIVE_SSR_MODE: mode,
        });
        const timer = setTimeout(() => terminate(child, 'SIGKILL'), 300_000);
        let buildError;
        let cleanupError;
        try {
          await exited;
        } catch (error) {
          buildError = error;
        } finally {
          clearTimeout(timer);
          try {
            await stopChild(child);
            children.delete(child);
            const artifact = path.join(appDir, 'dist');
            if (fs.existsSync(artifact)) {
              guardian([
                'register',
                artifact,
                '--owner',
                owner,
                '--owner-pid',
                String(process.pid),
                '--grace-hours',
                '24',
                '--kind',
                'build',
              ]);
            }
          } catch (error) {
            cleanupError = error;
          }
        }
        if (buildError && cleanupError) {
          throw new AggregateError(
            [buildError, cleanupError],
            'Native build and cleanup failed',
          );
        }
        if (buildError) throw buildError;
        if (cleanupError) throw cleanupError;
      },
      async start(phase, mode, port) {
        const { child, exited, output } = startCommand([phase], {
          NODE_ENV: phase === 'dev' ? 'development' : 'production',
          NATIVE_SSR_MODE: mode,
          PORT: String(port),
        });
        await Promise.race([
          waitForPort(child, port, output),
          exited.then(() => {
            throw new Error(
              `Native ${phase} exited before readiness\n${output()}`,
            );
          }),
        ]);
        return child;
      },
      async stop(child) {
        await stopChild(child);
        children.delete(child);
      },
    };
  } catch (error) {
    try {
      remove();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Native consumer setup and cleanup failed',
      );
    }
    throw error;
  }
}
