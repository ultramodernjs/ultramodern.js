import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { references } from '../octane-corrections/inputs.mjs';
import { installRouterRenderSnapshot } from '../octane-corrections/qualify.mjs';

test('adapter installs the digest-pinned source bytes under the original upstream filename', t => {
  assert(process.env.OWNED_TEMP_DIR, 'Use owned-temp-dir');
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'snapshot-input-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const here = path.join(root, 'inputs');
  const sourcePackage = path.join(root, 'package');
  fs.mkdirSync(here);
  fs.mkdirSync(path.join(sourcePackage, 'src/ssr'), { recursive: true });
  const original = fs.readFileSync(
    new URL(
      '../octane-corrections/routerRenderSnapshot.ts.txt',
      import.meta.url,
    ),
  );
  assert.equal(
    createHash('sha256').update(original).digest('hex'),
    references.snapshotSourceSha256,
  );
  const input = path.join(here, 'routerRenderSnapshot.ts.txt');
  const output = path.join(sourcePackage, 'src/ssr/routerRenderSnapshot.ts');
  fs.writeFileSync(input, original);
  installRouterRenderSnapshot({ here, sourcePackage });
  assert.deepEqual(fs.readFileSync(output), original);
  assert.deepEqual(fs.readdirSync(path.dirname(output)), [
    'routerRenderSnapshot.ts',
  ]);

  fs.unlinkSync(output);
  fs.writeFileSync(input, Buffer.concat([original, Buffer.from('\n')]));
  assert.throws(
    () => installRouterRenderSnapshot({ here, sourcePackage }),
    /Immutable router snapshot payload differs/,
  );
  assert.equal(fs.existsSync(output), false);
});
