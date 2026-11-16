const crypto = require('node:crypto');
const path = require('path');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const spawn = require('cross-spawn');
const treeKill = require('tree-kill');
const {
  leasePort,
} = require('../../scripts/ultramodern-production-readiness/renderer-mf-lifecycle-proof/port-lease.mjs');
const { launchOptions } = require('./launchOptions');

const kRepoRoot = path.join(__dirname, '../..');
const kTestsRoot = path.join(__dirname, '..');
const kModernAppTools = path.join(
  __dirname,
  '../node_modules/@modern-js/app-tools/bin/modern.js',
);
const kWorkspaceSearchRoots = [
  path.join(kRepoRoot, 'packages'),
  path.join(kRepoRoot, 'tests'),
];
const kPortAllocatorLockPollInterval = 200;
const kPortAllocatorLockStaleAge = 10 * 60 * 1000;
const kGlobPatternCharacters = ['*', '?', '[', '{'];

function resolvePortAllocatorLockDir(packageDir) {
  const digest = crypto
    .createHash('sha1')
    .update(path.resolve(packageDir))
    .digest('hex');

  return path.join(os.tmpdir(), `modernjs-port-allocator-${digest}.lock`);
}

async function acquirePortAllocatorLock(packageDir) {
  const lockDir = resolvePortAllocatorLockDir(packageDir);

  while (true) {
    try {
      await fs.promises.mkdir(lockDir);
      await fs.promises.writeFile(
        path.join(lockDir, 'owner.json'),
        JSON.stringify({
          pid: process.pid,
          packageDir: path.resolve(packageDir),
          acquiredAt: new Date().toISOString(),
        }),
      );

      return async () => {
        await fs.promises.rm(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      // Windows reports EPERM or EACCES while another process is still
      // removing the same directory: the lock is being released, so wait.
      const releasing =
        process.platform === 'win32' &&
        (error?.code === 'EPERM' || error?.code === 'EACCES');
      if (releasing) {
        await new Promise(resolve =>
          setTimeout(resolve, kPortAllocatorLockPollInterval),
        );
        continue;
      }
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      try {
        const stat = await fs.promises.stat(lockDir);
        if (Date.now() - stat.mtimeMs > kPortAllocatorLockStaleAge) {
          await fs.promises.rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }

      await new Promise(resolve =>
        setTimeout(resolve, kPortAllocatorLockPollInterval),
      );
    }
  }
}

async function waitForTcpServer(port, timeoutMs = 10_000) {
  const numericPort = Number(port);
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({
          host: '127.0.0.1',
          port: numericPort,
        });

        socket.once('connect', () => {
          socket.end();
          resolve();
        });
        socket.once('error', reject);
        socket.setTimeout(500, () => {
          socket.destroy(
            new Error(`Timed out connecting to 127.0.0.1:${numericPort}`),
          );
        });
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  const error = new Error(
    `Dev server did not accept TCP connections on 127.0.0.1:${numericPort} within ${timeoutMs}ms`,
  );
  error.cause = lastError;
  throw error;
}

function resolveReadyPort(configuredPort, output) {
  const numericPort = Number(configuredPort);
  const localUrl = output.match(
    /> Local:\s+(?:\x1b\[[0-9;]*m)*https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/i,
  );
  const detectedPort = Number(localUrl?.[1]);
  if (Number.isInteger(detectedPort) && detectedPort > 0) {
    if (
      Number.isInteger(numericPort) &&
      numericPort > 0 &&
      numericPort !== detectedPort
    ) {
      throw new Error(
        `Modern.js requested port ${numericPort} but started on ${detectedPort}`,
      );
    }
    return detectedPort;
  }

  if (Number.isInteger(numericPort) && numericPort > 0) {
    return numericPort;
  }

  throw new Error('Dev server reported readiness without a usable local port');
}

function resolveWorkspacePackageInfo(packageName) {
  try {
    const resolvedEntryPath = require.resolve(packageName, {
      paths: [kTestsRoot],
    });
    let packageDir = fs.realpathSync(path.dirname(resolvedEntryPath));
    let packageJsonPath = path.join(packageDir, 'package.json');

    while (!fs.existsSync(packageJsonPath)) {
      const parentDir = path.dirname(packageDir);
      if (parentDir === packageDir) {
        throw new Error(`Failed to locate package.json for ${packageName}`);
      }
      packageDir = parentDir;
      packageJsonPath = path.join(packageDir, 'package.json');
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    return {
      packageDir,
      packageJson,
    };
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
  }

  for (const searchRoot of kWorkspaceSearchRoots) {
    const found = findWorkspacePackageInfo(packageName, searchRoot);
    if (found) {
      return found;
    }
  }

  throw new Error(`Failed to resolve workspace package ${packageName}`);
}

function findWorkspacePackageInfo(packageName, currentDir) {
  if (!fs.existsSync(currentDir)) {
    return null;
  }

  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name.startsWith('.')
    ) {
      continue;
    }

    const entryPath = path.join(currentDir, entry.name);
    const packageJsonPath = path.join(entryPath, 'package.json');

    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (packageJson.name === packageName) {
        return {
          packageDir: entryPath,
          packageJson,
        };
      }
    }

    const nested = findWorkspacePackageInfo(packageName, entryPath);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function resolvePackageDistEntry(packageDir, packageJson) {
  if (packageJson.main) {
    return path.join(packageDir, packageJson.main);
  }

  const rootExport = packageJson.exports?.['.'];
  if (typeof rootExport === 'string') {
    return path.join(packageDir, rootExport);
  }
  if (rootExport?.node?.require) {
    return path.join(packageDir, rootExport.node.require);
  }
  if (rootExport?.default) {
    return path.join(packageDir, rootExport.default);
  }

  return path.join(packageDir, 'dist/cjs/index.js');
}

function hasGlobPattern(value) {
  return kGlobPatternCharacters.some(character => value.includes(character));
}

function collectExportDistEntries(packageDir, exportValue, entries) {
  if (typeof exportValue === 'string') {
    if (exportValue.startsWith('./dist/') && !exportValue.includes('/types/')) {
      const entryPath = path.join(packageDir, exportValue);
      if (!hasGlobPattern(exportValue)) {
        entries.push(entryPath);
      } else {
        const matches = fs
          .globSync(entryPath)
          .filter(match => fs.statSync(match).isFile())
          .sort();
        entries.push(...(matches.length > 0 ? matches : [entryPath]));
      }
    }
    return;
  }

  if (!exportValue || typeof exportValue !== 'object') {
    return;
  }

  for (const [condition, conditionValue] of Object.entries(exportValue)) {
    if (condition === 'types') {
      continue;
    }
    collectExportDistEntries(packageDir, conditionValue, entries);
  }
}

function resolveRequiredPackageDistEntries(packageDir, packageJson) {
  const entries = [];
  collectExportDistEntries(packageDir, packageJson.exports, entries);

  return [...new Set(entries)];
}

// Build-completeness probe: refuse to spawn a modern command against a dist
// tree that is missing required entries (e.g. a half-restored nx cache or an
// interrupted rebuild). Failing here produces an actionable error instead of
// an opaque ERR_MODULE_NOT_FOUND from a loader thread inside the child.
function assertWorkspacePackagesBuildComplete(packageNames = []) {
  const missingEntries = [];

  for (const packageName of packageNames) {
    const { packageDir, packageJson } =
      resolveWorkspacePackageInfo(packageName);
    const requiredEntries = new Set([
      resolvePackageDistEntry(packageDir, packageJson),
      ...resolveRequiredPackageDistEntries(packageDir, packageJson),
    ]);

    for (const entry of requiredEntries) {
      if (!fs.existsSync(entry)) {
        missingEntries.push(`${packageName}: ${entry}`);
      }
    }
  }

  if (missingEntries.length > 0) {
    throw new Error(
      'Workspace dist tree is incomplete; refusing to spawn a modern command ' +
        'against a half-written tree.\n' +
        `Missing files:\n  ${missingEntries.join('\n  ')}\n` +
        'Rebuild the packages above with `pnpm --filter <pkg> build` ' +
        '(or re-run `pnpm run prepare-build`) and retry.',
    );
  }
}

function runModernCommand(argv, options = {}) {
  const { cwd, rejectOnCompileError = true } = options;
  const cmd = argv[0];
  const env = {
    ...process.env,
    ...options.env,
  };

  const commandPromise = new Promise((resolve, reject) => {
    const launch = async () => {
      assertWorkspacePackagesBuildComplete(options.requiredWorkspacePackages);

      const instance = spawn(
        process.execPath,
        [options.modernBin ?? kModernAppTools, ...argv],
        {
          ...options.spawnOptions,
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      if (typeof options.instance === 'function') {
        options.instance(instance);
      }

      let stderrOutput = '';
      instance.stderr.on('data', chunk => {
        stderrOutput += chunk;
      });

      let stdoutOutput = '';
      instance.stdout.on('data', async chunk => {
        let { marker } = options;
        if (cmd === 'deploy') {
          marker = /end deploy!/i;
        }
        stdoutOutput += chunk;
        const message = chunk.toString();

        const compileErrorMarker = /Compile error/i;

        if (
          cmd === 'build' &&
          rejectOnCompileError &&
          compileErrorMarker.test(message)
        ) {
          reject(new Error(message));
        }

        if (marker?.test(stdoutOutput)) {
          resolve({
            code: 0,
            stdout: stdoutOutput,
          });
          await killApp(instance);
        }
      });

      instance.on('close', code => {
        resolve({
          code,
          stdout: stdoutOutput,
          stderr: stderrOutput,
        });
      });

      instance.on('error', err => {
        err.stdout = stdoutOutput;
        err.stderr = stderrOutput;
        reject(err);
      });
    };

    launch().catch(reject);
  });

  return commandPromise;
}

function runModernCommandDev(argv, stdOut, options = {}) {
  const { cwd, rejectOnCompileError = true } = options;
  const env = {
    ...process.env,
    ...options.env,
  };

  const commandPromise = new Promise((resolve, reject) => {
    const launch = async () => {
      assertWorkspacePackagesBuildComplete(options.requiredWorkspacePackages);
      const instance = spawn(
        process.execPath,
        [options.modernBin ?? kModernAppTools, ...argv],
        {
          cwd,
          env,
        },
      );
      let didResolve = false;
      let readinessStarted = false;
      let stdoutOutput = '';
      let stderrOutput = '';
      let closed = false;

      function failStartup(error) {
        if (didResolve) return;
        didResolve = true;
        clearBootupTimer();
        error.stdout = stdoutOutput;
        error.stderr = stderrOutput;
        // A rejected startup never returns its child to the caller. Retire it
        // here, preserving the startup failure if cleanup itself also fails.
        void (async () => {
          let finishClose;
          let closeTimer;
          const childClosed = new Promise(resolve => {
            finishClose = () => {
              clearTimeout(closeTimer);
              instance.removeListener('close', finishClose);
              resolve();
            };
            if (closed) return finishClose();
            instance.once('close', finishClose);
            closeTimer = setTimeout(finishClose, 10_000);
            closeTimer.unref?.();
          });
          try {
            if (!closed && instance.pid) await killApp(instance);
          } catch (cleanupError) {
            error.cleanupError = cleanupError;
          }
          await childClosed;
          reject(error);
        })();
      }

      function handleStdout(data) {
        const message = data.toString();
        stdoutOutput += message;
        const bootupMarkers = {
          dev: /> Local:/i,
          serve: /> Local:/i,
        };
        const compileErrorMarker = /Compile error/i;

        if (rejectOnCompileError && compileErrorMarker.test(message)) {
          failStartup(new Error(message));
        }

        if (
          !didResolve &&
          !readinessStarted &&
          bootupMarkers[options.modernServe ? 'serve' : 'dev'].test(message)
        ) {
          readinessStarted = true;
          let readyPort;
          try {
            readyPort = resolveReadyPort(env.PORT, stdoutOutput);
          } catch (error) {
            failStartup(error);
            return;
          }
          void waitForTcpServer(readyPort)
            .then(() => {
              if (!didResolve) {
                didResolve = true;
                clearBootupTimer();
                resolve(stdOut ? message : instance);
              }
            })
            .catch(error => {
              failStartup(error);
            });
        }

        if (typeof options.onStdout === 'function') {
          options.onStdout(message);
        }

        if (stdOut !== false && options.stdout !== false) {
          process.stdout.write(message);
        }
      }

      instance.stdout.on('data', handleStdout);
      instance.stderr.on('data', data => {
        const message = data.toString();
        stderrOutput += message;

        if (typeof options.onStderr === 'function') {
          options.onStderr(message);
        }

        const compileErrorMarker = /Compile error/i;
        if (rejectOnCompileError && compileErrorMarker.test(message)) {
          failStartup(new Error(message));
        }

        if (options.stderr !== false) {
          process.stderr.write(message);
        }
      });

      // A dev/serve child that never prints its readiness marker used to hang
      // this promise forever: the suite then died on its own hook timeout with
      // no indication of which server never came up or what it had emitted.
      // Fail with that evidence instead. This does not make a failing fixture
      // pass - it makes an opaque stall readable.
      const bootupTimeoutMs = Number(
        process.env.MODERN_TEST_BOOTUP_TIMEOUT_MS || 240_000,
      );
      const bootupTimer = setTimeout(() => {
        if (didResolve) {
          return;
        }
        const phase = options.modernServe ? 'serve' : 'dev';
        const output = [stdoutOutput.trim(), stderrOutput.trim()]
          .filter(Boolean)
          .join('\n');
        const error = new Error(
          `modern ${phase} in ${cwd} produced no readiness marker within ` +
            `${bootupTimeoutMs}ms (pid ${instance.pid}).` +
            (output ? `\nOutput so far:\n${output}` : '\nIt emitted nothing.'),
        );
        failStartup(error);
      }, bootupTimeoutMs);
      bootupTimer.unref?.();
      const clearBootupTimer = () => clearTimeout(bootupTimer);

      instance.on('error', error => {
        failStartup(error);
      });

      instance.on('close', code => {
        closed = true;
        clearBootupTimer();
        instance.stdout.removeListener('data', handleStdout);
        if (!didResolve) {
          const phase = options.modernServe ? 'serve' : 'dev';
          const output = [stdoutOutput.trim(), stderrOutput.trim()]
            .filter(Boolean)
            .join('\n');
          const detail = output ? `\n${output}` : '';
          const exitCode = code === null ? 'unknown' : String(code);
          const error = new Error(
            `modern ${phase} exited before readiness marker with code ${exitCode}.${detail}`,
          );
          failStartup(error);
        }
      });
    };

    launch().catch(reject);
  });

  return commandPromise;
}

function runContinuousTask(argv, stdOut, options = {}) {
  const env = {
    ...process.env,
    ...options.env,
  };
  const command = options.command || process.execPath;
  const waitMessage = options.waitMessage;

  return new Promise((resolve, reject) => {
    const instance = spawn(command, argv, {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let didResolve = false;
    let stdoutOutput = '';
    let stderrOutput = '';

    const tryResolve = message => {
      if (didResolve || !waitMessage) {
        return;
      }

      if (waitMessage.test(message)) {
        didResolve = true;
        resolve(stdOut ? message : instance);
      }
    };

    instance.stdout.on('data', data => {
      const message = data.toString();
      stdoutOutput += message;
      tryResolve(stdoutOutput);

      if (stdOut !== false && options.stdout !== false) {
        process.stdout.write(message);
      }
    });

    instance.stderr.on('data', data => {
      const message = data.toString();
      stderrOutput += message;
      tryResolve(stderrOutput);

      if (options.stderr !== false) {
        process.stderr.write(message);
      }
    });

    instance.on('error', error => {
      error.stdout = stdoutOutput;
      error.stderr = stderrOutput;
      reject(error);
    });

    instance.on('close', code => {
      if (!didResolve) {
        const output = [stdoutOutput.trim(), stderrOutput.trim()]
          .filter(Boolean)
          .join('\n');
        const detail = output ? `\n${output}` : '';
        const exitCode = code === null ? 'unknown' : String(code);
        const error = new Error(
          `Process exited before readiness marker with code ${exitCode}.${detail}`,
        );
        error.stdout = stdoutOutput;
        error.stderr = stderrOutput;
        didResolve = true;
        reject(error);
      }
    });
  });
}

function modernBuild(dir, args = [], opts = {}) {
  return runModernCommand(['build', ...args], {
    cwd: dir,
    stdout: true,
    stderr: true,
    ...opts,
    env: {
      NODE_ENV: 'production',
      ...(opts.env || {}),
    },
  });
}

function modernDeploy(dir, mode = '', opts = {}) {
  return runModernCommand(['deploy', `--dir=${dir}`, `--mode=${mode}`], {
    ...opts,
    stdout: true,
    cwd: dir,
    env: {
      NODE_ENV: 'production',
      BUILD_PATH: '',
    },
    cmd: 'deploy',
  });
}

function launchApp(dir, port, opts = {}, env = {}) {
  return runModernCommandDev(['dev'], undefined, {
    ...opts,
    cwd: dir,
    env: {
      PORT: port,
      NODE_ENV: 'development',
      ...env,
      ...(opts.env || {}),
    },
  });
}

function modernServe(dir, port, opts = {}) {
  return runModernCommandDev(['serve'], undefined, {
    ...opts,
    cwd: dir,
    env: {
      PORT: port,
      NODE_ENV: 'production',
      ...(opts.env || {}),
    },
    modernServe: true,
  });
}

function readLinuxProcess(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return {
      pid,
      state: fields[0],
      parent: Number(fields[1]),
      start: fields[19],
    };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined;
    throw error;
  }
}

function captureLinuxProcessTree(pid) {
  const processes = fs
    .readdirSync('/proc')
    .filter(name => /^\d+$/.test(name))
    .map(name => readLinuxProcess(Number(name)))
    .filter(Boolean);
  const owned = new Set([pid]);
  let previousSize;
  do {
    previousSize = owned.size;
    for (const process of processes) {
      if (owned.has(process.parent)) owned.add(process.pid);
    }
  } while (owned.size !== previousSize);
  return processes.filter(process => owned.has(process.pid));
}

async function waitForLinuxProcessTree(processes) {
  const deadline = Date.now() + 10_000;
  while (true) {
    const live = processes.filter(process => {
      const current = readLinuxProcess(process.pid);
      // start time binds the captured PID to this process, including after its
      // parent exits. A reused PID belongs to another owner and is untouched.
      return (
        current && current.start === process.start && current.state !== 'Z'
      );
    });
    if (!live.length) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `App processes did not exit after termination: ${live.map(process => process.pid).join(', ')}`,
      );
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function killApp(instance) {
  if (!instance) return;
  const processes =
    process.platform === 'linux' ? captureLinuxProcessTree(instance.pid) : [];
  await new Promise((resolve, reject) => {
    treeKill(instance.pid, err => {
      if (err) {
        if (
          process.platform === 'win32' &&
          typeof err.message === 'string' &&
          (err.message.includes(`Access is denied`) ||
            err.message.includes(`no running instance of the task`) ||
            err.message.includes(`not found`) ||
            err.message.includes(`operation attempted is not supported`))
        ) {
          // Windows can report transient taskkill errors after the app exits.
          //
          // Command failed: taskkill /pid 6924 /T /F
          // ERROR: The process with PID 6924 (child process of PID 6736) could not be terminated.
          // Reason: There is no running instance of the task.
          return resolve();
        }
        return reject(err);
      }
      return resolve();
    });
  });
  // tree-kill acknowledges signal delivery, not process exit. Even inherited
  // pipes can close while a descendant is still completing its shutdown.
  await waitForLinuxProcessTree(processes);
}

/**
 * The port number alone, with its socket already closed.
 *
 * A port whose socket is closed can be reissued to a sibling before the caller
 * binds it, which is the `listen EADDRINUSE` that cost whole check cycles.
 * Callers that own the process binding the port should take `leasePort()`
 * instead - it is re-exported here - and release it in the statement before
 * that process starts.
 */
async function getPort() {
  const lease = await leasePort();
  await lease.release();
  return lease.port;
}

function sleep(t) {
  return new Promise(resolve => setTimeout(resolve, t));
}

/**
 * Copy a fixture app into a unique temporary sibling directory so test files
 * that would otherwise share one project directory each run against their own
 * copy. Concurrent build/dev in a single directory corrupts artifacts: the
 * build empties `dist` under the running server.
 *
 * node_modules is NOT symlinked as a whole: a whole-dir link would make all
 * copies share `node_modules/.modern-js` (generated code), re-creating the
 * conflict. Every entry is linked individually instead, and `.cache` /
 * `.modern-js` are left out so each copy gets its own.
 */
async function createIsolatedTestApp(sourceAppDir, options = {}) {
  const fse = require('fs-extra');
  const { prefix = `.isolated-${path.basename(sourceAppDir)}-`, exclude = [] } =
    options;

  const appDir = await fse.mkdtemp(
    path.join(path.dirname(sourceAppDir), prefix),
  );
  const topLevelExcludes = [
    'node_modules',
    'dist',
    'dist-deploy',
    'dist-ssg',
    '.output',
    'tests',
    'test',
    ...exclude,
  ];
  await fse.copy(sourceAppDir, appDir, {
    filter: src => {
      const relative = path.relative(sourceAppDir, src);
      if (!relative) {
        return true;
      }
      const [firstSegment] = relative.split(path.sep);
      return !topLevelExcludes.includes(firstSegment);
    },
  });

  const sourceNodeModules = path.join(sourceAppDir, 'node_modules');
  const appNodeModules = path.join(appDir, 'node_modules');
  await fse.ensureDir(appNodeModules);
  if (await fse.pathExists(sourceNodeModules)) {
    for (const entry of await fse.readdir(sourceNodeModules)) {
      if (entry === '.cache' || entry === '.modern-js') {
        continue;
      }
      const target = path.join(sourceNodeModules, entry);
      // stat (not lstat): pnpm's top-level entries are themselves symlinks,
      // and the link type must describe what they finally point to.
      let isDirectory = true;
      try {
        isDirectory = (await fse.stat(target)).isDirectory();
      } catch {
        continue; // dangling link in the source tree
      }
      await fse.ensureSymlink(
        target,
        path.join(appNodeModules, entry),
        isDirectory ? 'junction' : 'file',
      );
    }
  }

  return {
    appDir,
    // Callers must kill any process using appDir before cleanup; removal is
    // retried because Windows keeps directories busy while children exit.
    async cleanup() {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await fse.remove(appDir);
          return;
        } catch {
          await sleep(500);
        }
      }
      await fse.remove(appDir).catch(() => {});
    },
  };
}

module.exports = {
  acquirePortAllocatorLock,
  runModernCommand,
  runModernCommandDev,
  modernBuild,
  modernDeploy,
  modernServe,
  launchApp,
  killApp,
  getPort,
  leasePort,
  sleep,
  runContinuousTask,
  launchOptions,
  assertWorkspacePackagesBuildComplete,
  resolveRequiredPackageDistEntries,
  createIsolatedTestApp,
};
