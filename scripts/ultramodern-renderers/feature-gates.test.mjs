import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertRendererFeatureRow,
  digestFile,
  requiredRendererFeatureRows,
  verifyRendererFeatureReceipt,
  writeRendererFeatureReceipt,
} from './feature-gates.mjs';

function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-feature-gate-')),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binding = {
    sourceRevision: 'a'.repeat(40),
    releaseVersion: '3.9.3-ultramodern.42',
    manifestSha256: 'b'.repeat(64),
    frameworkCohortDigest: 'c'.repeat(64),
  };
  const rows = Object.fromEntries(
    Object.entries(requiredRendererFeatureRows).map(([row, checks]) => {
      const evidence = path.join(root, `feature-${row}.log`);
      fs.writeFileSync(evidence, 'actual runtime assertions completed\n');
      return [
        row,
        {
          status: 'passed',
          binding,
          evidence: [{ path: evidence, sha256: digestFile(evidence) }],
          checks: Object.fromEntries(checks.map(check => [check, true])),
        },
      ];
    }),
  );
  const acceptanceReceiptPath = path.join(root, 'acceptance.json');
  const runIdentity = 'github:owner/repo:run:1:attempt:1';
  const acceptance = {
    passed: true,
    mode: 'source',
    binding: {
      runIdentity,
      source: { commit: binding.sourceRevision },
      release: { version: binding.releaseVersion },
      manifest: {
        sha256: binding.manifestSha256,
        cohortDigest: binding.frameworkCohortDigest,
      },
    },
  };
  fs.writeFileSync(acceptanceReceiptPath, JSON.stringify(acceptance));
  return {
    root,
    rows,
    binding,
    evidence: rows['dev-refresh'].evidence[0].path,
    acceptance,
    options: {
      rows,
      binding,
      mode: 'source',
      runIdentity,
      evidenceRoot: root,
      registryUrl: 'http://127.0.0.1:4873/',
      acceptanceReceiptPath,
      receiptPath: path.join(root, 'features.json'),
    },
  };
}

test('requires actual evidence and every independently executed feature row', t => {
  const { options } = fixture(t);
  const result = writeRendererFeatureReceipt(options);
  assert.equal(result.status, 'passed');
  assert.equal(
    result.acceptanceReceiptSha256,
    digestFile(options.acceptanceReceiptPath),
  );
  assert.throws(() => writeRendererFeatureReceipt(options), /EEXIST/u);
});

for (const status of ['skipped', 'failed', 'not-run', undefined])
  test(`rejects feature status ${status}`, t => {
    const { rows, binding } = fixture(t);
    rows['dev-refresh'].status = status;
    assert.throws(
      () =>
        assertRendererFeatureRow('dev-refresh', rows['dev-refresh'], binding),
      /did not pass/u,
    );
  });

test('generated Solid strict/browser acceptance is required independently of Worker and HMR', t => {
  const { options } = fixture(t);
  delete options.rows['generated-solid'];
  assert.throws(
    () => writeRendererFeatureReceipt(options),
    /Every renderer feature row/u,
  );
});

test('generated Solid cannot be skipped or omit its strict compilation result', t => {
  const { rows, binding } = fixture(t);
  const solid = rows['generated-solid'];
  solid.status = 'skipped';
  assert.throws(
    () => assertRendererFeatureRow('generated-solid', solid, binding),
    /did not pass/u,
  );
  solid.status = 'passed';
  delete solid.checks.strictGeneratedTypes;
  assert.throws(
    () => assertRendererFeatureRow('generated-solid', solid, binding),
    /did not execute strictGeneratedTypes/u,
  );
});

for (const row of ['prebuilt-worker', 'generated-worker']) {
  test(`${row} is required for release acceptance`, t => {
    const { options } = fixture(t);
    delete options.rows[row];
    assert.throws(
      () => writeRendererFeatureReceipt(options),
      /Every renderer feature row/u,
    );
  });

  test(`${row} must execute cancellation and bounded recovery`, t => {
    const { rows, binding } = fixture(t);
    for (const check of ['cancellation', 'boundedRecovery']) {
      const rowWithoutCheck = {
        ...rows[row],
        checks: { ...rows[row].checks, [check]: false },
      };
      assert.throws(
        () => assertRendererFeatureRow(row, rowWithoutCheck, binding),
        /failed or skipped/u,
      );
    }
  });
}

test('a passed row cannot omit, skip or fail a required runtime assertion', t => {
  const { rows, binding } = fixture(t);
  delete rows['dev-refresh'].checks.noDocumentReload;
  assert.throws(
    () => assertRendererFeatureRow('dev-refresh', rows['dev-refresh'], binding),
    /did not execute noDocumentReload/u,
  );
  rows['dev-refresh'].checks.noDocumentReload = false;
  assert.throws(
    () => assertRendererFeatureRow('dev-refresh', rows['dev-refresh'], binding),
    /failed or skipped/u,
  );
});

test('rejects stale cohort evidence and evidence changed after execution', t => {
  const { rows, binding, evidence } = fixture(t);
  assert.throws(
    () =>
      assertRendererFeatureRow('dev-refresh', rows['dev-refresh'], {
        ...binding,
        sourceRevision: 'd'.repeat(40),
      }),
    /another cohort/u,
  );
  fs.appendFileSync(evidence, 'changed');
  assert.throws(
    () => assertRendererFeatureRow('dev-refresh', rows['dev-refresh'], binding),
    /evidence changed/u,
  );
});

test('rejects missing runtime evidence', t => {
  const { rows, binding } = fixture(t);
  rows['dev-refresh'].evidence = [];
  assert.throws(
    () => assertRendererFeatureRow('dev-refresh', rows['dev-refresh'], binding),
    /no runtime evidence/u,
  );
});

test('binds features to successful ERP acceptance from the exact producer', t => {
  const { options, acceptance } = fixture(t);
  acceptance.binding.runIdentity = 'another-run';
  fs.writeFileSync(options.acceptanceReceiptPath, JSON.stringify(acceptance));
  assert.throws(
    () => writeRendererFeatureReceipt(options),
    /ERP producer run mismatch/u,
  );
});

function publishedFixture(t) {
  const data = fixture(t);
  writeRendererFeatureReceipt(data.options);
  const publishedAcceptancePath = path.join(data.root, 'published-erp.json');
  fs.writeFileSync(
    publishedAcceptancePath,
    JSON.stringify({
      ...data.acceptance,
      mode: 'published',
      registry: { url: 'https://registry.npmjs.org/' },
    }),
  );
  return {
    ...data,
    published: {
      ...data.options,
      mode: 'published',
      registryUrl: 'https://registry.npmjs.org',
      receiptPath: path.join(data.root, 'published-features.json'),
      acceptanceReceiptPath: publishedAcceptancePath,
      sourceFeatureReceiptPath: data.options.receiptPath,
      sourceAcceptanceReceiptPath: data.options.acceptanceReceiptPath,
    },
  };
}

test('published features require actual source ERP and source features plus registry execution', t => {
  const { published } = publishedFixture(t);
  assert.throws(
    () =>
      writeRendererFeatureReceipt({
        ...published,
        sourceFeatureReceiptPath: undefined,
      }),
    /require accepted source features/u,
  );
  const result = writeRendererFeatureReceipt(published);
  assert.equal(result.registryUrl, 'https://registry.npmjs.org/');
  assert.equal(
    result.sourceFeatureReceiptSha256,
    digestFile(published.sourceFeatureReceiptPath),
  );
});

test('published features reject a stale source feature cohort', t => {
  const { published } = publishedFixture(t);
  const source = JSON.parse(
    fs.readFileSync(published.sourceFeatureReceiptPath),
  );
  source.binding.sourceRevision = 'd'.repeat(40);
  fs.writeFileSync(published.sourceFeatureReceiptPath, JSON.stringify(source));
  assert.throws(
    () => writeRendererFeatureReceipt(published),
    /another cohort/u,
  );
});

test('published features reject substituted source ERP receipt bytes', t => {
  const { published } = publishedFixture(t);
  fs.appendFileSync(published.sourceAcceptanceReceiptPath, ' ');
  assert.throws(
    () => writeRendererFeatureReceipt(published),
    /actual ERP receipt bytes/u,
  );
});

test('published runtime registry must match the accepted ERP registry', t => {
  const { published } = publishedFixture(t);
  published.registryUrl = 'https://another.example/';
  assert.throws(
    () => writeRendererFeatureReceipt(published),
    /registry must equal/u,
  );
});

test('downloaded source results require all rows and the actual ERP digest', t => {
  const { options } = fixture(t);
  writeRendererFeatureReceipt(options);
  verifyRendererFeatureReceipt(options);
  const receipt = JSON.parse(fs.readFileSync(options.receiptPath));
  delete receipt.rows['generated-solid'];
  fs.writeFileSync(options.receiptPath, JSON.stringify(receipt));
  assert.throws(
    () => verifyRendererFeatureReceipt(options),
    /Every renderer feature row/u,
  );
});

for (const mutation of ['outside', 'empty', 'cross-row'])
  test(`rejects ${mutation} runtime evidence`, t => {
    const { options, rows, root } = fixture(t);
    const evidence = rows['dev-refresh'].evidence[0];
    if (mutation === 'outside') {
      evidence.path = path.join(root, 'unrelated.log');
      fs.writeFileSync(evidence.path, 'unrelated');
      evidence.sha256 = digestFile(evidence.path);
    } else if (mutation === 'empty') {
      fs.writeFileSync(evidence.path, '');
      evidence.sha256 = digestFile(evidence.path);
    } else rows['generated-solid'].evidence = rows['dev-refresh'].evidence;
    assert.throws(
      () => writeRendererFeatureReceipt(options),
      /distinct feature-row logs|nonempty/u,
    );
  });

test('localized navigation for both native renderers is mandatory independently of HMR and Workers', t => {
  const { options } = fixture(t);
  delete options.rows['localized-navigation'];
  assert.throws(
    () => writeRendererFeatureReceipt(options),
    /Every renderer feature row/u,
  );
});
