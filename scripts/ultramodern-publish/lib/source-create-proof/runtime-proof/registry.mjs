// Consumer: run-release-acceptance.mjs source-mode exact-tarball registry.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createAcceptancePackageManagerEnv } from '../../../../ultramodern-production-readiness/published-create-proof/process.mjs';
import { createProcessEnv } from '../../../../ultramodern-production-readiness/published-create-proof/constants.mjs';
import { readStagedSidecars } from '../../../publish-sidecars.mjs';
import {
  assertAcceptedPublishToolchain,
  loadNpmPublishingRuntime,
  publishPackageBuffer,
} from '../../prepare-bleedingdev-packages/npm-buffer-publisher.mjs';
import {
  readVerifiedPackageArtifactBytes,
  verifyPackageArtifactBytes,
} from '../../prepare-bleedingdev-packages/release-artifacts.mjs';

const VERDACCIO_VERSION = '6.7.4';
const VERDACCIO_SPECIFIER = `verdaccio@${VERDACCIO_VERSION}`;
const VERDACCIO_INTEGRITY =
  'sha512-C59DdKYtc1vayM3HiRFVRCRJMd4Hq4QCQnjTMM6CVanJvMpaqHlZ+DHE31/L8ScXkzUl1oS0HulizpxmMXW1LA==';
const VERDACCIO_UPSTREAM = 'https://registry.npmjs.org/';
const registryHost = '127.0.0.1';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: createProcessEnv(options.env ?? {}),
    stdio: options.stdio ?? 'pipe',
  });
  if (result.error) {
    throw new Error(
      `${command} ${args.join(' ')} failed to start: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join('\n');
    throw new Error(
      [`${command} ${args.join(' ')} exited ${result.status}`, output.trim()]
        .filter(Boolean)
        .join('\n'),
    );
  }
  return result.stdout?.trim() ?? '';
}

function createVerdaccioConfig({
  storageDir,
  htpasswdPath,
  scope,
  sidecarNames = [],
  cohortNames = [],
}) {
  return [
    `storage: ${JSON.stringify(storageDir)}`,
    // The five-platform compiler tarball is ~57 MB; npm PUT encodes it as
    // ~76 MB of Base64 plus metadata. Keep a finite limit above that envelope.
    'max_body_size: 100mb',
    'auth:',
    '  htpasswd:',
    `    file: ${JSON.stringify(htpasswdPath)}`,
    '    max_users: 1000',
    'uplinks:',
    '  npmjs:',
    `    url: ${JSON.stringify(VERDACCIO_UPSTREAM)}`,
    '    timeout: 10m',
    '    max_fails: 100',
    '    fail_timeout: 1s',
    'packages:',
    // Seed accepted bytes locally even when the same version exists on npm.
    // The consumer phase restores cohort proxying for historical lockfiles.
    ...[...new Set([...sidecarNames, ...cohortNames])].flatMap(name => [
      `  ${JSON.stringify(name)}:`,
      '    access: $all',
      '    publish: $authenticated',
      '    unpublish: $authenticated',
    ]),
    `  ${JSON.stringify(`@${scope}/*`)}:`,
    '    access: $all',
    '    publish: $authenticated',
    '    unpublish: $authenticated',
    // pnpm validates the consumer's existing lockfile before replacing its old
    // cohort. Keep published versions and their release times visible alongside
    // the exact candidate tarballs verified by the seed loop below.
    '    proxy: npmjs',
    "  '**':",
    '    access: $all',
    '    proxy: npmjs',
    'log:',
    '  type: stdout',
    '  format: pretty',
    '  level: warn',
    '',
  ].join('\n');
}

function verdaccioDlxArgs(configPath, port) {
  return [
    'dlx',
    VERDACCIO_SPECIFIER,
    '--config',
    configPath,
    '--listen',
    `${registryHost}:${port}`,
  ];
}

function assertVerdaccioDistributionIntegrity(runImpl = runChecked, env) {
  const output = runImpl(
    'npm',
    [
      'view',
      VERDACCIO_SPECIFIER,
      'dist.integrity',
      '--json',
      '--registry',
      VERDACCIO_UPSTREAM,
    ],
    { stdio: 'pipe', ...(env === undefined ? {} : { env }) },
  );
  let integrity;
  try {
    integrity = JSON.parse(output);
  } catch {
    integrity = output;
  }
  assert(
    integrity === VERDACCIO_INTEGRITY,
    `Verdaccio ${VERDACCIO_VERSION} integrity mismatch: expected ${VERDACCIO_INTEGRITY}, found ${integrity}`,
  );
}

function reservePort(host = registryHost) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForRegistry(registryUrl, fetchImpl = fetch, signal) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const response = await fetchImpl(new URL('-/ping', registryUrl), { signal });
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(
    `Verdaccio did not become ready at ${registryUrl}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function createRegistryUser(registryUrl, fetchImpl = fetch) {
  const username = 'ultramodern-acceptance';
  const response = await fetchImpl(
    new URL(`-/user/org.couchdb.user:${username}`, registryUrl),
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        _id: `org.couchdb.user:${username}`,
        name: username,
        password: 'ultramodern-acceptance-only',
        roles: [],
        type: 'user',
      }),
    },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Could not create the ephemeral Verdaccio publisher (HTTP ${response.status}): ${body}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('Verdaccio publisher response was not valid JSON');
  }
  assert(
    typeof parsed.token === 'string' && parsed.token.length > 0,
    'Verdaccio publisher response did not include an authentication token',
  );
  return parsed.token;
}

// No *_config_registry keys: the .npmrc scopes the ephemeral registry to the
// cohort scope only, so external packuments and tarballs go direct to npmjs
// instead of proxying through Verdaccio. The acceptance profile hard-asserts
// the cohort's lockfile tarball provenance after install, so a silently
// ignored scope override cannot fall through to npmjs unnoticed.
function createRegistryEnv({
  userConfigPath,
  cacheDir,
  verifiedPackages = [],
}) {
  return {
    npm_config_cache: cacheDir,
    npm_config_userconfig: userConfigPath,
    // Source candidates cannot carry npm trusted-publisher evidence before
    // publication. Only exact artifacts verified by this registry are exempt;
    // public history, unrelated dependencies, and published acceptance retain
    // the consumer's normal no-downgrade policy.
    ...(verifiedPackages.length > 0 && {
      PNPM_CONFIG_TRUST_POLICY_EXCLUDE: JSON.stringify(
        verifiedPackages.map(pkg => `${pkg.targetName}@${pkg.version}`).sort(),
      ),
    }),
  };
}

function writeRegistryUserConfig(filePath, registryUrl, token, scope) {
  const url = new URL(registryUrl);
  const authKey = `${url.host}${url.pathname}`.replace(/\/?$/u, '/');
  // The default registry is stated explicitly so the file is self-describing.
  // No always-auth: we hold no token for the npmjs default, and the
  // //host:_authToken line is already host-scoped to the ephemeral registry.
  fs.writeFileSync(
    filePath,
    [
      'registry=https://registry.npmjs.org/',
      `@${scope}:registry=${registryUrl}`,
      `//${authKey}:_authToken=${token}`,
      '',
    ].join('\n'),
  );
}

// Transport-only replacement for the seed loop's per-package `npm view`
// subprocess: one packument GET against the ephemeral registry. The two
// post-publish assertions on the returned dist stay unchanged.
async function readRegistryDistFromPackument(
  specifier,
  registry,
  fetchImpl = fetch,
) {
  const atIndex = specifier.lastIndexOf('@');
  const name = specifier.slice(0, atIndex);
  const version = specifier.slice(atIndex + 1);
  const encodedName = name.startsWith('@')
    ? name.replace('/', '%2f')
    : encodeURIComponent(name);
  const response = await fetchImpl(new URL(encodedName, registry.registryUrl), {
    headers: { accept: 'application/json' },
  });
  assert(
    response.ok,
    `Registry packument for ${specifier} returned HTTP ${response.status}`,
  );
  const packument = await response.json();
  const dist = packument?.versions?.[version]?.dist;
  assert(
    dist && typeof dist === 'object',
    `Registry packument for ${specifier} is missing dist metadata`,
  );
  return dist;
}

async function publishReleaseTarballs(
  release,
  registry,
  authToken,
  {
    publishPackageBufferImpl = publishPackageBuffer,
    readArtifactBytes = readVerifiedPackageArtifactBytes,
    readRegistryDistImpl = readRegistryDistFromPackument,
    fetchImpl = fetch,
  } = {},
) {
  const published = [];
  const packagesByTarget = new Map(
    release.packages.map(item => [item.targetName, item]),
  );
  // Strictly sequential over release.publishOrder — the seed path must remain
  // trivially correct; the dist read is transport-only (no fan-out).
  for (const targetName of release.publishOrder) {
    const item = packagesByTarget.get(targetName);
    assert(
      item,
      `Release publish order references missing package ${targetName}`,
    );
    const acceptedBytes = Buffer.from(
      readArtifactBytes(item, item.artifactPath),
    );
    await publishPackageBufferImpl(item, acceptedBytes, {
      acceptedTools: release.tools,
      authToken,
      provenance: false,
      registryUrl: registry.registryUrl,
      tag: release.release.tag,
    });
    verifyPackageArtifactBytes(item, acceptedBytes);
    const specifier = `${item.targetName}@${item.version}`;
    const dist = await readRegistryDistImpl(specifier, registry, fetchImpl);
    assert(
      dist.integrity === item.integrity,
      `${specifier} registry integrity mismatch after exact tarball publication`,
    );
    assert(
      dist.shasum === item.shasum,
      `${specifier} registry shasum mismatch after exact tarball publication`,
    );
    published.push({
      sourceName: item.sourceName,
      targetName: item.targetName,
      version: item.version,
      integrity: dist.integrity,
      shasum: dist.shasum,
    });
  }
  return published;
}

async function publishStagedSidecars(
  releaseDir,
  acceptedTools,
  registry,
  authToken,
  {
    loadRuntime = loadNpmPublishingRuntime,
    readRegistryDistImpl = readRegistryDistFromPackument,
    readSidecars = readStagedSidecars,
  } = {},
) {
  const { sidecars } = readSidecars(releaseDir);
  const runtime = loadRuntime();
  assertAcceptedPublishToolchain(acceptedTools, runtime);
  const registryUrl = new URL(registry.registryUrl);
  const authKey = `//${registryUrl.host}${registryUrl.pathname}:_authToken`;
  const published = [];

  for (const sidecar of sidecars) {
    await runtime.publish(sidecar.packageJson, sidecar.bytes, {
      access: 'public',
      defaultTag: 'latest',
      npmVersion: runtime.npmVersion,
      provenance: false,
      registry: registry.registryUrl,
      [authKey]: authToken,
    });
    const specifier = `${sidecar.name}@${sidecar.version}`;
    const dist = await readRegistryDistImpl(specifier, registry);
    assert(
      dist.integrity === sidecar.integrity,
      `${specifier} registry integrity mismatch after exact sidecar tarball publication`,
    );
    assert(
      dist.shasum === sidecar.shasum,
      `${specifier} registry shasum mismatch after exact sidecar tarball publication`,
    );
    published.push({
      name: sidecar.name,
      version: sidecar.version,
      integrity: sidecar.integrity,
      shasum: sidecar.shasum,
    });
  }

  return published;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  let timer;
  try {
    await Promise.race([
      once(child, 'exit'),
      new Promise(resolve => {
        timer = setTimeout(resolve, 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

async function startEphemeralRegistry({
  release,
  releaseDir,
  rootDir,
  storeDir,
  fetchImpl = fetch,
  runImpl = runChecked,
  spawnImpl = spawn,
  reservePortImpl = reservePort,
  publishReleaseTarballsImpl = publishReleaseTarballs,
  publishStagedSidecarsImpl = publishStagedSidecars,
}) {
  const packageManagerEnv =
    storeDir === undefined
      ? undefined
      : createAcceptancePackageManagerEnv(rootDir, {}, undefined, process.env, {
          storeDir,
        });
  assertVerdaccioDistributionIntegrity(runImpl, packageManagerEnv);
  const port = await reservePortImpl(registryHost);
  const configPath = path.join(rootDir, 'verdaccio.yaml');
  const storageDir = path.join(rootDir, 'storage');
  const htpasswdPath = path.join(rootDir, 'htpasswd');
  const userConfigPath = path.join(rootDir, '.npmrc');
  const cacheDir = path.join(rootDir, 'npm-cache');
  fs.mkdirSync(rootDir, { recursive: true });
  const sidecarNames = release.sidecars
    ? readStagedSidecars(releaseDir).sidecars.map(sidecar => sidecar.name)
    : [];
  const writeConfig = cohortNames =>
    fs.writeFileSync(
      configPath,
      createVerdaccioConfig({
        storageDir,
        htpasswdPath,
        scope: release.targetScope,
        sidecarNames,
        cohortNames,
      }),
    );
  writeConfig((release.packages ?? []).map(item => item.targetName));
  const registryUrl = `http://${registryHost}:${port}/`;
  let child;
  const startChild = async () => {
    const startedChild = spawnImpl('pnpm', verdaccioDlxArgs(configPath, port), {
      cwd: rootDir,
      env: createProcessEnv(packageManagerEnv ?? {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = startedChild;
    const output = [];
    for (const stream of [startedChild.stdout, startedChild.stderr]) {
      stream?.on('data', chunk => {
        output.push(String(chunk));
        if (output.join('').length > 65_536) {
          output.splice(0, output.length - 1);
        }
      });
    }
    const readiness = new AbortController();
    let onExit;
    let onError;
    const exited = new Promise((_, reject) => {
      onExit = (code, signal) =>
        reject(
          new Error(
            `Verdaccio exited before readiness (code ${code}, signal ${signal})\n${output.join('')}`,
          ),
        );
      onError = reject;
      startedChild.once('exit', onExit);
      startedChild.once('error', onError);
    });
    try {
      await Promise.race([
        waitForRegistry(registryUrl, fetchImpl, readiness.signal),
        exited,
      ]);
    } finally {
      readiness.abort();
      // An intentional seed-phase stop must not reject a stale readiness race.
      startedChild.removeListener('exit', onExit);
      startedChild.removeListener('error', onError);
    }
  };

  try {
    await startChild();
    const token = await createRegistryUser(registryUrl, fetchImpl);
    writeRegistryUserConfig(
      userConfigPath,
      registryUrl,
      token,
      release.targetScope,
    );
    const registry = {
      registryUrl,
      userConfigPath,
      env: createRegistryEnv({ userConfigPath, cacheDir }),
      tool: {
        name: 'verdaccio',
        version: VERDACCIO_VERSION,
        specifier: VERDACCIO_SPECIFIER,
        integrity: VERDACCIO_INTEGRITY,
      },
      stop: () => stopChild(child),
    };
    // Stdout-only seed timing so the seed phase is attributable in job logs;
    // never routed into the receipt. Sidecars publish first because the staged
    // cohort image package aliases them by exact registry version.
    const seedStartedAt = Date.now();
    console.log('[registry] seed start');
    registry.sidecars = release.sidecars
      ? await publishStagedSidecarsImpl(releaseDir, release.tools, registry, token)
      : [];
    registry.published = await publishReleaseTarballsImpl(
      release,
      registry,
      token,
      { fetchImpl },
    );
    // Publishing with an uplink would conflict with already published releases.
    // Once accepted bytes are local, restore history for the consumer install.
    await stopChild(child);
    writeConfig([]);
    await startChild();
    registry.env = createRegistryEnv({
      userConfigPath,
      cacheDir,
      verifiedPackages: release.packages,
    });
    console.log(`[registry] seed end (${Date.now() - seedStartedAt}ms)`);
    return registry;
  } catch (error) {
    if (child) await stopChild(child);
    throw error;
  }
}

export {
  assertVerdaccioDistributionIntegrity,
  createRegistryEnv,
  createVerdaccioConfig,
  publishReleaseTarballs,
  publishStagedSidecars,
  readRegistryDistFromPackument,
  reservePort,
  runChecked,
  startEphemeralRegistry,
  VERDACCIO_INTEGRITY,
  VERDACCIO_SPECIFIER,
  VERDACCIO_UPSTREAM,
  VERDACCIO_VERSION,
  verdaccioDlxArgs,
  writeRegistryUserConfig,
};
