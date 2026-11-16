import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = process.argv[2];
const require = createRequire(path.join(directory, 'package.json'));
const solid = await import(pathToFileURL(require.resolve('solid-js')));
const web = await import(pathToFileURL(require.resolve('@solidjs/web')));
assert.equal(solid.heldRead(), 0);
assert.equal(typeof web.heldRead, 'function');
assert.throws(() => web.heldRead(), /server|supported|client/iu);
assert.match(
  await new Response(
    web.renderToStream(() => web.ssr('<p>heldRead native SSR</p>')).readable,
  ).text(),
  /heldRead native SSR/u,
);
// A separate process selects the actual browser export instead of Node's SSR mock.
const result = spawnSync(
  process.execPath,
  [
    '--conditions=browser',
    '--input-type=module',
    '-e',
    `
  import assert from 'node:assert/strict';
  import { heldRead, createRoot, createSignal, createMemo } from 'solid-js';
  import { heldRead as webHeldRead } from '@solidjs/web';
  import { heldRead as signalsHeldRead } from '@solidjs/signals';
  assert.equal(heldRead, signalsHeldRead);
  assert.equal(webHeldRead, heldRead);
  createRoot(dispose => {
    const [value] = createSignal(2);
    const memo = createMemo(() => { const current = value(); assert.equal(typeof heldRead(), 'number'); return current; });
    assert.equal(memo(), 2);
    dispose();
  });
`,
  ],
  { cwd: directory, encoding: 'utf8' },
);
assert.equal(result.status, 0, result.stdout + result.stderr);
