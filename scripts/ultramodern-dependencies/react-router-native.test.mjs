import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');
const host = 'examples/module-federation/app-export/host/';

test('the MF host uses native framework routing without a global router alias or unused peer', () => {
  const manifest = JSON.parse(read(`${host}package.json`));
  assert.equal(manifest.dependencies['react-router'], undefined);
  assert.doesNotMatch(read(`${host}modern.config.ts`), /react-router/u);
  assert.match(
    read(`${host}src/routes/layout.tsx`),
    /from ['"]@modern-js\/runtime\/router['"]/u,
  );
  const runtime = JSON.parse(
    read('packages/runtime/plugin-runtime/package.json'),
  );
  assert.equal(runtime.dependencies['react-router'], '8.5.1');
});
