import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { inspectNpmTarball } from '../../ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import { packages, source } from './inputs.mjs';
import {
  assertSharedCoreManifest,
  defaultOctaneCandidate,
  sharedCoreCandidate,
  sharedCoreVersion,
} from './shared-core-peer.mjs';

const here = import.meta.dirname;
const integrityPattern = /^sha512-[A-Za-z0-9+/]{86}==$/;

/**
 * Pinned identities of the adapter and octane npm tarballs a candidate owns.
 * octane-0.18.0 keeps the reviewed static inputs; every other candidate reads
 * its pinned provenance, whose tags must name the one owning source commit.
 * Both are bound to the static manifest contract and to the octane version the
 * candidate's owning runtime build pins, so adapter and runtime cannot diverge.
 */
export function pinnedAdapterCandidate(
  octaneCandidate = defaultOctaneCandidate,
) {
  const contract = sharedCoreCandidate(octaneCandidate);
  let pinned;
  if (octaneCandidate === defaultOctaneCandidate) {
    const entry = name => {
      const item = packages.find(input => input.name === name);
      assert(item, `${octaneCandidate}: no pinned ${name}`);
      const { version, url, integrity } = item;
      return { name, version, url, integrity };
    };
    pinned = {
      directory: here,
      source,
      octane: entry('octane'),
      adapter: entry('@octanejs/tanstack-router'),
    };
  } else {
    const directory = path.join(here, octaneCandidate);
    const { upstream } = JSON.parse(
      fs.readFileSync(path.join(directory, 'provenance.json'), 'utf8'),
    );
    const entry = name => {
      const item = upstream.packages?.[name];
      assert(item, `${octaneCandidate}: provenance has no ${name}`);
      assert.equal(
        upstream.tags?.[`${name}@${item.version}`],
        upstream.commit,
        `${octaneCandidate}: ${name}@${item.version} is not tagged at the owning source`,
      );
      const { version, url, integrity } = item;
      return { name, version, url, integrity };
    };
    pinned = {
      directory,
      source: {
        commit: upstream.commit,
        sha256: upstream.sourceArchive.sha256,
        url: upstream.sourceArchive.url,
      },
      octane: entry('octane'),
      adapter: entry('@octanejs/tanstack-router'),
    };
  }
  assert.equal(pinned.octane.version, contract.octaneVersion);
  assert.equal(pinned.adapter.version, contract.adapterVersion);
  assert.equal(
    pinned.octane.url,
    `https://registry.npmjs.org/octane/-/octane-${contract.octaneVersion}.tgz`,
  );
  assert.equal(
    pinned.adapter.url,
    `https://registry.npmjs.org/@octanejs/tanstack-router/-/tanstack-router-${contract.adapterVersion}.tgz`,
  );
  for (const item of [pinned.octane, pinned.adapter])
    assert.match(item.integrity, integrityPattern, `${item.name} integrity`);
  assert.match(pinned.source.commit, /^[0-9a-f]{40}$/);
  assert.match(pinned.source.sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    pinned.source.url,
    `https://codeload.github.com/octanejs/octane/tar.gz/${pinned.source.commit}`,
  );
  const runtimeBuild = JSON.parse(
    fs.readFileSync(path.join(pinned.directory, 'runtime-build-package.json')),
  );
  assert.equal(
    runtimeBuild.dependencies?.octane,
    contract.octaneVersion,
    `${octaneCandidate}: adapter must qualify against the octane its owning runtime build pins`,
  );
  return Object.freeze({
    candidate: octaneCandidate,
    ...contract,
    source: Object.freeze(pinned.source),
    octane: Object.freeze(pinned.octane),
    adapter: Object.freeze(pinned.adapter),
  });
}

/**
 * The integrity pnpm verified for the exact registry tarball name@version.
 * Every lockfile document is scanned; exactly one resolved entry must exist.
 */
export function lockedIntegrity(lock, name, version) {
  const lines = lock.split(/\r?\n/);
  const key = `${name}@${version}`;
  const found = [];
  for (let index = 0; index < lines.length; index++) {
    const heading = /^ {2}(\S.*):$/.exec(lines[index]);
    if (!heading || heading[1].replace(/^(['"])(.*)\1$/, '$2') !== key)
      continue;
    const resolution =
      /^ {4}resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)[,}]/.exec(
        lines[index + 1] ?? '',
      );
    if (resolution) found.push(resolution[1]);
  }
  assert.equal(found.length, 1, `${key}: expected one locked registry tarball`);
  return found[0];
}

// Both byte buffers are the actual transported archives on packed qualification.
export function qualifySharedCorePeer({
  work,
  adapterBytes,
  coreBytes,
  run,
  disk,
  register,
  pnpm = process.env.NATIVE_RUNTIME_PNPM,
  octaneCandidate = defaultOctaneCandidate,
}) {
  // An unknown candidate is rejected before any process, file or install.
  const pinned = pinnedAdapterCandidate(octaneCandidate);
  assert(
    path.isAbsolute(pnpm ?? ''),
    'NATIVE_RUNTIME_PNPM must name pnpm 12.21.0',
  );
  assert.equal(
    run(pnpm, ['--version'], work, { encoding: 'utf8', stdio: 'pipe' }).trim(),
    '12.21.0',
  );
  const adapterPackage = inspectNpmTarball(adapterBytes).packageJson;
  assertSharedCoreManifest(adapterPackage, octaneCandidate);
  const coreManifest = inspectNpmTarball(coreBytes).packageJson;
  assert.equal(coreManifest.name, '@tanstack/router-core');
  assert.equal(coreManifest.version, sharedCoreVersion);
  assert.equal(
    adapterPackage.peerDependencies['@tanstack/router-core'],
    coreManifest.version,
    'Adapter peer must name the exact supplied shared core',
  );
  const root = path.join(work, 'shared-core-install');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'adapter.tgz'), adapterBytes);
  fs.writeFileSync(path.join(root, 'core.tgz'), coreBytes);
  const manifest = {
    private: true,
    dependencies: {
      '@octanejs/tanstack-router': 'file:./adapter.tgz',
      '@tanstack/router-core': 'file:./core.tgz',
      octane: pinned.octane.version,
    },
  };
  const write = value =>
    fs.writeFileSync(
      path.join(root, 'package.json'),
      `${JSON.stringify(value, null, 2)}\n`,
    );
  write(manifest);
  // No overrides, packageExtensions, hooks or root registry replacement.
  fs.writeFileSync(
    path.join(root, 'pnpm-workspace.yaml'),
    'packages: []\npackageImportMethod: clone-or-copy\nautoInstallPeers: false\n',
  );
  const install = frozen => {
    disk();
    register(path.join(root, 'node_modules'), 'dependencies');
    try {
      run(
        pnpm,
        [
          'install',
          '--ignore-scripts',
          '--strict-peer-dependencies',
          '--config.manage-package-manager-versions=false',
          '--store-dir',
          path.join(process.env.HOME, '.local/share/pnpm/store'),
          '--config.package-import-method=clone-or-copy',
          ...(frozen ? ['--frozen-lockfile'] : []),
        ],
        root,
      );
    } finally {
      if (fs.existsSync(path.join(root, 'node_modules')))
        register(path.join(root, 'node_modules'), 'dependencies');
    }
  };
  const singleton = () => {
    const app = createRequire(path.join(root, 'package.json'));
    const adapterManifest = app.resolve(
      '@octanejs/tanstack-router/package.json',
    );
    const adapter = createRequire(adapterManifest);
    const actual = adapter.resolve('@tanstack/router-core');
    assert.equal(
      fs.realpathSync(actual),
      fs.realpathSync(app.resolve('@tanstack/router-core')),
      'Adapter must physically resolve the application core',
    );
    const entries = fs.readdirSync(path.join(root, 'node_modules/.pnpm'));
    const cores = entries.filter(entry =>
      entry.startsWith('@tanstack+router-core@'),
    );
    assert.equal(cores.length, 1, `Unexpected duplicate core: ${cores}`);
    assert(
      cores[0].includes('file+'),
      'Core must be the supplied corrected archive, not registry',
    );
    // The adapter's octane peer is the application's one pinned runtime.
    const appOctane = fs.realpathSync(path.join(root, 'node_modules/octane'));
    assert.equal(
      fs.realpathSync(path.join(path.dirname(adapterManifest), '../../octane')),
      appOctane,
      'Adapter must physically resolve the application octane',
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(appOctane, 'package.json'))).version,
      pinned.octane.version,
    );
    for (const entry of entries.filter(entry => entry.startsWith('octane@')))
      assert(
        entry === `octane@${pinned.octane.version}` ||
          entry.startsWith(`octane@${pinned.octane.version}_`),
        `Unexpected octane runtime: ${entry}`,
      );
    assert.equal(
      lockedIntegrity(
        fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'),
        'octane',
        pinned.octane.version,
      ),
      pinned.octane.integrity,
      `octane@${pinned.octane.version} is not the pinned npm tarball`,
    );
    console.log(
      `Shared core singleton: ${path.relative(root, fs.realpathSync(actual))}`,
    );
  };
  install(false);
  singleton();
  const lock = fs.readFileSync(path.join(root, 'pnpm-lock.yaml'));
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
  install(true);
  singleton();
  assert.deepEqual(fs.readFileSync(path.join(root, 'pnpm-lock.yaml')), lock);
  // A real registry core with a different version must fail, not silently install
  // a second exact peer. Peer auto-install stays off as in the positive control.
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
  fs.unlinkSync(path.join(root, 'pnpm-lock.yaml'));
  manifest.dependencies['@tanstack/router-core'] = '1.171.34';
  write(manifest);
  let failure;
  try {
    install(false);
  } catch (error) {
    failure = error;
  }
  assert(failure, 'Strict wrong-core peer unexpectedly installed');
  const output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
  assert.match(output, /ERR_PNPM_PEER_DEP_ISSUES/);
  assert.match(output, /1\.171\.39/);
  assert.match(output, /@tanstack\/router-core/);
  assert.match(output, /1\.171\.34/);
  console.log(
    `${octaneCandidate} adapter ${pinned.adapterVersion}: shared core normal + fresh frozen + strict wrong-peer controls PASS`,
  );
  return { adapterManifest: adapterPackage, coreManifest };
}
