import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// Tiny local archives prove pnpm resolution mechanics, NOT artifact authentication.
export async function proveSupportInstallerMechanism(
  selector,
  source = 'url',
  requestMode = 'literal',
  hostPolicy = {},
) {
  assert.equal(source, 'url');
  assert(
    [
      'literal',
      'direct-reference',
      'catalog',
      'root-catalog',
      'root-catalog-direct-reference',
      'peer-host',
    ].includes(requestMode),
  );
  assert.equal(process.versions.node, '26.13.1');
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'support-installer-mechanism-'),
  );
  const name = 'rsbuild-plugin-dts';
  const version = '1.0.7';
  const exactOwner =
    requestMode === 'peer-host' ? '@rslib/core' : 'exact-owner';
  if (requestMode === 'peer-host')
    assert.deepEqual(hostPolicy, {
      '@rslib/core@1.0.7': {
        peerDependencies: { [name]: version },
      },
    });
  const archives = new Map();
  let base;
  const pack = (id, manifest, marker) => {
    const directory = path.join(root, 'archives', id);
    fs.mkdirSync(path.join(directory, 'package'), { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'package/package.json'),
      JSON.stringify({
        ...manifest,
        main: 'index.cjs',
      }),
    );
    fs.writeFileSync(
      path.join(directory, 'package/index.cjs'),
      `module.exports = ${JSON.stringify(marker)};\n`,
    );
    const filename = path.join(directory, 'fixture.tgz');
    execFileSync('tar', ['-czf', filename, '-C', directory, 'package']);
    const bytes = fs.readFileSync(filename);
    archives.set(`/${id}.tgz`, bytes);
    return {
      ...manifest,
      dist: {
        tarball: `${base}/${id}.tgz`,
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      },
    };
  };
  const metadata = new Map();
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, base).pathname;
    const bytes = archives.get(pathname);
    if (bytes) return response.end(bytes);
    const entry = metadata.get(decodeURIComponent(pathname.slice(1)));
    if (entry) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify(entry));
    }
    response.writeHead(404).end();
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const versions = Object.fromEntries(
      [version, '1.0.8', '2.0.0'].map(value => [
        value,
        pack(
          `registry-${value}`,
          { name, version: value },
          `registry-${value}`,
        ),
      ]),
    );
    metadata.set(name, {
      name,
      'dist-tags': { latest: '2.0.0' },
      versions,
      time: Object.fromEntries(
        Object.keys(versions).map(value => [value, '2020-01-01T00:00:00.000Z']),
      ),
    });
    const correctionArchive = pack(
      'correction',
      { name, version },
      'correction',
    );
    const correction = correctionArchive.dist.tarball;
    const owners = [
      [exactOwner, 'dependencies', version],
      ['optional-owner', 'optionalDependencies', version],
      ['range-owner', 'dependencies', '^1.0.0'],
      ['other-owner', 'dependencies', '2.0.0'],
      ['incompatible-owner', 'dependencies', '^1.0.8'],
      ['peer-owner', 'peerDependencies', version],
      ['range-peer-owner', 'peerDependencies', '^1.0.0'],
    ];
    const dependencies = { [name]: correction };
    for (const [owner, group, request] of owners)
      dependencies[owner] = pack(
        owner,
        {
          name: owner,
          version:
            owner === exactOwner && requestMode === 'peer-host'
              ? '1.0.7'
              : '1.0.0',
          [group]: { [name]: request },
        },
        owner,
      ).dist.tarball;
    const install = promisify(execFile);
    const env = { ...process.env, CI: 'true', MISE_PNPM_VERSION: '12.21.0' };
    assert.equal(
      (await install('pnpm', ['--version'], { cwd: root, env })).stdout.trim(),
      '12.21.0',
    );
    for (const corrected of [false, true]) {
      const catalog = requestMode.includes('catalog');
      const rootCatalog = requestMode.startsWith('root-catalog');
      const directory = path.join(root, corrected ? 'corrected' : 'before');
      fs.mkdirSync(directory);
      fs.writeFileSync(
        path.join(directory, 'package.json'),
        JSON.stringify({
          name: 'synthetic-mechanism-only',
          private: true,
          dependencies: {
            ...dependencies,
            ...(corrected && rootCatalog ? { [name]: 'catalog:support' } : {}),
          },
        }),
      );
      fs.writeFileSync(
        path.join(directory, 'pnpm-workspace.yaml'),
        [
          `registry: ${base}/`,
          'minimumReleaseAge: 1440',
          'minimumReleaseAgeStrict: true',
          'minimumReleaseAgeIgnoreMissingTime: false',
          'blockExoticSubdeps: true',
          'trustPolicy: no-downgrade',
          'strictPeerDependencies: true',
          'autoInstallPeers: false',
          `storeDir: ${JSON.stringify(path.join(root, 'store'))}`,
          ...(corrected && requestMode === 'peer-host'
            ? [
                'packageExtensions:',
                ...Object.entries({
                  ...hostPolicy,
                  'range-owner@1.0.0': {
                    peerDependencies: { [name]: '^1.0.0' },
                  },
                  'optional-owner@1.0.0': {
                    peerDependencies: { [name]: version },
                  },
                }).flatMap(([owner, extension]) => [
                  `  ${JSON.stringify(owner)}:`,
                  '    peerDependencies:',
                  `      ${name}: ${JSON.stringify(extension.peerDependencies[name])}`,
                ]),
              ]
            : corrected
              ? [
                  `overrides:\n  ${JSON.stringify(selector)}: ${JSON.stringify(
                    requestMode.endsWith('direct-reference')
                      ? `$${name}`
                      : catalog
                        ? 'catalog:support'
                        : correction,
                  )}`,
                  ...(catalog
                    ? [
                        `catalogs:\n  support:\n    ${name}: ${JSON.stringify(correction)}`,
                      ]
                    : []),
                ]
              : []),
          '',
        ].join('\n'),
      );
      try {
        await install(
          'pnpm',
          [
            'install',
            '--ignore-scripts',
            '--reporter=append-only',
            `--registry=${base}/`,
          ],
          {
            cwd: directory,
            timeout: 60_000,
            env,
          },
        );
      } catch (error) {
        error.mechanism = { selector, source, requestMode, corrected };
        throw error;
      }
      const require = createRequire(path.join(directory, 'package.json'));
      const direct = fs.realpathSync(require.resolve(name));
      for (const [owner, group, request] of owners) {
        const ownerManifest = require.resolve(`${owner}/package.json`);
        const manifest = JSON.parse(fs.readFileSync(ownerManifest, 'utf8'));
        assert.equal(
          manifest[group][name],
          request,
          'published ranges remain untouched',
        );
        const ownerRequire = createRequire(ownerManifest);
        const resolved = fs.realpathSync(ownerRequire.resolve(name));
        if (
          owner === exactOwner ||
          owner === 'optional-owner' ||
          (corrected && owner === 'range-owner')
        ) {
          const usesCorrection =
            corrected &&
            !(requestMode === 'peer-host' && owner === 'optional-owner');
          assert.equal(
            resolved === direct,
            usesCorrection,
            `${owner}: physical correction selection`,
          );
          assert.equal(
            ownerRequire(name),
            usesCorrection ? 'correction' : `registry-${version}`,
          );
        }
        if (owner === 'peer-owner' || owner === 'range-peer-owner') {
          assert.equal(
            resolved,
            direct,
            'exact peer uses the selected root host',
          );
        }
        if (owner === 'other-owner' || owner === 'incompatible-owner') {
          assert.notEqual(
            resolved,
            direct,
            'unrelated versions must not be redirected',
          );
          assert.equal(
            ownerRequire(name),
            owner === 'other-owner' ? 'registry-2.0.0' : 'registry-1.0.8',
          );
        }
      }
      // Frozen installation must preserve the lockfile and the same physical graph.
      if (corrected) {
        const lock = fs.readFileSync(
          path.join(directory, 'pnpm-lock.yaml'),
          'utf8',
        );
        await install(
          'pnpm',
          [
            'install',
            '--frozen-lockfile',
            '--ignore-scripts',
            '--reporter=append-only',
          ],
          {
            cwd: directory,
            timeout: 60_000,
            env,
          },
        );
        assert.equal(
          fs.readFileSync(path.join(directory, 'pnpm-lock.yaml'), 'utf8'),
          lock,
        );
        for (const owner of [
          exactOwner,
          ...(requestMode === 'peer-host' ? [] : ['optional-owner']),
          'range-owner',
          'peer-owner',
          'range-peer-owner',
        ])
          assert.equal(
            fs.realpathSync(
              createRequire(require.resolve(`${owner}/package.json`)).resolve(
                name,
              ),
            ),
            fs.realpathSync(require.resolve(name)),
          );
        // No peer exception: the same native policy must reject a bad host.
        const incompatible = pack(
          'incompatible-peer-owner',
          {
            name: 'incompatible-peer-owner',
            version: '1.0.0',
            peerDependencies: { [name]: '99.0.0' },
          },
          'incompatible-peer-owner',
        );
        const manifestPath = path.join(directory, 'package.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.dependencies['incompatible-peer-owner'] =
          incompatible.dist.tarball;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        await assert.rejects(
          () =>
            install(
              'pnpm',
              [
                'install',
                '--no-frozen-lockfile',
                '--ignore-scripts',
                '--reporter=append-only',
              ],
              { cwd: directory, timeout: 60_000, env },
            ),
          error => {
            assert.match(
              String(error.stdout) + String(error.stderr),
              /ERR_PNPM_PEER_DEP_ISSUES/u,
            );
            return true;
          },
          'strict peers must reject an incompatible peer without exemptions',
        );
        delete manifest.dependencies['incompatible-peer-owner'];
        const exotic = pack(
          'unapproved-exotic-owner',
          {
            name: 'unapproved-exotic-owner',
            version: '1.0.0',
            dependencies: {
              [name]: `${correctionArchive.dist.tarball}?unapproved=1`,
            },
          },
          'unapproved-exotic-owner',
        );
        manifest.dependencies['unapproved-exotic-owner'] = exotic.dist.tarball;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        await assert.rejects(
          () =>
            install(
              'pnpm',
              [
                'install',
                '--no-frozen-lockfile',
                '--ignore-scripts',
                '--reporter=append-only',
              ],
              { cwd: directory, timeout: 60_000, env },
            ),
          error => {
            assert.match(
              String(error.stdout) + String(error.stderr),
              /ERR_PNPM_EXOTIC_SUBDEP/u,
            );
            return true;
          },
          'host correction must not exempt unapproved transitive URLs',
        );
      }
    }
    return {
      source,
      requestMode,
      physicalSingleton: true,
      exactAndRangeDependencies: true,
      exactAndRangePeers: true,
      optionalDependenciesConverged: requestMode !== 'peer-host',
      incompatiblePeerRejected: true,
      unapprovedExoticRejected: true,
      frozenLockfileUnchanged: true,
      productionArtifactQualification: false,
    };
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
