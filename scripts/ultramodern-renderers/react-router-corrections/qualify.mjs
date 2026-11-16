import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalPatch,
  correctReactArchive,
  qualifySource,
  verifyPayload,
} from './correction.mjs';
import {
  assertInstalled,
  graph,
  isolatedEnvironment,
  prepare,
  writeConsumer,
} from './proof.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const inputs = JSON.parse(fs.readFileSync(path.join(here, 'inputs.json')));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Returns real source/patch/license/archive bytes only after actual install gates.
export async function qualifyReactRouter({
  workDirectory,
  toolchain,
  lifecycle,
  payloads,
  writePatch = false,
  log = console.log,
}) {
  assert(path.isAbsolute(workDirectory));
  assert(path.isAbsolute(toolchain.storeDirectory));
  const work = fs.mkdtempSync(path.join(workDirectory, 'react-router-'));
  assert(
    !path
      .resolve(toolchain.storeDirectory)
      .startsWith(path.resolve(workDirectory) + path.sep),
    'Store must be external to disposable scratch',
  );
  const env = isolatedEnvironment(work);
  const node = toolchain.node ?? process.execPath;
  const pnpm = toolchain.pnpm ?? 'pnpm';
  const run = (cmd, args, cwd, options = {}) =>
    execFileSync(cmd, args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 4 * 1024 ** 2,
      ...options,
    });
  const registered = new Set();
  const register = directory => {
    fs.mkdirSync(directory, { recursive: true });
    lifecycle?.register(directory);
    registered.add(directory);
  };
  const install = (directory, frozen = false) => {
    const { bavail, bsize } = fs.statfsSync(work);
    assert(
      bavail * bsize >= 20 * 1024 ** 3,
      'Below 20 GiB; stop before install',
    );
    register(path.join(directory, 'node_modules'));
    run(pnpm, ['install', ...(frozen ? ['--frozen-lockfile'] : [])], directory);
  };
  const behavior = (directory, corrected) => {
    fs.copyFileSync(
      path.join(here, 'runtime.mjs'),
      path.join(directory, 'runtime.mjs'),
    );
    for (const format of ['esm', 'cjs'])
      log(
        run(
          node,
          [
            '--conditions=development',
            'runtime.mjs',
            format,
            corrected ? 'corrected' : 'registry',
          ],
          directory,
        ).trim(),
      );
  };
  try {
    assert.equal(run(pnpm, ['--version'], work).trim(), '12.21.0');
    const prepared = await prepare({ work, run });
    const source = qualifySource({
      work,
      originalBytes: prepared.react.archiveBytes,
      sourceRepository: toolchain.sourceRepository,
      source: inputs.source,
    });
    const ordinary = path.join(work, 'ordinary');
    writeConsumer({
      directory: ordinary,
      reactBytes: prepared.react.archiveBytes,
      coreBytes: prepared.coreBytes,
      store: toolchain.storeDirectory,
    });
    install(ordinary);
    const before = graph(
      ordinary,
      prepared.coreBytes,
      prepared.react.archiveBytes,
    );
    if (before.singleton) {
      behavior(ordinary, true);
      return { correctionRequired: false, graph: before };
    }
    assert.equal(before.physicalCores.length, 2);
    assertInstalled(
      path.join(
        ordinary,
        'node_modules/.pnpm/@tanstack+router-core@1.171.39/node_modules/@tanstack/router-core',
      ),
      prepared.core.archiveBytes,
    );
    behavior(ordinary, false);
    log('ORDINARY_DUPLICATE_PROVED', JSON.stringify(before));
    const corrected = correctReactArchive(prepared.react.archiveBytes);
    const patchBytes = canonicalPatch({
      work,
      originalBytes: prepared.react.archiveBytes,
      correctedBytes: corrected.archiveBytes,
    });
    const patchPath = path.join(here, 'react-router-1.170.46.patch');
    if (writePatch) fs.writeFileSync(patchPath, patchBytes);
    else
      assert(
        fs.readFileSync(patchPath).equals(patchBytes),
        'Canonical metadata patch mismatch',
      );
    if (payloads) {
      assert.deepEqual(
        Object.keys(payloads).sort(),
        ['@tanstack/react-router', '@tanstack/router-core'].sort(),
      );
    }
    const reactBytes = payloads
      ? verifyPayload(
          payloads['@tanstack/react-router'],
          corrected.archiveBytes,
        )
      : corrected.archiveBytes;
    const coreBytes = payloads
      ? verifyPayload(payloads['@tanstack/router-core'], prepared.coreBytes)
      : prepared.coreBytes;
    const consumer = path.join(work, 'corrected');
    writeConsumer({
      directory: consumer,
      reactBytes,
      coreBytes,
      store: toolchain.storeDirectory,
    });
    const verify = () => {
      const actual = graph(consumer, coreBytes, reactBytes);
      assert(
        actual.singleton,
        'React must resolve the actual corrected root core',
      );
      assert.equal(
        actual.physicalCores.length,
        1,
        'Exactly one installed core authority',
      );
      assert.match(actual.rootCore, /file\+core\.tgz/);
      behavior(consumer, true);
      fs.copyFileSync(
        path.join(here, 'public-api.ts'),
        path.join(consumer, 'public-api.ts'),
      );
      fs.writeFileSync(
        path.join(consumer, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            skipLibCheck: false,
            noEmit: true,
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            lib: ['ES2022', 'DOM', 'DOM.Iterable'],
            types: ['react', 'react-dom'],
          },
          files: ['public-api.ts'],
        }),
      );
      assert.match(
        run(node, ['node_modules/typescript/bin/tsc', '--version'], consumer),
        /Version 7\.0\.2/,
      );
      run(
        node,
        ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
        consumer,
      );
      log(
        'STRICT_TS7_PASS strict=true skipLibCheck=false public React routing API',
      );
      return actual;
    };
    install(consumer);
    const after = verify();
    const lock = fs.readFileSync(path.join(consumer, 'pnpm-lock.yaml'));
    fs.rmSync(path.join(consumer, 'node_modules'), { recursive: true });
    install(consumer, true);
    verify();
    assert(
      fs.readFileSync(path.join(consumer, 'pnpm-lock.yaml')).equals(lock),
      'Frozen install changed lock',
    );
    fs.rmSync(path.join(consumer, 'node_modules'), { recursive: true });
    fs.unlinkSync(path.join(consumer, 'pnpm-lock.yaml'));
    const manifestPath = path.join(consumer, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    manifest.dependencies['@tanstack/router-core'] = '1.171.34';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    let rejected;
    try {
      install(consumer);
    } catch (error) {
      rejected = error;
    }
    assert(rejected, 'Wrong registry core must fail strict peers');
    assert.match(
      `${rejected.stdout}\n${rejected.stderr}`,
      /ERR_PNPM_PEER_DEP_ISSUES/,
    );
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /1\.171\.39/);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /1\.171\.34/);
    log('WRONG_REGISTRY_CORE_REJECTED strict exact required peer 1.171.39');
    return {
      correctionRequired: true,
      before,
      after,
      gates: {
        normal: true,
        freshFrozen: true,
        allInstalledBytes: true,
        singleton: true,
        publicRouting: true,
        strictTS7: true,
        wrongRegistryPeer: true,
        actualTransportedPayloads: Boolean(payloads),
      },
      artifacts: [
        {
          name: prepared.react.name,
          version: prepared.react.version,
          archiveBytes: reactBytes,
          patchBytes,
          licenseBytes: source.licenseBytes,
          patchSha256: sha256(patchBytes),
          licenseSha256: sha256(source.licenseBytes),
          upstream: prepared.react,
          source: {
            ...inputs.source,
            archiveBytes: source.archiveBytes,
            sourceFiles: source.sourceFiles,
          },
        },
      ],
      coreBytes,
      corePatchSha256: inputs.corePatchSha256,
    };
  } finally {
    for (const directory of [...registered].reverse())
      lifecycle?.release(directory);
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert(
    process.env.OWNED_TEMP_DIR &&
      process.env.REACT_ROUTER_STORE &&
      process.env.REACT_ROUTER_PNPM &&
      process.env.REACT_ROUTER_SOURCE,
  );
  const guardian = '/Users/satan/bin/disk-guardian-artifacts';
  const owner = `react-router-${process.pid}`;
  const result = await qualifyReactRouter({
    workDirectory: process.env.OWNED_TEMP_DIR,
    toolchain: {
      pnpm: process.env.REACT_ROUTER_PNPM,
      storeDirectory: process.env.REACT_ROUTER_STORE,
      sourceRepository: process.env.REACT_ROUTER_SOURCE,
    },
    lifecycle: {
      register(directory) {
        execFileSync(guardian, [
          'register',
          directory,
          '--owner',
          owner,
          '--owner-pid',
          String(process.pid),
          '--kind',
          'dependencies',
        ]);
      },
      release(directory) {
        execFileSync(guardian, ['release', directory, '--owner', owner]);
      },
    },
    writePatch: process.argv.includes('--write-patch'),
  });
  console.log(
    'REACT_ROUTER_ACCEPTANCE',
    JSON.stringify(
      {
        gates: result.gates,
        before: result.before,
        after: result.after,
        receipts: result.artifacts?.map(
          ({ name, version, patchSha256, licenseSha256, source }) => ({
            name,
            version,
            patchSha256,
            licenseSha256,
            source: { ...source, archiveBytes: undefined },
          }),
        ),
      },
      null,
      2,
    ),
  );
}
