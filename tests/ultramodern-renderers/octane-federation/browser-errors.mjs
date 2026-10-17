import assert from 'node:assert/strict';
import path from 'node:path';

/** Keep proof browser ownership independent of machine-wide CLI defaults. */
export function ownedBrowserInvocation({
  env,
  configPath,
  executable,
  session,
}) {
  assert(path.isAbsolute(configPath), 'Use an operation-owned absolute config');
  assert(
    typeof executable === 'string' && path.isAbsolute(executable),
    'Provide the intended browser executable explicitly',
  );
  assert(
    /^[A-Za-z0-9_-]+$/u.test(session),
    'Use a unique proof browser session',
  );
  return {
    args: [
      '--engine',
      'chrome',
      '--headed',
      'false',
      '--executable-path',
      executable,
      '--session',
      session,
    ],
    env: {
      ...Object.fromEntries(
        Object.entries(env).filter(
          ([key]) => !key.startsWith('AGENT_BROWSER_'),
        ),
      ),
      AGENT_BROWSER_CONFIG: configPath,
      AGENT_BROWSER_ENGINE: 'chrome',
      AGENT_BROWSER_HEADED: 'false',
      AGENT_BROWSER_EXECUTABLE_PATH: executable,
      AGENT_BROWSER_SESSION: session,
    },
  };
}

/** Read-only diagnostics installed before native application entries execute. */
export function installBrowserErrorDiagnostics(target = globalThis) {
  const records = [];
  target.__octaneMFStartupErrors = records;
  const describe = (value, depth = 0, seen = new Set()) => {
    if (value === null || typeof value !== 'object')
      return { type: typeof value, value: String(value) };
    if (seen.has(value)) return { circular: true };
    if (depth >= 4) return { truncated: true };
    seen.add(value);
    const result = {};
    for (const key of ['name', 'message', 'stack', 'code']) {
      try {
        if (typeof value[key] === 'string') result[key] = value[key];
      } catch {
        result[key] = '<unreadable>';
      }
    }
    try {
      if ('cause' in value)
        result.cause = describe(value.cause, depth + 1, seen);
      if (Array.isArray(value.errors))
        result.errors = value.errors
          .slice(0, 16)
          .map(error => describe(error, depth + 1, seen));
    } catch {
      result.details = '<unreadable>';
    }
    return result;
  };
  const record = value => {
    if (records.length < 64) records.push(value);
  };
  target.addEventListener('error', event => {
    record({
      type: 'error',
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: describe(event.error),
    });
  });
  target.addEventListener('unhandledrejection', event => {
    record({ type: 'unhandledrejection', reason: describe(event.reason) });
  });
}

export const browserErrorDiagnosticsSource = `(${installBrowserErrorDiagnostics.toString()})(globalThis);`;

/** Install only on the exact blank target created by this proof's CLI session. */
export async function installBrowserErrorDiagnosticsViaCDP({
  browser,
  targetURL,
  signal,
  WebSocketImpl = globalThis.WebSocket,
}) {
  if (!targetURL.startsWith('about:blank#') || targetURL.length < 20)
    throw new Error(
      'Startup diagnostics require the exact owned blank target.',
    );
  signal?.throwIfAborted();
  const endpoint = new URL(await browser('get', 'cdp-url'));
  if (
    endpoint.protocol !== 'ws:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
    !endpoint.pathname.startsWith('/devtools/browser/')
  )
    throw new Error(
      'Startup diagnostics require the owned loopback browser CDP endpoint.',
    );
  const socket = new WebSocketImpl(endpoint.href);
  let sequence = 0;
  let sessionId;
  let disposed = false;
  const wait = (subscribe, label) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error(`${label} timed out`)),
        5000,
      );
      const abort = () => finish(signal.reason);
      let unsubscribe = () => {};
      function finish(error, value) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        unsubscribe();
        if (error) reject(error);
        else resolve(value);
      }
      unsubscribe = subscribe(finish);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  const command = (method, params = {}, attachedSession) => {
    const id = ++sequence;
    return wait(finish => {
      const message = event => {
        let result;
        try {
          result = JSON.parse(String(event.data));
        } catch (error) {
          finish(error);
          return;
        }
        if (result.id !== id) return;
        if (result.error)
          finish(new Error(`${method}: ${JSON.stringify(result.error)}`));
        else finish(undefined, result.result);
      };
      const failed = event =>
        finish(event.error ?? new Error(`${method}: CDP socket failed`));
      const closed = () => finish(new Error(`${method}: CDP socket closed`));
      socket.addEventListener('message', message);
      socket.addEventListener('error', failed);
      socket.addEventListener('close', closed);
      const unsubscribe = () => {
        socket.removeEventListener('message', message);
        socket.removeEventListener('error', failed);
        socket.removeEventListener('close', closed);
      };
      try {
        socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(attachedSession ? { sessionId: attachedSession } : {}),
          }),
        );
      } catch (error) {
        unsubscribe();
        finish(error);
      }
      return unsubscribe;
    }, method);
  };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      if (
        sessionId &&
        !signal?.aborted &&
        socket.readyState === WebSocketImpl.OPEN
      )
        await command('Target.detachFromTarget', { sessionId });
    } finally {
      socket.close();
    }
  };
  try {
    await wait(finish => {
      const opened = () => finish();
      const failed = event =>
        finish(event.error ?? new Error('Diagnostic CDP connection failed'));
      socket.addEventListener('open', opened);
      socket.addEventListener('error', failed);
      return () => {
        socket.removeEventListener('open', opened);
        socket.removeEventListener('error', failed);
      };
    }, 'Diagnostic CDP connection');
    const { targetInfos } = await command('Target.getTargets');
    const targets = targetInfos.filter(
      target => target.type === 'page' && target.url === targetURL,
    );
    if (targets.length !== 1)
      throw new Error('The exact owned diagnostic target is not unique.');
    ({ sessionId } = await command('Target.attachToTarget', {
      targetId: targets[0].targetId,
      flatten: true,
    }));
    await command(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: browserErrorDiagnosticsSource },
      sessionId,
    );
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Diagnostic CDP setup/cleanup failed',
      );
    }
    throw error;
  }
  // Keep the exact page session alive through navigation; its disposer owns
  // both the attachment and this separate WebSocket, never the browser itself.
  dispose.snapshot = async () => {
    signal?.throwIfAborted();
    if (disposed || !sessionId || socket.readyState !== WebSocketImpl.OPEN)
      throw new Error('The owned diagnostic CDP session is unavailable.');
    const observed = await command(
      'Runtime.evaluate',
      {
        expression: 'globalThis.__octaneMFStartupErrors',
        returnByValue: true,
      },
      sessionId,
    );
    if (observed.exceptionDetails)
      throw new Error(
        `Diagnostic snapshot failed: ${JSON.stringify(observed.exceptionDetails)}`,
      );
    if (!Array.isArray(observed.result?.value))
      throw new Error('The owned diagnostic snapshot is not an error list.');
    return observed.result.value;
  };
  return dispose;
}
