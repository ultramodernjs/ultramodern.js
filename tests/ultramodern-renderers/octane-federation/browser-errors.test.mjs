import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  browserErrorDiagnosticsSource,
  installBrowserErrorDiagnosticsViaCDP,
  ownedBrowserInvocation,
} from './browser-errors.mjs';

test('browser invocations ignore ambient providers and profiles and explicitly select owned headless Chrome', () => {
  const env = {
    PATH: '/trusted/bin',
    AGENT_BROWSER_CONFIG: '/global/agent-browser.json',
    AGENT_BROWSER_PROVIDER: 'headed-plugin',
    AGENT_BROWSER_PROFILE: '/user/profile',
    AGENT_BROWSER_PLUGINS: '["launch-mutator"]',
    AGENT_BROWSER_AUTO_CONNECT: 'true',
    AGENT_BROWSER_RESTORE: 'user-state',
    AGENT_BROWSER_CDP: '9222',
  };
  const invocation = ownedBrowserInvocation({
    env,
    configPath: '/owned/proof/agent-browser.json',
    executable: '/intended/chromium',
    session: 'unique-owned-proof-session',
  });
  assert.deepEqual(invocation.args, [
    '--engine',
    'chrome',
    '--headed',
    'false',
    '--executable-path',
    '/intended/chromium',
    '--session',
    'unique-owned-proof-session',
  ]);
  assert.deepEqual(invocation.env, {
    PATH: '/trusted/bin',
    AGENT_BROWSER_CONFIG: '/owned/proof/agent-browser.json',
    AGENT_BROWSER_ENGINE: 'chrome',
    AGENT_BROWSER_HEADED: 'false',
    AGENT_BROWSER_EXECUTABLE_PATH: '/intended/chromium',
    AGENT_BROWSER_SESSION: 'unique-owned-proof-session',
  });
  assert.equal(env.AGENT_BROWSER_PROFILE, '/user/profile');
  assert.throws(
    () =>
      ownedBrowserInvocation({
        env,
        configPath: '/owned/proof/config.json',
        session: 'proof',
      }),
    /executable explicitly/,
  );
});

function diagnostics() {
  const target = new EventTarget();
  const context = {
    addEventListener: target.addEventListener.bind(target),
  };
  runInNewContext(browserErrorDiagnosticsSource, context);
  return { target, records: context.__octaneMFStartupErrors };
}

test('captures the original browser error stack and nested cause without suppressing it', () => {
  const { target, records } = diagnostics();
  const error = new Error('publisher startup failed', {
    cause: new TypeError('missing native function'),
  });
  const event = new Event('error', { cancelable: true });
  Object.assign(event, {
    message: error.message,
    filename: 'http://localhost:62271/native-runtime.mjs',
    lineno: 3,
    colno: 5,
    error,
  });
  assert.equal(target.dispatchEvent(event), true);
  assert.equal(event.defaultPrevented, false);
  assert.equal(records[0].message, error.message);
  assert.equal(records[0].filename, event.filename);
  assert.equal(records[0].error.stack, error.stack);
  assert.equal(records[0].error.cause.message, 'missing native function');
});

test('captures rejected aggregate and primitive reasons without handling the rejection', () => {
  const { target, records } = diagnostics();
  for (const reason of [
    new AggregateError([new Error('inner')], 'outer'),
    'failed',
  ]) {
    const event = new Event('unhandledrejection', { cancelable: true });
    Object.assign(event, { reason });
    assert.equal(target.dispatchEvent(event), true);
    assert.equal(event.defaultPrevented, false);
  }
  assert.equal(records[0].reason.message, 'outer');
  assert.equal(records[0].reason.errors[0].message, 'inner');
  assert.equal(records[1].reason.type, 'string');
  assert.equal(records[1].reason.value, 'failed');
});

function cdp({
  missing = false,
  scriptError = false,
  diagnosticErrors = [],
  evaluationError = false,
  missingObserver = false,
  pageEnableError = false,
} = {}) {
  const commands = [];
  let closes = 0;
  let socket;
  let pageEnabled = false;
  const targetURL = 'about:blank#owned-native-startup-proof';
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    constructor() {
      super();
      socket = this;
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      });
    }
    send(encoded) {
      const command = JSON.parse(encoded);
      commands.push(command);
      if (command.method === 'Page.enable' && !pageEnableError)
        pageEnabled = true;
      const result =
        command.method === 'Target.getTargets'
          ? {
              targetInfos: [
                {
                  targetId: 'other',
                  type: 'page',
                  url: 'https://unrelated.example/',
                },
                ...(missing
                  ? []
                  : [{ targetId: 'owned', type: 'page', url: targetURL }]),
              ],
            }
          : command.method === 'Target.attachToTarget'
            ? { sessionId: 'owned-session' }
            : command.method === 'Runtime.evaluate'
              ? evaluationError
                ? { exceptionDetails: { text: 'evaluation failed' } }
                : {
                    result: {
                      type: missingObserver ? 'undefined' : 'object',
                      value: runInNewContext(
                        command.params.expression,
                        missingObserver
                          ? {}
                          : { __octaneMFStartupErrors: diagnosticErrors },
                      ),
                    },
                  }
              : command.method === 'Page.getFrameTree'
                ? { frameTree: { frame: { url: 'http://localhost:62271/' } } }
                : {};
      const response =
        command.method === 'Page.enable' && pageEnableError
          ? { id: command.id, error: { message: 'Page domain refused' } }
          : (scriptError || !pageEnabled) &&
              command.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? {
                id: command.id,
                error: { message: 'script installation failed' },
              }
            : { id: command.id, result };
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent('message', { data: JSON.stringify(response) }),
        ),
      );
    }
    close() {
      closes++;
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  }
  return {
    commands,
    closes: () => closes,
    disconnect: () => socket.close(),
    input: {
      targetURL,
      WebSocketImpl: Socket,
      browser: async (...args) => {
        assert.deepEqual(args, ['get', 'cdp-url']);
        return 'ws://127.0.0.1:9222/devtools/browser/owned-browser';
      },
    },
  };
}

test('installs only in the exact owned CDP page and retains its session until disposal', async () => {
  const control = cdp();
  const dispose = await installBrowserErrorDiagnosticsViaCDP(control.input);
  assert.deepEqual(
    control.commands.map(command => command.method),
    [
      'Target.getTargets',
      'Target.attachToTarget',
      'Page.enable',
      'Page.addScriptToEvaluateOnNewDocument',
    ],
  );
  assert.equal(control.commands[1].params.targetId, 'owned');
  assert.equal(control.commands[2].sessionId, 'owned-session');
  assert.equal(control.commands[3].sessionId, 'owned-session');
  assert.equal(
    control.commands[3].params.source,
    browserErrorDiagnosticsSource,
  );
  assert.equal(control.closes(), 0);
  await dispose();
  await dispose();
  assert.equal(control.commands.at(-1).method, 'Target.detachFromTarget');
  assert.equal(control.closes(), 1);
});

test('missing owned target never attaches to another page and closes its CDP socket', async () => {
  const control = cdp({ missing: true });
  await assert.rejects(
    installBrowserErrorDiagnosticsViaCDP(control.input),
    /not unique/,
  );
  assert.deepEqual(
    control.commands.map(command => command.method),
    ['Target.getTargets'],
  );
  assert.equal(control.closes(), 1);
});

test('snapshot reads only diagnostic errors through the retained exact page session', async () => {
  const errors = [
    {
      type: 'unhandledrejection',
      reason: {
        name: 'Error',
        message: 'hydration failed',
        stack: 'Error: hydration failed\n    at native-owner.js:10:2',
        cause: { name: 'Error', message: 'missing publisher' },
      },
    },
  ];
  const control = cdp({ diagnosticErrors: errors });
  const dispose = await installBrowserErrorDiagnosticsViaCDP(control.input);
  assert.deepEqual(await dispose.snapshot(), errors);
  const evaluation = control.commands.at(-1);
  assert.equal(evaluation.method, 'Runtime.evaluate');
  assert.equal(evaluation.sessionId, 'owned-session');
  assert.deepEqual(evaluation.params, {
    expression: 'globalThis.__octaneMFStartupErrors',
    returnByValue: true,
  });
  await dispose();
  const count = control.commands.length;
  await assert.rejects(dispose.snapshot(), /session is unavailable/);
  assert.equal(control.commands.length, count);
});

test('snapshot rejects a lost CDP session without evaluating a different page', async () => {
  const control = cdp();
  const dispose = await installBrowserErrorDiagnosticsViaCDP(control.input);
  control.disconnect();
  const count = control.commands.length;
  await assert.rejects(dispose.snapshot(), /session is unavailable/);
  assert.equal(control.commands.length, count);
  await dispose();
});

test('snapshot reports an evaluation failure instead of inventing an empty error list', async () => {
  const control = cdp({ evaluationError: true });
  const dispose = await installBrowserErrorDiagnosticsViaCDP(control.input);
  await assert.rejects(dispose.snapshot(), /evaluation failed/);
  await dispose();
});

test('snapshot rejects an absent observer instead of reporting an empty error list', async () => {
  const control = cdp({ missingObserver: true });
  const dispose = await installBrowserErrorDiagnosticsViaCDP(control.input);
  await assert.rejects(
    dispose.snapshot(),
    /snapshot is not an error list \(target owned, observed URL http:\/\/localhost:62271\/\)/,
  );
  assert.equal(control.commands.at(-1).method, 'Page.getFrameTree');
  assert.equal(control.commands.at(-1).sessionId, 'owned-session');
  await dispose();
});

test('a refused Page domain aborts registration and detaches only the owned session', async () => {
  const control = cdp({ pageEnableError: true });
  await assert.rejects(
    installBrowserErrorDiagnosticsViaCDP(control.input),
    /Page domain refused/,
  );
  assert.deepEqual(
    control.commands.map(command => command.method),
    [
      'Target.getTargets',
      'Target.attachToTarget',
      'Page.enable',
      'Target.detachFromTarget',
    ],
  );
  assert.equal(control.commands[2].sessionId, 'owned-session');
  assert.equal(control.closes(), 1);
});

test('failed script installation detaches its owned session and preserves the original error', async () => {
  const control = cdp({ scriptError: true });
  await assert.rejects(
    installBrowserErrorDiagnosticsViaCDP(control.input),
    /script installation failed/,
  );
  assert.equal(control.commands.at(-1).method, 'Target.detachFromTarget');
  assert.equal(control.closes(), 1);
});
