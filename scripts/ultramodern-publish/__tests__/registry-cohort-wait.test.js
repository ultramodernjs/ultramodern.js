// Consumers: independent ERP-10 and Tractor registry convergence gates.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const script = path.resolve(__dirname, '../wait-for-registry-cohort.sh');
const npmRuntimeUrl = pathToFileURL(
  path.resolve(
    __dirname,
    '../lib/prepare-bleedingdev-packages/npm-buffer-publisher.mjs',
  ),
).href;

for (const explicitIdentity of [false, true]) {
  test(`registry wait keeps the bound Node and npm despite PATH drift (${explicitIdentity ? 'explicit' : 'manifest'} identity)`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-cohort-node-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const manifest = {
      release: { version: '3.9.3-ultramodern.8', tag: 'latest' },
    };
    fs.writeFileSync(
      path.join(root, 'manifest.json'),
      JSON.stringify(manifest),
    );
    const calls = path.join(root, 'calls.jsonl');
    const acceptedBin = path.join(root, 'accepted-bin');
    fs.mkdirSync(acceptedBin);
    // Exercise the real PATH-based npm runtime loader and toolchain guard.
    // Each fake installation supplies only the module metadata the loader
    // needs; neither can publish or contact a registry.
    for (const [bin, npmVersion] of [
      [acceptedBin, '11.20.0'],
      [root, '11.19.1'],
    ]) {
      const globalRoot = path.join(bin, 'global');
      const npmRoot = path.join(globalRoot, 'npm');
      const publisherRoot = path.join(npmRoot, 'node_modules/libnpmpublish');
      fs.mkdirSync(publisherRoot, { recursive: true });
      fs.writeFileSync(
        path.join(npmRoot, 'package.json'),
        JSON.stringify({ version: npmVersion }),
      );
      fs.writeFileSync(
        path.join(publisherRoot, 'package.json'),
        JSON.stringify({ version: '1.0.0', main: 'index.js' }),
      );
      fs.writeFileSync(
        path.join(publisherRoot, 'index.js'),
        'exports.publish = () => { throw new Error("fixture must not publish"); };\n',
      );
      fs.writeFileSync(
        path.join(bin, 'npm'),
        `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(globalRoot)}\n`,
        { mode: 0o755 },
      );
    }
    const pinnedNode = path.join(acceptedBin, 'node');
    fs.writeFileSync(
      pinnedNode,
      `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === '-e') {
  process.exit(spawnSync(process.execPath, args, { stdio: 'inherit' }).status);
}
if (!args[0].endsWith('/prepare-bleedingdev-packages.mjs')) process.exit(87);
import(${JSON.stringify(npmRuntimeUrl)}).then(
  ({ assertAcceptedPublishToolchain, loadNpmPublishingRuntime }) =>
    assertAcceptedPublishToolchain(
      { node: process.version, npm: '11.20.0', pnpm: '12.11.2' },
      loadNpmPublishingRuntime(),
    ),
);
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(root, 'node'), '#!/bin/sh\nexit 86\n', {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(root, 'sleep'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });
    const result = spawnSync(
      'bash',
      [
        script,
        root,
        '8',
        ...(explicitIdentity
          ? [manifest.release.version, manifest.release.tag]
          : []),
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${root}${path.delimiter}${process.env.PATH}`,
          ULTRAMODERN_ACCEPTANCE_NODE: pinnedNode,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const invocations = fs
      .readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(invocations.length, explicitIdentity ? 1 : 3);
    assert.deepEqual(invocations.at(-1), [
      path.resolve(__dirname, '../prepare-bleedingdev-packages.mjs'),
      '--publish-existing',
      '--dry-run',
      '--out',
      root,
      '--version',
      manifest.release.version,
      '--tag',
      manifest.release.tag,
      '--publish-concurrency',
      '8',
    ]);
  });
}

test('registry wait fails closed when the cohort never becomes verifiable', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-cohort-wait-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      release: { version: '3.8.2-ultramodern.9', tag: 'latest' },
    }),
  );
  fs.writeFileSync(
    path.join(root, 'node'),
    `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === '-e') {
  process.exit(spawnSync(process.execPath, args, { stdio: 'inherit' }).status);
}
process.exit(1);
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(root, 'sleep'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });
  const result = spawnSync('bash', [script, root, '8'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${root}${path.delimiter}${process.env.PATH}`,
    },
  });
  assert.equal(result.status, 1);
});
