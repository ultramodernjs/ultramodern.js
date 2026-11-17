import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import yaml from '../../packages/toolkit/utils/compiled/js-yaml/index.js';
import { digestFile, requiredRendererFeatureRows } from './feature-gates.mjs';
import { retainFeatureEvidence } from './retain-feature-evidence.mjs';

function fixture(t) {
  assert(process.env.OWNED_TEMP_DIR, 'Run through owned-temp-dir');
  const workRoot = fs.mkdtempSync(
    path.join(
      fs.realpathSync(process.env.OWNED_TEMP_DIR),
      'renderer-features-',
    ),
  );
  const root = path.join(workRoot, 'logs');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(workRoot, { recursive: true }));
  const binding = { releaseVersion: 'test-cohort' };
  const rows = Object.fromEntries(
    Object.entries(requiredRendererFeatureRows).map(([row, checks]) => {
      const directory = path.join(root, `feature-${row}.proof`);
      fs.mkdirSync(directory);
      const evidence = [
        'proof.json',
        'workspace.yaml',
        'source.ts',
        'run.log',
      ].map(name => {
        const file = path.join(directory, name);
        fs.writeFileSync(file, `actual ${row}/${name}\n`);
        return { path: file, sha256: digestFile(file) };
      });
      return [
        row,
        {
          status: 'passed',
          binding,
          evidence,
          checks: Object.fromEntries(checks.map(check => [check, true])),
        },
      ];
    }),
  );
  fs.writeFileSync(path.join(root, 'unreferenced.env'), 'must not be copied');
  const receipt = {
    schema: 'bleedingdev.ultramodern.renderer-feature-acceptance',
    schemaVersion: 1,
    status: 'passed',
    evidenceRoot: root,
    binding,
    rows,
  };
  const receiptPath = path.join(root, 'receipt.json');
  const write = () => fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  write();
  return { root, workRoot, receipt, receiptPath, write };
}

test('retains every referenced extension and no unrelated files', t => {
  const { root, receipt, receiptPath } = fixture(t);
  const result = retainFeatureEvidence(receiptPath);
  assert.equal(result.files, 20);
  for (const row of Object.values(receipt.rows))
    for (const evidence of row.evidence)
      assert.equal(
        digestFile(
          path.join(result.output, path.relative(root, evidence.path)),
        ),
        evidence.sha256,
      );
  assert(!fs.existsSync(path.join(result.output, 'unreferenced.env')));
  assert.throws(() => retainFeatureEvidence(receiptPath), /EEXIST/u);
});

// Only the published lane retains: the source lane emits rows, uploads its
// whole fixed logs root, and `seal` re-digests that evidence in place.
for (const [workflow, job] of [
  ['accept-bleedingdev-release', 'accept-published'],
])
  test(`${workflow} upload includes every real retained file under the renderer logs root`, t => {
    const { workRoot, receiptPath } = fixture(t);
    const result = retainFeatureEvidence(receiptPath);
    const source = yaml.load(
      fs.readFileSync(
        new URL(`../../.github/workflows/${workflow}.yml`, import.meta.url),
        'utf8',
      ),
    );
    const upload = source.jobs[job].steps.find(
      step => step.name === 'Preserve renderer feature runtime evidence',
    );
    const selected = new Set(
      upload.with.path
        .trim()
        .split('\n')
        .flatMap(pattern =>
          [
            ...fs.globSync(
              pattern.replace('${{ runner.temp }}', path.dirname(workRoot)),
            ),
          ].filter(file => fs.statSync(file).isFile()),
        ),
    );
    const retained = [...fs.globSync(`${result.output}/**/*`)].filter(file =>
      fs.statSync(file).isFile(),
    );
    assert.equal(retained.length, 20);
    assert.deepEqual(
      retained.filter(file => !selected.has(file)),
      [],
      'Upload must retain every receipt-referenced byte, not only log files',
    );
    assert(![...selected].some(file => file.endsWith('.env')));
  });

for (const failure of ['missing', 'changed', 'symlink', 'outside', 'skipped'])
  test(`fails closed before creating output for ${failure} evidence`, t => {
    const { root, receipt, receiptPath, write } = fixture(t);
    const row = receipt.rows['dev-refresh'];
    const evidence = row.evidence[0];
    if (failure === 'missing') fs.unlinkSync(evidence.path);
    if (failure === 'changed') fs.appendFileSync(evidence.path, 'changed');
    if (failure === 'symlink') {
      fs.unlinkSync(evidence.path);
      fs.symlinkSync(row.evidence[1].path, evidence.path);
    }
    if (failure === 'outside') evidence.path = path.join(root, '..', 'outside');
    if (failure === 'skipped') row.status = 'skipped';
    write();
    assert.throws(() => retainFeatureEvidence(receiptPath));
    assert(!fs.existsSync(path.join(root, 'retained-evidence')));
  });
