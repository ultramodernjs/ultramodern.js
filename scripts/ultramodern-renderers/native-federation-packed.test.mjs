import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  packedNativeFederationManifest,
  retirePackedNativeFederationInstaller,
  runPackedNativeFederationCommand,
  runPackedNativeFederationProof,
  verifyPackedNativeFederationDependencies,
  verifyPackedNativeFederationInputs,
} from './native-federation-packed.mjs';

assert(
  process.env.OWNED_TEMP_DIR,
  'Run these filesystem tests through owned-temp-dir',
);

function fixture() {
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'packed-native-mf-'),
  );
  const appRoot = path.join(root, 'app');
  const store = path.join(appRoot, 'node_modules/.pnpm');
  const targetName = '@bleedingdev/modern-js-renderer-octane';
  const sourceName = '@modern-js/renderer-octane';
  const directory = path.join(store, 'renderer@1', 'node_modules', targetName);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: targetName, version: '1.0.0' }),
  );
  fs.writeFileSync(
    path.join(directory, 'index.mjs'),
    'export const native = true;\n',
  );
  const files = ['package.json', 'index.mjs'].map(filename => {
    const bytes = fs.readFileSync(path.join(directory, filename));
    return {
      path: filename,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
  const cohort = {
    artifacts: [{ sourceName, targetName, version: '1.0.0', files }],
  };
  fs.writeFileSync(
    path.join(appRoot, 'package.json'),
    JSON.stringify({
      dependencies: { [sourceName]: `npm:${targetName}@1.0.0` },
    }),
  );
  const link = path.join(appRoot, 'node_modules', sourceName);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(directory, link, 'dir');
  return { root, appRoot, directory, link, cohort, sourceName };
}

function externalPackage(supplied, name, version, request = version) {
  const directory = path.join(
    supplied.appRoot,
    'node_modules/.pnpm',
    `${encodeURIComponent(name)}@${version}`,
    'node_modules',
    name,
  );
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name, version }),
  );
  const link = path.join(supplied.appRoot, 'node_modules', name);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(directory, link, 'dir');
  const manifestPath = path.join(supplied.appRoot, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.dependencies[name] = request;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return directory;
}

test('authenticates a normal pnpm alias and rejects a changed installed module', () => {
  const supplied = fixture();
  try {
    assert.equal(
      verifyPackedNativeFederationDependencies(supplied)[supplied.sourceName],
      supplied.directory,
    );
    fs.writeFileSync(
      path.join(supplied.directory, 'index.mjs'),
      'export const native = false;\n',
    );
    assert.throws(
      () => verifyPackedNativeFederationDependencies(supplied),
      /differs from its tarball/u,
    );
  } finally {
    fs.rmSync(supplied.root, { recursive: true });
  }
});

test('retires a witnessed live installer before retiring its descendants', async () => {
  const pid = 12345;
  const uid = process.geteuid();
  const startTime = 'Mon Oct 5 12:00:00 2026';
  let live = true;
  const events = [];
  await retirePackedNativeFederationInstaller(
    { pid, uid, startTime },
    {
      inspectGroup: () => ({ members: [{ pid, uid, live }] }),
      readStartTime: () => startTime,
      kill: (group, signal) => {
        events.push([group, signal]);
        live = false;
      },
      retireClosedGroup: async group => {
        assert.equal(live, false);
        events.push(['retired', group]);
      },
    },
  );
  assert.deepEqual(events, [
    [-pid, 'SIGTERM'],
    ['retired', pid],
  ]);
});

test('refuses a reused installer PID without signaling it', async () => {
  const pid = 12345;
  const uid = process.geteuid();
  let signaled = false;
  await assert.rejects(
    retirePackedNativeFederationInstaller(
      { pid, uid, startTime: 'original process' },
      {
        inspectGroup: () => ({ members: [{ pid, uid, live: true }] }),
        readStartTime: () => 'another process',
        kill: () => {
          signaled = true;
        },
      },
    ),
    /PID now belongs to another process/u,
  );
  assert.equal(signaled, false);
});

test('accepts a leader that exits between the group and start-time inspections', async () => {
  const pid = 12345;
  const uid = process.geteuid();
  let live = true;
  let retired = false;
  await retirePackedNativeFederationInstaller(
    { pid, uid, startTime: 'original process' },
    {
      inspectGroup: () => ({ members: [{ pid, uid, live }] }),
      readStartTime: () => {
        live = false;
        throw Object.assign(new Error('ps reports no process'), {
          status: 1,
          stdout: '',
          stderr: '',
          signal: null,
        });
      },
      kill: () => {
        assert.fail('Exited installer must not be signaled');
      },
      retireClosedGroup: async () => {
        retired = true;
      },
    },
  );
  assert.equal(retired, true);
});

test('stops a real owned process group with a live installer leader', async () => {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import { execFileSync } from 'node:child_process';
const startTime = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
process.stdout.write(JSON.stringify({ pid: process.pid, uid: process.geteuid(), startTime }) + '\\n');
setInterval(() => {}, 10_000);
`,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const closed = once(child, 'close');
  closed.catch(() => {});
  let timer;
  try {
    const witness = await new Promise((resolve, reject) => {
      let output = '';
      timer = setTimeout(
        () => reject(new Error('Installer witness was not written')),
        2000,
      );
      child.once('error', reject);
      child.stdout.on('data', bytes => {
        output += bytes;
        if (output.includes('\n')) {
          try {
            resolve(JSON.parse(output.trim()));
          } catch (error) {
            reject(error);
          }
        }
      });
    });
    clearTimeout(timer);
    const retirement = await retirePackedNativeFederationInstaller(witness);
    await closed;
    assert.equal((retirement.after ?? retirement.before).liveMemberCount, 0);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await closed.catch(() => {});
  }
});

test('witnessed commands preserve arguments, status, and retired process groups', async () => {
  const supplied = fixture();
  try {
    const log = path.join(supplied.root, 'command.log');
    const witness = path.join(supplied.root, 'command-process.json');
    const result = await runPackedNativeFederationCommand(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'console.log(process.argv[1])',
        'argument with spaces',
      ],
      {
        cwd: supplied.appRoot,
        env: process.env,
        log,
        witness,
        signal: new AbortController().signal,
      },
    );
    const processWitness = JSON.parse(fs.readFileSync(witness, 'utf8'));
    assert.equal(result.exitCode, 0);
    assert.equal(processWitness.pid, result.pid);
    assert.equal(processWitness.uid, process.geteuid());
    assert(processWitness.startTime);
    assert.equal(fs.readFileSync(log, 'utf8').trim(), 'argument with spaces');
    assert.equal(
      (result.processGroupCleanup.after ?? result.processGroupCleanup.before)
        .liveMemberCount,
      0,
    );
    await assert.rejects(
      runPackedNativeFederationCommand(
        process.execPath,
        ['-e', 'process.exit(7)'],
        {
          cwd: supplied.appRoot,
          env: process.env,
          log: path.join(supplied.root, 'failed-command.log'),
          witness: path.join(supplied.root, 'failed-command-process.json'),
          signal: new AbortController().signal,
        },
      ),
      error => error.code === 'ERR_ASSERTION' && error.actual === 7,
    );
  } finally {
    fs.rmSync(supplied.root, { recursive: true });
  }
});

test('witness directories record the actual command child PID', async () => {
  const supplied = fixture();
  try {
    const witnessDirectory = path.join(supplied.root, 'process-witnesses');
    fs.mkdirSync(witnessDirectory);
    const result = await runPackedNativeFederationCommand(
      process.execPath,
      ['-e', 'console.log("actual child")'],
      {
        cwd: supplied.appRoot,
        env: process.env,
        log: path.join(supplied.root, 'directory-command.log'),
        witnessDirectory,
        signal: new AbortController().signal,
      },
    );
    assert.deepEqual(fs.readdirSync(witnessDirectory), [`${result.pid}.json`]);
    const witness = JSON.parse(
      fs.readFileSync(path.join(witnessDirectory, `${result.pid}.json`)),
    );
    assert.equal(witness.pid, result.pid);
    assert.notEqual(witness.pid, process.pid);
    assert.equal(witness.uid, process.geteuid());
    assert(witness.startTime);
  } finally {
    fs.rmSync(supplied.root, { recursive: true });
  }
});

test('parent cleanup retires a detached group left by an exited proof', async () => {
  const supplied = fixture();
  const copiedWitness = path.join(supplied.root, 'child-process.json');
  try {
    const proofScript = path.join(supplied.root, 'exit-before-cleanup.mjs');
    fs.writeFileSync(
      proofScript,
      `
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { recordPackedNativeFederationProcess } from ${JSON.stringify(new URL('./native-federation-packed.mjs', import.meta.url).href)};
const input = JSON.parse(fs.readFileSync(process.env.ULTRAMODERN_MF_PACKED_CONTEXT, 'utf8'));
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10_000)'], { detached: true, stdio: 'ignore' });
const witness = path.join(process.env.OWNED_TEMP_DIR, 'process-witnesses', child.pid + '.json');
recordPackedNativeFederationProcess(witness, child.pid);
fs.copyFileSync(witness, input.copiedWitness);
process.exit(0);
`,
    );
    const workDir = path.join(supplied.root, 'proof');
    await runPackedNativeFederationProof({
      renderer: 'octane',
      consumerRoot: supplied.appRoot,
      manifestPath: path.join(supplied.root, 'unused-manifest.json'),
      pnpmExecutable: process.execPath,
      workDir,
      log: path.join(supplied.root, 'proof.log'),
      env: process.env,
      proofScript,
      contextExtras: { copiedWitness },
    });
    assert.equal(fs.existsSync(workDir), false);
    const retirement = await retirePackedNativeFederationInstaller(
      JSON.parse(fs.readFileSync(copiedWitness, 'utf8')),
    );
    assert.equal((retirement.after ?? retirement.before).liveMemberCount, 0);
  } finally {
    if (fs.existsSync(copiedWitness))
      await retirePackedNativeFederationInstaller(
        JSON.parse(fs.readFileSync(copiedWitness, 'utf8')),
      );
    fs.rmSync(supplied.root, { recursive: true });
  }
});

test('rejects an identical package linked outside this consumer install', () => {
  const supplied = fixture();
  try {
    const otherCheckout = path.join(supplied.root, 'other-checkout/renderer');
    fs.cpSync(supplied.directory, otherCheckout, { recursive: true });
    fs.unlinkSync(supplied.link);
    fs.symlinkSync(otherCheckout, supplied.link, 'dir');
    assert.throws(
      () => verifyPackedNativeFederationDependencies(supplied),
      /outside the packed consumer's pnpm store/u,
    );
  } finally {
    fs.rmSync(supplied.root, { recursive: true });
  }
});

test('rejects a package with another published identity', () => {
  const supplied = fixture();
  try {
    fs.writeFileSync(
      path.join(supplied.directory, 'package.json'),
      JSON.stringify({ name: '@unverified/renderer-octane', version: '1.0.0' }),
    );
    assert.throws(
      () => verifyPackedNativeFederationDependencies(supplied),
      /wrong installed package identity/u,
    );
  } finally {
    fs.rmSync(supplied.root, { recursive: true });
  }
});

test('rejects symlinked package-owned code even when its bytes match', () => {
  const supplied = fixture();
  try {
    const code = path.join(supplied.directory, 'index.mjs');
    const external = path.join(supplied.root, 'source.mjs');
    fs.copyFileSync(code, external);
    fs.unlinkSync(code);
    fs.symlinkSync(external, code);
    assert.throws(
      () => verifyPackedNativeFederationDependencies(supplied),
      /contains a symlink/u,
    );
  } finally {
    fs.rmSync(supplied.root, { recursive: true });
  }
});

test('rejects native package identity and version drift from the bootstrap install', () => {
  const supplied = fixture();
  try {
    const directory = externalPackage(supplied, 'octane', '0.7.1', '^0.7.0');
    const input = {
      ...supplied,
      packageIdentities: { octane: { name: 'octane', version: '0.7.1' } },
    };
    assert.equal(
      verifyPackedNativeFederationDependencies(input).octane,
      directory,
    );
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: 'another-runtime', version: '0.7.1' }),
    );
    assert.throws(
      () => verifyPackedNativeFederationDependencies(input),
      /wrong installed package identity/u,
    );
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: 'octane', version: '0.7.2' }),
    );
    assert.throws(
      () => verifyPackedNativeFederationDependencies(input),
      /differs from the packed consumer's installed version/u,
    );
  } finally {
    fs.rmSync(supplied.root, { recursive: true });
  }
});

test('uses candidate aliases and preserves maintained Octane downloads and tooling pins', () => {
  const supplied = fixture();
  try {
    const typescript = externalPackage(supplied, 'typescript', '7.0.0-test');
    const nodeTypes = externalPackage(supplied, '@types/node', '26.0.0');
    const context = {
      cohort: supplied.cohort,
      packageRequests: {
        octane:
          'https://github.com/bleedingdev/octane/releases/download/test/octane.tgz',
        '@module-federation/enhanced': '2.9.2',
        '@tsrx/oxc': '0.20.0',
        typescript: '7.0.0-test',
        '@types/node': '26.0.0',
      },
      packageRoots: {
        typescript,
        '@types/node': nodeTypes,
      },
    };
    const manifest = packedNativeFederationManifest(
      {
        dependencies: {
          [supplied.sourceName]: 'workspace',
          octane: '0.7.1',
          '@module-federation/enhanced': '2.9.1',
          '@tsrx/oxc': '0.19.0',
        },
      },
      context,
    );
    assert.equal(
      manifest.dependencies[supplied.sourceName],
      'npm:@bleedingdev/modern-js-renderer-octane@1.0.0',
    );
    assert.equal(manifest.dependencies.octane, context.packageRequests.octane);
    assert.equal(manifest.dependencies['@module-federation/enhanced'], '2.9.2');
    assert.equal(manifest.dependencies['@tsrx/oxc'], '0.20.0');
    assert.throws(
      () =>
        packedNativeFederationManifest(
          { dependencies: { '@tsrx/oxc': '0.20.0' } },
          { ...context, packageRequests: {} },
        ),
      /missing the @tsrx\/oxc dependency pin/u,
    );
    assert.equal(manifest.devDependencies.typescript, '7.0.0-test');
    assert.throws(
      () =>
        packedNativeFederationManifest(
          { dependencies: { '@modern-js/missing-renderer': 'workspace:*' } },
          context,
        ),
      /Packed cohort is missing/u,
    );
    assert.throws(
      () =>
        packedNativeFederationManifest(
          { dependencies: { octane: 'link:../octane' } },
          {
            ...context,
            packageRequests: {
              ...context.packageRequests,
              octane: 'link:../octane',
            },
          },
        ),
      /cannot use a source dependency/u,
    );
    assert.throws(
      () =>
        packedNativeFederationManifest(
          { dependencies: { octane: '0.7.1' } },
          { ...context, packageRequests: {} },
        ),
      /missing the octane dependency pin/u,
    );
  } finally {
    fs.rmSync(supplied.root, { recursive: true });
  }
});

test('retains an explicitly supplied core archive in real host and remote fixture manifests', async () => {
  const { createOctaneFederationFixtures } = await import(
    '../../tests/ultramodern-renderers/octane-federation/fixtures.mjs'
  );
  const supplied = fixture();
  try {
    const typescript = externalPackage(supplied, 'typescript', '7.0.0-test');
    const nodeTypes = externalPackage(supplied, '@types/node', '26.0.0');
    const fixtures = createOctaneFederationFixtures({
      remoteUrl: 'http://127.0.0.1:4101',
      failures: false,
      development: true,
    });
    for (const files of [fixtures.host, fixtures.remote]) {
      const manifest = JSON.parse(files['package.json']);
      const packageRequests = Object.fromEntries(
        Object.keys(manifest.dependencies).map(name => [name, '1.0.0']),
      );
      const context = {
        cohort: { artifacts: [] },
        packageRequests: {
          ...packageRequests,
          typescript: '7.0.0-test',
          '@types/node': '26.0.0',
        },
        packageRoots: { typescript, '@types/node': nodeTypes },
      };
      // Supply genuine cohort identities for the framework fixture declarations.
      context.cohort.artifacts = Object.keys(manifest.dependencies)
        .filter(name => name.startsWith('@modern-js/'))
        .map(sourceName => ({
          sourceName,
          targetName: sourceName,
          version: '1.0.0',
        }));
      const core =
        'https://github.com/BleedingDev/router/releases/download/accepted/tanstack-router-core.tgz';
      context.packageRequests['@tanstack/router-core'] = core;
      assert.equal(
        packedNativeFederationManifest(manifest, context).dependencies[
          '@tanstack/router-core'
        ],
        core,
      );
      delete context.packageRequests['@tanstack/router-core'];
      assert.equal(
        Object.hasOwn(
          packedNativeFederationManifest(manifest, context).dependencies,
          '@tanstack/router-core',
        ),
        false,
      );
    }
  } finally {
    fs.rmSync(supplied.root, { recursive: true });
  }
});

test('checks every supplied native byte and rejects a second physical core before dev starts', () => {
  const supplied = fixture();
  try {
    const inputs = {};
    const directories = {};
    for (const name of [
      'octane',
      '@octanejs/tanstack-router',
      '@octanejs/rspack-plugin',
      '@tanstack/router-core',
    ]) {
      const request = `https://example.test/${encodeURIComponent(name)}.tgz`;
      const directory = externalPackage(supplied, name, '1.0.0', request);
      directories[name] = directory;
      fs.writeFileSync(
        path.join(directory, 'index.mjs'),
        'export const native = true;\n',
      );
      const archiveRoot = path.join(supplied.root, encodeURIComponent(name));
      fs.mkdirSync(archiveRoot);
      fs.cpSync(directory, path.join(archiveRoot, 'package'), {
        recursive: true,
      });
      const archivePath = path.join(archiveRoot, 'candidate.tgz');
      execFileSync('tar', ['-czf', archivePath, '-C', archiveRoot, 'package'], {
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      });
      inputs[name] = {
        request,
        archivePath,
        integrity: `sha512-${createHash('sha512').update(fs.readFileSync(archivePath)).digest('base64')}`,
      };
    }
    const adapterModules = path.join(
      directories['@octanejs/tanstack-router'],
      'node_modules/@tanstack',
    );
    fs.mkdirSync(adapterModules, { recursive: true });
    const coreLink = path.join(adapterModules, 'router-core');
    fs.symlinkSync(directories['@tanstack/router-core'], coreLink, 'dir');
    verifyPackedNativeFederationInputs(supplied.appRoot, inputs);
    const nativeFile = path.join(directories.octane, 'index.mjs');
    fs.writeFileSync(nativeFile, 'export const native = false;\n');
    assert.throws(
      () => verifyPackedNativeFederationInputs(supplied.appRoot, inputs),
      /differs from its tarball/u,
    );
    fs.writeFileSync(nativeFile, 'export const native = true;\n');
    assert.throws(
      () =>
        verifyPackedNativeFederationInputs(supplied.appRoot, {
          ...inputs,
          octane: { ...inputs.octane, integrity: `sha512-${'A'.repeat(88)}` },
        }),
      /supplied archive integrity/u,
    );
    const rendererCoreLink = path.join(
      supplied.directory,
      'node_modules/@tanstack/router-core',
    );
    fs.mkdirSync(path.dirname(rendererCoreLink), { recursive: true });
    const rendererDuplicate = path.join(
      supplied.root,
      'renderer-duplicate-core',
    );
    fs.cpSync(directories['@tanstack/router-core'], rendererDuplicate, {
      recursive: true,
    });
    fs.symlinkSync(rendererDuplicate, rendererCoreLink, 'dir');
    const verifyInFreshProcess = () =>
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { verifyPackedNativeFederationInputs } from ${JSON.stringify(new URL('./native-federation-packed.mjs', import.meta.url).href)}; verifyPackedNativeFederationInputs(process.argv[1], JSON.parse(process.argv[2]));`,
          supplied.appRoot,
          JSON.stringify(inputs),
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
    assert.throws(
      verifyInFreshProcess,
      /Octane renderer must resolve the application's physical @tanstack\/router-core/u,
    );
    fs.unlinkSync(rendererCoreLink);
    fs.unlinkSync(coreLink);
    const duplicate = path.join(supplied.root, 'duplicate-core');
    fs.cpSync(directories['@tanstack/router-core'], duplicate, {
      recursive: true,
    });
    fs.symlinkSync(duplicate, coreLink, 'dir');
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import { verifyPackedNativeFederationInputs } from ${JSON.stringify(new URL('./native-federation-packed.mjs', import.meta.url).href)}; verifyPackedNativeFederationInputs(process.argv[1], JSON.parse(process.argv[2]));`,
            supplied.appRoot,
            JSON.stringify(inputs),
          ],
          { encoding: 'utf8', stdio: 'pipe' },
        ),
      /one physical router core/u,
    );
  } finally {
    fs.rmSync(supplied.root, { recursive: true });
  }
});
