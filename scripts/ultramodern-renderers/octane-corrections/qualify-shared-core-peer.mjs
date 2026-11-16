import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { inspectNpmTarball } from '../../ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import { assertSharedCoreManifest } from './shared-core-peer.mjs';

// Both byte buffers are the actual transported archives on packed qualification.
export function qualifySharedCorePeer({
  work,
  adapterBytes,
  coreBytes,
  run,
  disk,
  register,
  pnpm = process.env.NATIVE_RUNTIME_PNPM,
}) {
  assert(
    path.isAbsolute(pnpm ?? ''),
    'NATIVE_RUNTIME_PNPM must name pnpm 12.21.0',
  );
  assert.equal(
    run(pnpm, ['--version'], work, { encoding: 'utf8', stdio: 'pipe' }).trim(),
    '12.21.0',
  );
  assertSharedCoreManifest(inspectNpmTarball(adapterBytes).packageJson);
  const coreManifest = inspectNpmTarball(coreBytes).packageJson;
  assert.equal(coreManifest.name, '@tanstack/router-core');
  assert.equal(coreManifest.version, '1.171.39');
  const root = path.join(work, 'shared-core-install');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'adapter.tgz'), adapterBytes);
  fs.writeFileSync(path.join(root, 'core.tgz'), coreBytes);
  const manifest = {
    private: true,
    dependencies: {
      '@octanejs/tanstack-router': 'file:./adapter.tgz',
      '@tanstack/router-core': 'file:./core.tgz',
      octane: '0.18.0',
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
    'Shared core normal + fresh frozen + strict wrong-peer controls PASS',
  );
}
