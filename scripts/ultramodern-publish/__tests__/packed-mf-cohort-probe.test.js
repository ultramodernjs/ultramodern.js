const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('serialized MF cohort probe rejects missing, linked and stale physical identities before API execution', async t => {
  const { packedMfCohortProbeMain } = await import(
    '../packed-mf-cohort-probe.mjs'
  );
  const root = fs.mkdtempSync(
    path.join(
      process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
      'packed-mf-cohort-negative-',
    ),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const directory = path.join(
    root,
    'node_modules/@bleedingdev/mf-bridge-react',
  );
  const run = () =>
    spawnSync(
      process.execPath,
      [
        '--experimental-vm-modules',
        '--input-type=module',
        '--eval',
        `await (${packedMfCohortProbeMain.toString()})();`,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
      },
    );
  let result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT/u);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: '@bleedingdev/mf-bridge-react', version: '2.9.3' }),
  );
  result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cohort drift/u);
  fs.rmSync(directory, { recursive: true });
  const linked = path.join(root, 'linked');
  fs.mkdirSync(linked);
  fs.symlinkSync(linked, directory, 'dir');
  result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /physically installed/u);
  fs.rmSync(directory);
  const { sidecarProfile } = await import('../sidecar-profiles.mjs');
  for (const [name, version] of Object.entries(
    sidecarProfile('mf-cohort').dependencies,
  )) {
    const installed = path.join(root, 'node_modules', name);
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(
      path.join(installed, 'package.json'),
      JSON.stringify({
        name,
        version,
        ...(name === '@bleedingdev/mf-enhanced'
          ? { peerDependencies: { webpack: '^5.112.2' } }
          : {}),
      }),
    );
  }
  result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mf-runtime-core[/\\]dist[/\\]index\.cjs/u);
  const modern = path.join(
    root,
    'node_modules/@bleedingdev/mf-modern-js-v3/package.json',
  );
  const manifest = JSON.parse(fs.readFileSync(modern, 'utf8'));
  assert.equal(manifest.version, '2.9.6');
  fs.writeFileSync(modern, JSON.stringify({ ...manifest, version: '2.9.5' }));
  result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mf-modern-js-v3 cohort drift/u);
});
