import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  assertRendererFeatureRow,
  digestFile,
  requiredRendererFeatureRows,
} from './feature-gates.mjs';

/** Retain only the exact runtime files named by a passing feature receipt. */
export function retainFeatureEvidence(receiptPath) {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(
    receipt.schema,
    'bleedingdev.ultramodern.renderer-feature-acceptance',
  );
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.status, 'passed');
  assert.deepEqual(
    Object.keys(receipt.rows).sort(),
    Object.keys(requiredRendererFeatureRows).sort(),
  );
  const root = receipt.evidenceRoot;
  assert.equal(typeof root, 'string');
  assert(path.isAbsolute(root));
  assert.equal(fs.realpathSync(root), path.resolve(root));
  const files = new Map();
  for (const [row, result] of Object.entries(receipt.rows)) {
    assertRendererFeatureRow(row, result, receipt.binding, {
      evidenceRoot: root,
    });
    for (const evidence of result.evidence) {
      const relative = path.relative(root, evidence.path);
      const key = relative.toLowerCase();
      assert(!files.has(key), 'Runtime evidence paths must be distinct');
      files.set(key, { ...evidence, relative });
    }
  }
  const output = path.join(root, 'retained-evidence');
  // Never replace an existing directory, or copy unrelated generated trees.
  fs.mkdirSync(output);
  try {
    for (const evidence of files.values()) {
      const destination = path.join(output, evidence.relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(evidence.path, destination, fs.constants.COPYFILE_EXCL);
      assert.equal(
        digestFile(destination),
        evidence.sha256,
        'Runtime evidence changed while being retained',
      );
    }
    return { output, files: files.size };
  } catch (error) {
    fs.rmSync(output, { recursive: true });
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values } = parseArgs({
    options: { receipt: { type: 'string' } },
  });
  assert(values.receipt, 'Pass --receipt');
  console.log(JSON.stringify(retainFeatureEvidence(values.receipt)));
}
