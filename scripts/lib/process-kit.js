/**
 * Shared process and server lifecycle helpers for fork-owned script runners.
 */
const { spawnSync } = require('node:child_process');

const completeProcessEnvs = new WeakSet();

function applyProcessEnvOverrides(env, overrides) {
  for (const [name, value] of Object.entries(overrides)) {
    const normalizedName = name.toLowerCase();
    for (const inheritedName of Object.keys(env)) {
      if (inheritedName.toLowerCase() === normalizedName) {
        delete env[inheritedName];
      }
    }
    if (value === undefined) {
      // Undefined is an explicit inherited-variable scrub, not a child value.
      continue;
    }
    env[name] = value;
  }
  return env;
}

function createProcessEnv(overrides = {}) {
  const env = applyProcessEnvOverrides({ ...process.env }, {
    FORCE_COLOR: '0',
  });
  applyProcessEnvOverrides(env, overrides);
  completeProcessEnvs.add(env);
  return env;
}

// Env for git commands that must operate on the repository at their `cwd`.
// Inherited GIT_* variables (git hooks export GIT_DIR and GIT_INDEX_FILE,
// callers may export GIT_CONFIG_*) would redirect or reconfigure them.
function createRepositoryGitEnv(overrides = {}) {
  return createProcessEnv({
    ...Object.fromEntries(
      Object.keys(process.env)
        .filter(name => name.toUpperCase().startsWith('GIT_'))
        .map(name => [name, undefined]),
    ),
    ...overrides,
  });
}

function writeStream(stream, message) {
  return new Promise((resolve, reject) => {
    stream.write(message, error => (error ? reject(error) : resolve()));
  });
}

function runCommand(command, args = [], options = {}) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('Command must be a non-empty string');
  }
  if (!Array.isArray(args)) {
    throw new Error('Command args must be an array');
  }

  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    // A complete env may contain deliberate removals; merging the parent a
    // second time would restore the variables createProcessEnv scrubbed.
    env:
      completeProcessEnvs.has(options.env)
        ? applyProcessEnvOverrides({}, options.env)
        : createProcessEnv(options.env || {}),
    encoding: options.encoding || 'utf8',
    stdio: options.stdio || 'inherit',
    ...(options.maxBuffer === undefined
      ? {}
      : { maxBuffer: options.maxBuffer }),
  });

  return {
    command,
    args,
    processStatus: result.status,
    exitCode: result.status ?? 1,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    durationMs: Date.now() - startedAt,
  };
}

function normalizeCommandEntry(entry, fallbackCwd) {
  const item = Array.isArray(entry)
    ? { command: entry[0], args: entry.slice(1) }
    : entry;
  if (!item || typeof item.command !== 'string' || item.command.length === 0) {
    throw new Error('Command entry must include a command string');
  }
  if (item.args !== undefined && !Array.isArray(item.args)) {
    throw new Error('Command entry args must be an array');
  }
  return {
    ...item,
    args: item.args || [],
    cwd: item.cwd || fallbackCwd || process.cwd(),
  };
}

function runCommandList(commands, options = {}) {
  const results = [];
  for (const entry of commands) {
    const item = normalizeCommandEntry(entry, options.cwd);
    if (options.dryRun) {
      results.push({
        ...item,
        status: 'planned',
        exitCode: 0,
        durationMs: 0,
      });
      continue;
    }

    if (typeof options.onCommandStart === 'function') {
      options.onCommandStart(item);
    }

    const result = runCommand(item.command, item.args, {
      cwd: item.cwd,
      env: item.env,
      stdio: options.stdio,
    });
    const passed = result.exitCode === 0 && !result.error;
    const itemResult = {
      ...item,
      status: passed ? 'passed' : 'failed',
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
    };
    if (options.includeProcessStatus) {
      itemResult.processStatus = result.processStatus;
    }
    if (options.includeErrors && result.error) {
      itemResult.error = result.error;
    }
    results.push(itemResult);

    if (!passed && !options.continueOnError) {
      break;
    }
  }
  return results;
}

function killChild(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to direct child kill.
    }
  }
  child.kill(signal);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  createProcessEnv,
  createRepositoryGitEnv,
  killChild,
  runCommand,
  runCommandList,
  sleep,
  writeStream,
};
