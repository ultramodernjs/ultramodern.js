import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as native from '../../ultramodern-renderers/native-artifacts/protocol.mjs';

export function authenticate(bytes, integrity) {
  assert.equal(
    `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    integrity,
    'archive integrity mismatch',
  );
}

export function policy(registry, store) {
  return [
    `registry: ${JSON.stringify(registry)}`,
    `storeDir: ${JSON.stringify(store)}`,
    'packageImportMethod: clone-or-copy',
    'blockExoticSubdeps: true',
    'trustPolicy: no-downgrade',
    'strictPeerDependencies: true',
    '',
  ].join('\n');
}

const core = '@tanstack/router-core';

/** The renderer's own admitted native descriptor and the Core tuple it installs. */
export function admittedRouterCore(manifest) {
  const descriptor = native.validateDescriptor(
    manifest.ultramodern?.nativeArtifacts,
  );
  const pin = descriptor.packages[core];
  assert.equal(
    manifest.devDependencies?.[core],
    pin.request,
    'renderer must install its admitted Core archive',
  );
  assert.equal(
    manifest.peerDependencies?.[core],
    pin.version,
    'renderer host peer must be the admitted Core version',
  );
  return { ...pin, producer: descriptor.producer };
}

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const ownerName = '@support-install-proof/synthetic-parent';
const ownerVersion = '1.0.0';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function main() {
  const owned = process.env.OWNED_TEMP_DIR;
  const store = process.env.SUPPORT_PROOF_STORE;
  const guardian = process.env.ARTIFACT_GUARDIAN;
  assert(
    owned && store && guardian,
    'owned-temp-dir, external shared store and guardian required',
  );
  assert(!path.resolve(store).startsWith(path.resolve(owned) + path.sep));
  assert(!path.resolve(store).startsWith(root + path.sep));
  const generatorPolicy = path.join(
    root,
    'packages/toolkit/ultramodern-create/src/ultramodern-workspace/policy.ts',
  );
  const policyBefore = fs.readFileSync(generatorPolicy);
  assert.match(policyBefore.toString(), /blockExoticSubdeps: true/);
  assert.match(policyBefore.toString(), /trustPolicy: 'no-downgrade'/);
  const pin = admittedRouterCore(
    JSON.parse(
      fs.readFileSync(
        path.join(root, 'packages/runtime/renderer-solid/package.json'),
      ),
    ),
  );
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'SystemRoot']
      .filter(key => process.env[key])
      .map(key => [key, process.env[key]]),
  );
  env.CI = 'true';
  env.npm_config_userconfig = path.join(owned, 'empty.npmrc');
  env.npm_config_globalconfig = path.join(owned, 'empty-global.npmrc');
  fs.writeFileSync(env.npm_config_userconfig, '');
  fs.writeFileSync(env.npm_config_globalconfig, '');
  assert.equal(
    execFileSync('pnpm', ['--version'], { env, encoding: 'utf8' }).trim(),
    '12.21.0',
  );
  const response = await fetch(pin.request, {
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  authenticate(bytes, pin.integrity);
  assert.throws(
    () =>
      authenticate(Buffer.concat([bytes, Buffer.from('wrong')]), pin.integrity),
    /integrity mismatch/,
  );
  const archive = path.join(owned, 'actual-router.tgz');
  fs.writeFileSync(archive, bytes);
  const unpacked = path.join(owned, 'authenticated');
  fs.mkdirSync(unpacked);
  execFileSync('tar', ['-xzf', archive, '-C', unpacked]);
  const actual = JSON.parse(
    fs.readFileSync(path.join(unpacked, 'package/package.json')),
  );
  assert.equal(actual.name, '@tanstack/router-core');
  assert.equal(actual.version, pin.version);
  console.log(
    JSON.stringify({
      payload: pin,
      bytes: bytes.length,
      peers: actual.peerDependencies ?? {},
      dependencies: actual.dependencies,
      syntheticParent: { name: ownerName, version: ownerVersion },
      generatorPolicySha256: hash(policyBefore),
    }),
  );

  const parents = new Map();
  for (const [name, manifest] of [
    [ownerName, { dependencies: { [actual.name]: pin.request } }],
    [
      '@support-install-proof/synthetic-peer-parent',
      { peerDependencies: { [actual.name]: actual.version } },
    ],
    [
      '@support-install-proof/synthetic-incompatible-peer-parent',
      { peerDependencies: { [actual.name]: '99.0.0' } },
    ],
  ]) {
    const directory = path.join(owned, name.split('/')[1], 'package');
    fs.mkdirSync(directory, { recursive: true });
    const parent = { name, version: ownerVersion, ...manifest };
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify(parent),
    );
    const archive = path.join(path.dirname(directory), 'parent.tgz');
    execFileSync('tar', [
      '-czf',
      archive,
      '-C',
      path.dirname(directory),
      'package',
    ]);
    const bytes = fs.readFileSync(archive);
    parents.set(name, {
      parent,
      bytes,
      integrity:
        'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    });
  }
  let registry;
  const server = http.createServer((request, reply) => {
    const name = decodeURIComponent(request.url)
      .replace(/^\//, '')
      .replace(/\.tgz$/, '');
    const entry = parents.get(name);
    if (!entry) {
      reply.statusCode = 404;
      reply.end('Synthetic parent registry only');
      return;
    }
    if (request.url.endsWith('.tgz')) {
      reply.end(entry.bytes);
      return;
    }
    reply.setHeader('content-type', 'application/json');
    reply.end(
      JSON.stringify({
        name,
        'dist-tags': { latest: ownerVersion },
        time: {
          created: '2020-01-01T00:00:00.000Z',
          modified: '2020-01-01T00:00:00.000Z',
          [ownerVersion]: '2020-01-01T00:00:00.000Z',
        },
        versions: {
          [ownerVersion]: {
            ...entry.parent,
            dist: {
              tarball: registry + '/' + encodeURIComponent(name) + '.tgz',
              integrity: entry.integrity,
            },
          },
        },
      }),
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  registry = `http://127.0.0.1:${server.address().port}`;
  const leases = [];
  const lifecycleOwner = `support-install-proof-${process.pid}`;
  const run = (args, cwd) =>
    new Promise((resolve, reject) => {
      const child = spawn('pnpm', args, { cwd, env });
      let output = '';
      child.stdout.on('data', bytes => {
        output += bytes;
      });
      child.stderr.on('data', bytes => {
        output += bytes;
      });
      const timer = setTimeout(() => child.kill('SIGTERM'), 90000);
      child.on('error', reject);
      child.on('close', code => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
  async function scenario(
    name,
    rootRequest,
    includeParent = true,
    selectedParent = ownerName,
  ) {
    const cwd = path.join(owned, name);
    fs.mkdirSync(cwd);
    const modules = path.join(cwd, 'node_modules');
    fs.mkdirSync(modules);
    execFileSync(guardian, [
      'register',
      modules,
      '--owner',
      lifecycleOwner,
      '--owner-pid',
      String(process.pid),
      '--kind',
      'dependencies',
      '--grace-hours',
      '24',
    ]);
    leases.push(modules);
    const dependencies = includeParent
      ? { [selectedParent]: ownerVersion }
      : {};
    if (rootRequest) dependencies[actual.name] = rootRequest;
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        name: `proof-${name}`,
        private: true,
        version: '1.0.0',
        packageManager: 'pnpm@12.21.0',
        dependencies,
      }),
    );
    fs.writeFileSync(
      path.join(cwd, 'pnpm-workspace.yaml'),
      policy('https://registry.npmjs.org/', store),
    );
    fs.writeFileSync(
      path.join(cwd, '.npmrc'),
      `@support-install-proof:registry=${registry}/\n`,
    );
    const result = await run(['install', '--reporter=append-only'], cwd);
    console.log(
      `\n=== ${name}: normal install exit ${result.code} ===\n${result.output}`,
    );
    return { ...result, cwd };
  }
  try {
    const blocked = await scenario('transitive-only');
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.output, /ERR_PNPM_.*EXOTIC/);
    const rootAuthority = await scenario('exact-root-direct', pin.request);
    const transitiveAccepted = rootAuthority.code === 0;
    if (!transitiveAccepted) {
      assert.match(rootAuthority.output, /ERR_PNPM_.*EXOTIC/);
      console.log(
        'STRUCTURAL BLOCKER: exact root direct authority is not accepted. Legitimate alternative: publish the corrected package to a registry (normal semver request) under its owning distribution; do not disable blockExoticSubdeps.',
      );
    }
    const wrong = await scenario(
      'wrong-root-request',
      `${pin.request}?wrong-root-authority=1`,
    );
    assert.notEqual(wrong.code, 0);
    assert.match(wrong.output, /ERR_PNPM_.*EXOTIC/);
    const accepted = transitiveAccepted
      ? rootAuthority
      : await scenario('direct-only-control', pin.request, false);
    assert.equal(
      accepted.code,
      0,
      'direct-only actual payload control must install normally',
    );
    const installed = fs.realpathSync(
      path.join(accepted.cwd, 'node_modules', actual.name),
    );
    if (transitiveAccepted) {
      const installedParent = fs.realpathSync(
        path.join(accepted.cwd, 'node_modules', ownerName),
      );
      assert.equal(
        fs.realpathSync(path.join(installedParent, '../..', actual.name)),
        installed,
        'root and parent must resolve one physical package',
      );
    }
    const routerCopies = fs
      .readdirSync(path.join(accepted.cwd, 'node_modules/.pnpm'))
      .filter(entry =>
        fs.existsSync(
          path.join(
            accepted.cwd,
            'node_modules/.pnpm',
            entry,
            'node_modules',
            actual.name,
            'package.json',
          ),
        ),
      );
    assert.equal(
      routerCopies.length,
      1,
      'one physical router payload in isolated install',
    );
    const identity = JSON.parse(
      fs.readFileSync(path.join(installed, 'package.json')),
    );
    assert.equal(identity.name, actual.name);
    assert.equal(identity.version, actual.version);
    let compared = 0;
    function compare(directory, relative = '', destination = installed) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const next = path.join(relative, entry.name);
        if (entry.isDirectory())
          compare(path.join(directory, entry.name), next, destination);
        else {
          assert(
            entry.isFile(),
            'archive comparison accepts regular files only',
          );
          assert.equal(
            hash(fs.readFileSync(path.join(destination, next))),
            hash(fs.readFileSync(path.join(directory, entry.name))),
            next,
          );
          compared++;
        }
      }
    }
    compare(path.join(unpacked, 'package'));
    const lockBefore = fs.readFileSync(
      path.join(accepted.cwd, 'pnpm-lock.yaml'),
    );
    const resolvesPin = lock =>
      assert(
        lock
          .toString()
          .includes(
            `resolution: {integrity: ${pin.integrity}, tarball: ${pin.request}}`,
          ),
        'lockfile must resolve the admitted Core request and integrity',
      );
    resolvesPin(lockBefore);
    const frozen = await run(
      ['install', '--frozen-lockfile', '--reporter=append-only'],
      accepted.cwd,
    );
    console.log(`=== frozen install exit ${frozen.code} ===\n${frozen.output}`);
    assert.equal(frozen.code, 0);
    assert.deepEqual(
      fs.readFileSync(path.join(accepted.cwd, 'pnpm-lock.yaml')),
      lockBefore,
    );
    assert.equal(
      fs.realpathSync(path.join(accepted.cwd, 'node_modules', actual.name)),
      installed,
    );
    compared = 0;
    compare(path.join(unpacked, 'package'));
    const peerOwner = '@support-install-proof/synthetic-peer-parent';
    const peer = await scenario(
      'ordinary-peer-root-direct',
      pin.request,
      true,
      peerOwner,
    );
    assert.equal(
      peer.code,
      0,
      'ordinary semver peer with exact root URL must pass strict policy',
    );
    const peerRouter = fs.realpathSync(
      path.join(peer.cwd, 'node_modules', actual.name),
    );
    const peerParent = fs.realpathSync(
      path.join(peer.cwd, 'node_modules', peerOwner),
    );
    assert.equal(
      fs.realpathSync(path.join(peerParent, '../..', actual.name)),
      peerRouter,
    );
    assert.equal(
      hash(fs.readFileSync(path.join(peerRouter, 'package.json'))),
      hash(fs.readFileSync(path.join(installed, 'package.json'))),
    );
    compare(path.join(unpacked, 'package'), '', peerRouter);
    const peerLock = fs.readFileSync(path.join(peer.cwd, 'pnpm-lock.yaml'));
    resolvesPin(peerLock);
    const peerFrozen = await run(
      ['install', '--frozen-lockfile', '--reporter=append-only'],
      peer.cwd,
    );
    console.log(
      '=== ordinary-peer frozen exit ' +
        peerFrozen.code +
        ' ===\n' +
        peerFrozen.output,
    );
    assert.equal(peerFrozen.code, 0);
    assert.deepEqual(
      fs.readFileSync(path.join(peer.cwd, 'pnpm-lock.yaml')),
      peerLock,
    );
    compare(path.join(unpacked, 'package'), '', peerRouter);
    compared = 0;
    compare(path.join(unpacked, 'package'));
    const incompatible = await scenario(
      'incompatible-peer',
      pin.request,
      true,
      '@support-install-proof/synthetic-incompatible-peer-parent',
    );
    assert.notEqual(incompatible.code, 0);
    assert.match(incompatible.output, /ERR_PNPM_PEER_DEP_ISSUES/);
    console.log(
      JSON.stringify({
        ordinarySemverPeerAlternative:
          'PASS normal + frozen; root and parent same physical package',
        incompatiblePeerRejected: true,
        result: transitiveAccepted ? 'PASS' : 'STRUCTURAL_BLOCKER_CONFIRMED',
        comparedArchiveFiles: compared,
        physicalSingleton: true,
        normalThenFrozen: true,
        installedControl: transitiveAccepted
          ? 'root plus synthetic parent'
          : 'direct-only, NOT transitive acceptance',
        transitiveAccepted,
        wrongRequestRejected: true,
        wrongDigestRejected: true,
        limitation:
          'Synthetic registry parent, real authenticated published GitHub payload. Not support5 hosted acceptance, nor an actual framework publication. Router payload has no peerDependencies; strict peer checking enabled without exceptions.',
      }),
    );
  } finally {
    server.close();
    for (const directory of leases)
      execFileSync(guardian, ['release', directory, '--owner', lifecycleOwner]);
    assert.deepEqual(
      fs.readFileSync(generatorPolicy),
      policyBefore,
      'generator policy changed during proof',
    );
    // The enclosing owned-temp-dir owns and removes the entire scratch tree,
    // including released node_modules, on success, failure and interruption.
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
