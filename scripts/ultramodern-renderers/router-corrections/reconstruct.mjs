import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qualify } from './qualify.mjs';

export const upstream = {
  commit: '6b9fe6d29552270836c511bc9b343d73541f4424',
  integrity:
    'sha512-qUhoJ0meuSUqGYQbHbcJYdASr06YtK+bulbj6vtrhKYFkLgkSsZ6tXmMyym7sFxiSJSPYgasgozrL01LyyR/6A==',
  url: 'https://registry.npmjs.org/@tanstack/router-core/-/router-core-1.171.39.tgz',
  accepted: '585d3233f7f54e69c057b413cc3bacbfbcc9b7a5',
};
const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../..');
const patchPath = path.join(
  repository,
  'patches/@tanstack__router-core@1.171.39.patch',
);
function run(command, args, cwd, options = {}) {
  return execFileSync(command, args, { cwd, stdio: 'inherit', ...options });
}
function json(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function disk() {
  run('df', ['-h', '/System/Volumes/Data']);
  const { bavail, bsize } = fs.statfsSync('/System/Volumes/Data');
  assert(
    bavail * bsize >= 20 * 1024 ** 3,
    'Below 20 GiB: stop before installing/building',
  );
}
export function portableExports(manifest) {
  const portable = manifest.exports['./ssr/server'];
  const node = JSON.parse(
    JSON.stringify(portable).replaceAll('ssr/server.', 'ssr/server.node.'),
  );
  manifest.exports['./ssr/server'] = {
    browser: portable,
    workerd: portable,
    worker: portable,
    node,
    ...portable,
  };
  manifest.exports['./ssr/server.node'] = node;
  return manifest;
}
export async function main() {
  assert(
    process.env.OWNED_TEMP_DIR,
    'Use owned-temp-dir --run router-core-corrections -- node .../reconstruct.mjs',
  );
  const root = process.env.OWNED_TEMP_DIR;
  const owner = `router-corrections-${process.pid}`;
  const sourceRepo =
    process.env.ROUTER_REFERENCE_REPOSITORY ??
    '/Users/satan/workspace/bleedingdev/projects/tanstack-router/code/router';
  const source = path.join(root, 'source');
  const pkg = path.join(source, 'packages/router-core');
  const original = path.join(root, 'original');
  const corrected = path.join(root, 'corrected');
  fs.mkdirSync(source);
  fs.mkdirSync(original);
  const registered = [];
  function register(dir, kind) {
    fs.mkdirSync(dir, { recursive: true });
    run('/Users/satan/bin/disk-guardian-artifacts', [
      'register',
      dir,
      '--owner',
      owner,
      '--owner-pid',
      String(process.pid),
      '--grace-hours',
      '24',
      '--kind',
      kind,
    ]);
    registered.push(dir);
  }
  try {
    const response = await fetch(upstream.url, {
      signal: AbortSignal.timeout(30000),
    });
    assert(response.ok);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(
      `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      upstream.integrity,
    );
    fs.writeFileSync(path.join(root, 'upstream.tgz'), bytes);
    run('tar', [
      '-xzf',
      path.join(root, 'upstream.tgz'),
      '--strip-components=1',
      '-C',
      original,
    ]);
    const archive = execFileSync(
      'git',
      [
        '-C',
        sourceRepo,
        'archive',
        upstream.commit,
        'packages/router-core',
        'tsconfig.json',
        'LICENSE',
      ],
      { maxBuffer: 30 * 1024 ** 2 },
    );
    const provenance = JSON.parse(
      fs.readFileSync(path.join(here, 'provenance.json')),
    );
    assert.equal(
      createHash('sha512').update(archive).digest('hex'),
      provenance.sourceArchiveSha512,
      'Pinned git archive mismatch',
    );
    assert.equal(
      createHash('sha256')
        .update(fs.readFileSync(path.join(here, 'source.patch')))
        .digest('hex'),
      provenance.sourcePatchSha256,
    );
    execFileSync('tar', ['-xf', '-', '-C', source], { input: archive });
    assert.equal(
      fs.readFileSync(path.join(original, 'LICENSE'), 'utf8'),
      fs.readFileSync(path.join(source, 'LICENSE'), 'utf8'),
    );
    for (const file of fs.readdirSync(path.join(original, 'src'), {
      recursive: true,
    })) {
      const published = path.join(original, 'src', file);
      if (fs.statSync(published).isFile())
        assert.deepEqual(
          fs.readFileSync(published),
          fs.readFileSync(path.join(pkg, 'src', file)),
          `git/npm source mismatch: ${file}`,
        );
    }
    run(
      'patch',
      ['-p1', '--fuzz=0', '--batch', '-i', path.join(here, 'source.patch')],
      source,
    );
    for (const file of fs.readdirSync(path.join(here, 'tests')))
      fs.copyFileSync(
        path.join(here, 'tests', file),
        path.join(pkg, 'tests', file),
      );
    const sourceManifest = JSON.parse(
      fs.readFileSync(path.join(pkg, 'package.json')),
    );
    // Isolated build tools only; never install or mutate the reference checkout.
    sourceManifest.dependencies = {
      '@tanstack/history': '1.162.5',
      'cookie-es': '3.1.1',
      seroval: '1.6.7',
      'seroval-plugins': '1.6.7',
    }; // upstream source lock versions
    sourceManifest.devDependencies = {
      '@tanstack/store': '0.11.2',
      '@types/node': '25.0.9',
      esbuild: '0.27.4',
      vite: '8.3.4',
      '@tanstack/vite-config': '0.5.2',
      vitest: '5.0.4',
      jsdom: '25.0.1',
      typescript: '6.0.2',
    };
    json(path.join(pkg, 'package.json'), sourceManifest);
    fs.writeFileSync(
      path.join(source, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/router-core\npackageImportMethod: clone-or-copy\n',
    );
    json(path.join(source, 'package.json'), {
      private: true,
      type: 'module',
      packageManager: 'pnpm@11.21.0',
    });
    const buildLock = path.join(here, 'build-lock.yaml');
    const useBuildLock =
      fs.existsSync(buildLock) &&
      !process.argv.includes('--refresh-build-lock');
    if (useBuildLock)
      fs.copyFileSync(buildLock, path.join(source, 'pnpm-lock.yaml'));
    disk();
    register(path.join(source, 'node_modules'), 'dependencies');
    register(path.join(pkg, 'node_modules'), 'dependencies');
    run(
      'pnpm',
      [
        'install',
        ...(useBuildLock ? ['--frozen-lockfile'] : []),
        '--ignore-scripts',
        '--store-dir',
        '/Users/satan/.local/share/pnpm/store',
        '--config.package-import-method=clone-or-copy',
      ],
      source,
    );
    if (!useBuildLock)
      fs.copyFileSync(path.join(source, 'pnpm-lock.yaml'), buildLock);
    register(path.join(source, 'node_modules'), 'dependencies');
    register(path.join(pkg, 'node_modules'), 'dependencies');
    disk();
    register(path.join(pkg, 'dist'), 'build');
    run('pnpm', ['exec', 'vite', 'build'], pkg);
    register(path.join(pkg, 'dist'), 'build');
    fs.cpSync(original, corrected, { recursive: true });
    fs.cpSync(path.join(pkg, 'src'), path.join(corrected, 'src'), {
      recursive: true,
    });
    fs.rmSync(path.join(corrected, 'dist'), { recursive: true });
    fs.cpSync(path.join(pkg, 'dist'), path.join(corrected, 'dist'), {
      recursive: true,
    });
    const publishedManifest = portableExports(
      JSON.parse(fs.readFileSync(path.join(original, 'package.json'))),
    );
    assert.equal(publishedManifest.name, '@tanstack/router-core');
    assert.equal(publishedManifest.version, '1.171.39');
    json(path.join(corrected, 'package.json'), publishedManifest);
    const result = spawnSync(
      'git',
      [
        'diff',
        '--no-index',
        '--diff-algorithm=histogram',
        '--unified=3',
        '--indent-heuristic',
        '--abbrev=10',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--no-color',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        original,
        corrected,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: devNull,
          GIT_CONFIG_NOSYSTEM: '1',
        },
        maxBuffer: 30 * 1024 ** 2,
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 1);
    const diff = Buffer.from(
      result.stdout
        .replaceAll(`a/${original.slice(1)}/`, 'a/')
        .replaceAll(`b/${corrected.slice(1)}/`, 'b/')
        .replaceAll(`a/${corrected.slice(1)}/`, 'a/')
        .replaceAll(`b/${original.slice(1)}/`, 'b/'),
    );
    if (process.argv.includes('--write')) fs.writeFileSync(patchPath, diff);
    else
      assert(
        fs.readFileSync(patchPath).equals(diff),
        'Owning build differs from canonical patch',
      );
    const reconstructed = path.join(root, 'reconstructed');
    fs.cpSync(original, reconstructed, { recursive: true });
    run(
      'patch',
      ['-p1', '--fuzz=0', '--batch', '-i', patchPath],
      reconstructed,
    );
    run('diff', ['-qr', corrected, reconstructed]);
    assert.equal(
      createHash('sha256')
        .update(fs.readFileSync(path.join(reconstructed, 'LICENSE')))
        .digest('hex'),
      provenance.licenseSha256,
    );
    let verifiedMaps = 0;
    for (const file of fs.readdirSync(path.join(reconstructed, 'dist'), {
      recursive: true,
    })) {
      if (!file.endsWith('.map')) continue;
      const mapFile = path.join(reconstructed, 'dist', file);
      const map = JSON.parse(fs.readFileSync(mapFile));
      for (const [index, sourceFile] of map.sources.entries()) {
        const originalSource = path.resolve(path.dirname(mapFile), sourceFile);
        if (
          originalSource.startsWith(
            path.join(reconstructed, 'src') + path.sep,
          ) &&
          fs.existsSync(originalSource)
        ) {
          assert.equal(
            map.sourcesContent[index],
            fs.readFileSync(originalSource, 'utf8'),
            `Source map mismatch: ${file}`,
          );
          verifiedMaps++;
        }
      }
    }
    assert(verifiedMaps > 100, 'Must verify actual CJS and ESM source maps');
    console.log('VERIFIED_MAP_SOURCES', verifiedMaps);
    console.log(
      'PATCH_SHA256',
      createHash('sha256').update(diff).digest('hex'),
    );
    run(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--typecheck.enabled=false',
        'dehydration-hook-loads',
        'server-route-lifecycle',
        'server-load-dehydration',
        'commit-location-public-href',
        'mask-inherit-search',
        'headers.test',
        'transformStreamWithRouter.test',
      ],
      pkg,
    );
    run(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--typecheck.only',
        'mask-inherit-search',
        'headers',
        'transformStreamWithRouter',
      ],
      pkg,
    );
    qualify({ root, pkg, reconstructed, here, run, register, disk });
  } finally {
    for (const dir of [...new Set(registered)].reverse()) {
      run('/Users/satan/bin/disk-guardian-artifacts', [
        'release',
        dir,
        '--owner',
        owner,
      ]);
    }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
