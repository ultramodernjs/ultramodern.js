#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MICROVERTICAL_RELEASE_ENVELOPE_SCHEMA_VERSION,
  verifyMicroVerticalReleaseEnvelope,
} from '@modern-js/app-tools-extensions/release-envelope';

const workspaceRoot = path.resolve(process.env.ULTRAMODERN_WORKSPACE_ROOT ?? process.cwd());
const workspaceRequire = createRequire(path.join(workspaceRoot, 'package.json'));
const topologyPath = path.join(workspaceRoot, 'topology/reference-topology.json');
const localOverlayPath = path.join(workspaceRoot, 'topology/local-overlays/development.json');
const defaultOut = path.join(
  workspaceRoot,
  '.codex/reports/node-backend-federation-proof/proof.json',
);

// Keep these constants/checks in sync with
// @modern-js/utils/universal backend-federation-contract. Generated workspace
// scripts do not currently import @modern-js/utils directly.
const contractVersion = 'microvertical-server-effect-v1';
const nodeAdapterVersion = 'backend-mf-effect-v2';
const backendExpose = './effect-api';
const releaseEnvelopePath = 'release/microvertical-release-envelope.json';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readBuildIdentity(app, target) {
  const buildArtifactPath = path.join(
    workspaceRoot,
    app.directory,
    target,
    'ultramodern-build.json',
  );
  assertFile(buildArtifactPath, app.id, 'stamped target build identity');
  const artifact = readJson(buildArtifactPath);
  const deliveryUnit = artifact.deliveryUnit ?? {};
  return {
    artifactPath: buildArtifactPath,
    buildVersion: deliveryUnit.buildMarker ?? deliveryUnit.build,
    packageName: deliveryUnit.packageName,
    version: deliveryUnit.version,
    unitId: deliveryUnit.unitId,
    sourceRevision: deliveryUnit.sourceRevision,
  };
}

function hasBackendFederationManifestAdapter(runtime) {
  return typeof runtime?.loadBackendFederatedEffectApiFromManifest === 'function';
}

export async function importBackendFederationRuntime() {
  const runtimePath = workspaceRequire.resolve(
    '@modern-js/plugin-bff-extensions/backend-federation-manifest/node',
  );
  const effectPath = workspaceRequire.resolve('@modern-js/bff-effect/effect');
  const [runtime, effect] = await Promise.all([
    import(pathToFileURL(runtimePath).href),
    import(pathToFileURL(effectPath).href),
  ]);
  if (!hasBackendFederationManifestAdapter(runtime)) {
    throw new Error(
      `${runtimePath} does not export loadBackendFederatedEffectApiFromManifest`,
    );
  }
  if (typeof effect.createEffectBffTestHandler !== 'function') {
    throw new Error(
      `${effectPath} does not export createEffectBffTestHandler`,
    );
  }
  return {
    loadBackendFederatedEffectApiFromManifest:
      runtime.loadBackendFederatedEffectApiFromManifest,
    createEffectBffTestHandler: effect.createEffectBffTestHandler,
  };
}

function normalizeRelativePath(value) {
  return String(value ?? '')
    .replace(/\\/gu, '/')
    .replace(/^\.\/+/u, '');
}

function toPascalCase(value) {
  return String(value)
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function createBackendName(app) {
  return (
    app.backendFederation?.name ??
    app.backendFederation?.executionSurfaces?.node?.remoteName ??
    (typeof app.moduleFederation?.name === 'string'
      ? `${app.moduleFederation.name}Backend`
      : `vertical${toPascalCase(app.id)}Backend`)
  );
}

function createBackendManifestUrl(app) {
  return (
    app.serverExecution?.node?.manifestUrl ??
    `http://localhost:${app.port}/backend-mf-manifest.json`
  );
}

function createBackendContainerEntry(app) {
  return (
    app.serverExecution?.node?.containerEntry ??
    `http://localhost:${app.port}/backendRemoteEntry.cjs`
  );
}

function resolveRemoteType(app) {
  return (
    app.serverExecution?.node?.remoteType ??
    app.backendFederation?.executionSurfaces?.node?.remoteType ??
    'commonjs-module'
  );
}

function normalizeRoutePath(value) {
  const route = String(value ?? '').trim();
  if (!route) {
    return '/';
  }
  return route.startsWith('/') ? route : `/${route}`;
}

function collectJsonSmokeChecks(apps, targetApp) {
  const apiPrefix = normalizeRoutePath(targetApp.api?.prefix ?? `/${targetApp.id}-api`);

  const configuredChecks = apps
    .flatMap((app) =>
      Array.isArray(app?.cloudflare?.jsonSmokeChecks)
        ? app.cloudflare.jsonSmokeChecks
        : [],
    )
    .filter((check) => {
      if (typeof check?.route !== 'string') {
        return false;
      }
      const route = normalizeRoutePath(check.route);
      return route === apiPrefix || route.startsWith(`${apiPrefix}/`);
    });

  if (configuredChecks.length > 0) {
    return configuredChecks;
  }

  const readinessRoute =
    targetApp.backendFederation?.exposes?.[backendExpose]?.readiness ??
    targetApp.backendFederation?.versionBoundary?.api?.readiness ??
    targetApp.serverExecution?.cloudflare?.apiReadiness;
  if (typeof readinessRoute !== 'string' || readinessRoute.length === 0) {
    return [];
  }

  return [
    {
      id: `${targetApp.id}-backend-readiness`,
      method: 'GET',
      route: readinessRoute,
      expect: {
        'checks.api': 'ready',
        status: 'ready',
        versionSkew: 'none',
      },
    },
  ];
}

export function topologyApps(topology, localOverlay, appFilter, env = process.env) {
  if (!Array.isArray(topology?.verticals) || !localOverlay?.ports || !localOverlay?.serverExecution) {
    throw new Error('Node proof requires declared reference topology and development overlay.');
  }
  const apps = topology.verticals;
  const filteredApps = apps
    .filter((app) => app?.kind === 'vertical' && app.api)
    .filter((app) => !appFilter || app.id === appFilter)
    .map((app) => {
      const overlayPort = localOverlay.ports[app.id];
      const domain = app.domain ?? app.id;
      const portEnv = app.portEnv ??
        `VERTICAL_${String(domain).replace(/[^a-zA-Z0-9]/gu, '_').toUpperCase()}_PORT`;
      const configuredPort = env[portEnv];
      const port = configuredPort === undefined ? overlayPort : Number(configuredPort);
      const serverExecution = localOverlay.serverExecution[app.id];
      if (!app.path || !Number.isInteger(overlayPort) || !Number.isInteger(port) || port < 1 || port > 65535 || !serverExecution?.node) {
        throw new Error(`${app.id} is missing its declared path, port or Node server execution.`);
      }
      const appManifest = readJson(path.join(workspaceRoot, app.path, 'package.json'));
      if (app.package !== appManifest.name || typeof appManifest.version !== 'string') {
        throw new Error(`${app.id} topology package identity must match package.json`);
      }
      const api = { ...app.api, prefix: app.api.bff?.prefix };
      const declared = { ...app, api, serverExecution };
      const publicUrlEnv = app.cloudflare?.publicUrlEnv;
      const configuredPublicUrl = publicUrlEnv ? env[publicUrlEnv] : undefined;
      const publicOrigin = configuredPublicUrl
        ? new URL(configuredPublicUrl).origin
        : `http://localhost:${port}`;
      if (!/^https?:\/\//u.test(publicOrigin)) {
        throw new Error(`${app.id} has an invalid declared public URL.`);
      }
      const nodeUrl = (declaredUrl) => {
        const url = new URL(declaredUrl);
        return url.origin === new URL(`http://localhost:${overlayPort}`).origin &&
          url.username === '' &&
          url.password === ''
          ? `${publicOrigin}${url.pathname}${url.search}${url.hash}`
          : declaredUrl;
      };
      return {
      id: app.id,
      directory: normalizeRelativePath(app.path),
      backendName: createBackendName(declared),
      manifestUrl: nodeUrl(createBackendManifestUrl(declared)),
      containerEntry: nodeUrl(createBackendContainerEntry(declared)),
      port,
      portEnv,
      remoteType: resolveRemoteType(declared),
      apiProtocol: app.api.protocol ?? 'rest',
      apiPrefix: app.api.bff?.prefix,
      rpcPath: app.api.rpcPath,
      rpcSerialization: app.api.rpcSerialization,
      apiOnly: app.surfaceProfile === 'api-only',
      ...(app.rendererProfile ? { rendererProfile: app.rendererProfile } : {}),
      smokeChecks: collectJsonSmokeChecks(apps, declared),
      topologyDeliveryUnit:
        app.deliveryUnit && typeof app.deliveryUnit === 'object'
          ? app.deliveryUnit
          : undefined,
      packageName: appManifest.name,
      version: appManifest.version,
    };
    });

  if (appFilter && filteredApps.length === 0) {
    throw new Error(`No vertical API app matched --app ${appFilter}`);
  }

  return filteredApps;
}

// Public URLs remain manifest identity inputs; proof traffic only targets the
// resolved local app port, including when servers are supplied in existing mode.
function nodeProofOrigin(app) {
  if (!Number.isInteger(app.port) || app.port < 1 || app.port > 65535) {
    throw new Error(`${app.id} has no valid Node proof port`);
  }
  return `http://127.0.0.1:${app.port}`;
}

function nodeProofArtifactUrl(app, declaredUrl, logicalPath) {
  const expectedUrl = logicalPath === 'backend-mf-manifest.json'
    ? app.manifestUrl
    : logicalPath === 'backendRemoteEntry.cjs'
      ? app.containerEntry
      : undefined;
  const url = new URL(declaredUrl);
  if (expectedUrl === undefined || declaredUrl !== expectedUrl ||
      !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !url.pathname.endsWith(`/${logicalPath}`)) {
    throw new Error(`${app.id} unsupported Node proof artifact URL ${declaredUrl}`);
  }
  // The owned server serves these envelope artifacts from its output root.
  // Deployment prefixes, query and fragment stay in the declared identity;
  // never resolve their pathname (which may start with //) as a transport URL.
  return `${nodeProofOrigin(app)}/${logicalPath}`;
}

function nodeProofApiUrl(app, route) {
  const origin = nodeProofOrigin(app);
  const url = new URL(route, origin);
  const prefix = app.apiPrefix;
  if (typeof prefix !== 'string' || prefix === '/' ||
      !prefix.startsWith('/') || (!route.startsWith(`${prefix}/`) && route !== prefix) ||
      url.origin !== origin || url.pathname !== route ||
      url.search || url.hash || route.includes('\\')) {
    throw new Error(`${app.id} unsupported or cross-app Node proof API path ${route}`);
  }
  return url.href;
}

const sleep = (durationMs) =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

async function assertPortAvailable(port, appId) {
  for (const host of ['127.0.0.1', '::']) {
    await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once('error', (error) => {
        if (
          host === '::' &&
          ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error?.code)
        ) {
          resolve();
          return;
        }
        reject(
          new Error(
            `${appId} Node proof port ${port} is unavailable on ${host}: ${error.message}`,
          ),
        );
      });
      server.listen({ host, port }, () => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });
  }
}

function runtimeLogTail(logPath) {
  if (!fs.existsSync(logPath)) {
    return '';
  }
  const source = fs.readFileSync(logPath, 'utf8');
  return source.length > 8_000 ? source.slice(-8_000) : source;
}

async function waitForNodeRuntime(runtime, startupTimeoutMs) {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (runtime.exitResult) {
      const tail = runtimeLogTail(runtime.logPath);
      throw new Error(
        `${runtime.appId} Node runtime exited before readiness (code ${runtime.exitResult.exitCode}, signal ${runtime.exitResult.signal})${
          tail ? `\n${tail}` : ''
        }`,
      );
    }
    try {
      const response = await fetch(runtime.manifestUrl, {
        redirect: 'error',
        headers: {
          accept: 'application/json',
          'cache-control': 'no-cache',
        },
      });
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }

  throw new Error(
    `${runtime.appId} Node runtime did not serve ${runtime.manifestUrl} within ${startupTimeoutMs}ms${
      lastError instanceof Error ? `: ${lastError.message}` : ''
    }`,
  );
}

export async function startNodeRuntime(
  app,
  target,
  {
    deferReadiness = false,
    startupTimeoutMs = 90_000,
    workspaceRoot: runtimeWorkspaceRoot = workspaceRoot,
  } = {},
) {
  const manifestUrl = nodeProofArtifactUrl(app, app.manifestUrl, 'backend-mf-manifest.json');
  const parsedPort = app.port;
  await assertPortAvailable(parsedPort, app.id);

  const outputDirectory = path.join(
    runtimeWorkspaceRoot,
    app.directory,
    target,
  );
  const entryPath = path.join(outputDirectory, 'index.js');
  assertFile(entryPath, app.id, 'Node deploy entry');
  const logPath = path.join(
    runtimeWorkspaceRoot,
    '.codex/reports/node-backend-federation-proof',
    `${app.id}-serve.log`,
  );
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { flags: 'w' });
  const env = {
    ...process.env,
    PORT: String(parsedPort),
    ...(typeof app.portEnv === 'string' && app.portEnv.length > 0
      ? { [app.portEnv]: String(parsedPort) }
      : {}),
  };
  const child = spawn(process.execPath, ['index.js'], {
    cwd: outputDirectory,
    detached: process.platform !== 'win32',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  const runtime = {
    appId: app.id,
    child,
    exitResult: undefined,
    logPath,
    logStream,
    manifestUrl,
  };
  runtime.exited = new Promise((resolve) => {
    let spawnError;
    child.once('error', (error) => {
      spawnError = error instanceof Error ? error.message : String(error);
    });
    child.once('close', (exitCode, signal) => {
      runtime.exitResult = { exitCode, signal, spawnError };
      logStream.end();
      resolve(runtime.exitResult);
    });
  });

  if (deferReadiness) {
    runtime.startupTimeoutMs = startupTimeoutMs;
    return runtime;
  }

  try {
    await waitForNodeRuntime(runtime, startupTimeoutMs);
    return runtime;
  } catch (error) {
    await stopNodeRuntime(runtime);
    throw error;
  }
}

function processGroupIsAlive(pid) {
  if (process.platform === 'win32' || !pid) {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalRuntime(runtime, signal) {
  if (!runtime.child.pid) {
    return;
  }
  if (process.platform === 'win32') {
    runtime.child.kill(signal);
    return;
  }
  try {
    process.kill(-runtime.child.pid, signal);
  } catch {}
}

export async function stopNodeRuntime(runtime) {
  if (!runtime?.child || runtime.exitResult) {
    return;
  }
  signalRuntime(runtime, 'SIGTERM');
  const deadline = Date.now() + 5_000;
  while (
    processGroupIsAlive(runtime.child.pid) &&
    Date.now() < deadline
  ) {
    await sleep(50);
  }
  if (processGroupIsAlive(runtime.child.pid)) {
    signalRuntime(runtime, 'SIGKILL');
  }
  await Promise.race([runtime.exited, sleep(1_000)]);
}

export function resolveNodeProofServerMode(env = process.env) {
  const mode = env.ULTRAMODERN_NODE_PROOF_SERVER_MODE ?? 'owned';
  if (mode !== 'owned' && mode !== 'existing') {
    throw new Error(
      `ULTRAMODERN_NODE_PROOF_SERVER_MODE must be "owned" or "existing", received ${JSON.stringify(mode)}`,
    );
  }
  return mode;
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}

function assertFile(filePath, appId, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `${appId} missing ${path.relative(
        workspaceRoot,
        filePath,
      )}; run pnpm build or the relevant vertical build before pnpm node:proof`,
    );
  }

  if (!fs.statSync(filePath).isFile()) {
    throw new Error(`${appId} ${label} is not a file`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function readBoundReleaseEnvelope(app, target) {
  const targetDirectory = path.join(workspaceRoot, app.directory, target);
  const envelopePath = path.join(targetDirectory, releaseEnvelopePath);
  assertFile(envelopePath, app.id, 'Node release envelope');
  const envelope = readJson(envelopePath);
  assertEqual(
    envelope.schemaVersion,
    MICROVERTICAL_RELEASE_ENVELOPE_SCHEMA_VERSION,
    `${app.id} release-envelope schema`,
  );
  assertEqual(envelope.target, 'node', `${app.id} release-envelope target`);
  assertEqual(
    envelope.kind,
    'ultramodern-target-microvertical-release-envelope',
    `${app.id} release-envelope kind`,
  );
  if (app.apiOnly) {
    if (envelope.surfaces?.uiClient?.length !== 0 || envelope.surfaces?.ssr?.length !== 0) {
      throw new Error(`${app.id} API-only release envelope must declare empty UI/client and SSR surfaces`);
    }
  } else if (!envelope.surfaces?.uiClient?.length || !envelope.surfaces?.ssr?.length) {
    throw new Error(`${app.id} full-stack release envelope must bind UI/client and SSR surfaces`);
  }
  if (!app.apiOnly && !app.rendererProfile) {
    throw new Error(`${app.id} full-stack Node proof requires its resolved renderer profile`);
  }

  const manifestLogicalPath = envelope.surfaces?.backendFederation?.manifest;
  const containerLogicalPath = envelope.surfaces?.backendFederation?.container;
  assertEqual(
    manifestLogicalPath,
    'backend-mf-manifest.json',
    `${app.id} release-envelope backend manifest path`,
  );
  assertEqual(
    containerLogicalPath,
    'backendRemoteEntry.cjs',
    `${app.id} release-envelope backend container path`,
  );

  const apiBackendPaths = envelope.surfaces?.apiBackend;
  if (!Array.isArray(apiBackendPaths) || apiBackendPaths.length === 0) {
    throw new Error(`${app.id} release envelope has no bound API/backend executable`);
  }
  if (
    !apiBackendPaths.some((logicalPath) =>
      /^api\/.*\.(?:c|m)?js$/u.test(logicalPath),
    )
  ) {
    throw new Error(
      `${app.id} release envelope does not bind a compiled api/**/*.js executable`,
    );
  }

  const artifacts = Array.isArray(envelope.artifacts) ? envelope.artifacts : [];
  const artifactByPath = new Map(
    artifacts.map((artifact) => [artifact.logicalPath, artifact]),
  );
  const requiredPaths = [
    manifestLogicalPath,
    containerLogicalPath,
    ...apiBackendPaths,
  ];
  const boundArtifacts = requiredPaths.map((logicalPath) => {
    const artifact = artifactByPath.get(logicalPath);
    if (!artifact) {
      throw new Error(
        `${app.id} release envelope surface references unbound artifact ${logicalPath}`,
      );
    }
    if (artifact.kind !== 'file') {
      throw new Error(
        `${app.id} release envelope surface references non-file artifact ${logicalPath}`,
      );
    }
    const artifactPath = path.join(targetDirectory, logicalPath);
    assertFile(artifactPath, app.id, `release-envelope artifact ${logicalPath}`);
    const bytes = fs.readFileSync(artifactPath);
    assertEqual(
      bytes.byteLength,
      artifact.byteLength,
      `${app.id} ${logicalPath} envelope byte length`,
    );
    assertEqual(
      sha256(bytes),
      artifact.sha256,
      `${app.id} ${logicalPath} envelope SHA-256`,
    );
    return artifact;
  });
  const verifiedEnvelope = await verifyMicroVerticalReleaseEnvelope(envelope, {
    artifactRoot: targetDirectory,
    expectedTarget: 'node',
    ...(app.apiOnly ? {} : { expectedRendererProfile: app.rendererProfile }),
  });
  if (!app.apiOnly) {
    assertEqual(
      verifiedEnvelope.ui.rendererIdentity.appId,
      app.id,
      `${app.id} release-envelope renderer app identity`,
    );
  }

  return {
    envelope: verifiedEnvelope,
    envelopePath,
    manifestArtifact: artifactByPath.get(manifestLogicalPath),
    containerArtifact: artifactByPath.get(containerLogicalPath),
    apiBackendArtifacts: boundArtifacts.filter((artifact) =>
      apiBackendPaths.includes(artifact.logicalPath),
    ),
  };
}

export async function fetchBoundArtifact(
  app,
  url,
  artifact,
  label,
  fetchImpl = globalThis.fetch,
) {
  const transportUrl = nodeProofArtifactUrl(app, url, artifact.logicalPath);
  const response = await fetchImpl(transportUrl, {
    redirect: 'error',
    headers: {
      accept: '*/*',
      'cache-control': 'no-cache',
    },
  });
  if (!response.ok) {
    throw new Error(`${app.id} live ${label} returned HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  assertEqual(
    bytes.byteLength,
    artifact.byteLength,
    `${app.id} live ${label} byte length`,
  );
  const digest = sha256(bytes);
  assertEqual(
    digest,
    artifact.sha256,
    `${app.id} live ${label} SHA-256`,
  );
  const urlPath = normalizeRelativePath(new URL(url).pathname);
  if (!urlPath.endsWith(artifact.logicalPath)) {
    throw new Error(
      `${app.id} live ${label} URL ${url} does not map to envelope artifact ${artifact.logicalPath}`,
    );
  }
  return {
    bytes,
    evidence: {
      url,
      transportUrl,
      logicalPath: artifact.logicalPath,
      statusCode: response.status,
      byteLength: bytes.byteLength,
      sha256: digest,
      status: 'pass',
    },
  };
}

export async function loadBackendFromVerifiedArtifacts({
  app,
  buildIdentity,
  container,
  loadImpl,
  manifest,
}) {
  let manifestDocument;
  try {
    manifestDocument = JSON.parse(Buffer.from(manifest.bytes).toString('utf8'));
  } catch (error) {
    throw new Error(
      `${app.id} verified live backend manifest is invalid JSON: ${error.message}`,
    );
  }
  const verifiedContainerBytes = Buffer.from(container.bytes);
  const verifiedEntryUrl = new URL(app.containerEntry);
  // Match native backend-federation-security's HTTP resource identity. Fragments
  // remain exact manifest inputs, but are never part of its entry fetch URL.
  verifiedEntryUrl.hash = '';
  const fetchVerifiedEntry = async (url, init = {}) => {
    const requestedEntryUrl = new URL(url);
    requestedEntryUrl.hash = '';
    assertEqual(
      requestedEntryUrl.href,
      verifiedEntryUrl.href,
      `${app.id} verified backend container URL`,
    );
    if (init.signal?.aborted) {
      throw init.signal.reason ?? new Error('Verified entry load was aborted');
    }
    return new Response(verifiedContainerBytes, {
      headers: {
        'content-length': String(verifiedContainerBytes.byteLength),
        'content-type': 'text/javascript',
      },
      status: 200,
    });
  };

  return loadImpl({
    hostName: 'ultramodernNodeBackendProof',
    manifest: manifestDocument,
    entryPolicy: { fetch: fetchVerifiedEntry },
    expected: {
      buildMarker: buildIdentity.buildVersion,
      buildVersion: buildIdentity.buildVersion,
      contractVersion,
      nodeAdapterVersion,
      packageName: buildIdentity.packageName,
      remoteName: app.backendName,
      unitId: buildIdentity.unitId,
    },
  });
}

async function proveLiveApi(app, manifest, releaseBinding) {
  const route = normalizeRoutePath(
    manifest.backendFederation?.readinessPath,
  );
  const url = nodeProofApiUrl(app, route);
  const response = await fetch(url, {
    redirect: 'error',
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache',
    },
  });
  const bodyText = await response.text();
  let body;
  try {
    body = bodyText.length > 0 ? JSON.parse(bodyText) : undefined;
  } catch (error) {
    throw new Error(
      `${app.id} live API GET ${route} did not return JSON: ${error.message}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `${app.id} live API GET ${route} returned HTTP ${response.status}`,
    );
  }

  const identity = releaseBinding.envelope.identity ?? {};
  const marker = body?.marker;
  assertEqual(
    marker?.unitId,
    identity.unitId,
    `${app.id} live API marker unitId`,
  );
  assertEqual(
    marker?.buildMarker ?? marker?.build,
    identity.buildMarker,
    `${app.id} live API marker buildMarker`,
  );
  assertEqual(
    marker?.sourceRevision,
    identity.sourceRevision,
    `${app.id} live API marker sourceRevision`,
  );
  assertEqual(
    marker?.version,
    identity.releaseVersion,
    `${app.id} live API marker releaseVersion`,
  );

  return {
    method: 'GET',
    route,
    url,
    statusCode: response.status,
    marker: {
      unitId: marker.unitId,
      buildMarker: marker.buildMarker ?? marker.build,
      sourceRevision: marker.sourceRevision,
      releaseVersion: marker.version,
    },
    envelopeDigest: releaseBinding.envelope.envelopeDigest,
    apiBackendArtifacts: releaseBinding.apiBackendArtifacts.map((artifact) => ({
      logicalPath: artifact.logicalPath,
      runtime: artifact.runtime,
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
    })),
    status: 'pass',
  };
}

export async function proveLiveRpcApi(app, loaded, manifest, releaseBinding) {
  const contract = loaded.contract;
  if (contract?.protocol !== 'rpc' || typeof contract.group !== 'string' ||
      typeof contract.path !== 'string' || contract.serialization !== 'json') {
    throw new Error(`${app.id} backend expose missing native RPC contract`);
  }
  assertEqual(contract.path, app.rpcPath, `${app.id} RPC contract/topology path`);
  assertEqual(contract.path, manifest.backendFederation?.rpcPath, `${app.id} RPC contract/manifest path`);
  assertEqual(contract.serialization, app.rpcSerialization, `${app.id} RPC contract/topology serialization`);
  assertEqual(contract.serialization, manifest.backendFederation?.rpcSerialization, `${app.id} RPC contract/manifest serialization`);
  const check = app.smokeChecks.find((entry) => entry?.body?.method === 'list' && entry.route === contract.path);
  if (!check || !Number.isInteger(check.body?.params?.limit) || check.body.params.limit < 1) {
    throw new Error(`${app.id} has no declared RPC list smoke check`);
  }
  const route = normalizeRoutePath(contract.path);
  const url = nodeProofApiUrl(app, route);
  const appRequire = createRequire(
    path.join(workspaceRoot, app.directory, 'package.json'),
  );
  const clientModule = appRequire(`${app.packageName}/api/rpc-client`);
  const { FetchHttpClient } = await import(pathToFileURL(appRequire.resolve('effect/http')).href);
  // Scope redirect policy to these native client effects, never global fetch.
  const runRpc = (effect) => clientModule.Effect.runPromise(
    clientModule.Effect.provideService(effect, FetchHttpClient.RequestInit, { redirect: 'error' }),
  );
  const clientName = toPascalCase(contract.group);
  const localContract = clientModule[`${clientName}RpcContract`];
  if (localContract?.path !== contract.path ||
      localContract?.group !== contract.group ||
      localContract?.serialization !== contract.serialization ||
      localContract?.protocol !== contract.protocol) {
    throw new Error(`${app.id} public RPC client contract does not match the verified backend expose`);
  }
  const makeClient = clientModule[`make${clientName}RpcClient`];
  if (typeof makeClient !== 'function' ||
      typeof clientModule.Effect?.runPromise !== 'function') {
    throw new Error(`${app.id} has no native public RPC client`);
  }
  const client = await clientModule.Effect.runPromise(makeClient({ url }));
  try {
    const listed = await runRpc(client.list({ limit: check.body.params.limit }));
    const item = listed?.items?.[0];
    if (typeof item?.id !== 'string' || item.id.length === 0) {
      throw new Error(`${app.id} native RPC list returned no item id`);
    }
    for (const expectation of normalizeJsonExpectations(check)) {
      if (expectation.path === 'id') {
        assertJsonEqual(check.body.id, expectation.value, `${app.id} declared RPC request id`);
      } else if (expectation.path.startsWith('result.')) {
        assertJsonEqual(
          jsonPathValue(listed, expectation.path.slice('result.'.length)),
          expectation.value,
          `${app.id} native RPC ${expectation.path}`,
        );
      } else {
        throw new Error(`${app.id} RPC smoke check has unsupported expectation ${expectation.path}`);
      }
    }
    const fetched = await runRpc(client.get({ id: item.id }));
    assertEqual(fetched?.id, item.id, `${app.id} native RPC get item id`);
    const missingId = `__ultramodern-proof-missing-${item.id}__`;
    const missing = await runRpc(
      clientModule.Effect.match(client.get({ id: missingId }), {
        onFailure: (error) => ({ error }),
        onSuccess: (value) => ({ value }),
      }),
    );
    const expectedErrorTag = `${toPascalCase(contract.group)}NotFoundRpc`;
    if (missing?.error?._tag !== expectedErrorTag ||
        missing.error?.id !== missingId) {
      throw new Error(`${app.id} native RPC get did not return ${expectedErrorTag} for a missing item`);
    }
    return {
      method: 'RPC',
      route,
      url,
      protocol: contract.protocol,
      serialization: contract.serialization,
      group: contract.group,
      operations: [
        { method: 'list', itemId: item.id, status: 'pass' },
        { method: 'get', itemId: fetched.id, status: 'pass' },
        { method: 'get', errorTag: missing.error._tag, missingId, status: 'pass' },
      ],
      envelopeDigest: releaseBinding.envelope.envelopeDigest,
      apiBackendArtifacts: releaseBinding.apiBackendArtifacts.map((artifact) => ({
        logicalPath: artifact.logicalPath,
        runtime: artifact.runtime,
        byteLength: artifact.byteLength,
        sha256: artifact.sha256,
      })),
      status: 'pass',
    };
  } finally {
    await client.dispose();
  }
}

function jsonPathValue(value, path) {
  const segments = String(path ?? '')
    .split('.')
    .filter(Boolean);
  let current = value;
  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current) && /^\d+$/u.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function normalizeJsonExpectations(check) {
  if (Array.isArray(check.expectations)) {
    return check.expectations;
  }
  if (check.expect && typeof check.expect === 'object') {
    return Object.entries(check.expect).map(([path, value]) => ({
      path,
      value,
    }));
  }
  return [];
}

function assertJsonEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

async function runSmokeChecks(app, loaded, createEffectBffTestHandler) {
  if (!Array.isArray(app.smokeChecks) || app.smokeChecks.length === 0) {
    throw new Error(
      `${app.id} backend runtime has no smoke checks; configure a JSON smoke check or expose an API readiness route`,
    );
  }
  if (typeof createEffectBffTestHandler !== 'function') {
    throw new Error(`${app.id} backend runtime cannot create Effect test handler`);
  }

  const servicePrefix = loaded.contract?.protocol === 'rpc'
    ? app.apiPrefix
    : loaded.contract?.servicePrefix ?? loaded.contract?.apiPrefix;
  if (typeof servicePrefix !== 'string' || servicePrefix.length === 0) {
    throw new Error(
      `${app.id} backend expose missing declared API prefix`,
    );
  }
  if (loaded.contract?.protocol === 'rpc') {
    assertEqual(loaded.contract.path, app.rpcPath, `${app.id} RPC smoke route`);
  }

  const edge = await createEffectBffTestHandler({
    module: loaded.runtime,
    prefix: servicePrefix,
  });
  try {
    const results = [];
    for (const check of app.smokeChecks) {
      const method = String(check.method ?? 'GET').toUpperCase();
      const route = normalizeRoutePath(check.route);
      const headers = {};
      const init = { method, headers };
      if (check.body !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(check.body);
      }

      const response = await edge.handler(new Request(nodeProofApiUrl(app, route), init));
      const bodyText = await response.text();
      let body;
      try {
        body = bodyText.length > 0 ? JSON.parse(bodyText) : undefined;
      } catch (error) {
        throw new Error(`${app.id} ${method} ${route} did not return JSON: ${error.message}`);
      }

      if (!response.ok) {
        throw new Error(`${app.id} ${method} ${route} returned HTTP ${response.status}`);
      }

      const assertions = normalizeJsonExpectations(check).map((expectation) => {
        const actual = jsonPathValue(body, expectation.path);
        assertJsonEqual(
          actual,
          expectation.value,
          `${app.id} ${method} ${route} ${expectation.path}`,
        );
        return {
          path: expectation.path,
          expected: expectation.value,
          actual,
          status: 'pass',
        };
      });

      results.push({
        id: check.id ?? `${method} ${route}`,
        method,
        route,
        statusCode: response.status,
        assertions,
        status: 'pass',
      });
    }
    return results;
  } finally {
    await edge.dispose?.();
  }
}

function resolveArtifacts(app, target) {
  const targetDirectory = path.join(workspaceRoot, app.directory, target);

  return {
    manifestPath: path.join(targetDirectory, 'backend-mf-manifest.json'),
    entryPath: path.join(targetDirectory, 'backendRemoteEntry.cjs'),
  };
}

function validateManifest(app, manifest, buildIdentity) {
  assertEqual(manifest.schemaVersion, 1, `${app.id} backend manifest schema`);
  assertEqual(manifest.name, app.backendName, `${app.id} backend manifest name`);
  assertEqual(manifest.id, app.backendName, `${app.id} backend manifest id`);
  assertEqual(
    manifest.version,
    buildIdentity.version,
    `${app.id} backend manifest version`,
  );
  assertEqual(
    manifest.buildVersion,
    buildIdentity.buildVersion,
    `${app.id} backend manifest build version`,
  );
  assertEqual(manifest.metaData?.name, app.backendName, `${app.id} backend manifest metadata name`);
  assertEqual(
    manifest.metaData?.buildInfo?.buildName,
    buildIdentity.packageName,
    `${app.id} backend manifest package name`,
  );
  assertEqual(
    manifest.metaData?.buildInfo?.buildVersion,
    buildIdentity.buildVersion,
    `${app.id} backend manifest metadata build version`,
  );
  assertEqual(
    manifest.metaData?.remoteEntry?.name,
    'backendRemoteEntry.cjs',
    `${app.id} backend manifest remote entry filename`,
  );
  assertEqual(
    manifest.metaData?.remoteEntry?.type,
    app.remoteType,
    `${app.id} backend manifest remote entry type`,
  );
  assertEqual(manifest.entry?.url, app.containerEntry, `${app.id} backend manifest entry URL`);
  assertEqual(manifest.entry?.type, app.remoteType, `${app.id} backend manifest entry type`);
  assertEqual(
    manifest.backendFederation?.role,
    'microvertical-server',
    `${app.id} backend manifest role`,
  );
  assertEqual(
    manifest.backendFederation?.runtimeFramework,
    'effect',
    `${app.id} backend manifest runtime framework`,
  );
  assertEqual(
    manifest.backendFederation?.strictEffectApproach,
    true,
    `${app.id} backend manifest strict Effect flag`,
  );
  assertEqual(
    manifest.backendFederation?.contractVersion,
    contractVersion,
    `${app.id} backend manifest contract version`,
  );
  assertEqual(
    manifest.backendFederation?.nodeAdapterVersion,
    nodeAdapterVersion,
    `${app.id} backend manifest Node adapter version`,
  );
  assertEqual(
    manifest.backendFederation?.manifestUrl,
    app.manifestUrl,
    `${app.id} backend manifest URL`,
  );
  assertEqual(
    manifest.backendFederation?.containerEntry,
    app.containerEntry,
    `${app.id} backend container URL`,
  );
  assertEqual(manifest.backendFederation?.expose, backendExpose, `${app.id} backend expose`);
  assertEqual(
    manifest.backendFederation?.versionBoundary?.packageName,
    buildIdentity.packageName,
    `${app.id} backend manifest version-boundary package`,
  );
  assertEqual(
    manifest.backendFederation?.versionBoundary?.version,
    buildIdentity.version,
    `${app.id} backend manifest version-boundary version`,
  );
  assertEqual(
    manifest.backendFederation?.versionBoundary?.buildVersion,
    buildIdentity.buildVersion,
    `${app.id} backend manifest version-boundary build version`,
  );

  const manifestDeliveryUnit = manifest.backendFederation?.deliveryUnit;
  if (manifestDeliveryUnit) {
    assertEqual(
      manifestDeliveryUnit.unitId,
      buildIdentity.unitId,
      `${app.id} backend manifest delivery-unit id`,
    );
    assertEqual(
      manifestDeliveryUnit.buildMarker,
      buildIdentity.buildVersion,
      `${app.id} backend manifest delivery-unit build marker`,
    );
    assertEqual(
      manifestDeliveryUnit.packageName,
      buildIdentity.packageName,
      `${app.id} backend manifest delivery-unit package name`,
    );
    assertEqual(
      manifestDeliveryUnit.version,
      buildIdentity.version,
      `${app.id} backend manifest delivery-unit version`,
    );
    assertEqual(
      manifestDeliveryUnit.sourceRevision,
      buildIdentity.sourceRevision,
      `${app.id} backend manifest delivery-unit source revision`,
    );
  }

  const versionBoundaryDeliveryUnit =
    manifest.backendFederation?.versionBoundary?.deliveryUnit;
  if (versionBoundaryDeliveryUnit) {
    assertEqual(
      versionBoundaryDeliveryUnit.unitId,
      buildIdentity.unitId,
      `${app.id} backend manifest version-boundary delivery-unit id`,
    );
    assertEqual(
      versionBoundaryDeliveryUnit.buildMarker,
      buildIdentity.buildVersion,
      `${app.id} backend manifest version-boundary delivery-unit build marker`,
    );
  }

  const exposes = Array.isArray(manifest.exposes) ? manifest.exposes : [];
  if (!exposes.some((expose) => expose?.name === backendExpose)) {
    throw new Error(`${app.id} backend manifest missing ${backendExpose} expose`);
  }
}

function assertTopologyStableIdentityMatchesBuild(app, buildIdentity) {
  const topologyDeliveryUnit = app.topologyDeliveryUnit;
  if (!topologyDeliveryUnit) {
    throw new Error(`${app.id} is missing its declared topology delivery-unit identity`);
  }

  const mismatches = [];
  const compare = (label, a, b) => {
    if (a !== undefined && b !== undefined && a !== b) {
      mismatches.push(`${label}: deliveryUnit=${a} vs ultramodern-build=${b}`);
    }
  };
  compare('unitId', topologyDeliveryUnit.unitId, buildIdentity.unitId);
  compare(
    'packageName',
    topologyDeliveryUnit.packageName,
    buildIdentity.packageName,
  );
  compare('version', topologyDeliveryUnit.version, buildIdentity.version);
  compare('packageName', app.packageName, buildIdentity.packageName);
  compare('version', app.version, buildIdentity.version);

  if (mismatches.length > 0) {
    throw new Error(
      `${app.id} delivery-unit identity drift between ${path.relative(
        workspaceRoot,
        topologyPath,
      )} (reference topology) and ${path.relative(
        workspaceRoot,
        buildIdentity.artifactPath,
      )} (stamped target identity): ${mismatches.join('; ')}`,
    );
  }
}

export async function proveBackend(app, backendRuntime, target) {
  const {
    createEffectBffTestHandler,
    loadBackendFederatedEffectApiFromManifest,
  } = backendRuntime;
  const { manifestPath, entryPath } = resolveArtifacts(app, target);

  assertFile(manifestPath, app.id, 'backend manifest');
  assertFile(entryPath, app.id, 'backend remote entry');

  const buildIdentity = readBuildIdentity(app, target);
  assertTopologyStableIdentityMatchesBuild(app, buildIdentity);
  const manifest = readJson(manifestPath);
  validateManifest(app, manifest, buildIdentity);
  const releaseBinding = await readBoundReleaseEnvelope(app, target);
  assertEqual(
    releaseBinding.envelope.identity?.unitId,
    buildIdentity.unitId,
    `${app.id} release-envelope/build unitId`,
  );
  assertEqual(
    releaseBinding.envelope.identity?.buildMarker,
    buildIdentity.buildVersion,
    `${app.id} release-envelope/build marker`,
  );
  assertEqual(
    releaseBinding.envelope.identity?.sourceRevision,
    buildIdentity.sourceRevision,
    `${app.id} release-envelope/build source revision`,
  );
  assertEqual(
    releaseBinding.envelope.identity?.releaseVersion,
    buildIdentity.version,
    `${app.id} release-envelope/build version`,
  );
  const fetchedArtifacts = {
    manifest: await fetchBoundArtifact(
      app,
      app.manifestUrl,
      releaseBinding.manifestArtifact,
      'backend manifest',
    ),
    container: await fetchBoundArtifact(
      app,
      app.containerEntry,
      releaseBinding.containerArtifact,
      'backend container',
    ),
  };
  const liveArtifacts = {
    manifest: fetchedArtifacts.manifest.evidence,
    container: fetchedArtifacts.container.evidence,
  };

  const loaded = await loadBackendFromVerifiedArtifacts({
    app,
    buildIdentity,
    container: fetchedArtifacts.container,
    loadImpl: loadBackendFederatedEffectApiFromManifest,
    manifest: fetchedArtifacts.manifest,
  });
  const backendContract = loaded.backendFederationContract;

  assertEqual(
    backendContract?.strictEffectApproach,
    true,
    `${app.id} backend expose strict Effect flag`,
  );
  assertEqual(
    backendContract?.runtimeFramework,
    'effect',
    `${app.id} backend expose runtime framework`,
  );
  assertEqual(backendContract?.role, 'microvertical-server', `${app.id} backend expose role`);
  assertEqual(backendContract?.name, app.backendName, `${app.id} backend expose name`);
  assertEqual(
    backendContract?.compatibility?.contractVersion,
    contractVersion,
    `${app.id} backend expose contract version`,
  );
  assertEqual(
    backendContract?.compatibility?.nodeAdapterVersion,
    nodeAdapterVersion,
    `${app.id} backend expose Node adapter version`,
  );
  assertEqual(
    backendContract?.compatibility?.packageName,
    buildIdentity.packageName,
    `${app.id} backend expose package name`,
  );
  assertEqual(
    backendContract?.compatibility?.build,
    buildIdentity.buildVersion,
    `${app.id} backend expose build version`,
  );
  assertEqual(
    manifest.buildVersion,
    backendContract?.compatibility?.build,
    `${app.id} backend manifest/expose build coupling`,
  );
  if (backendContract?.compatibility?.unitId !== undefined) {
    assertEqual(
      backendContract.compatibility.unitId,
      manifest.backendFederation?.deliveryUnit?.unitId,
      `${app.id} backend expose delivery-unit id`,
    );
  }

  if (loaded.api === undefined || loaded.runtime === undefined) {
    throw new Error(`${app.id} backend expose missing api/runtime exports`);
  }

  const smokeChecks = await runSmokeChecks(app, loaded, createEffectBffTestHandler);
  const liveApi = loaded.contract?.protocol === 'rpc'
    ? await proveLiveRpcApi(app, loaded, manifest, releaseBinding)
    : await proveLiveApi(app, manifest, releaseBinding);

  return {
    appId: app.id,
    expose: backendExpose,
    manifestPath: normalizeRelativePath(path.relative(workspaceRoot, manifestPath)),
    containerPath: normalizeRelativePath(path.relative(workspaceRoot, entryPath)),
    manifestUrl: app.manifestUrl,
    containerEntry: app.containerEntry,
    runtimeEntry: app.containerEntry,
    releaseEnvelope: {
      path: normalizeRelativePath(
        path.relative(workspaceRoot, releaseBinding.envelopePath),
      ),
      envelopeDigest: releaseBinding.envelope.envelopeDigest,
      target: releaseBinding.envelope.target,
    },
    liveArtifacts,
    liveApi,
    remoteName: app.backendName,
    remoteType: app.remoteType,
    versionBoundary: {
      packageName: buildIdentity.packageName,
      version: buildIdentity.version,
      buildVersion: buildIdentity.buildVersion,
      unitId: buildIdentity.unitId,
      sourceRevision: buildIdentity.sourceRevision,
    },
    smokeChecks,
    status: 'pass',
  };
}

function parseArgs(argv) {
  const parsed = { app: undefined, out: defaultOut, target: '.output' };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      parsed.out = argv[index + 1];
      index += 1;
    } else if (arg === '--app') {
      parsed.app = argv[index + 1];
      index += 1;
    } else if (arg === '--target') {
      parsed.target = argv[index + 1];
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!parsed.out) {
    throw new Error('--out requires a path');
  }
  if (!parsed.target) {
    throw new Error('--target requires a directory name');
  }

  return parsed;
}

function printHelp() {
  process.stdout
    .write(`Usage: node scripts/proof-node-backend-federation.mjs [--app id] [--target .output] [--out proof.json]
`);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  const topology = readJson(topologyPath);
  const localOverlay = readJson(localOverlayPath);
  const runtimeApps = topologyApps(topology, localOverlay);
  const apps = args.app ? topologyApps(topology, localOverlay, args.app) : runtimeApps;
  const results = [];
  const backendRuntime =
    apps.length > 0 ? await importBackendFederationRuntime() : undefined;
  const runtimes = [];
  try {
    if (resolveNodeProofServerMode() === 'owned') {
      for (const app of runtimeApps) {
        runtimes.push(
          await startNodeRuntime(app, args.target, {
            deferReadiness: true,
          }),
        );
      }
      await Promise.all(
        runtimes.map((runtime) =>
          waitForNodeRuntime(runtime, runtime.startupTimeoutMs),
        ),
      );
    }
    for (const app of apps) {
      results.push(await proveBackend(app, backendRuntime, args.target));
    }
  } finally {
    await Promise.allSettled(
      runtimes.reverse().map((runtime) => stopNodeRuntime(runtime)),
    );
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: results.length > 0 ? 'pass' : 'skipped',
    target: args.target,
    results,
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`[node-backend-federation-proof] ${report.status}: ${args.out}\n`);

  return 0;
}

const isMain =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      process.stderr.write(`[node-backend-federation-proof] ${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
