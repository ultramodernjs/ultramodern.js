import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { parse } from 'yaml';
import { createTemplateRequiredFiles } from '../../ultramodern-publish/lib/prepare-bleedingdev-packages/constants.mjs';
import {
  canonicalJson,
  inspectNpmTarball,
  readVerifiedPackageArtifactBytes,
  verifySidecarArtifacts,
} from '../../ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import {
  confinedPath,
  fileEvidence,
  materializeFixtureSources,
  ordinaryFiles,
  parseArgs,
  releaseConsumerInputs,
  workerOptions,
} from './contract.mjs';
import { runCommand } from './main.mjs';
import { retireOwnedProcessGroup } from './runtime.mjs';

function ownedDirectory(t) {
  const parent = process.env.ULTRAMODERN_RSC_WORKER_PROOF_TEST_ROOT;
  assert(
    parent && path.isAbsolute(parent),
    'Set ULTRAMODERN_RSC_WORKER_PROOF_TEST_ROOT to an owned, registered test parent',
  );
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(parent), 'rsc-worker-contract-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relative, contents = 'export default {};\n') {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

test('a failed command preserves its bounded diagnostic tail before its workspace retires', async t => {
  const root = ownedDirectory(t);
  const log = path.join(root, 'failure.log');
  await assert.rejects(
    runCommand(
      process.execPath,
      [
        '-e',
        'process.stdout.write("omitted-start\\n" + "x".repeat(32768) + "\\nactual nested failure\\n"); process.exitCode = 7;',
      ],
      { cwd: root, env: process.env, log, signal: t.signal },
    ),
    error => {
      assert.equal(error.actual, 7);
      assert.equal(error.expected, 0);
      assert.match(error.message, /actual nested failure/u);
      assert.doesNotMatch(error.message, /omitted-start/u);
      assert(error.message.length < 17 * 1024);
      return true;
    },
  );
});

for (const exitCode of [7, 0]) {
  test(`owned command preserves exit ${exitCode} semantics when group cleanup is denied`, {
    timeout: 10_000,
  }, async t => {
    const root = ownedDirectory(t);
    const log = path.join(root, 'command.log');
    const cleanupErrors = [];
    const denied = Object.assign(new Error('Owned group signal denied'), {
      code: 'EPERM',
    });
    const kill = t.mock.method(process, 'kill', (pid, signal) => {
      const { groupId } = JSON.parse(fs.readFileSync(log, 'utf8'));
      assert(Number.isSafeInteger(groupId) && groupId > 0);
      assert.equal(pid, -groupId, 'Only the actual owned group is signalled');
      assert.equal(signal, 'SIGKILL');
      throw denied;
    });
    try {
      await assert.rejects(
        runCommand(
          process.execPath,
          [
            '-e',
            `const descendant = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); require("node:fs").writeSync(3, "ready");'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
descendant.once('error', error => { throw error; });
descendant.stdio[3].once('data', ready => {
  if (ready.toString() !== 'ready') throw new Error('Invalid descendant readiness');
  require('node:fs').writeSync(1, JSON.stringify({ groupId: process.pid, descendantPid: descendant.pid }));
  descendant.unref();
  process.exit(${exitCode});
});`,
          ],
          {
            cwd: root,
            env: process.env,
            log,
            signal: t.signal,
            cleanupErrors,
          },
        ),
        error => {
          assert.notEqual(error, denied);
          assert.equal(error.name, 'AssertionError');
          if (exitCode) {
            assert.equal(error.actual, exitCode);
            assert.equal(error.expected, 0);
            assert.match(error.message, /Command failed; see/u);
          } else assert.match(error.message, /Owned command cleanup failed/u);
          return true;
        },
      );
      const { groupId, descendantPid } = JSON.parse(
        fs.readFileSync(log, 'utf8'),
      );
      assert.equal(
        kill.mock.callCount(),
        1,
        JSON.stringify({
          groupId,
          descendantPid,
          cleanupErrors,
        }),
      );
      assert.equal(cleanupErrors.length, 1);
      const [error] = cleanupErrors;
      assert.equal(error.name, denied.name);
      assert.equal(error.message, denied.message);
      assert.equal(error.code, 'EPERM');
      assert.equal(error.signal, 'SIGKILL');
      assert.equal(error.pid, groupId);
      assert.equal(error.exitCode, exitCode);
      assert.equal(error.terminatedBy, null);
      assert.equal(error.membership.before.groupId, groupId);
      assert(error.membership.before.liveMemberCount > 0);
      assert(
        error.membership.before.members.some(
          member =>
            member.pid === descendantPid &&
            member.live &&
            member.uid === process.geteuid(),
        ),
      );
    } finally {
      kill.mock.restore();
      if (fs.existsSync(log) && fs.statSync(log).size) {
        const { groupId } = JSON.parse(fs.readFileSync(log, 'utf8'));
        await retireOwnedProcessGroup(groupId);
      }
    }
  });
}

test('owned command retains a spawn failure without signalling a nonexistent process', async t => {
  const root = ownedDirectory(t);
  const cleanupErrors = [];
  const kill = t.mock.method(process, 'kill', () => {
    assert.fail('A failed spawn has no owned process group');
  });
  await assert.rejects(
    runCommand(path.join(root, 'missing-command'), [], {
      cwd: root,
      env: process.env,
      log: path.join(root, 'command.log'),
      signal: new AbortController().signal,
      cleanupErrors,
    }),
    { code: 'ENOENT' },
  );
  assert.equal(kill.mock.callCount(), 0);
  assert.deepEqual(cleanupErrors, []);
});

function args(root, overrides = {}) {
  return Object.entries({
    '--manifest': path.join(root, 'release', 'manifest.json'),
    '--expected-source-revision': 'a'.repeat(40),
    '--expected-version': '3.9.0-ultramodern.1',
    '--work-dir': root,
    '--receipt': path.join(root, 'receipt.json'),
    '--store-dir': path.join(root, 'shared-store'),
    '--browser-executable': path.join(root, 'browser'),
    '--owner': 'rsc-worker-contract-test',
    '--owner-pid': String(process.pid),
    ...overrides,
  }).flat();
}

function workerFixture(t) {
  const root = ownedDirectory(t);
  const output = path.join(root, 'output');
  write(output, 'worker/main.mjs');
  write(output, 'worker/chunk.js');
  write(output, 'worker/chunk.js.map', '{}');
  write(output, 'server/nested/render.cjs', 'module.exports = {};\n');
  write(output, 'server/runtime.mjs');
  write(output, 'public/index.html', '<!doctype html>');
  return {
    root,
    output,
    wrangler: {
      name: 'react-rsc-worker',
      main: './worker/main.mjs',
      compatibility_date: '2026-09-21',
      compatibility_flags: ['nodejs_compat', 'streams_enable_constructors'],
      assets: {
        directory: './public',
        binding: 'ASSETS',
        run_worker_first: true,
      },
    },
  };
}

// These tiny archives exercise the real artifact reader. They are unit inputs,
// not a production capture or evidence that a renderer package works.
function tarBytes(files) {
  const blocks = [];
  for (const [relative, contents] of Object.entries(files)) {
    const bytes = Buffer.from(contents);
    const header = Buffer.alloc(512);
    const name = `package/${relative}`;
    assert(Buffer.byteLength(name) < 100);
    header.write(name, 0, 100);
    header.write('0000644\0', 100, 8);
    header.write('0000000\0', 108, 8);
    header.write('0000000\0', 116, 8);
    header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    header.write('00000000000\0', 136, 12);
    header.fill(32, 148, 156);
    header.write('0', 156, 1);
    header.write('ustar\0', 257, 6);
    header.write('00', 263, 2);
    const checksum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function releaseFixture(
  t,
  {
    react = '19.3.0',
    reactDom = '19.3.0',
    builderRsc = '0.1.0',
    rscCompiler = '0.1.1',
    reactRouter = '7.18.4',
    renderRsc = '0.1.0',
    sidecars = [],
    toolsDependencies = {},
    policy = 'strictDepBuilds: true\nallowBuilds:\n  esbuild: true\n  sharp: false\n  workerd: true\n',
  } = {},
) {
  const root = ownedDirectory(t);
  const version = '3.9.0-ultramodern.1';
  const definitions = {
    'ultramodern-create': { dependencies: { react, 'react-dom': reactDom } },
    builder: {
      peerDependencies: {
        'react-server-dom-rspack': builderRsc,
        'rsbuild-plugin-rsc': rscCompiler,
      },
    },
    'plugin-tanstack': {
      dependencies: {
        '@tanstack/react-router': '1.170.44',
        '@tanstack/router-core': '1.171.37',
      },
      peerDependencies: { 'react-server-dom-rspack': '0.1.0' },
    },
    runtime: { dependencies: { 'react-router': reactRouter } },
    render: { peerDependencies: { 'react-server-dom-rspack': renderRsc } },
    tsconfig: {},
    'ultramodern-app-tools': { dependencies: toolsDependencies },
    'app-tools-extensions': {},
  };
  const packages = Object.entries(definitions).map(([name, definition]) => {
    const sourceName = `@modern-js/${name}`;
    const targetName = `@bleedingdev/modern-js-${name}`;
    const files = {
      'package.json': canonicalJson({
        name: targetName,
        version,
        publishConfig: { access: 'public' },
        ...definition,
      }),
      'index.js': 'export default {};\n',
    };
    if (name === 'ultramodern-create') {
      for (const relative of createTemplateRequiredFiles)
        files[relative] = 'unit fixture\n';
      files['template-workspace/pnpm-workspace.yaml.handlebars'] = policy;
    }
    const bytes = tarBytes(files);
    const inspection = inspectNpmTarball(bytes);
    const artifactPath = write(root, `${name}.tgz`, bytes);
    const digest = (algorithm, encoding = 'hex') =>
      crypto.createHash(algorithm).update(bytes).digest(encoding);
    const record = {
      sourceName,
      targetName,
      version,
      artifactPath,
      size: bytes.length,
      sha256: digest('sha256'),
      shasum: digest('sha1'),
      integrity: `sha512-${digest('sha512', 'base64')}`,
      fileCount: inspection.fileCount,
      unpackedSize: inspection.unpackedSize,
      packageJsonSha256: inspection.packageJsonSha256,
      fileListSha256: inspection.fileListSha256,
      packageJson: inspection.packageJson,
    };
    readVerifiedPackageArtifactBytes(record, artifactPath);
    return record;
  });
  let verifiedSidecars;
  if (sidecars.length > 0) {
    const records = sidecars.map(packageJson => {
      const name = packageJson.name.split('/')[1];
      const bytes = tarBytes({
        'package.json': canonicalJson(packageJson),
        'index.js': 'export default {};\n',
      });
      const inspection = inspectNpmTarball(bytes);
      const tarballPath = `sidecar-tarballs/${name}.tgz`;
      write(root, tarballPath, bytes);
      const digest = (algorithm, encoding = 'hex') =>
        crypto.createHash(algorithm).update(bytes).digest(encoding);
      return {
        name: packageJson.name,
        version: packageJson.version,
        root: `sidecars/${name}`,
        tarballPath,
        size: bytes.length,
        sha256: digest('sha256'),
        shasum: digest('sha1'),
        integrity: `sha512-${digest('sha512', 'base64')}`,
        fileCount: inspection.fileCount,
        unpackedSize: inspection.unpackedSize,
        packageJsonSha256: inspection.packageJsonSha256,
        fileListSha256: inspection.fileListSha256,
      };
    });
    const bytes = Buffer.from(
      `${canonicalJson(
        {
          schema: 'bleedingdev.ultramodern.sidecar-manifest',
          schemaVersion: 2,
          publishBefore: '@bleedingdev/modern-js-image',
          publishOrder: records.map(item => item.name),
          packages: records,
        },
        2,
      )}\n`,
    );
    write(root, 'sidecars.json', bytes);
    verifiedSidecars = verifySidecarArtifacts(root, {
      manifestPath: 'sidecars.json',
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return {
    root,
    release: {
      artifactRoot: root,
      sidecars: verifiedSidecars,
      packages,
      createPackage: packages.find(
        item => item.sourceName === '@modern-js/ultramodern-create',
      ),
      tools: { pnpm: '11.17.0' },
      release: { version },
    },
    template: JSON.parse(
      fs.readFileSync(
        new URL('./fixture/package.json.template', import.meta.url),
      ),
    ),
  };
}

test('arguments bind the expected release, tools, owner, and confined receipt', t => {
  const root = ownedDirectory(t);
  const options = parseArgs(args(root));
  assert.equal(
    options.manifestPath,
    path.join(root, 'release', 'manifest.json'),
  );
  assert.equal(options.expectedSourceRevision, 'a'.repeat(40));
  assert.equal(options.expectedVersion, '3.9.0-ultramodern.1');
  assert.equal(options.workDir, root);
  assert.equal(options.receipt, path.join(root, 'receipt.json'));
  assert.equal(options.storeDir, path.join(root, 'shared-store'));
  assert.equal(options.browserExecutable, path.join(root, 'browser'));
  assert.equal(options.owner, 'rsc-worker-contract-test');
  assert.equal(options.ownerPid, process.pid);
});

test('arguments reject unknown, duplicate, missing, and valueless options', t => {
  const root = ownedDirectory(t);
  const valid = args(root);
  assert.throws(
    () => parseArgs([...valid, '--force', 'true']),
    /Unknown argument/u,
  );
  assert.throws(
    () => parseArgs([...valid, '--owner', 'other']),
    /Duplicate argument/u,
  );
  for (let index = 0; index < valid.length; index += 2) {
    const without = [...valid.slice(0, index), ...valid.slice(index + 2)];
    assert.throws(() => parseArgs(without), /is required/u, valid[index]);
  }
  assert.throws(() => parseArgs([...valid.slice(0, -1)]), /requires a value/u);
  assert.throws(
    () => parseArgs(args(root, { '--owner': '--other' })),
    /requires a value/u,
  );
});

test('fixture continuation requires its explicit cursor and an absolute prior receipt', t => {
  const root = ownedDirectory(t);
  const priorReceipt = path.join(root, 'previous/receipt.json');
  const options = parseArgs(
    args(root, {
      '--continue-from': 'materialized-fixture',
      '--prior-receipt': priorReceipt,
    }),
  );
  assert.equal(options.continueFrom, 'materialized-fixture');
  assert.equal(options.priorReceipt, priorReceipt);
  for (const overrides of [
    { '--continue-from': 'materialized-fixture' },
    { '--prior-receipt': priorReceipt },
    { '--continue-from': 'build', '--prior-receipt': priorReceipt },
    {
      '--continue-from': 'materialized-fixture',
      '--prior-receipt': 'relative/receipt.json',
    },
  ])
    assert.throws(() => parseArgs(args(root, overrides)));
});

test('materializes the proof favicon through the ordinary public asset directory', t => {
  const fixtureRoot = path.join(import.meta.dirname, 'fixture');
  const consumer = path.join(ownedDirectory(t), 'consumer');
  const source = path.join(fixtureRoot, 'config/public/favicon.ico');
  const bytes = fs.readFileSync(source);
  assert.deepEqual(bytes.subarray(0, 4), Buffer.from([0, 0, 1, 0]));
  assert(
    bytes.readUInt16LE(4) > 0,
    'The fixture must contain a valid ICO image',
  );
  const { fixture } = materializeFixtureSources({ fixtureRoot, consumer });
  const evidence = fixture.find(
    item => item.path === 'config/public/favicon.ico',
  );
  assert(evidence, 'The published favicon must be recorded as a fixture input');
  assert.deepEqual(fileEvidence(source, fixtureRoot), evidence);
  const materialized = path.join(consumer, 'config/public/favicon.ico');
  assert.deepEqual(fileEvidence(materialized, consumer), evidence);
  assert.deepEqual(fs.readFileSync(materialized), bytes);
});

function priorFixture(t) {
  const root = ownedDirectory(t);
  const fixtureRoot = path.join(root, 'fixture');
  write(fixtureRoot, 'package.json.template', '{"name":"fixture"}\n');
  write(fixtureRoot, 'modern.config.ts', 'export default {};\n');
  write(
    fixtureRoot,
    'src/page.tsx',
    'export default () => <div>retained</div>;\n',
  );
  const sourceRoot = path.join(root, 'original/consumer');
  const { fixture } = materializeFixtureSources({
    fixtureRoot,
    consumer: sourceRoot,
  });
  const release = {
    source: { commit: 'a'.repeat(40) },
    release: { version: '3.9.0-ultramodern.1' },
    manifestSha256: 'b'.repeat(64),
    cohortDigest: 'c'.repeat(64),
  };
  const receipt = {
    schema: 'bleedingdev.ultramodern.react-rsc-workerd-proof',
    schemaVersion: 1,
    status: 'failed',
    sourceRevision: release.source.commit,
    releaseVersion: release.release.version,
    manifestSha256: release.manifestSha256,
    frameworkCohortDigest: release.cohortDigest,
    fixture,
    commands: [],
  };
  const priorReceipt = write(
    root,
    'original/receipt.json',
    `${JSON.stringify(receipt)}\n`,
  );
  return {
    fixtureRoot,
    sourceRoot,
    release,
    receipt,
    priorReceipt,
    consumer: path.join(root, 'continued/consumer'),
  };
}

test('fixture continuation copies recorded sources and attributes reuse while leaving dependency inputs for rematerialization', t => {
  const input = priorFixture(t);
  write(input.sourceRoot, 'package.json', '{"stale":"dependency input"}\n');
  write(input.sourceRoot, 'pnpm-workspace.yaml', 'overrides: {}\n');
  const result = materializeFixtureSources(input);
  assert.deepEqual(result.fixture, input.receipt.fixture);
  assert.equal(
    result.reusedFixture.qualification,
    'verified-prior-materialized-source-only',
  );
  assert.equal(result.reusedFixture.sourceRoot, input.sourceRoot);
  assert.deepEqual(
    Buffer.from(result.reusedFixture.priorReceipt.text),
    fs.readFileSync(input.priorReceipt),
  );
  for (const item of result.fixture.filter(
    item => item.path !== 'package.json.template',
  )) {
    assert.deepEqual(
      fileEvidence(path.join(input.consumer, item.path), input.consumer),
      item,
    );
    assert.deepEqual(
      fileEvidence(path.join(input.sourceRoot, item.path), input.sourceRoot),
      item,
    );
  }
  assert.equal(fs.existsSync(path.join(input.consumer, 'package.json')), false);
  assert.equal(
    fs.existsSync(path.join(input.consumer, 'pnpm-workspace.yaml')),
    false,
  );
});

test('fixture continuation rejects success, completed commands, foreign candidate identity and changed source inventory before copying', t => {
  for (const mutate of [
    receipt => {
      receipt.status = 'passed';
    },
    receipt => {
      receipt.commands.push({ exitCode: 0 });
    },
    receipt => {
      receipt.sourceRevision = 'd'.repeat(40);
    },
    receipt => {
      receipt.releaseVersion = '3.9.0-ultramodern.2';
    },
    receipt => {
      receipt.manifestSha256 = 'd'.repeat(64);
    },
    receipt => {
      receipt.frameworkCohortDigest = 'd'.repeat(64);
    },
    receipt => {
      receipt.fixture.pop();
    },
  ]) {
    const input = priorFixture(t);
    mutate(input.receipt);
    fs.writeFileSync(input.priorReceipt, JSON.stringify(input.receipt));
    assert.throws(() => materializeFixtureSources(input));
    assert.equal(fs.existsSync(input.consumer), false);
  }
});

test('fixture continuation rejects changed, missing and symlinked retained sources before copying', t => {
  for (const change of ['bytes', 'missing', 'symlink']) {
    const input = priorFixture(t);
    const file = path.join(input.sourceRoot, 'src/page.tsx');
    if (change === 'bytes') fs.appendFileSync(file, '// changed');
    else {
      fs.unlinkSync(file);
      if (change === 'symlink')
        fs.symlinkSync(path.join(input.fixtureRoot, 'src/page.tsx'), file);
    }
    assert.throws(() => materializeFixtureSources(input));
    assert.equal(fs.existsSync(input.consumer), false);
  }
});

test('arguments reject relative tool paths, malformed source identity, and invalid owner pid', t => {
  const root = ownedDirectory(t);
  for (const key of [
    '--manifest',
    '--work-dir',
    '--receipt',
    '--store-dir',
    '--browser-executable',
  ]) {
    assert.throws(
      () => parseArgs(args(root, { [key]: 'relative/path' })),
      /must be absolute/u,
    );
  }
  for (const revision of ['main', 'a'.repeat(39), 'g'.repeat(40)]) {
    assert.throws(() =>
      parseArgs(args(root, { '--expected-source-revision': revision })),
    );
  }
  for (const pid of ['0', '-1', '1.5', 'not-a-pid']) {
    assert.throws(() => parseArgs(args(root, { '--owner-pid': pid })));
  }
});

test('receipt paths cannot escape the owned work directory lexically', t => {
  const root = ownedDirectory(t);
  for (const receipt of [
    path.join(root, '..', 'receipt.json'),
    `${root}-sibling/receipt.json`,
  ]) {
    assert.throws(
      () => parseArgs(args(root, { '--receipt': receipt })),
      /escapes/u,
    );
  }
});

test('receipt paths cannot escape through a symlink ancestor', t => {
  const root = ownedDirectory(t);
  const work = path.join(root, 'work');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(work);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(work, 'receipts'), 'dir');
  assert.throws(
    () =>
      parseArgs(
        args(work, {
          '--receipt': path.join(work, 'receipts', 'receipt.json'),
        }),
      ),
    /symlink|escapes/u,
  );
});

test('confined paths reject absolute, parent, and sibling escapes', t => {
  const root = ownedDirectory(t);
  assert.equal(
    confinedPath(root, './worker/main.mjs'),
    path.join(root, 'worker/main.mjs'),
  );
  for (const relative of [
    '../main.mjs',
    `../${path.basename(root)}-sibling/main.mjs`,
  ]) {
    assert.throws(() => confinedPath(root, relative), /escapes/u);
  }
  assert.throws(
    () => confinedPath(root, path.join(root, 'main.mjs')),
    /must be relative/u,
  );
  assert.throws(() => confinedPath(root, ''));
});

test('file evidence records actual bytes under a portable relative path', t => {
  const root = ownedDirectory(t);
  const file = write(root, 'server/main.mjs', 'abc');
  assert.deepEqual(fileEvidence(file, root), {
    path: 'server/main.mjs',
    byteLength: 3,
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  });
});

test('file evidence cannot authenticate a file outside its root', t => {
  const root = ownedDirectory(t);
  const file = write(root, 'outside/main.mjs');
  const output = path.join(root, 'output');
  fs.mkdirSync(output);
  assert.throws(() => fileEvidence(file, output), /escapes|outside/u);
});

test('ordinary files enumerate nested inputs and reject symlink entries and roots', t => {
  const root = ownedDirectory(t);
  const directory = path.join(root, 'inputs');
  const first = write(directory, 'a.mjs');
  const second = write(directory, 'nested/b.cjs');
  assert.deepEqual(ordinaryFiles(directory), [first, second].sort());
  fs.symlinkSync(first, path.join(directory, 'alias.mjs'));
  assert.throws(() => ordinaryFiles(directory), /symlink/u);
  const linkedRoot = path.join(root, 'linked-inputs');
  fs.symlinkSync(directory, linkedRoot, 'dir');
  fs.rmSync(path.join(directory, 'alias.mjs'));
  assert.throws(() => ordinaryFiles(linkedRoot), /symlink/u);
});

test('worker options use emitted flags, assets routing, and all actual JavaScript modules', t => {
  const { output, wrangler } = workerFixture(t);
  const options = workerOptions(output, wrangler);
  assert.equal(options.name, wrangler.name);
  assert.equal(options.modulesRoot, output);
  assert.equal(options.compatibilityDate, wrangler.compatibility_date);
  assert.deepEqual(options.compatibilityFlags, wrangler.compatibility_flags);
  assert.deepEqual(options.assets, {
    binding: 'ASSETS',
    directory: path.join(output, 'public'),
    routerConfig: {
      has_user_worker: true,
      invoke_user_worker_ahead_of_assets: true,
    },
  });
  assert.deepEqual(options.modules, [
    { type: 'ESModule', path: path.join(output, 'worker/main.mjs') },
    { type: 'CommonJS', path: path.join(output, 'server/nested/render.cjs') },
    { type: 'ESModule', path: path.join(output, 'server/runtime.mjs') },
    { type: 'ESModule', path: path.join(output, 'worker/chunk.js') },
  ]);
  const assetsFirst = workerOptions(output, {
    ...wrangler,
    assets: { ...wrangler.assets, run_worker_first: false },
  });
  assert.equal(
    assetsFirst.assets.routerConfig.invoke_user_worker_ahead_of_assets,
    false,
  );
});

test('worker options reject escaped main and assets paths', t => {
  const { output, wrangler } = workerFixture(t);
  assert.throws(
    () => workerOptions(output, { ...wrangler, main: '../main.mjs' }),
    /escapes/u,
  );
  assert.throws(
    () =>
      workerOptions(output, {
        ...wrangler,
        assets: { ...wrangler.assets, directory: '../public' },
      }),
    /escapes/u,
  );
});

test('worker options reject symlink main files and main ancestors', t => {
  const { root, output, wrangler } = workerFixture(t);
  const outside = write(root, 'outside/main.mjs');
  fs.symlinkSync(outside, path.join(output, 'linked-main.mjs'));
  assert.throws(() =>
    workerOptions(output, { ...wrangler, main: './linked-main.mjs' }),
  );
  fs.symlinkSync(
    path.dirname(outside),
    path.join(output, 'linked-directory'),
    'dir',
  );
  assert.throws(
    () =>
      workerOptions(output, {
        ...wrangler,
        main: './linked-directory/main.mjs',
      }),
    /symlink|escapes/u,
  );
});

test('worker options reject symlink assets and module directory roots', t => {
  const { root, output, wrangler } = workerFixture(t);
  const external = path.join(root, 'external');
  write(external, 'module.mjs');
  fs.symlinkSync(external, path.join(output, 'linked-assets'), 'dir');
  assert.throws(
    () =>
      workerOptions(output, {
        ...wrangler,
        assets: { ...wrangler.assets, directory: './linked-assets' },
      }),
    /symlink|escapes/u,
  );
  fs.rmSync(path.join(output, 'server'), { recursive: true });
  fs.symlinkSync(external, path.join(output, 'server'), 'dir');
  assert.throws(() => workerOptions(output, wrangler), /symlink|escapes/u);
});

test('consumer inputs authenticate mapped tar bytes and retain their exact pins and build policy', t => {
  const { release, template } = releaseFixture(t);
  const before = structuredClone(template);
  const inputs = releaseConsumerInputs(release, template);
  assert.deepEqual(
    template,
    before,
    'The caller-owned template must remain unchanged',
  );
  const workspace = parse(inputs.workspaceYaml);
  for (const item of release.packages) {
    assert.equal(
      workspace.overrides[item.sourceName],
      `npm:${item.targetName}@${item.version}`,
    );
    assert.equal(workspace.overrides[item.targetName], item.version);
  }
  for (const block of ['dependencies', 'devDependencies']) {
    for (const [name, specifier] of Object.entries(inputs.manifest[block])) {
      if (!name.startsWith('@modern-js/')) continue;
      const item = release.packages.find(
        candidate => candidate.sourceName === name,
      );
      assert.equal(specifier, `npm:${item.targetName}@${item.version}`);
    }
  }
  const inspection = inspectNpmTarball(
    readVerifiedPackageArtifactBytes(
      release.createPackage,
      release.createPackage.artifactPath,
    ),
  );
  assert.deepEqual(workspace.allowBuilds, {
    esbuild: true,
    sharp: false,
    workerd: true,
  });
  assert.equal(workspace.strictDepBuilds, true);
  assert.equal(workspace.autoInstallPeers, false);
  assert.equal(workspace.engineStrict, true);
  assert.equal(workspace.verifyDepsBeforeRun, 'error');
  assert.equal(workspace.packageImportMethod, 'clone-or-copy');
  assert.equal(inputs.manifest.packageManager, 'pnpm@11.17.0');
  assert.equal(inputs.manifest.version, release.release.version);
  assert.deepEqual(inputs.exactPackages, {
    react: '19.3.0',
    'react-dom': '19.3.0',
    'react-server-dom-rspack': '0.1.0',
    'rsbuild-plugin-rsc': '0.1.1',
    '@tanstack/react-router': '1.170.44',
    '@tanstack/router-core': '1.171.37',
    'react-router': '7.18.4',
  });
  assert.equal(inputs.manifest.devDependencies['rsbuild-plugin-rsc'], '0.1.1');
  for (const name of ['react', 'react-dom']) {
    assert.equal(
      inputs.manifest.dependencies[name],
      inspection.packageJson.dependencies[name],
    );
    assert.equal(
      inputs.exactPackages[name],
      inspection.packageJson.dependencies[name],
    );
  }
});

test('consumer input authentication rejects changed tarball bytes', t => {
  const { root, release, template } = releaseFixture(t);
  const changed = path.join(root, 'changed.tgz');
  fs.writeFileSync(
    changed,
    Buffer.concat([
      fs.readFileSync(release.createPackage.artifactPath),
      Buffer.from('tampered'),
    ]),
  );
  const forged = {
    ...release,
    packages: release.packages.map(item =>
      item.sourceName === release.createPackage.sourceName
        ? { ...item, artifactPath: changed }
        : item,
    ),
  };
  assert.throws(
    () => releaseConsumerInputs(forged, template),
    /tarball size mismatch/u,
  );
});

test('consumer inputs resolve exact prepared sidecars and their dependencies from authenticated archives', t => {
  const { release, template } = releaseFixture(t, {
    toolsDependencies: {
      '@rsbuild/core': 'npm:@bleedingdev/rsbuild-core@2.2.11',
    },
    sidecars: [
      { name: '@bleedingdev/rsbuild-core', version: '2.2.11' },
      {
        name: '@bleedingdev/rslib-core',
        version: '0.20.0',
        dependencies: {
          '@rsbuild/core': 'npm:@bleedingdev/rsbuild-core@2.2.11',
        },
      },
    ],
  });
  const before = structuredClone(template);
  const inputs = releaseConsumerInputs(release, template);
  const workspace = parse(inputs.workspaceYaml);
  for (const item of release.sidecars.packages) {
    assert.equal(
      workspace.overrides[`${item.name}@${item.version}`],
      undefined,
    );
    assert.equal(workspace.overrides[item.name], item.version);
    assert.equal(inputs.manifest.dependencies[item.name], undefined);
    assert.equal(inputs.manifest.devDependencies[item.name], undefined);
  }
  assert.equal(
    workspace.overrides['@rsbuild/core'],
    'npm:@bleedingdev/rsbuild-core@2.2.11',
  );
  assert.equal(workspace.overrides['@rslib/core'], undefined);
  assert.equal(
    workspace.overrides[
      `@bleedingdev/modern-js-ultramodern-app-tools@${release.release.version}>@rsbuild/core@npm:@bleedingdev/rsbuild-core@2.2.11`
    ],
    undefined,
  );
  assert.equal(
    workspace.overrides[
      '@bleedingdev/rslib-core@0.20.0>@rsbuild/core@npm:@bleedingdev/rsbuild-core@2.2.11'
    ],
    undefined,
  );
  assert.deepEqual(template, before);
});

test('sidecar aliases do not override another authenticated package exact pin', t => {
  const { release, template } = releaseFixture(t, {
    toolsDependencies: { jiti: 'npm:@bleedingdev/jiti@2.7.0' },
    sidecars: [
      { name: '@bleedingdev/jiti', version: '2.7.0' },
      {
        name: '@bleedingdev/mf-cli',
        version: '2.9.1',
        dependencies: { jiti: '2.4.2' },
      },
    ],
  });
  const workspace = parse(
    releaseConsumerInputs(release, template).workspaceYaml,
  );
  assert.equal(workspace.overrides.jiti, undefined);
  assert.equal(workspace.overrides['@bleedingdev/jiti'], '2.7.0');
  const matching = releaseFixture(t, {
    toolsDependencies: { jiti: 'npm:@bleedingdev/jiti@2.7.0' },
    sidecars: [
      { name: '@bleedingdev/jiti', version: '2.7.0' },
      {
        name: '@bleedingdev/mf-cli',
        version: '2.9.1',
        dependencies: { jiti: '2.7.0' },
      },
    ],
  });
  assert.equal(
    parse(
      releaseConsumerInputs(matching.release, matching.template).workspaceYaml,
    ).overrides.jiti,
    'npm:@bleedingdev/jiti@2.7.0',
  );
});

test('sidecar alias transport rejects an authenticated dependency on a different sidecar version', t => {
  const { release, template } = releaseFixture(t, {
    toolsDependencies: {
      '@rsbuild/core': 'npm:@bleedingdev/rsbuild-core@2.2.10',
    },
    sidecars: [{ name: '@bleedingdev/rsbuild-core', version: '2.2.11' }],
  });
  assert.throws(
    () => releaseConsumerInputs(release, template),
    /Sidecar dependency must match the authenticated version/u,
  );
});

test('sidecar alias transport rejects conflicting canonical aliases from two authenticated owners', t => {
  const { release, template } = releaseFixture(t, {
    toolsDependencies: {
      '@rsbuild/core': 'npm:@bleedingdev/rsbuild-core@2.2.11',
    },
    sidecars: [
      {
        name: '@bleedingdev/rsbuild-core',
        version: '2.2.11',
        dependencies: {
          '@rsbuild/core': 'npm:@bleedingdev/rslib-core@0.20.0',
        },
      },
      { name: '@bleedingdev/rslib-core', version: '0.20.0' },
    ],
  });
  assert.throws(
    () => releaseConsumerInputs(release, template),
    /Conflicting authenticated sidecar alias: @rsbuild\/core/u,
  );
});

test('consumer registry transport retains bare package selectors without file overrides', t => {
  const { release, template } = releaseFixture(t, {
    toolsDependencies: { '@rslib/core': 'npm:@bleedingdev/rslib-core@0.20.0' },
    sidecars: [
      { name: '@bleedingdev/rsbuild-core', version: '2.2.11' },
      {
        name: '@bleedingdev/rslib-core',
        version: '0.20.0',
        dependencies: {
          '@rsbuild/core': 'npm:@bleedingdev/rsbuild-core@2.2.11',
        },
      },
    ],
  });
  const inputs = releaseConsumerInputs(release, template);
  const workspace = parse(inputs.workspaceYaml);
  const names = new Set([
    ...release.packages.flatMap(item => [item.sourceName, item.targetName]),
    ...release.sidecars.packages.map(item => item.name),
    '@rslib/core',
    '@rsbuild/core',
  ]);
  assert.deepEqual(Object.keys(workspace.overrides).sort(), [...names].sort());
  for (const [name, specifier] of Object.entries(workspace.overrides)) {
    assert.match(
      name,
      /^@[^/]+\/[^@>]+$/u,
      'Only bare package selectors are emitted',
    );
    assert.equal(
      specifier.startsWith('file:'),
      false,
      `${name} must retain registry resolution`,
    );
  }
});

test('consumer sidecar transport rejects changed manifests and archive bytes', t => {
  for (const target of ['manifest', 'archive']) {
    const { release, template } = releaseFixture(t, {
      sidecars: [{ name: '@bleedingdev/rsbuild-core', version: '2.2.11' }],
    });
    const file =
      target === 'manifest'
        ? release.sidecars.manifestPath
        : release.sidecars.packages[0].artifactPath;
    fs.appendFileSync(file, 'tampered');
    assert.throws(
      () => releaseConsumerInputs(release, template),
      /Sidecar manifest SHA-256 mismatch|sidecar tarball size mismatch/u,
    );
  }
});

test('consumer pins come from authenticated tar bytes instead of caller packageJson', t => {
  const { release, template } = releaseFixture(t, {
    react: '^19.3.0',
    reactDom: '^19.3.0',
  });
  const forged = {
    ...release,
    packages: release.packages.map(item => ({
      ...item,
      packageJson: {
        ...item.packageJson,
        dependencies: {
          ...item.packageJson.dependencies,
          ...(item.sourceName === '@modern-js/ultramodern-create'
            ? { react: '99.0.0' }
            : {}),
        },
      },
    })),
  };
  const inputs = releaseConsumerInputs(forged, template);
  assert.equal(inputs.manifest.dependencies.react, '19.3.0');
  assert.equal(inputs.exactPackages.react, '19.3.0');
});

test('consumer inputs pin exact and single-caret React declarations to the same numeric base', t => {
  for (const [react, reactDom] of [
    ['^19.3.0', '^19.3.0'],
    ['^19.3.0', '19.3.0'],
    ['19.3.0', '^19.3.0'],
  ]) {
    const { release, template } = releaseFixture(t, { react, reactDom });
    const inputs = releaseConsumerInputs(release, template);
    for (const name of ['react', 'react-dom']) {
      assert.equal(inputs.manifest.dependencies[name], '19.3.0');
      assert.equal(inputs.exactPackages[name], '19.3.0');
    }
  }
});

test('consumer inputs reject mismatched React and React DOM base pins', t => {
  const { release, template } = releaseFixture(t, {
    react: '^19.3.0',
    reactDom: '^19.3.1',
  });
  assert.throws(
    () => releaseConsumerInputs(release, template),
    /React and React DOM consumer pins must match/u,
  );
});

test('consumer inputs reject unsupported React declarations in either package', t => {
  for (const invalid of [
    '^^19.3.0',
    '^19.3',
    '19.x',
    '19.3.0 || 20.0.0',
    '*',
    '~19.3.0',
    '^19.3.0-rc.1',
    '^19.3.0+build',
    '019.3.0',
    ' ^19.3.0',
    '^19.3.0\n',
    '19.3.0\r',
    ['^19.3.0'],
    [['19.3.0']],
    null,
  ]) {
    for (const name of ['react', 'reactDom']) {
      const { release, template } = releaseFixture(t, { [name]: invalid });
      assert.throws(
        () => releaseConsumerInputs(release, template),
        /authenticated exact or single-caret numeric version/u,
      );
    }
  }
});

test('consumer inputs retain exact RSC and router dependencies and consistent RSC peers', t => {
  for (const options of [
    { builderRsc: '^0.1.0' },
    { rscCompiler: '^0.1.1' },
    { reactRouter: '^7.18.4' },
  ]) {
    const { release, template } = releaseFixture(t, options);
    assert.throws(
      () => releaseConsumerInputs(release, template),
      /authenticated exact version/u,
    );
  }
  const inconsistent = releaseFixture(t, { renderRsc: '0.2.0' });
  assert.throws(() =>
    releaseConsumerInputs(inconsistent.release, inconsistent.template),
  );
});

test('consumer inputs reject missing cohort packages and unapproved packed build policy', t => {
  const { release, template } = releaseFixture(t);
  assert.throws(
    () =>
      releaseConsumerInputs(
        {
          ...release,
          packages: release.packages.filter(
            item => item.sourceName !== '@modern-js/builder',
          ),
        },
        template,
      ),
    /Required package absent from final cohort/u,
  );
  for (const policy of [
    'strictDepBuilds: true\n',
    'strictDepBuilds: false\nallowBuilds:\n  workerd: true\n',
    'strictDepBuilds: true\nallowBuilds:\n  workerd: yes\n',
  ]) {
    const invalid = releaseFixture(t, { policy });
    assert.throws(() =>
      releaseConsumerInputs(invalid.release, invalid.template),
    );
  }
});
