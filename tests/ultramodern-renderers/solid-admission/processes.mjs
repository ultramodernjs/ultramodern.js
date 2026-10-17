import { spawn } from 'node:child_process';

/** Own only subprocess groups created by this scope. Lifecycle cleanup remains
 * outside its abort signal so registrations can always be released. */
export function createAdmissionProcessScope({ signal } = {}) {
  const controller = new AbortController();
  const interrupted = () =>
    controller.abort(signal.reason ?? new Error('Solid admission interrupted'));
  signal?.addEventListener('abort', interrupted, { once: true });
  if (signal?.aborted) interrupted();
  const children = new Set();
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () =>
      controller.abort(new Error(`Solid admission interrupted by ${signal}`));
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  function start(
    command,
    args,
    { cwd, env = process.env, maxBuffer = 8 * 1024 * 1024 } = {},
  ) {
    controller.signal.throwIfAborted();
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let output = '';
    let stdout = '';
    let stderr = '';
    let failure;
    let stopped;
    const completion = new Promise(resolve => {
      child.once('error', error => {
        failure = error;
        resolve();
      });
      child.once('close', resolve);
    });
    const terminate = signal => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    const stop = () =>
      (stopped ??= (async () => {
        controller.signal.removeEventListener('abort', interrupted);
        terminate('SIGTERM');
        const hardStop = setTimeout(() => terminate('SIGKILL'), 2_000);
        try {
          await completion;
        } finally {
          clearTimeout(hardStop);
          terminate('SIGKILL');
          children.delete(child);
        }
      })());
    const interrupted = () => {
      void stop().catch(() => {});
    };
    controller.signal.addEventListener('abort', interrupted, { once: true });
    for (const [stream, type] of [
      [child.stdout, 'stdout'],
      [child.stderr, 'stderr'],
    ]) {
      stream.on('data', bytes => {
        output = `${output}${bytes}`.slice(-8192);
        if (failure) return;
        if (type === 'stdout') stdout += bytes;
        else stderr += bytes;
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBuffer) {
          failure = new Error(
            `Solid admission command exceeded output limit: ${command}`,
          );
          void stop().catch(() => {});
        }
      });
    }
    child.output = () => output;
    child.admissionCompletion = completion;
    child.admissionStop = stop;
    child.admissionResult = () => ({ stdout, stderr, failure });
    if (controller.signal.aborted) interrupted();
    return child;
  }

  async function execute(command, args, options = {}) {
    const timeoutMs = options.timeout ?? 120_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000)
      throw new Error('Solid admission command timeout must be bounded');
    const child = start(command, args, options);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void child.admissionStop().catch(() => {});
    }, timeoutMs);
    try {
      await child.admissionCompletion;
      controller.signal.throwIfAborted();
      const result = child.admissionResult();
      if (result.failure) throw result.failure;
      if (timedOut || child.exitCode !== 0) {
        const error = new Error(
          `Solid admission command failed (${timedOut ? 'timeout' : (child.exitCode ?? child.signalCode)}): ${command}\n${child.output()}`,
        );
        Object.assign(error, { stdout: result.stdout, stderr: result.stderr });
        throw error;
      }
      return { stdout: result.stdout, stderr: result.stderr };
    } finally {
      clearTimeout(timer);
      await child.admissionStop();
    }
  }

  return {
    signal: controller.signal,
    start,
    execute,
    stop: child => child.admissionStop(),
    async dispose() {
      const results = await Promise.allSettled(
        [...children].map(child => child.admissionStop()),
      );
      signal?.removeEventListener('abort', interrupted);
      for (const [signal, handler] of handlers)
        process.removeListener(signal, handler);
      const failures = results
        .filter(result => result.status === 'rejected')
        .map(result => result.reason);
      if (failures.length)
        throw new AggregateError(
          failures,
          'Solid admission subprocess cleanup failed',
        );
    },
  };
}
