import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

function checkExportTargets(value) {
  if (typeof value === 'string') {
    assert.ok(
      existsSync(resolve(root, value)),
      `missing export target: ${value}`,
    );
    return;
  }
  for (const target of Object.values(value)) checkExportTargets(target);
}

test('preserves every public JavaScript, conditional and declaration entry', () => {
  for (const entry of Object.values(pkg.exports)) checkExportTargets(entry);
});

test('built SSR renders without a global application RSC manifest', async () => {
  const { renderSSRStream } = await import(
    pathToFileURL(resolve(root, pkg.exports['./ssr'].default)).href
  );
  const rootElement = React.createElement('p', null, 'ordinary HTML');
  const stream = await renderSSRStream(rootElement, {
    request: new Request('https://example.test/'),
    rscRoot: rootElement,
  });
  assert.equal(await new Response(stream).text(), '<p>ordinary HTML</p>');
});

test('built Node and edge Flight entries retain their own runtime and the CSR manifest', () => {
  const entry = pkg.exports['./rsc'];
  for (const [condition, runtime] of [
    ['default', 'node'],
    ['workerd', 'edge'],
    ['worker', 'edge'],
    ['edge-light', 'edge'],
  ]) {
    const code = readFileSync(resolve(root, entry[condition]), 'utf8');
    assert.ok(code.includes(`react-server-dom-rspack/server.${runtime}`));
    assert.match(code, /__rspack_rsc_manifest__\?\.entryCssFiles/);
    assert.doesNotMatch(code, /RSPACK_RSC_MANIFEST|\.rscM\b/);
  }
});

for (const condition of ['default', 'workerd']) {
  test(`built ${condition} Flight renderer injects application CSS and real Flight data`, () => {
    // React allows only one RSC renderer per process, with its server condition enabled.
    const result = spawnSync(
      process.execPath,
      [
        '--conditions=react-server',
        '--input-type=module',
        '--eval',
        `
          import assert from 'node:assert/strict';
          import React from 'react';

          globalThis.__rspack_rsc_manifest__ = {
            clientManifest: {},
            serverManifest: {},
            moduleLoading: null,
            entryCssFiles: { index: ['/app.css'] },
          };
          const { renderCSRWithRSC } = await import(process.argv[1]);
          const response = await renderCSRWithRSC({
            html: '<html><head></head><body><div id="root"></div></body></html>',
            rscRoot: React.createElement('p', null, 'real Flight payload'),
          });
          assert.equal(response.status, 200);
          assert.equal(response.headers.get('content-type'), 'text/html; charset=UTF-8');
          const html = await response.text();
          assert.ok(html.includes('<link href="/app.css" rel="stylesheet" /></head>'));
          assert.ok(html.includes('__FLIGHT_DATA'));
          assert.ok(html.includes('real Flight payload'));
          assert.ok(html.endsWith('</body></html>'));
        `,
        pathToFileURL(resolve(root, pkg.exports['./rsc'][condition])).href,
      ],
      { cwd: root, encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(
      result.status,
      0,
      `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`,
    );
  });
}
