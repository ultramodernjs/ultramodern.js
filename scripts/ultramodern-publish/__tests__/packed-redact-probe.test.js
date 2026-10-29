// Consumer: clean installed Redact qualification; these tests cover what the probe rejects.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const marker = '// ultramodern-redact-patch: v1';

async function probeSource() {
  const { packedRedactProbeMain } = await import('../packed-redact-probe.mjs');
  return `await (${packedRedactProbeMain.toString()})();\n`;
}

function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(
      path.join(
        process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
        'packed-redact-probe-test-',
      ),
    ),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'consumer');
  fs.mkdirSync(workspace);
  fs.writeFileSync(
    path.join(workspace, 'package.json'),
    '{"private":true,"type":"module"}\n',
  );
  return { root, workspace };
}

// The smallest package shape the probe reads, with a configurable id format.
function packageFixture(
  directory,
  { firstLine = marker, ids = ['_R_1_', '_R_2_'] } = {},
) {
  fs.mkdirSync(path.join(directory, 'dist/server'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: '@bleedingdev/tanstack-redact',
      version: '0.2.1',
      type: 'module',
      exports: {
        '.': './index.js',
        './jsx-runtime': './index.js',
        './server': './index.js',
      },
    }),
  );
  fs.writeFileSync(
    path.join(directory, 'dist/server/stream.js'),
    `${firstLine}\nexport {};\n`,
  );
  fs.writeFileSync(
    path.join(directory, 'index.js'),
    `export const Suspense = 'suspense';
export const useId = () => '';
export const jsx = () => null;
export const renderToString = () =>
  '<table><tbody><tr><td>${ids.map(id => `<label for="${id}" id="${id}">field</label>`).join('')}</td></tr></tbody></table>';
export const renderToReadableStream = async () => new Response('<p>streamed</p>').body;
`,
  );
}

function runProbe(workspace, source) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', source],
    {
      cwd: workspace,
      env,
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
}

const installed = workspace =>
  path.join(workspace, 'node_modules/@bleedingdev/tanstack-redact');

test('the exported function serializes into a standalone module', async t => {
  const { workspace } = fixture(t);
  const source = await probeSource();
  const checked = spawnSync(
    process.execPath,
    ['--input-type=module', '--check'],
    { cwd: workspace, input: source, encoding: 'utf8', timeout: 5_000 },
  );
  assert.equal(checked.status, 0, checked.stderr);
  const result = runProbe(workspace, source);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /ENOENT/u);
  assert.doesNotMatch(result.stderr, /packedRedactProbeMain is not defined/u);
});

test('an install without the reviewed patch marker fails', async t => {
  const { workspace } = fixture(t);
  packageFixture(installed(workspace), {
    firstLine: 'import { isThenable } from "../core/functions.js";',
  });
  const result = runProbe(workspace, await probeSource());
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /ultramodern-redact-patch: v1/u);
});

test('upstream useId output fails even when the marker is present', async t => {
  const { workspace } = fixture(t);
  packageFixture(installed(workspace), { ids: [':R0', ':R1'] });
  const result = runProbe(workspace, await probeSource());
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /_R_\[0-9a-z\]\+_/u);
});

test('an upstream @tanstack/redact install cannot sit beside the sidecar', async t => {
  const { workspace } = fixture(t);
  packageFixture(installed(workspace));
  packageFixture(path.join(workspace, 'node_modules/@tanstack/redact'));
  const result = runProbe(workspace, await probeSource());
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Upstream Redact must not satisfy/u);
});

test('a linked external Redact cannot satisfy clean installed qualification', async t => {
  const { root, workspace } = fixture(t);
  const external = path.join(root, 'external-redact');
  packageFixture(external);
  fs.mkdirSync(path.dirname(installed(workspace)), { recursive: true });
  fs.symlinkSync(external, installed(workspace));
  const result = runProbe(workspace, await probeSource());
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /escaped the clean installed workspace/u);
});

test('the reconstructed sidecar passes the probe', async t => {
  const { verifySidecar } = await import(
    '../../ultramodern-supply/verify-sidecars.mjs'
  );
  const { workspace } = fixture(t);
  await verifySidecar('tanstack-redact', {
    materializeTo: installed(workspace),
  });
  const result = runProbe(workspace, await probeSource());
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(receipt.probe, 'redact-sidecar');
  assert.equal(receipt.marker, marker);
  for (const id of receipt.ids) assert.match(id, /^_R_[0-9a-z]+_$/u);
});
