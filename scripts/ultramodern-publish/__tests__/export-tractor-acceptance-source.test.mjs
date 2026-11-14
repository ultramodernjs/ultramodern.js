import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { exportTractorAcceptanceSource } from '../export-tractor-acceptance-source.mjs';

const node = process.execPath;
const exporter = path.resolve(
  'scripts/ultramodern-publish/export-tractor-acceptance-source.mjs',
);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  assert.ok(process.env.OWNED_TEMP_DIR, 'Run through owned-temp-dir');
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'retention-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'tractor');
  fs.mkdirSync(workspace);
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: workspace,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Retention test');
  git('config', 'user.email', 'retention@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const write = (name, content = 'source\n') => {
    const target = path.join(workspace, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const commit = () => {
    git('add', '-A');
    git('commit', '-m', 'source');
    return git('rev-parse', 'HEAD');
  };
  write('app.js', 'baseline\n');
  const baselineRevision = commit();
  write('app.js', 'accepted\n');
  write('.env.example', 'EXAMPLE=placeholder\n');
  write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
  const applicationSourceRevision = commit();
  const report = {
    status: 'passed',
    mode: 'published',
    tractor: { baselineRevision, applicationSourceRevision },
  };
  const reportPath = path.join(root, 'receipt.json');
  const save = () =>
    fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);
  save();
  const options = { workspace, reportPath, out: path.join(root, 'artifact') };
  return { root, workspace, git, write, commit, report, save, options };
}

test('retains receipt and bounded advertised bundle recoverable over baseline', t => {
  const f = fixture(t);
  // Ignored/uncommitted outputs must never become part of the artifact.
  f.write('.env', 'DO NOT READ');
  f.write('node_modules/ignored.js');
  const metadata = exportTractorAcceptanceSource(f.options);
  const bundle = path.join(f.options.out, 'tractor-source.bundle');
  assert.equal(
    f.git('bundle', 'list-heads', bundle),
    `${f.report.tractor.applicationSourceRevision} HEAD`,
  );
  assert.equal(
    metadata.applicationSourceTree,
    f.git('rev-parse', 'HEAD^{tree}'),
  );
  assert.equal(
    metadata.reportSha256,
    hash(fs.readFileSync(f.options.reportPath)),
  );
  assert.equal(metadata.bundleSha256, hash(fs.readFileSync(bundle)));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.options.out, 'metadata.json'))),
    metadata,
  );
  assert.deepEqual(
    fs.readFileSync(
      path.join(f.options.out, 'tractor-downstream-acceptance.json'),
    ),
    fs.readFileSync(f.options.reportPath),
  );
  const consumer = path.join(f.root, 'consumer');
  fs.mkdirSync(consumer);
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: consumer,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init');
  assert.throws(() => git('bundle', 'verify', bundle), /prerequisite|history/);
  git('fetch', f.workspace, f.report.tractor.baselineRevision);
  git('bundle', 'verify', bundle);
  git('fetch', bundle, 'HEAD:refs/heads/accepted');
  assert.equal(
    git('rev-parse', 'accepted'),
    metadata.applicationSourceRevision,
  );
  assert.equal(git('rev-parse', 'accepted^'), metadata.baselineRevision);
  assert.equal(git('show', 'accepted:app.js'), 'accepted');
  assert.equal(git('show', 'accepted:pnpm-lock.yaml'), 'lockfileVersion: 9');
  assert.throws(() => git('show', 'accepted:.env'));
  assert.throws(
    () => exportTractorAcceptanceSource(f.options),
    /already exists/,
  );
});

for (const change of [
  'failed',
  'source',
  'invalid-sha',
  'tampered-head',
  'extra-commit',
  'unrelated-baseline',
  'empty',
]) {
  test(`rejects ${change} before creating artifacts`, t => {
    const f = fixture(t);
    if (change === 'failed') f.report.status = 'failed';
    if (change === 'source') f.report.mode = 'source';
    if (change === 'invalid-sha') f.report.tractor.baselineRevision = '--all';
    if (change === 'tampered-head')
      f.report.tractor.applicationSourceRevision =
        f.report.tractor.baselineRevision;
    if (change === 'extra-commit') {
      f.write('extra.js');
      f.report.tractor.applicationSourceRevision = f.commit();
    }
    if (change === 'unrelated-baseline')
      f.report.tractor.baselineRevision = 'a'.repeat(40);
    if (change === 'empty')
      f.report.tractor.baselineRevision =
        f.report.tractor.applicationSourceRevision;
    f.save();
    assert.throws(() => exportTractorAcceptanceSource(f.options));
    assert.equal(fs.existsSync(f.options.out), false);
  });
}

for (const name of [
  '.env',
  'apps/a/.env.production',
  'node_modules/x.js',
  '.output/x',
  'dist/x',
  'dist-cloudflare/x',
  '.cache/x',
  '.wrangler/state/x',
  '.data/x',
  'data/orders.db',
  'data/orders.sqlite3-wal',
]) {
  test(`rejects committed forbidden path ${name} without reading its bytes`, t => {
    const f = fixture(t);
    f.git('reset', '--hard', f.report.tractor.baselineRevision);
    f.write(name, 'PRIVATE');
    f.report.tractor.applicationSourceRevision = f.commit();
    f.save();
    const originalRead = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (target, ...args) => {
      assert.notEqual(
        String(target),
        path.join(f.workspace, name),
        'must not read forbidden content',
      );
      return originalRead(target, ...args);
    });
    assert.throws(
      () => exportTractorAcceptanceSource(f.options),
      /Forbidden source snapshot path/,
    );
    assert.equal(fs.existsSync(f.options.out), false);
  });
}

test('refuses output inside source, through symlink, or pre-existing destination', t => {
  const f = fixture(t);
  for (const out of [f.workspace, path.join(f.workspace, 'artifact')]) {
    assert.throws(
      () => exportTractorAcceptanceSource({ ...f.options, out }),
      /outside/,
    );
  }
  const link = path.join(f.root, 'link');
  fs.symlinkSync(f.workspace, link);
  assert.throws(
    () =>
      exportTractorAcceptanceSource({
        ...f.options,
        out: path.join(link, 'artifact'),
      }),
    /outside/,
  );
  fs.mkdirSync(f.options.out);
  fs.writeFileSync(path.join(f.options.out, 'keep'), 'existing');
  assert.throws(
    () => exportTractorAcceptanceSource(f.options),
    /already exists/,
  );
  assert.equal(
    fs.readFileSync(path.join(f.options.out, 'keep'), 'utf8'),
    'existing',
  );
});

test('CLI uses fixed sibling workspace and readiness paths', t => {
  const f = fixture(t);
  const cwd = path.join(f.root, 'modernjs');
  const readiness = path.join(cwd, '.modern/production-readiness');
  fs.mkdirSync(readiness, { recursive: true });
  fs.copyFileSync(
    f.options.reportPath,
    path.join(readiness, 'tractor-downstream-acceptance.json'),
  );
  execFileSync(node, [exporter], { cwd });
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(readiness, 'tractor-source/metadata.json')),
    ).applicationSourceRevision,
    f.report.tractor.applicationSourceRevision,
  );
});
