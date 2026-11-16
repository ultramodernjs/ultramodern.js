import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertSameFiles, packArchive, readArchive } from './archive.mjs';
import { authenticateArchive } from './authenticate.mjs';
import { corrections, versions } from './inputs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const identities = JSON.parse(
  fs.readFileSync(new URL('./registry-identities.json', import.meta.url)),
);
const names = Object.keys(corrections);
const environmentKeys = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'TZ',
]);

/**
 * Closed metadata3 producer/verifier. workDirectory is caller-owned scratch;
 * toolchain.storeDirectory is an external pnpm store (required). Optional
 * payloads is an exact name->Uint8Array map of transported corrected archives.
 * All returned bytes have passed real runtime/type/install gates. No root deps.
 * Optional run({command,args,cwd,env,timeout}) returns {status,stdout,stderr}.
 * Optional lifecycle.register/release(path,{kind}) only manages local ownership;
 * this function always removes its own unique scratch subtree in finally.
 */
export async function qualifyPeerCorrections({
  workDirectory,
  toolchain,
  payloads,
  lifecycle,
  log = console.log,
  fetchBytes = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    assert(response.ok, `fetch ${url}: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  },
}) {
  assert(
    path.isAbsolute(workDirectory),
    'absolute caller-owned workDirectory required',
  );
  assert(
    toolchain && path.isAbsolute(toolchain.storeDirectory),
    'external storeDirectory required',
  );
  const work = fs.realpathSync(workDirectory);
  fs.mkdirSync(toolchain.storeDirectory, { recursive: true });
  const store = fs.realpathSync(toolchain.storeDirectory);
  assert(
    store !== work && !store.startsWith(work + path.sep),
    'store must be external to workDirectory',
  );
  if (payloads !== undefined) {
    assert.deepEqual(
      Object.keys(payloads).sort(),
      [...names].sort(),
      'payloads must contain exactly metadata3',
    );
    for (const name of names)
      assert(
        payloads[name] instanceof Uint8Array,
        `${name}: actual archive bytes required`,
      );
  }
  const temporary = fs.mkdtempSync(path.join(work, 'peer-corrections-'));
  const fixture = path.join(temporary, 'fixture');
  const node = toolchain.node ?? process.execPath;
  const pnpm = toolchain.pnpm ?? 'pnpm';
  const runner =
    toolchain.run ??
    (options =>
      spawnSync(options.command, options.args, {
        ...options,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      }));
  async function run(command, args, cwd = fixture, allowFailure = false) {
    const result = await runner({
      command,
      args,
      cwd,
      timeout: 120000,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) =>
            environmentKeys.has(key),
          ),
        ),
        CI: 'true',
        TMPDIR: temporary,
      },
    });
    assert(!result.error, String(result.error));
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (output) log(output);
    if (!allowFailure)
      assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${output}`);
    return { status: result.status, output };
  }
  try {
    fs.mkdirSync(path.join(fixture, 'node_modules'), { recursive: true });
    await lifecycle?.register?.(path.join(fixture, 'node_modules'), {
      kind: 'dependencies',
    });
    fs.writeFileSync(
      path.join(fixture, 'package.json'),
      JSON.stringify({ private: true, packageManager: 'pnpm@12.21.0' }),
    );
    assert.equal(
      (await run(pnpm, ['--version'])).output.trim(),
      '12.21.0',
      'pinned pnpm toolchain required',
    );
    const upstreams = [];
    const originals = new Map();
    const dependencies = {};
    for (const identity of identities) {
      const bytes = Buffer.from(await fetchBytes(identity.tarball));
      const authenticated = authenticateArchive(identity, bytes);
      const files = readArchive(bytes);
      const metadata = JSON.parse(files.get('package.json'));
      assert.equal(metadata.name, identity.name);
      assert.equal(metadata.version, identity.version);
      originals.set(identity.name, files);
      upstreams.push(authenticated);
      const archive = path.join(
        temporary,
        `${identity.name.replaceAll('/', '_')}-upstream.tgz`,
      );
      fs.writeFileSync(archive, bytes);
      dependencies[identity.name] = `file:${archive}`;
    }
    assert.deepEqual(
      identities.map(i => i.name).sort(),
      [...Object.keys(versions), 'typescript', '@types/node'].sort(),
    );
    const writeManifest = () =>
      fs.writeFileSync(
        path.join(fixture, 'package.json'),
        JSON.stringify({
          private: true,
          type: 'module',
          packageManager: 'pnpm@12.21.0',
          dependencies,
        }),
      );
    writeManifest();
    fs.writeFileSync(
      path.join(fixture, 'pnpm-workspace.yaml'),
      'packages: []\nstrictPeerDependencies: true\nautoInstallPeers: false\npackageImportMethod: clone-or-copy\n',
    );
    const install = ['install', '--no-frozen-lockfile', '--store-dir', store];
    const before = await run(pnpm, install, fixture, true);
    assert.notEqual(
      before.status,
      0,
      'uncorrected strict install must reject latest tuple',
    );
    assert.match(before.output, /ERR_PNPM_PEER_DEP_ISSUES/);
    assert.match(before.output, /happy-dom/);
    assert.match(before.output, /ioredis/);
    assert.match(before.output, /@rstest\/core/);
    assert.match(before.output, /@types\/ioredis-mock/);
    assert.match(before.output, /ioredis-mock/);
    for (const name of Object.keys(dependencies)) {
      // Authenticate the actual normally installed direct payload, not a root symlink.
      const installed = path.join(fixture, 'node_modules', name);
      for (const [relative, bytes] of originals.get(name))
        assert.deepEqual(
          fs.readFileSync(path.join(installed, relative)),
          bytes,
          `installed ${name}/${relative}`,
        );
    }
    for (const file of [
      'redis-runtime.cjs',
      'redis-types.cts',
      'happy-lifecycle.mjs',
    ])
      fs.copyFileSync(path.join(here, file), path.join(fixture, file));
    fs.copyFileSync(
      path.join(here, 'rstest-lifecycle.fixture.mjs'),
      path.join(fixture, 'rstest-lifecycle.test.mjs'),
    );
    fs.writeFileSync(
      path.join(fixture, 'rstest.config.mjs'),
      `export default {testEnvironment:{name:'happy-dom',options:{url:'https://qualification.invalid/runner'}},include:['rstest-lifecycle.test.mjs']};`,
    );
    fs.writeFileSync(
      path.join(fixture, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          types: ['node'],
        },
        include: ['redis-types.cts'],
      }),
    );
    async function realGates() {
      await run(node, ['redis-runtime.cjs']);
      await run(node, ['happy-lifecycle.mjs']);
      await run(node, [
        path.join(fixture, 'node_modules/@rstest/core/bin/rstest.js'),
        'run',
        '--config',
        path.join(fixture, 'rstest.config.mjs'),
      ]);
      await run(node, [
        path.join(fixture, 'node_modules/typescript/bin/tsc'),
        '-p',
        path.join(fixture, 'tsconfig.json'),
      ]);
    }
    await realGates();
    const artifacts = [];
    for (const name of names) {
      const original = originals.get(name);
      const patched = new Map(original);
      patched.modes = original.modes;
      const originalText = original.get('package.json').toString();
      const metadata = JSON.parse(originalText);
      let correctedText = originalText;
      const patchBytes = fs.readFileSync(
        path.join(here, `${name.replaceAll('/', '_')}.patch`),
      );
      // Apply the canonical patch, then verify the entire resulting manifest is
      // exactly the original plus the closed peer extension (no hidden edits).
      const source = path.join(
        temporary,
        `${name.replaceAll('/', '_')}-source`,
      );
      fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, 'package.json'), originalText);
      await run(
        toolchain.git ?? 'git',
        [
          'apply',
          '--check',
          path.join(here, `${name.replaceAll('/', '_')}.patch`),
        ],
        source,
      );
      await run(
        toolchain.git ?? 'git',
        ['apply', path.join(here, `${name.replaceAll('/', '_')}.patch`)],
        source,
      );
      correctedText = fs.readFileSync(
        path.join(source, 'package.json'),
        'utf8',
      );
      for (const [peer, range] of Object.entries(corrections[name]))
        metadata.peerDependencies[peer] = range;
      assert.deepEqual(
        JSON.parse(correctedText),
        metadata,
        'patch may only extend exact peers',
      );
      patched.set('package.json', Buffer.from(correctedText));
      const archiveBytes =
        payloads === undefined
          ? packArchive(patched)
          : Buffer.from(payloads[name]);
      assertSameFiles(readArchive(archiveBytes), patched);
      const archive = path.join(
        temporary,
        `${name.replaceAll('/', '_')}-corrected.tgz`,
      );
      fs.writeFileSync(archive, archiveBytes);
      dependencies[name] = `file:${archive}`;
      const licenses = [...patched]
        .filter(([name]) => /(^|\/)(license|licence|notice)(\.|$)/i.test(name))
        .map(([path, bytes]) => ({ path, bytes }));
      assert(licenses.length > 0, `${name}: license bytes required`);
      artifacts.push({
        name,
        version: versions[name],
        archiveBytes,
        upstream: upstreams.find(i => i.name === name),
        patchBytes,
        licenses,
      });
    }
    writeManifest();
    await run(pnpm, install);
    await realGates();
    for (const artifact of artifacts) {
      for (const [relative, bytes] of readArchive(artifact.archiveBytes))
        assert.deepEqual(
          fs.readFileSync(
            path.join(fixture, 'node_modules', artifact.name, relative),
          ),
          bytes,
          `installed transported ${artifact.name}/${relative}`,
        );
    }
    const gates = {
      strictNegativeControl: true,
      owningMetadataExact: true,
      rstestSetup: true,
      rstestVM: true,
      rstestCLI: true,
      redisRuntime: true,
      strictTypeScript: '7.0.2',
      nodeTypes: '26.6.6',
      transportedPayloads: payloads !== undefined,
    };
    log(
      'PASS portable metadata3: authenticated npm signatures/SHA512; real original+corrected runtime/types; strict negative control; actual archive bytes',
    );
    return { artifacts, upstreams, gates };
  } finally {
    try {
      await lifecycle?.release?.(path.join(fixture, 'node_modules'), {
        kind: 'dependencies',
      });
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  assert(
    process.env.OWNED_TEMP_DIR && process.env.PEER_CORRECTIONS_STORE,
    'set OWNED_TEMP_DIR and external PEER_CORRECTIONS_STORE',
  );
  await qualifyPeerCorrections({
    workDirectory: process.env.OWNED_TEMP_DIR,
    toolchain: { storeDirectory: process.env.PEER_CORRECTIONS_STORE },
  });
}
