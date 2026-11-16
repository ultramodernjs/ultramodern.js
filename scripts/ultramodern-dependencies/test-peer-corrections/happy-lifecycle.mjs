import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInContext } from 'node:vm';

const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve('@rstest/core/package.json'));
// Execute the package's own environment, not a reimplementation or a Window-only smoke test.
const { setupEnvironment, setupVM } = await import(
  pathToFileURL(path.join(root, 'dist/happyDom~0.js'))
);
const owner = require.resolve('happy-dom', { paths: [root] });
assert.equal(owner, require.resolve('happy-dom'));
for (const vm of [false, true]) {
  const target = {
    console,
    ...Object.fromEntries(
      [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'setImmediate',
        'clearImmediate',
      ].map(k => [k, globalThis[k]]),
    ),
  };
  const originalTimeout = target.setTimeout;
  const context = { scope: 'test' };
  const options = {
    url: 'https://qualification.invalid/path',
    settings: { disableIframePageLoading: true },
  };
  const environment = vm
    ? await setupVM(options, context)
    : await setupEnvironment(target, options, context);
  const global = vm ? runInContext('globalThis', environment.context) : target;
  const document = global.document;
  let leaked = false;
  try {
    assert.equal(global.location.href, options.url);
    assert.equal(global.window, global);
    assert.equal(document.defaultView, global);
    assert.equal(global.happyDOM.settings.enableIframePageLoading, false);
    document.body.innerHTML = '<button>click</button>';
    const button = document.querySelector('button');
    let clicked = false;
    button.addEventListener('click', () => {
      clicked = true;
    });
    button.click();
    assert(clicked);
    const mutation = new Promise(resolve =>
      new global.MutationObserver(resolve).observe(document.body, {
        childList: true,
      }),
    );
    document.body.append(document.createElement('div'));
    await mutation;
    assert.equal(await new global.Response('ok').text(), 'ok');
    const url = global.URL.createObjectURL(new global.Blob(['hello']));
    assert.match(url, /^blob:/);
    global.URL.revokeObjectURL(url);
    await new Promise(resolve => global.setTimeout(resolve, 1));
    global.setTimeout(() => {
      leaked = true;
    }, 30);
    global.setInterval(() => {
      leaked = true;
    }, 30);
  } finally {
    await environment.teardown();
  }
  assert.equal(global.document, undefined);
  if (!vm) assert.equal(target.setTimeout, originalTimeout);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(leaked, false, 'owning teardown cancels pending test timers');
}
console.log(
  'PASS rstest actual setupEnvironment + setupVM: DOM/events/mutations, globals, URL/settings, Response, Blob URLs, timers and teardown',
);
