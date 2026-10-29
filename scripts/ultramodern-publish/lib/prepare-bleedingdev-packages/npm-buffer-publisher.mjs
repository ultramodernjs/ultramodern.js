// Consumer: publish-bleedingdev.yml OIDC publication of accepted tarball bytes.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { sleep } from './commands.mjs';
import { npmRegistryOrigin, repoRoot } from './constants.mjs';
import validationKit from '../../../lib/validation-kit.js';
import { verifyPackageArtifactBytes } from './release-artifacts.mjs';

const { assertNonEmptyString } = validationKit;
const npmRegistryUrl = `${npmRegistryOrigin}/`;
const githubActionsOidcHostSuffix = '.actions.githubusercontent.com';
let cachedNpmPublishingRuntime;

function assertPublishRegistryUrl(value) {
  let registry;
  try {
    registry = new URL(value);
  } catch (error) {
    throw new Error('Publish registry URL is invalid', { cause: error });
  }
  if (
    !['http:', 'https:'].includes(registry.protocol) ||
    registry.username !== '' ||
    registry.password !== '' ||
    registry.search !== '' ||
    registry.hash !== '' ||
    !registry.pathname.endsWith('/')
  ) {
    throw new Error(`Publish registry URL is unsafe: ${registry.href}`);
  }
  return registry;
}

function assertNpmRegistryUrl(value) {
  const registry = assertPublishRegistryUrl(value);
  if (registry.href !== npmRegistryUrl) {
    throw new Error(`Trusted publishing requires registry ${npmRegistryUrl}`);
  }
  return registry;
}

function escapedPackageName(packageName) {
  if (!/^@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*$/u.test(packageName)) {
    throw new Error(`Trusted publishing requires a valid scoped package name: ${packageName}`);
  }
  return packageName.replace('/', '%2f');
}

function assertAcceptedPublishToolchain(acceptedTools, runtime) {
  if (
    !acceptedTools ||
    typeof acceptedTools !== 'object' ||
    Array.isArray(acceptedTools) ||
    JSON.stringify(Object.keys(acceptedTools).sort()) !==
      JSON.stringify(['node', 'npm', 'pnpm'])
  ) {
    throw new Error('Trusted publishing requires the accepted release toolchain');
  }
  if (acceptedTools.node !== process.version) {
    throw new Error(
      `Trusted publishing Node.js drift: accepted ${String(acceptedTools.node)}, active ${process.version}`,
    );
  }
  if (acceptedTools.npm !== runtime.npmVersion) {
    throw new Error(
      `Trusted publishing npm drift: accepted ${String(acceptedTools.npm)}, active ${runtime.npmVersion}`,
    );
  }
}

function acceptedPackageManifest(item, acceptedBytes) {
  if (!Buffer.isBuffer(acceptedBytes)) {
    throw new Error(`${item.targetName} accepted publish input must be a Buffer`);
  }
  const manifest = verifyPackageArtifactBytes(item, acceptedBytes).packageJson;
  if (Object.hasOwn(manifest, 'tag')) {
    throw new Error(
      `${item.targetName} accepted package manifest must not declare top-level tag`,
    );
  }
  for (const key of ['registry', 'tag']) {
    if (Object.hasOwn(manifest.publishConfig ?? {}, key)) {
      throw new Error(
        `${item.targetName} accepted package publishConfig must not declare ${key}`,
      );
    }
  }
  return manifest;
}

function loadNpmPublishingRuntime(runner = execFileSync) {
  if (runner === execFileSync && cachedNpmPublishingRuntime) {
    return cachedNpmPublishingRuntime;
  }
  let globalRoot;
  try {
    globalRoot = String(
      runner('npm', ['root', '--global'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).trim();
  } catch (error) {
    throw new Error('Cannot resolve the active npm installation for publishing', {
      cause: error,
    });
  }
  assertNonEmptyString(globalRoot, 'Active npm global module root');
  const npmPackageJsonPath = path.join(globalRoot, 'npm', 'package.json');
  try {
    const requireFromNpm = createRequire(npmPackageJsonPath);
    const npmPackageJson = requireFromNpm(npmPackageJsonPath);
    const libnpmpublish = requireFromNpm('libnpmpublish');
    const libnpmpublishPackageJson = requireFromNpm(
      'libnpmpublish/package.json',
    );
    if (typeof libnpmpublish?.publish !== 'function') {
      throw new Error('libnpmpublish.publish is unavailable');
    }
    assertNonEmptyString(npmPackageJson?.version, 'Active npm version');
    assertNonEmptyString(
      libnpmpublishPackageJson?.version,
      'npm-bundled libnpmpublish version',
    );
    const runtime = Object.freeze({
      libnpmpublishVersion: libnpmpublishPackageJson.version,
      npmVersion: npmPackageJson.version,
      publish: libnpmpublish.publish,
    });
    if (runner === execFileSync) {
      cachedNpmPublishingRuntime = runtime;
    }
    return runtime;
  } catch (error) {
    throw new Error(
      `The active npm installation at ${npmPackageJsonPath} does not provide a usable buffer publisher`,
      { cause: error },
    );
  }
}

async function readJsonResponse(response, label) {
  if (!response?.ok) {
    throw new Error(`${label} returned HTTP ${String(response?.status ?? '<unknown>')}`);
  }
  if (typeof response.json !== 'function') {
    throw new Error(`${label} returned a malformed response`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${label} did not return valid JSON`, { cause: error });
  }
}

function githubOidcUrl(value, registry) {
  assertNonEmptyString(value, 'ACTIONS_ID_TOKEN_REQUEST_URL');
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error('ACTIONS_ID_TOKEN_REQUEST_URL is invalid', { cause: error });
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith(githubActionsOidcHostSuffix) ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      'ACTIONS_ID_TOKEN_REQUEST_URL must be an authenticated GitHub Actions HTTPS endpoint',
    );
  }
  url.searchParams.set('audience', `npm:${registry.hostname}`);
  return url;
}

async function requestTrustedPublishingToken(
  packageName,
  {
    env = process.env,
    fetchImpl = globalThis.fetch,
    registryUrl = npmRegistryUrl,
  } = {},
) {
  if (env.GITHUB_ACTIONS !== 'true') {
    throw new Error('npm trusted publishing token exchange requires GitHub Actions');
  }
  assertNonEmptyString(
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  );
  if (typeof fetchImpl !== 'function') {
    throw new Error('npm trusted publishing token exchange requires fetch');
  }
  const registry = assertNpmRegistryUrl(registryUrl);
  const oidcUrl = githubOidcUrl(env.ACTIONS_ID_TOKEN_REQUEST_URL, registry);
  let oidcResponse;
  try {
    oidcResponse = await fetchImpl(oidcUrl, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
      },
      method: 'GET',
      redirect: 'error',
    });
  } catch (error) {
    throw new Error('GitHub Actions OIDC request failed', { cause: error });
  }
  const oidc = await readJsonResponse(
    oidcResponse,
    'GitHub Actions OIDC request',
  );
  assertNonEmptyString(oidc?.value, 'GitHub Actions OIDC token');

  const exchangeUrl = new URL(
    `/-/npm/v1/oidc/token/exchange/package/${escapedPackageName(packageName)}`,
    registry,
  );
  let exchangeResponse;
  try {
    exchangeResponse = await fetchImpl(exchangeUrl, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${oidc.value}`,
      },
      method: 'POST',
      redirect: 'error',
    });
  } catch (error) {
    throw new Error(`npm trusted publishing exchange failed for ${packageName}`, {
      cause: error,
    });
  }
  const exchange = await readJsonResponse(
    exchangeResponse,
    `npm trusted publishing exchange for ${packageName}`,
  );
  assertNonEmptyString(exchange?.token, 'npm trusted publishing token');
  return exchange.token;
}

const maxPreflightConcurrency = 8;
const preflightTokenRetryAttempts = 2;
const preflightTokenRetryDelayMs = 1000;
const preflightTokenStatusPattern = /returned HTTP (\d{3})$/u;

function resolvePreflightConcurrency(options, env) {
  const requested = Number(
    options?.publishConcurrency ?? env?.PUBLISH_CONCURRENCY,
  );
  if (!Number.isInteger(requested) || requested < 1) {
    return 1;
  }
  return Math.min(requested, maxPreflightConcurrency);
}

// A throttled or unavailable registry says nothing about whether trusted
// publishing is configured, so it is retried and then reported as throttling.
function isThrottledPreflightTokenError(error) {
  const match = preflightTokenStatusPattern.exec(
    error instanceof Error ? error.message : '',
  );
  if (!match) {
    return false;
  }
  const status = Number(match[1]);
  return status === 429 || status >= 500;
}

async function preflightTrustedPublishingPackages(
  items,
  options,
  {
    env = process.env,
    fetchImpl = globalThis.fetch,
    requestToken = requestTrustedPublishingToken,
    wait = sleep,
  } = {},
) {
  const registry = assertNpmRegistryUrl(options.registryUrl ?? npmRegistryUrl);
  const entries = [...items];
  const outcomes = new Array(entries.length);
  const attemptToken = async item => {
    let lastError;
    for (let attempt = 1; attempt <= preflightTokenRetryAttempts; attempt += 1) {
      try {
        await requestToken(item.targetName, {
          env,
          fetchImpl,
          registryUrl: registry.href,
        });
        return undefined;
      } catch (error) {
        lastError = error;
        if (!isThrottledPreflightTokenError(error)) {
          return { error };
        }
        if (attempt < preflightTokenRetryAttempts) {
          await wait(preflightTokenRetryDelayMs * attempt);
        }
      }
    }
    return { error: lastError, throttled: true };
  };
  const workers = Math.min(
    resolvePreflightConcurrency(options, env),
    entries.length,
  );
  let cursor = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (cursor < entries.length) {
        const index = cursor;
        cursor += 1;
        outcomes[index] = await attemptToken(entries[index]);
      }
    }),
  );

  const failures = [];
  for (const [index, item] of entries.entries()) {
    const outcome = outcomes[index];
    if (!outcome) {
      continue;
    }
    const detail =
      outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error);
    failures.push(
      `${item.targetName}: ${
        outcome.throttled
          ? `token exchange stayed throttled after ${preflightTokenRetryAttempts} attempts; ${detail}`
          : detail
      }`,
    );
  }
  if (failures.length > 0) {
    throw new Error(
      [
        `npm trusted publishing preflight failed for ${failures.length} of ${entries.length} package(s):`,
        ...failures,
      ].join('\n'),
    );
  }
}

async function publishAcceptedPackage(
  item,
  acceptedBytes,
  options,
  {
    env = process.env,
    fetchImpl = globalThis.fetch,
    loadRuntime = loadNpmPublishingRuntime,
    requestToken = requestTrustedPublishingToken,
  } = {},
) {
  const registry = assertNpmRegistryUrl(options.registryUrl ?? npmRegistryUrl);
  const runtime = loadRuntime();
  assertAcceptedPublishToolchain(options.acceptedTools, runtime);
  assertNonEmptyString(options.tag, 'Publish dist-tag');
  acceptedPackageManifest(item, acceptedBytes);
  const token = await requestToken(item.targetName, {
    env,
    fetchImpl,
    registryUrl: registry.href,
  });
  return publishPackageBuffer(
    item,
    acceptedBytes,
    {
      acceptedTools: options.acceptedTools,
      authToken: token,
      provenance: true,
      registryUrl: registry.href,
      tag: options.tag,
    },
    { runtime },
  );
}

// libnpmpublish hands its options to sigstore.attest, whose Rekor and Fulcio
// requests otherwise time out after 5s. A Rekor that logs the entry but answers
// later makes the client retry its own entry into a fatal 409. Give signing the
// registry's own 5 minute default instead.
const npmPublishTimeoutMs = 5 * 60 * 1000;

async function publishPackageBuffer(
  item,
  acceptedBytes,
  { acceptedTools, authToken, provenance, registryUrl, tag },
  { runtime = loadNpmPublishingRuntime() } = {},
) {
  const registry = assertPublishRegistryUrl(registryUrl);
  assertAcceptedPublishToolchain(acceptedTools, runtime);
  assertNonEmptyString(authToken, 'Publish registry authentication token');
  assertNonEmptyString(tag, 'Publish dist-tag');
  if (typeof provenance !== 'boolean') {
    throw new Error('Publish provenance mode must be explicit');
  }
  const manifest = acceptedPackageManifest(item, acceptedBytes);
  const authKey = `//${registry.host}${registry.pathname}:_authToken`;
  await runtime.publish(manifest, acceptedBytes, {
    access: 'public',
    defaultTag: tag,
    npmVersion: runtime.npmVersion,
    provenance,
    registry: registry.href,
    timeout: npmPublishTimeoutMs,
    [authKey]: authToken,
  });
  return {
    libnpmpublishVersion: runtime.libnpmpublishVersion,
    npmVersion: runtime.npmVersion,
  };
}

function validateAcceptedPackageDryRun(
  item,
  acceptedBytes,
  options,
  { loadRuntime = loadNpmPublishingRuntime } = {},
) {
  const registry = assertNpmRegistryUrl(options.registryUrl ?? npmRegistryUrl);
  const runtime = loadRuntime();
  assertAcceptedPublishToolchain(options.acceptedTools, runtime);
  assertNonEmptyString(options.tag, 'Publish dist-tag');
  const manifest = acceptedPackageManifest(item, acceptedBytes);
  return {
    bytes: acceptedBytes.length,
    libnpmpublishVersion: runtime.libnpmpublishVersion,
    manifest: { name: manifest.name, version: manifest.version },
    npmVersion: runtime.npmVersion,
    registry: registry.href,
    tag: options.tag,
  };
}

export {
  assertAcceptedPublishToolchain,
  loadNpmPublishingRuntime,
  preflightTrustedPublishingPackages,
  publishAcceptedPackage,
  publishPackageBuffer,
  requestTrustedPublishingToken,
  validateAcceptedPackageDryRun,
};
