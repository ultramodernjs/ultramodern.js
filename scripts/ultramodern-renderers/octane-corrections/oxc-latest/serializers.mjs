import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { assetFilename } from '../../native-artifacts/protocol.mjs';

export async function qualifySerializers({
  root,
  modules,
  installed,
  work,
  run,
  receipt,
  here,
  directory,
}) {
  const request = createRequire(path.join(installed, 'package.json'));
  const core = path.dirname(
    request.resolve('@tanstack/router-core/package.json'),
  );
  const adapter = path.dirname(
    request.resolve('@octanejs/tanstack-router/package.json'),
  );
  assert.equal(
    fs.realpathSync(
      createRequire(path.join(adapter, 'package.json')).resolve(
        '@tanstack/router-core',
      ),
    ),
    fs.realpathSync(request.resolve('@tanstack/router-core')),
  );
  receipt.serializers = {};
  for (const [name, version] of [
    ['seroval', '1.8.1'],
    ['seroval-plugins', '1.8.0'],
  ]) {
    const metadata = await (
      await fetch(`https://registry.npmjs.org/${name}/${version}`)
    ).json();
    const resolved = createRequire(path.join(core, 'package.json')).resolve(
      name === 'seroval' ? name : `${name}/web`,
    );
    const rootResolved = request.resolve(
      name === 'seroval' ? name : `${name}/web`,
    );
    assert.equal(
      fs.realpathSync(resolved),
      fs.realpathSync(rootResolved),
      'Core must use exact root serializer',
    );
    const entries = fs
      .readdirSync(path.join(modules, '.pnpm'))
      .filter(entry => entry.startsWith(`${name}@`));
    assert.equal(entries.length, 1, `Duplicate ${name}: ${entries}`);
    assert(entries[0].startsWith(`${name}@${version}`));
    assert(
      fs
        .readFileSync(path.join(installed, 'pnpm-lock.yaml'), 'utf8')
        .includes(metadata.dist.integrity),
      'Installed lock must authenticate exact serializer release',
    );
    receipt.serializers[name] = { version, integrity: metadata.dist.integrity };
  }
  // Bind all three installed owning payloads, not just the root dependency names.
  receipt.installedPackages = {};
  for (const [name, version] of [
    ['octane', '0.18.0'],
    ['@tanstack/router-core', '1.171.39'],
    ['@octanejs/tanstack-router', '0.3.4'],
  ]) {
    const target =
      name === 'octane'
        ? fs.realpathSync(path.join(modules, 'octane'))
        : name === '@tanstack/router-core'
          ? core
          : adapter;
    const unpacked = path.join(work, `verify-${name.replaceAll('/', '-')}`);
    fs.mkdirSync(unpacked);
    run('tar', [
      '-xzf',
      path.join(directory, assetFilename(name, version)),
      '--strip-components=1',
      '-C',
      unpacked,
    ]);
    const files = fs
      .readdirSync(unpacked, { recursive: true })
      .filter(f => fs.lstatSync(path.join(unpacked, f)).isFile());
    for (const f of files)
      assert.deepEqual(
        fs.readFileSync(path.join(target, f)),
        fs.readFileSync(path.join(unpacked, f)),
        `${name}/${f}`,
      );
    receipt.installedPackages[name] = { files: files.length };
  }
  receipt.gates.push(
    'normal+clean frozen graph: one physical corrected core, one exact seroval1.8.1 and plugins1.8.0; all supplied Octane/core/adapter files match',
  );
  const commit = '6b9fe6d29552270836c511bc9b343d73541f4424';
  const tree = await (
    await fetch(
      `https://api.github.com/repos/TanStack/router/git/trees/${commit}?recursive=1`,
    )
  ).json();
  receipt.owningSerializerTests = { commit, files: {} };
  const names = [
    'routerTestUtils.ts',
    'hydrate.test.ts',
    'hydration-boundary-chunks.test.ts',
  ];
  const bytes = new Map();
  for (const name of names) {
    const relative = `packages/router-core/tests/${name}`;
    const response = await fetch(
      `https://raw.githubusercontent.com/TanStack/router/${commit}/${relative}`,
    );
    assert(response.ok);
    const b = Buffer.from(await response.arrayBuffer());
    const blob = createHash('sha1')
      .update(`blob ${b.length}\0`)
      .update(b)
      .digest('hex');
    assert.equal(
      blob,
      tree.tree.find(entry => entry.path === relative)?.sha,
      'Owning test git blob mismatch',
    );
    bytes.set(name, b);
    receipt.owningSerializerTests.files[name] = createHash('sha256')
      .update(b)
      .digest('hex');
  }
  for (const format of ['esm', 'cjs']) {
    const stage = path.join(root, `serializer-${format}`);
    fs.mkdirSync(stage);
    for (const [name, b] of bytes) {
      const text = b
        .toString()
        .replace(
          /(['"])\.\.\/src(?:\/([^'"]+))?\1/g,
          (_, quote, subpath) =>
            `${quote}${path.join(core, 'dist', format, `${subpath ?? 'index'}.${format === 'esm' ? 'js' : 'cjs'}`)}${quote}`,
        );
      fs.writeFileSync(path.join(stage, name), text);
    }
    const config = path.join(root, `serializer-${format}.config.mjs`);
    fs.writeFileSync(
      config,
      `import{defineConfig}from'vitest/config';export default defineConfig({test:{environment:'jsdom',include:[${JSON.stringify(stage + '/*.test.ts')}],maxWorkers:1}});`,
    );
    run(
      process.execPath,
      [path.join(modules, 'vitest/vitest.mjs'), 'run', '--config', config],
      root,
    );
    receipt.gates.push(
      `unchanged owning router-core hydrate + hydration-boundary-chunks whole suites against actual ${format} package; real Seroval dehydration/bootstrap evaluation`,
    );
  }
  // A real Octane DOM hydrate after the router's actual emitted Seroval payload is evaluated.
  const probe = path.join(
    root,
    'packages/octane/tests/hydration/latest-seroval-roundtrip.test.ts',
  );
  fs.copyFileSync(path.join(here, 'serializer-roundtrip.test.ts.txt'), probe);
  const { qualifyRuntimeTree } = await import('../qualify-runtime.mjs');
  qualifyRuntimeTree(
    root,
    modules,
    fs.realpathSync(path.join(modules, 'octane')),
    run,
    {
      suites: [
        'packages/octane/tests/hydration/latest-seroval-roundtrip.test.ts',
      ],
    },
  );
  receipt.payloadEvidence = JSON.parse(
    fs.readFileSync(path.join(root, 'serializer-payload-evidence.json')),
  );
  assert.deepEqual(Object.keys(receipt.payloadEvidence).sort(), [
    'routerBootstrap',
    'webReadableStream',
  ]);
  for (const format of ['module', 'commonjs']) {
    const probe =
      format === 'module'
        ? "import * as server from 'octane/server';"
        : "const server = require('octane/server');";
    run(
      process.execPath,
      [
        '--input-type=' + format,
        '-e',
        probe +
          `const assert=${format === 'module' ? "(await import('node:assert/strict')).default" : "require('node:assert/strict')"};const out=server.renderToStaticMarkup(()=>server.createElement('p',{children:'café☕'}),{});assert(out.html.includes('café☕'));console.log('ACTUAL OCTANE SSR '+${JSON.stringify(format)}+' PASS');`,
      ],
      installed,
    );
  }
  receipt.gates.push('actual Octane public ESM+CJS SSR Unicode rendering');
  receipt.gates.push(
    'actual packed Octane SSR -> emitted Seroval payload bytes -> router hydrate -> Octane DOM adoption; rich cyclic loader values, escaped script text, web-stream plugin',
  );
}
