// Consumers: independent ERP-10 and Tractor registry convergence gates.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.resolve(__dirname, '../wait-for-registry-cohort.sh');

for (const explicitIdentity of [false, true]) {
  test(`registry wait keeps the bound interpreter despite PATH drift (${explicitIdentity ? 'explicit' : 'manifest'} identity)`, t => {
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
    const pinnedNode = path.join(root, 'accepted-node');
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
process.exit(0);
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
