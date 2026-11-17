import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { packFiles } from '../../ultramodern-artifacts/reconstruct.mjs';
import { releaseBody } from '../../ultramodern-artifacts/transport.mjs';
import {
  inputs,
  inspectSupportTarball,
  supportProtocol as p,
} from '../../ultramodern-support-artifacts/protocol.mjs';
import { releaseRecipe } from '../../ultramodern-support-artifacts/recipes.mjs';
import { reconstruct } from '../../ultramodern-support-artifacts/reconstruct.mjs';
import { inspectNpmTarball } from '../lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import {
  parseSupportConsumerArgs,
  verifySupportConsumer,
} from '../verify-support-consumer.mjs';

// SYNTHETIC GitHub evidence and installed layout, NOT hosted/normal-install or
// strict-policy acceptance. Actual authenticated pinned npm bytes + reviewed
// patches; no fake pins, package execution, installs, or qualification callbacks.
let directory;
let canonical;
const actualUpstream = new Map();
// The admission seam requires an owned scratch root in OWNED_TEMP_DIR. This
// suite creates its own under the OS temp dir and restores the caller's env.
const callerOwnedTempDir = process.env.OWNED_TEMP_DIR;
const upstreamContracts = [
  {
    name: 'terser',
    version: '5.51.2',
    request: 'https://registry.npmjs.org/terser/-/terser-5.51.2.tgz',
    integrity:
      'sha512-bWnjSNscmuI+GJze6ZupnHP8G/cTcsJF+bXCeQknk2SHQsgbNJnLrqiH9jZ2W4STPVXH2mDKKRX3iwPhc9Cn/Q==',
  },
  {
    name: '@solidjs/web',
    version: '2.0.0-rc.22',
    request: 'https://registry.npmjs.org/@solidjs/web/-/web-2.0.0-rc.22.tgz',
    integrity:
      'sha512-m2HvRD0jqes659bGjuCtXVbz4TChP0aO4lRLmbRYgEbmCnh7UUPI564jgbq/b4mbcp0gVwHDmi7uoSGeLaUuZA==',
  },
  {
    name: '@rstest/adapter-rsbuild',
    version: '0.12.6',
    request:
      'https://registry.npmjs.org/@rstest/adapter-rsbuild/-/adapter-rsbuild-0.12.6.tgz',
    integrity:
      'sha512-Dj4i3h8ttF3Aq8U+ZotlNMK0Od4CN7SUJyHkQvwnjBP3Q/czGmgS1fDN5jlwFqDgkUTrpkQAjrhhi/m7fD4H7w==',
  },
];
const upstream = new Map();
const producer = {
  repository: p.repository,
  repositoryId: p.repositoryId,
  workflow: p.workflow,
  source: 'a'.repeat(40),
  runId: 123,
  runAttempt: 2,
  tag: `support-artifacts-${'a'.repeat(40)}-123-2`,
};
async function npmFetch(url) {
  assert(
    Object.values(inputs).some(input => input.upstream.request === url),
    `Unexpected npm URL ${url}`,
  );
  if (!upstream.has(url)) {
    const response = await fetch(url);
    assert(response.ok);
    upstream.set(url, Buffer.from(await response.arrayBuffer()));
  }
  return new Response(upstream.get(url));
}
before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-support-'));
  process.env.OWNED_TEMP_DIR = directory;
  canonical = await reconstruct({
    recipe: releaseRecipe(),
    producer,
    directory: path.join(directory, 'canonical'),
    fetchArtifact: npmFetch,
  });
  for (const input of upstreamContracts) {
    const response = await fetch(input.request);
    assert(response.ok);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(p.integrity(bytes), input.integrity);
    const packed = inspectNpmTarball(bytes);
    assert.equal(packed.packageJson.name, input.name);
    assert.equal(packed.packageJson.version, input.version);
    actualUpstream.set(input.name, packed);
  }
});
after(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  if (callerOwnedTempDir === undefined) delete process.env.OWNED_TEMP_DIR;
  else process.env.OWNED_TEMP_DIR = callerOwnedTempDir;
});
function writeManifest(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
}
function unpack(bytes, dir) {
  const packed = inspectSupportTarball(bytes);
  for (const file of packed.files) {
    const absolute = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, packed.fileContents.get(file.path), {
      mode: file.mode & 0o777,
    });
    fs.chmodSync(absolute, file.mode & 0o777);
  }
}
function fixture(selected = ['solid-js']) {
  const root = fs.mkdtempSync(path.join(directory, 'consumer-'));
  const manifest = structuredClone(canonical);
  const payloads = new Map(
    Object.entries(p.cohort).map(([name, version]) => {
      const filename = p.assetFilename(name, version);
      return [
        filename,
        fs.readFileSync(path.join(directory, 'canonical', filename)),
      ];
    }),
  );
  const f = { root, manifest, payloads };
  f.seal = () => {
    f.descriptor = p.descriptorFor(manifest);
    payloads.set(p.manifestFilename, p.manifestBytes(manifest));
    f.release = {
      tag_name: producer.tag,
      target_commitish: producer.source,
      draft: false,
      prerelease: false,
      html_url: `https://github.com/${p.repository}/releases/tag/${producer.tag}`,
      body: releaseBody({ protocol: p, descriptor: f.descriptor }),
      assets: [...payloads].map(([name, bytes], index) => ({
        id: index + 1,
        name,
        state: 'uploaded',
        digest: `sha256:${p.sha256(bytes)}`,
        browser_download_url: p.releaseUrl(producer, name),
      })),
    };
  };
  f.seal();
  f.rootManifest = {
    name: '@synthetic/consumer',
    version: '1.0.0',
    ultramodern: { supportArtifacts: f.descriptor },
    devDependencies: Object.fromEntries(
      selected.map(name => [name, f.descriptor.packages[name].request]),
    ),
  };
  f.save = () => writeManifest(root, f.rootManifest);
  f.save();
  for (const name of selected)
    unpack(
      payloads.get(p.assetFilename(name, p.cohort[name])),
      path.join(root, 'node_modules', name),
    );
  const repo = { id: p.repositoryId, full_name: p.repository };
  f.readGithub = async route => {
    const base = `/repos/${p.repository}`;
    const routes = new Map([
      [`/repositories/${p.repositoryId}`, repo],
      [
        `${base}/actions/runs/123/attempts/2`,
        {
          id: 123,
          run_attempt: 2,
          repository: repo,
          head_repository: repo,
          head_sha: producer.source,
          path: p.workflow,
          event: 'workflow_dispatch',
          head_branch: 'main-ultramodern',
          actor: { login: 'BleedingDev' },
          triggering_actor: { login: 'BleedingDev' },
          status: 'completed',
          conclusion: 'success',
        },
      ],
      [
        `${base}/actions/runs/123/attempts/2/jobs?per_page=100`,
        {
          total_count: 2,
          jobs: ['produce', 'qualify'].map(name => ({
            name,
            head_sha: producer.source,
            status: 'completed',
            conclusion: 'success',
          })),
        },
      ],
      [
        `${base}/git/ref/tags/${producer.tag}`,
        {
          ref: `refs/tags/${producer.tag}`,
          object: { type: 'commit', sha: producer.source },
        },
      ],
      [`${base}/releases/tags/${producer.tag}`, f.release],
    ]);
    assert(routes.has(route), `Unexpected synthetic GitHub route ${route}`);
    return routes.get(route);
  };
  f.fetchArtifact = async url => {
    if (url.startsWith('https://registry.npmjs.org/')) return npmFetch(url);
    const item = [...payloads].find(
      ([name]) => p.releaseUrl(producer, name) === url,
    );
    return new Response(item?.[1] ?? 'missing', { status: item ? 200 : 404 });
  };
  f.framework = (name, peers, extra = {}) => {
    const dir = path.join(root, 'node_modules', name);
    writeManifest(dir, {
      name,
      version: '1.0.0',
      exports: { '.': './entry.cjs' },
      ultramodern: { supportArtifacts: f.descriptor },
      peerDependencies: peers,
      ...extra,
    });
    // If this module were executed, every passing fixture would fail.
    fs.writeFileSync(
      path.join(dir, 'entry.cjs'),
      'throw new Error("UNTRUSTED RUNTIME EXECUTED");',
    );
    f.rootManifest.dependencies ??= {};
    f.rootManifest.dependencies[name] = '1.0.0';
    f.save();
    return dir;
  };
  return f;
}

test('one selected runtime: real full archive bytes and physical owner peer; immutable static receipt', async () => {
  const f = fixture();
  const owner = f.framework('@synthetic/renderer', {
    'solid-js': p.cohort['solid-js'],
  });
  const receipt = await verifySupportConsumer(f);
  assert.deepEqual(receipt.selectedPackages, ['solid-js']);
  assert.equal(
    receipt.packages[0].files,
    inspectSupportTarball(
      f.payloads.get(p.assetFilename('solid-js', p.cohort['solid-js'])),
    ).fileCount,
  );
  assert.equal(
    receipt.packages[0].directory,
    fs.realpathSync(path.join(f.root, 'node_modules/solid-js')),
  );
  assert(
    receipt.resolutions.some(
      item => item.owner === owner && item.name === 'solid-js',
    ),
  );
  assert(Object.isFrozen(receipt.packages[0]));
  // Same actual installed control, changed in place only in this owned fixture.
  const runtime = path.join(f.root, 'node_modules/solid-js/dist/server.js');
  const file = fs.existsSync(runtime)
    ? runtime
    : path.join(f.root, 'node_modules/solid-js/package.json');
  fs.appendFileSync(file, '\n ');
  await assert.rejects(verifySupportConsumer(f), /installed bytes differ/);
});
test('the complete cohort or dev-only tools do not force public Redis/rstest peers', async () => {
  const f = fixture(Object.keys(p.cohort));
  f.framework(
    '@synthetic/renderer',
    { 'solid-js': p.cohort['solid-js'] },
    {
      devDependencies: {
        '@rstest/core': p.cohort['@rstest/core'],
        'ioredis-mock': p.cohort['ioredis-mock'],
      },
    },
  );
  f.framework(
    '@synthetic/bff',
    { '@effect/opentelemetry': p.cohort['@effect/opentelemetry'] },
    { peerDependenciesMeta: { '@effect/opentelemetry': { optional: true } } },
  );
  const compiler = f.framework('@synthetic/compiler', {
    'rsbuild-plugin-dts': p.cohort['rsbuild-plugin-dts'],
  });
  const receipt = await verifySupportConsumer(f);
  assert.deepEqual(
    receipt.packages.map(item => item.name).sort(),
    Object.keys(p.cohort).sort(),
  );
  assert(
    receipt.resolutions.some(
      item => item.name === 'rsbuild-plugin-dts' && item.owner === compiler,
    ),
  );
  assert(
    receipt.packages
      .find(item => item.name === '@types/ioredis-mock')
      .entry.endsWith('package.json'),
  );
  assert(
    receipt.resolutions.some(
      item =>
        item.name === '@effect/opentelemetry' && item.owner.endsWith('/bff'),
    ),
  );
  const tools = fixture([
    '@rstest/core',
    'ioredis-mock',
    '@types/ioredis-mock',
    'rsbuild-plugin-dts',
  ]);
  assert.deepEqual(
    (await verifySupportConsumer(tools)).packages.map(item => item.name).sort(),
    [
      '@rstest/core',
      '@types/ioredis-mock',
      'ioredis-mock',
      'rsbuild-plugin-dts',
    ],
  );
});
test('correct bytes in a private duplicate still reject physical peer mismatch', async () => {
  const f = fixture();
  const owner = f.framework('@synthetic/renderer', {
    'solid-js': p.cohort['solid-js'],
  });
  await verifySupportConsumer(f);
  unpack(
    f.payloads.get(p.assetFilename('solid-js', p.cohort['solid-js'])),
    path.join(owner, 'node_modules/solid-js'),
  );
  await assert.rejects(verifySupportConsumer(f), /wrong physical peer/);
});
for (const [label, mutate, pattern] of [
  [
    'missing descriptor',
    f => {
      delete f.descriptor;
    },
    /descriptor required/,
  ],
  [
    'uninstalled',
    f =>
      fs.rmSync(path.join(f.root, 'node_modules/solid-js'), {
        recursive: true,
      }),
    /Cannot find module/,
  ],
  [
    'wrong root URL',
    f => {
      f.rootManifest.devDependencies['solid-js'] = 'https://evil.invalid/a.tgz';
      f.save();
    },
    /differs from support request/,
  ],
  [
    'root semver projection',
    f => {
      f.rootManifest.devDependencies['solid-js'] = p.cohort['solid-js'];
      f.save();
    },
    /differs from support request/,
  ],
  [
    'missing owner descriptor',
    f => {
      f.framework(
        '@synthetic/renderer',
        { 'solid-js': p.cohort['solid-js'] },
        { ultramodern: { sourceName: '@modern-js/renderer-solid' } },
      );
    },
    /exact support descriptor/,
  ],
  [
    'wrong owner peer',
    f => {
      f.framework('@synthetic/renderer', { 'solid-js': '99.0.0' });
    },
    /wrong framework peer/,
  ],
  [
    'private correction dependency',
    f => {
      f.framework(
        '@synthetic/renderer',
        {},
        {
          dependencies: {
            'solid-js': f.descriptor.packages['solid-js'].request,
          },
        },
      );
    },
    /private correction dependency/,
  ],
  [
    'missing optional OTel host',
    f => {
      f.framework(
        '@synthetic/bff',
        { '@effect/opentelemetry': p.cohort['@effect/opentelemetry'] },
        {
          peerDependenciesMeta: { '@effect/opentelemetry': { optional: true } },
        },
      );
    },
    /requires a selected direct host/,
  ],
  [
    'extra file',
    f =>
      fs.writeFileSync(path.join(f.root, 'node_modules/solid-js/extra.js'), ''),
    /unexpected installed file/,
  ],
  [
    'mode change',
    f =>
      fs.chmodSync(
        path.join(f.root, 'node_modules/solid-js/package.json'),
        0o600,
      ),
    /mode differs/,
  ],
  [
    'exports mutation',
    f => {
      const file = path.join(f.root, 'node_modules/solid-js/package.json');
      const m = JSON.parse(fs.readFileSync(file));
      m.exports['./evil'] = './dist/server.js';
      fs.writeFileSync(file, JSON.stringify(m));
    },
    /installed bytes differ/,
  ],
  [
    'unknown selection',
    f => {
      f.selectedPackages = ['react'];
    },
    /Unknown selected/,
  ],
  [
    'duplicate selection',
    f => {
      f.selectedPackages = ['solid-js', 'solid-js'];
    },
    /Duplicate selected/,
  ],
  [
    'empty selection',
    f => {
      f.selectedPackages = [];
    },
    /Nonempty selected/,
  ],
  [
    'wrong GitHub SHA256',
    f => {
      f.release.assets.find(
        a => a.name === p.assetFilename('solid-js', p.cohort['solid-js']),
      ).digest = `sha256:${'0'.repeat(64)}`;
    },
    /GitHub asset digest mismatch/,
  ],
  [
    'wrong descriptor URL',
    f => {
      f.descriptor.packages['solid-js'].request =
        'https://evil.invalid/archive.tgz';
    },
    /./,
  ],
])
  test(`rejects ${label}`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(verifySupportConsumer(f), pattern);
  });
test('explicit selected names cannot skip another actual direct support input', async () => {
  const f = fixture(['solid-js', '@rstest/core']);
  f.selectedPackages = ['solid-js'];
  await assert.rejects(verifySupportConsumer(f), /omit actual direct/);
});
test('transport SHA512 and canonical tar controls cannot be replaced by matching installed bytes', async () => {
  const f = fixture();
  const filename = p.assetFilename('solid-js', p.cohort['solid-js']);
  f.payloads.set(filename, Buffer.from('corrupt'));
  await assert.rejects(verifySupportConsumer(f), /SHA512 mismatch/);
  const g = fixture();
  const archive = inspectSupportTarball(g.payloads.get(filename));
  const files = new Map(
    archive.files.map(file => [
      file.path,
      { bytes: archive.fileContents.get(file.path), mode: file.mode },
    ]),
  );
  files.set('extra.js', { bytes: Buffer.from('evil'), mode: 0o644 });
  const bytes = packFiles(files);
  g.payloads.set(filename, bytes);
  g.manifest.packages['solid-js'].integrity = p.integrity(bytes);
  g.seal();
  g.rootManifest.ultramodern.supportArtifacts = g.descriptor;
  g.save();
  unpack(bytes, path.join(g.root, 'node_modules/solid-js'));
  await assert.rejects(verifySupportConsumer(g), /tar bytes mismatch/);
});
test('CLI requires root/descriptor and exposes no policy override/skip', () => {
  assert.deepEqual(
    parseSupportConsumerArgs([
      '--root',
      '/consumer',
      '--descriptor',
      '/descriptor.json',
      '--select',
      'solid-js,@rstest/core',
    ]),
    {
      root: '/consumer',
      descriptorPath: '/descriptor.json',
      selectedPackages: ['solid-js', '@rstest/core'],
    },
  );
  for (const argv of [
    [],
    ['--root', '/a'],
    ['--root', '/a', '--descriptor', '/b', '--skip', 'solid-js'],
    ['--root', '/a', '--root', '/b'],
    ['--root=/a'],
  ])
    assert.throws(() => parseSupportConsumerArgs(argv));
});

test('follows public framework aliases and import-only intermediates, not dependency-history guesses', async () => {
  const f = fixture();
  const renderer = f.framework('@synthetic/renderer', {
    'solid-js': p.cohort['solid-js'],
  });
  delete f.rootManifest.dependencies['@synthetic/renderer'];
  f.rootManifest.dependencies.alias = 'npm:@synthetic/renderer@1.0.0';
  fs.symlinkSync(renderer, path.join(f.root, 'node_modules/alias'));
  const importer = path.join(f.root, 'node_modules/import-only');
  writeManifest(importer, {
    name: 'import-only',
    version: '1.0.0',
    exports: { '.': { import: './entry.mjs' } },
    dependencies: { alias: 'npm:@synthetic/renderer@1.0.0' },
  });
  fs.writeFileSync(
    path.join(importer, 'entry.mjs'),
    'throw new Error("DO NOT EXECUTE");',
  );
  f.rootManifest.dependencies['import-only'] = '1.0.0';
  f.save();
  const receipt = await verifySupportConsumer(f);
  assert(receipt.owners.some(owner => owner.directory === renderer));
});
for (const [request, catalog] of [
  ['catalog:', 'catalog'],
  ['catalog:ultramodern', 'catalogs:\n  ultramodern'],
]) {
  test(`resolves renamed installed framework owners through ${request}`, async () => {
    const f = fixture();
    const target = '@bleedingdev/modern-js-app-tools';
    const renderer = f.framework(
      target,
      {
        'solid-js': p.cohort['solid-js'],
      },
      request === 'catalog:ultramodern'
        ? { exports: { '.': { import: './entry.cjs' } } }
        : {},
    );
    delete f.rootManifest.dependencies[target];
    f.rootManifest.dependencies['@modern-js/app-tools'] = request;
    fs.mkdirSync(path.join(f.root, 'node_modules/@modern-js'), {
      recursive: true,
    });
    fs.symlinkSync(
      renderer,
      path.join(f.root, 'node_modules/@modern-js/app-tools'),
    );
    const workspaceFile = path.join(f.root, 'pnpm-workspace.yaml');
    const indent = request === 'catalog:' ? '  ' : '    ';
    fs.writeFileSync(
      workspaceFile,
      `${catalog}:\n${indent}'@modern-js/app-tools': npm:${target}@1.0.0\n`,
    );
    f.save();
    const receipt = await verifySupportConsumer(f);
    assert(receipt.owners.some(owner => owner.directory === renderer));
    fs.writeFileSync(
      workspaceFile,
      `${catalog}:\n${indent}'@modern-js/app-tools': npm:@unreviewed/other@1.0.0\n`,
    );
    await assert.rejects(verifySupportConsumer(f), /Wrong owning manifest/);
    fs.writeFileSync(workspaceFile, `${catalog}: {}\n`);
    await assert.rejects(
      verifySupportConsumer(f),
      /catalog .* omits @modern-js\/app-tools/u,
    );
  });
}
test('catalog resolution cannot replace exact direct support authority', async () => {
  const f = fixture();
  f.rootManifest.devDependencies['solid-js'] = 'catalog:';
  f.save();
  fs.writeFileSync(
    path.join(f.root, 'pnpm-workspace.yaml'),
    `catalog:\n  solid-js: ${f.descriptor.packages['solid-js'].request}\n`,
  );
  await assert.rejects(
    verifySupportConsumer(f),
    /differs from support request/,
  );
});
test('workspace catalog changes during transport invalidate the receipt', async () => {
  const f = fixture();
  const target = '@synthetic/renderer';
  f.framework(target, { 'solid-js': p.cohort['solid-js'] });
  f.rootManifest.dependencies[target] = 'catalog:';
  f.save();
  const workspaceFile = path.join(f.root, 'pnpm-workspace.yaml');
  fs.writeFileSync(workspaceFile, `catalog:\n  '${target}': 1.0.0\n`);
  const transport = f.fetchArtifact;
  f.fetchArtifact = async (...args) => {
    fs.appendFileSync(workspaceFile, '# changed after resolution\n');
    return transport(...args);
  };
  await assert.rejects(verifySupportConsumer(f), /workspace catalog changed/);
});
test('pnpm-like symlinks resolve to one physical support tree from real owner locations', async () => {
  const f = fixture();
  const linked = path.join(f.root, 'node_modules/solid-js');
  const physical = path.join(
    f.root,
    '.store/arbitrary-name/node_modules/solid-js',
  );
  fs.mkdirSync(path.dirname(physical), { recursive: true });
  fs.renameSync(linked, physical);
  fs.symlinkSync(physical, linked);
  const renderer = f.framework('@synthetic/renderer', {
    'solid-js': p.cohort['solid-js'],
  });
  const realRenderer = path.join(
    f.root,
    '.store/other-arbitrary-name/node_modules/@synthetic/renderer',
  );
  fs.mkdirSync(path.dirname(realRenderer), { recursive: true });
  fs.renameSync(renderer, realRenderer);
  fs.symlinkSync(realRenderer, renderer);
  fs.symlinkSync(
    physical,
    path.join(f.root, '.store/other-arbitrary-name/node_modules/solid-js'),
  );
  const receipt = await verifySupportConsumer(f);
  assert.equal(receipt.packages[0].directory, physical);
  assert(
    receipt.resolutions.some(
      item => item.owner === realRenderer && item.directory === physical,
    ),
  );
});
test('declared dev-only tools need no public peer or installed host, but require descriptor authority', async () => {
  const f = fixture();
  f.framework(
    '@synthetic/renderer',
    { 'solid-js': p.cohort['solid-js'] },
    {
      devDependencies: {
        '@rstest/core': p.cohort['@rstest/core'],
        'ioredis-mock': p.cohort['ioredis-mock'],
      },
    },
  );
  assert.deepEqual((await verifySupportConsumer(f)).selectedPackages, [
    'solid-js',
  ]);
});
test('React workspace root must host the generator dependency on the required Solid adapter', async () => {
  // Minimal installed projection of release 6: the React root selects these
  // three support inputs, but create also requires renderer-solid by npm alias.
  // Adapter availability is not the same thing as the selected app renderer.
  const selected = [
    '@effect/opentelemetry',
    'rsbuild-plugin-dts',
    '@tanstack/react-router',
  ];
  const f = fixture(selected);
  const generatorName = '@bleedingdev/modern-js-ultramodern-create';
  const rendererName = '@bleedingdev/modern-js-renderer-solid';
  const generator = f.framework(
    generatorName,
    {},
    {
      ultramodern: {
        sourceName: '@modern-js/ultramodern-create',
        supportArtifacts: f.descriptor,
      },
      dependencies: {
        '@modern-js/renderer-solid': `npm:${rendererName}@1.0.0`,
      },
    },
  );
  const renderer = f.framework(
    rendererName,
    { 'solid-js': p.cohort['solid-js'] },
    {
      ultramodern: {
        sourceName: '@modern-js/renderer-solid',
        supportArtifacts: f.descriptor,
      },
    },
  );
  delete f.rootManifest.dependencies[rendererName];
  fs.mkdirSync(path.join(generator, 'node_modules/@modern-js'), {
    recursive: true,
  });
  fs.symlinkSync(
    renderer,
    path.join(generator, 'node_modules/@modern-js/renderer-solid'),
  );
  f.save();
  await assert.rejects(
    verifySupportConsumer(f),
    /solid-js: owner closure requires a selected direct host/,
  );

  // The owner contract stays required; generation must provide its exact host.
  f.rootManifest.devDependencies['solid-js'] =
    f.descriptor.packages['solid-js'].request;
  f.save();
  unpack(
    f.payloads.get(p.assetFilename('solid-js', p.cohort['solid-js'])),
    path.join(f.root, 'node_modules/solid-js'),
  );
  const receipt = await verifySupportConsumer(f);
  assert.deepEqual(receipt.selectedPackages, [...selected, 'solid-js'].sort());
  assert(
    receipt.resolutions.some(
      item => item.owner === renderer && item.name === 'solid-js',
    ),
  );
  fs.writeFileSync(
    path.join(f.root, 'pnpm-workspace.yaml'),
    `catalog:\n  solid-js: ${f.descriptor.packages['solid-js'].request}\n`,
  );
  for (const request of [p.cohort['solid-js'], 'catalog:']) {
    f.rootManifest.devDependencies['solid-js'] = request;
    f.save();
    await assert.rejects(
      verifySupportConsumer(f),
      /differs from support request/,
    );
  }
});
test('private support aliases and orphan peer metadata reject', async () => {
  const f = fixture();
  f.rootManifest.dependencies = { 'private-solid': 'npm:solid-js@2.0.0-rc.22' };
  fs.symlinkSync(
    path.join(f.root, 'node_modules/solid-js'),
    path.join(f.root, 'node_modules/private-solid'),
  );
  f.save();
  await assert.rejects(
    verifySupportConsumer(f),
    /private support correction alias/,
  );
  const g = fixture();
  g.framework(
    '@synthetic/bff',
    {},
    { peerDependenciesMeta: { '@effect/opentelemetry': { optional: true } } },
  );
  await assert.rejects(verifySupportConsumer(g), /wrong framework peer/);
});
test('actual owner manifest changes during transport invalidate the receipt', async () => {
  const f = fixture();
  const owner = f.framework('@synthetic/renderer', {
    'solid-js': p.cohort['solid-js'],
  });
  const transport = f.fetchArtifact;
  f.fetchArtifact = async (url, options) => {
    const response = await transport(url, options);
    if (url === f.descriptor.manifest.request)
      fs.appendFileSync(path.join(owner, 'package.json'), ' ');
    return response;
  };
  await assert.rejects(verifySupportConsumer(f), /owner manifest changed/);
});
test('default GitHub reader authenticates through the transport instead of needing a caller API projection', async () => {
  const f = fixture();
  const readGithub = f.readGithub;
  const fetchArtifact = f.fetchArtifact;
  delete f.readGithub;
  let apiCalls = 0;
  f.fetchArtifact = async (url, options) => {
    if (url.startsWith('https://api.github.com/')) {
      apiCalls++;
      return Response.json(
        await readGithub(url.slice('https://api.github.com'.length)),
      );
    }
    return fetchArtifact(url, options);
  };
  await verifySupportConsumer(f);
  assert.equal(apiCalls, 5);
});

test('authenticated different gzip encoding accepts identical canonical tar and installed bytes', async () => {
  const f = fixture();
  const filename = p.assetFilename('solid-js', p.cohort['solid-js']);
  const original = f.payloads.get(filename);
  const bytes = gzipSync(gunzipSync(original), { level: 1 });
  assert(!bytes.equals(original));
  f.payloads.set(filename, bytes);
  f.manifest.packages['solid-js'].integrity = p.integrity(bytes);
  f.seal();
  f.rootManifest.ultramodern.supportArtifacts = f.descriptor;
  f.save();
  const receipt = await verifySupportConsumer(f);
  assert.equal(receipt.packages[0].integrity, p.integrity(bytes));
});
test('successful-looking GitHub evidence for a different source is rejected', async () => {
  const f = fixture();
  const readGithub = f.readGithub;
  f.readGithub = async route => {
    const result = await readGithub(route);
    return route.endsWith('/attempts/2')
      ? { ...result, head_sha: 'b'.repeat(40) }
      : result;
  };
  await assert.rejects(
    verifySupportConsumer(f),
    /Expected values to be strictly equal/,
  );
});

function upstreamOwner(f, manifest, packed) {
  const directory = path.join(f.root, 'node_modules', manifest.name);
  if (packed) {
    for (const file of packed.files) {
      const filename = path.join(directory, file.path);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, packed.fileContents.get(file.path), {
        mode: file.mode & 0o777,
      });
    }
  } else {
    writeManifest(directory, manifest);
    fs.writeFileSync(
      path.join(directory, 'entry.cjs'),
      'throw new Error("UPSTREAM EXECUTED");',
    );
  }
  f.rootManifest.dependencies ??= {};
  f.rootManifest.dependencies[manifest.name] = manifest.version;
  f.save();
  return directory;
}
function stubOrdinaryDependency(f, name) {
  upstreamOwner(f, { name, version: '1.0.0', main: './entry.cjs' });
}
test('actual terser nested dist manifest does not become an installed owner', async () => {
  const f = fixture();
  const packed = actualUpstream.get('terser');
  assert.equal(packed.packageJson.version, '5.51.2');
  const nested = JSON.parse(packed.fileContents.get('dist/package.json'));
  assert.equal(nested.name, 'dist');
  assert.equal(nested.private, true);
  upstreamOwner(f, packed.packageJson, packed);
  for (const name of Object.keys(packed.packageJson.dependencies))
    stubOrdinaryDependency(f, name);
  await verifySupportConsumer(f);
});
test('nested named private package scopes do not replace the installed package owner', async () => {
  const f = fixture();
  const owner = upstreamOwner(f, {
    name: 'minifier-with-dist-scope',
    version: '1.0.0',
    main: './dist/bundle.min.js',
    peerDependencies: { 'solid-js': '^2.0.0-rc.22' },
  });
  writeManifest(path.join(owner, 'dist'), {
    name: 'dist',
    private: true,
    type: 'commonjs',
    // A nested scope is not a separately installed runtime owner.
    dependencies: { 'not-an-installed-dependency': '1.0.0' },
  });
  fs.writeFileSync(
    path.join(owner, 'dist/bundle.min.js'),
    'throw new Error("NESTED RUNTIME EXECUTED");',
  );
  const receipt = await verifySupportConsumer(f);
  assert(
    receipt.resolutions.some(
      item => item.owner === owner && item.name === 'solid-js',
    ),
  );
});
test('public entries outside the resolved physical package remain rejected', async () => {
  const f = fixture();
  const owner = upstreamOwner(f, {
    name: 'escaping-package',
    version: '1.0.0',
    main: '../foreign-entry.cjs',
  });
  fs.writeFileSync(
    path.join(owner, '../foreign-entry.cjs'),
    'throw new Error("FOREIGN RUNTIME EXECUTED");',
  );
  await assert.rejects(
    verifySupportConsumer(f),
    /Resolved entry escapes owning package/u,
  );
});
test('actual upstream @solidjs/web manifest: admitting Solid range and workspace dev edge require no fork descriptor', async () => {
  const f = fixture();
  const packed = actualUpstream.get('@solidjs/web');
  assert.equal(packed.packageJson.peerDependencies['solid-js'], '^2.0.0-rc.22');
  assert.equal(packed.packageJson.devDependencies['solid-js'], 'workspace:*');
  const owner = upstreamOwner(f, packed.packageJson, packed);
  for (const name of Object.keys(packed.packageJson.dependencies))
    stubOrdinaryDependency(f, name);
  const receipt = await verifySupportConsumer(f);
  assert(
    receipt.resolutions.some(
      item => item.owner === owner && item.name === 'solid-js',
    ),
  );
});
test('actual upstream @rstest/adapter-rsbuild manifest: admitting rstest range needs no fork descriptor', async () => {
  const f = fixture(['@rstest/core']);
  const packed = actualUpstream.get('@rstest/adapter-rsbuild');
  assert.equal(packed.packageJson.peerDependencies['@rstest/core'], '^0.12.0');
  const owner = upstreamOwner(f, packed.packageJson, packed);
  stubOrdinaryDependency(f, '@rsbuild/core');
  const receipt = await verifySupportConsumer(f);
  assert(
    receipt.resolutions.some(
      item => item.owner === owner && item.name === '@rstest/core',
    ),
  );
});
test('ordinary upstream dev-only support tooling is irrelevant when unselected or selected', async () => {
  for (const selected of [['solid-js'], ['solid-js', '@rstest/core']]) {
    const f = fixture(selected);
    upstreamOwner(f, {
      name: 'upstream-test-tool-user',
      version: '1.0.0',
      main: './entry.cjs',
      devDependencies: { '@rstest/core': '^0.1.0' },
    });
    await verifySupportConsumer(f);
  }
});
test('ordinary upstream optional disabled support integration does not select OTel', async () => {
  const f = fixture();
  upstreamOwner(f, {
    name: 'upstream-optional-integration',
    version: '1.0.0',
    main: './entry.cjs',
    peerDependencies: { '@effect/opentelemetry': '^4.1.0' },
    peerDependenciesMeta: { '@effect/opentelemetry': { optional: true } },
  });
  assert.deepEqual((await verifySupportConsumer(f)).selectedPackages, [
    'solid-js',
  ]);
});

test('upstream ranges cannot conceal incompatible peers, required closure, or private copies', async () => {
  const wrongRange = fixture();
  upstreamOwner(wrongRange, {
    name: 'upstream-wrong-range',
    version: '1.0.0',
    main: './entry.cjs',
    peerDependencies: { 'solid-js': '^1.0.0' },
  });
  await assert.rejects(
    verifySupportConsumer(wrongRange),
    /range does not admit/,
  );
  const missingHost = fixture();
  upstreamOwner(missingHost, {
    name: 'upstream-required-otel',
    version: '1.0.0',
    main: './entry.cjs',
    peerDependencies: { '@effect/opentelemetry': '^4.1.0' },
  });
  await assert.rejects(
    verifySupportConsumer(missingHost),
    /requires a selected direct host/,
  );
  for (const block of ['dependencies', 'peerDependencies']) {
    const duplicate = fixture();
    const owner = upstreamOwner(duplicate, {
      name: 'upstream-private-copy',
      version: '1.0.0',
      main: './entry.cjs',
      [block]: { 'solid-js': '^2.0.0-rc.22' },
    });
    await verifySupportConsumer(duplicate);
    unpack(
      duplicate.payloads.get(p.assetFilename('solid-js', p.cohort['solid-js'])),
      path.join(owner, 'node_modules/solid-js'),
    );
    await assert.rejects(
      verifySupportConsumer(duplicate),
      /wrong physical peer/,
    );
  }
});
test('ordinary upstream dependency range can share the canonical installed host', async () => {
  const f = fixture();
  const owner = upstreamOwner(f, {
    name: 'upstream-runtime-dependency',
    version: '1.0.0',
    main: './entry.cjs',
    dependencies: { 'solid-js': '^2.0.0-rc.22' },
  });
  const receipt = await verifySupportConsumer(f);
  assert(
    receipt.resolutions.some(
      item => item.owner === owner && item.name === 'solid-js',
    ),
  );
});
test('foreign descriptor presence commits even without edges or on dev-only tooling', async () => {
  for (const devDependencies of [undefined, { '@rstest/core': '^0.1.0' }]) {
    const f = fixture();
    upstreamOwner(f, {
      name: 'ordinary-descriptor-claim',
      version: '1.0.0',
      main: './entry.cjs',
      ultramodern: { supportArtifacts: { protocol: 'wrong' } },
      ...(devDependencies ? { devDependencies } : {}),
    });
    await assert.rejects(verifySupportConsumer(f), /exact support descriptor/);
  }
});
test('actual source name and sourceName metadata keep exact fork authority, including dev-only owners', async () => {
  for (const identity of [
    { name: '@modern-js/renderer-solid' },
    {
      name: '@bleedingdev/modern-js-renderer-solid',
      ultramodern: { sourceName: '@modern-js/renderer-solid' },
    },
  ]) {
    const missing = fixture();
    upstreamOwner(missing, {
      ...identity,
      version: '1.0.0',
      main: './entry.cjs',
      peerDependencies: { 'solid-js': '^2.0.0-rc.22' },
    });
    await assert.rejects(
      verifySupportConsumer(missing),
      /exact support descriptor/,
    );
    const ranged = fixture();
    upstreamOwner(ranged, {
      ...identity,
      version: '1.0.0',
      main: './entry.cjs',
      ultramodern: {
        ...identity.ultramodern,
        supportArtifacts: ranged.descriptor,
      },
      peerDependencies: { 'solid-js': '^2.0.0-rc.22' },
    });
    await assert.rejects(verifySupportConsumer(ranged), /wrong framework peer/);
  }
  const dev = fixture();
  upstreamOwner(dev, {
    name: '@modern-js/test-owner',
    version: '1.0.0',
    main: './entry.cjs',
    devDependencies: { '@rstest/core': '^0.12.0' },
  });
  await assert.rejects(verifySupportConsumer(dev), /exact support descriptor/);
});

test('workspace pipeline verifies every selected real importer and rejects a second registry request', async () => {
  const { verifySupportWorkspace, supportWorkspaceImporters } = await import(
    '../verify-support-workspace.mjs'
  );
  const f = fixture(['solid-js']);
  fs.writeFileSync(
    path.join(f.root, 'pnpm-workspace.yaml'),
    'packages:\n  - apps/*\n  - "!apps/excluded"\n',
  );
  const app = path.join(f.root, 'apps/app');
  writeManifest(app, {
    ...structuredClone(f.rootManifest),
    name: '@synthetic/app',
  });
  fs.symlinkSync(
    path.join(f.root, 'node_modules'),
    path.join(app, 'node_modules'),
    'dir',
  );
  writeManifest(path.join(f.root, 'apps/excluded'), {
    name: '@synthetic/excluded',
    dependencies: { 'solid-js': 'bad' },
  });
  assert.deepEqual(supportWorkspaceImporters(f.root), [f.root, app].sort());
  const receipt = await verifySupportWorkspace(f);
  assert.deepEqual(
    receipt.importers.map(item => item.root).sort(),
    [f.root, app].sort(),
  );
  writeManifest(app, {
    ...structuredClone(f.rootManifest),
    name: '@synthetic/app',
    devDependencies: { 'solid-js': p.cohort['solid-js'] },
  });
  await assert.rejects(
    verifySupportWorkspace(f),
    /differs from support request/,
  );
});

test('selected importer fetches only its payload and upstream, never unrelated support payloads', async () => {
  const f = fixture(['solid-js']);
  f.framework(
    '@synthetic/dev-tools',
    {},
    { devDependencies: { '@rstest/core': p.cohort['@rstest/core'] } },
  );
  const requests = [];
  const fetchArtifact = async (...args) => {
    requests.push(args[0]);
    return f.fetchArtifact(...args);
  };
  const receipt = await verifySupportConsumer({ ...f, fetchArtifact });
  assert.deepEqual(receipt.selectedPackages, ['solid-js']);
  for (const name of Object.keys(p.cohort).filter(
    name => name !== 'solid-js',
  )) {
    assert(!requests.includes(f.descriptor.packages[name].request));
    assert(!requests.includes(inputs[name].upstream.request));
  }
});

test('actual release source and packed owner admission requires descriptor and never rewrites registry metadata', async () => {
  const { assertReleaseSupportOwners, verifyReleaseSupportOwners } =
    await import('../lib/support-release-admission.mjs');
  const f = fixture(['solid-js']);
  const manifest = {
    name: '@modern-js/renderer-solid',
    version: '1.0.0',
    publishConfig: { access: 'public' },
    peerDependencies: { 'solid-js': p.cohort['solid-js'] },
  };
  assert.throws(
    () => assertReleaseSupportOwners([manifest]),
    /descriptor required/,
  );
  assert.throws(
    () =>
      assertReleaseSupportOwners([{ name: '@modern-js/ultramodern-create' }]),
    /descriptor required/,
  );
  manifest.ultramodern = { supportArtifacts: f.descriptor };
  assert.deepEqual(assertReleaseSupportOwners([manifest]), f.descriptor);
  const bytes = packFiles(
    new Map([
      [
        'package.json',
        { bytes: Buffer.from(JSON.stringify(manifest)), mode: 0o644 },
      ],
    ]),
  );
  assert.deepEqual(
    await verifyReleaseSupportOwners([{ bytes }], f),
    f.descriptor,
  );
  // The production call receives verified release records with artifactPath,
  // not an in-memory bytes field. Re-read and authenticate that exact file.
  const { createHash } = await import('node:crypto');
  const inspected = inspectNpmTarball(bytes);
  const artifactPath = path.join(f.root, 'actual-release-owner.tgz');
  fs.writeFileSync(artifactPath, bytes);
  const item = {
    artifactPath,
    targetName: manifest.name,
    sourceName: manifest.name,
    version: '1.0.0',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    shasum: createHash('sha1').update(bytes).digest('hex'),
    integrity: p.integrity(bytes),
    ...Object.fromEntries(
      ['fileCount', 'unpackedSize', 'packageJsonSha256', 'fileListSha256'].map(
        key => [key, inspected[key]],
      ),
    ),
  };
  assert.deepEqual(await verifyReleaseSupportOwners([item], f), f.descriptor);
  fs.appendFileSync(artifactPath, 'tampered');
  await assert.rejects(verifyReleaseSupportOwners([item], f), /size mismatch/);
  const wrong = structuredClone(manifest);
  wrong.peerDependencies['solid-js'] = '^2.0.0-rc.22';
  await assert.rejects(
    verifyReleaseSupportOwners(
      [
        {
          bytes: packFiles(
            new Map([
              [
                'package.json',
                { bytes: Buffer.from(JSON.stringify(wrong)), mode: 0o644 },
              ],
            ]),
          ),
        },
      ],
      f,
    ),
    /wrong framework peer/,
  );
  assert.equal(manifest.peerDependencies['solid-js'], p.cohort['solid-js']);
});

test('release preparation and recovery invoke packed admission before publish and ERP invokes install admission', () => {
  const source = fs.readFileSync(
    new URL(
      '../lib/prepare-bleedingdev-packages/workflow.mjs',
      import.meta.url,
    ),
    'utf8',
  );
  assert(
    source.indexOf('assertReleaseSupportOwners(packages.map') <
      source.indexOf('packSourcePackage(sourceName'),
  );
  assert.equal(
    source.match(
      /await verifyReleaseSupportOwners\(releaseArtifacts.packages\)/gu,
    ).length,
    2,
  );
  const acceptance = fs.readFileSync(
    new URL('../run-release-acceptance.mjs', import.meta.url),
    'utf8',
  );
  assert.match(acceptance, /runImpl: supportAdmissionRun\(run\)/u);
  assert.match(
    acceptance,
    /verifyInstalledSupportWorkspace\(\s*path.join\(options.workDir, options.projectName\),?\s*\)/u,
  );
});

test('failed installed admission cleans scratch without a caller-owned directory', async t => {
  const { verifyInstalledSupportWorkspace } = await import(
    '../lib/support-release-admission.mjs'
  );
  const root = fs.mkdtempSync(path.join(directory, 'no-support-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ private: true }),
  );
  const { OWNED_TEMP_DIR: _callerOwned, ...env } = process.env;
  env.TMPDIR = root;
  assert.throws(
    () => verifyInstalledSupportWorkspace(root, env),
    /Installed support importer admission failed/u,
  );
  assert.deepEqual(fs.readdirSync(root), ['package.json']);
  assert(!Object.hasOwn(env, 'OWNED_TEMP_DIR'));
});

test('real frozen-install command seam fails when the generated importer lacks owner descriptor', async () => {
  const { supportAdmissionRun } = await import(
    '../lib/support-release-admission.mjs'
  );
  const f = fixture(['solid-js']);
  delete f.rootManifest.ultramodern;
  f.save();
  const calls = [];
  const execute = supportAdmissionRun((...args) => {
    calls.push(args);
    return 'installed';
  });
  assert.equal(
    execute('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], {
      cwd: f.root,
    }),
    'installed',
  );
  assert.throws(
    () => execute('pnpm', ['install', '--frozen-lockfile'], { cwd: f.root }),
    /Installed support importer admission failed/,
  );
  assert.equal(calls.length, 2);
});
