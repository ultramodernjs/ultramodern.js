// Read-only registry transport and artifact checks. No publication credentials or writes.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import {
  npmRegistryOrigin,
  repoRoot,
  transientNpmPublishErrorPatterns,
} from './constants.mjs';
import { sleep } from './commands.mjs';
import validationKit from '../../../lib/validation-kit.js';
const { assertNonEmptyString, isPlainObject } = validationKit;
const execFileAsync = promisify(execFile);

// Walks the cause chain: undici reports a reset as `TypeError: fetch failed`
// and keeps the ECONNRESET/ETIMEDOUT code on `cause`.
function isTransientNpmPublishError(error) {
  const output = [];
  for (let current = error; current; current = current.cause) {
    output.push(
      current instanceof Error ? current.message : '',
      typeof current.code === 'string' ? current.code : '',
      typeof current.stdout === 'string' ? current.stdout : '',
      typeof current.stderr === 'string' ? current.stderr : '',
    );
  }
  const text = output.join('\n');
  return transientNpmPublishErrorPatterns.some(pattern => pattern.test(text));
}

async function mapWithConcurrency(items, limit, mapper) {
  const entries = [...items];
  const results = new Array(entries.length);
  const workers = Math.min(Math.max(1, limit), entries.length);
  const failures = new Array(entries.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await mapper(entries[index], index);
      } catch (error) {
        failures[index] = { error };
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  const failure = failures.find(Boolean);
  if (failure) throw failure.error;
  return results;
}

async function readRegistryField(
  specifier,
  field,
  {
    registryUrl,
    run = execFileAsync,
    cwd = repoRoot,
    env,
    optional = false,
  } = {},
) {
  try {
    const { stdout } = await run(
      'npm',
      [
        'view',
        specifier,
        field,
        '--json',
        ...(registryUrl ? ['--registry', registryUrl] : []),
      ],
      { cwd, env, encoding: 'utf-8' },
    );
    const value = JSON.parse(stdout);
    if (!isPlainObject(value)) {
      throw new Error(
        `${specifier} returned invalid registry ${field} metadata`,
      );
    }
    return value;
  } catch (error) {
    if (optional && isRegistryNotFoundError(error)) return null;
    throw new Error(
      `Registry ${field} state is uncertain for ${specifier}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function resolveRegistryPackageDist(packageName, version, options) {
  return readRegistryField(`${packageName}@${version}`, 'dist', options);
}

function isRegistryNotFoundError(error) {
  const output = [
    error instanceof Error ? error.message : '',
    typeof error?.stdout === 'string' ? error.stdout : '',
    typeof error?.stderr === 'string' ? error.stderr : '',
  ].join('\n');
  return (
    /\bE404\b/u.test(output) ||
    /404 Not Found/u.test(output) ||
    /is not in this registry/u.test(output)
  );
}

// Every registry read must see the origin, not a CDN or npm-cache copy: the
// post-publish poll is waiting for a version that a cached packument (or a
// cached 404 on the attestations endpoint) would never show.
const registryOriginRequestInit = Object.freeze({
  cache: 'no-store',
  headers: Object.freeze({
    accept: 'application/json',
    'cache-control': 'no-cache',
  }),
  method: 'GET',
  redirect: 'error',
});

function pinnedRegistryPackageMetadataUrl(packageName) {
  assertNonEmptyString(packageName, 'Registry package name');
  return `${npmRegistryOrigin}/${encodeURIComponent(packageName)}`;
}

async function fetchRegistryPackageMetadata(
  packageName,
  fetchImpl = globalThis.fetch,
) {
  const metadataUrl = pinnedRegistryPackageMetadataUrl(packageName);
  if (typeof fetchImpl !== 'function') {
    throw new Error(`${packageName} registry metadata fetch is unavailable`);
  }
  let response;
  try {
    response = await fetchImpl(metadataUrl, registryOriginRequestInit);
  } catch (error) {
    throw new Error(
      `${packageName} registry metadata request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  if (!response?.ok) {
    throw new Error(
      `${packageName} registry metadata returned HTTP ${String(
        response?.status ?? '<unknown>',
      )}`,
    );
  }
  if (typeof response.json !== 'function') {
    throw new Error(`${packageName} registry metadata response is malformed`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${packageName} registry metadata is not valid JSON`, {
      cause: error,
    });
  }
}

const registryPackumentAttempts = 4;
const registryPackumentRetryDelayMs = 1000;
const throttledRegistryMetadataMarker = 'registry metadata stayed throttled';
const registryMetadataStatusPattern =
  /registry metadata returned HTTP (\d{3})$/u;

function registryMetadataStatus(error) {
  const match = registryMetadataStatusPattern.exec(
    error instanceof Error ? error.message : '',
  );
  return match ? Number(match[1]) : undefined;
}

function isRegistryMetadataNotFoundError(error) {
  return registryMetadataStatus(error) === 404;
}

function isTransientRegistryMetadataError(error) {
  const status = registryMetadataStatus(error);
  if (status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }
  return isTransientNpmPublishError(error);
}

function isThrottledRegistryMetadataError(error) {
  return (
    error instanceof Error &&
    error.message.includes(throttledRegistryMetadataMarker)
  );
}

async function fetchRegistryPackumentWithRetry(packageName, overrides) {
  const wait = overrides.wait ?? sleep;
  const retryDelayMs = overrides.retryDelayMs ?? registryPackumentRetryDelayMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetchRegistryPackageMetadata(
        packageName,
        overrides.fetchImpl,
      );
    } catch (error) {
      if (attempt >= registryPackumentAttempts) {
        if (registryMetadataStatus(error) === 429) {
          throw new Error(
            `${packageName} ${throttledRegistryMetadataMarker} after ${registryPackumentAttempts} attempts`,
            { cause: error },
          );
        }
        throw error;
      }
      if (!isTransientRegistryMetadataError(error)) {
        throw error;
      }
      await wait(retryDelayMs * attempt);
    }
  }
}

// Memoized for the process so one packument answers both preflight phases. The
// post-publish propagation poll must keep using lookupRegistryPackageDist:
// a memoized packument would never observe the version it is waiting for.
const registryPackumentCache = new Map();

async function lookupRegistryPackument(packageName, overrides = {}) {
  if (overrides.fetchImpl) {
    return fetchRegistryPackumentWithRetry(packageName, overrides);
  }
  let pending = registryPackumentCache.get(packageName);
  if (!pending) {
    pending = fetchRegistryPackumentWithRetry(packageName, overrides).catch(
      error => {
        registryPackumentCache.delete(packageName);
        throw error;
      },
    );
    registryPackumentCache.set(packageName, pending);
  }
  return pending;
}

function registryPackumentDistTag(packument, packageName, tag) {
  const distTags = packument?.['dist-tags'];
  if (!isPlainObject(distTags)) {
    throw new Error(`${packageName} returned invalid registry dist-tags`);
  }
  return typeof distTags[tag] === 'string' ? distTags[tag] : undefined;
}

// `null` is reserved for a genuinely absent version; a malformed versions map
// or a version entry without usable dist metadata must throw so it can never
// be mistaken for "not published yet".
function registryPackumentDist(packument, packageName, version) {
  const versions = packument?.versions;
  if (!isPlainObject(versions)) {
    throw new Error(
      `${packageName} returned invalid registry versions metadata`,
    );
  }
  if (!Object.hasOwn(versions, version)) {
    return null;
  }
  const dist = versions[version]?.dist;
  if (!isPlainObject(dist)) {
    throw new Error(
      `${packageName}@${version} registry version entry has no dist metadata`,
    );
  }
  return dist;
}

// Uncached origin reads, never memoized: `null` means the package is absent.
async function readFreshRegistryPackument(packageName, overrides = {}) {
  try {
    return await fetchRegistryPackumentWithRetry(packageName, overrides);
  } catch (error) {
    if (isRegistryMetadataNotFoundError(error)) return null;
    throw error;
  }
}

async function lookupRegistryDistTag(packageName, tag, overrides) {
  const packument = await readFreshRegistryPackument(packageName, overrides);
  return packument === null
    ? undefined
    : registryPackumentDistTag(packument, packageName, tag);
}

async function lookupRegistryPackageDist(packageName, version, overrides) {
  const packument = await readFreshRegistryPackument(packageName, overrides);
  return packument === null
    ? null
    : registryPackumentDist(packument, packageName, version);
}

function assertRegistryDistMatches(item, dist) {
  const mismatches = [];
  if (dist?.integrity !== item.integrity) {
    mismatches.push(
      `integrity expected ${item.integrity}, found ${String(dist?.integrity)}`,
    );
  }
  if (dist?.shasum !== item.shasum) {
    mismatches.push(
      `shasum expected ${item.shasum}, found ${String(dist?.shasum)}`,
    );
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Registry artifact identity mismatch for ${item.targetName}@${item.version}: ${mismatches.join(
        '; ',
      )}`,
    );
  }
}

function pinnedRegistryTarballUrl(item, value) {
  if (typeof value !== 'string' || value.trim() !== value || value === '') {
    throw new Error(
      `${item.targetName}@${item.version} is missing dist.tarball`,
    );
  }
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(
      `${item.targetName}@${item.version} registry tarball URL is invalid`,
      { cause: error },
    );
  }
  const packageBaseName = item.targetName.slice(
    item.targetName.lastIndexOf('/') + 1,
  );
  const expectedPath = `/${item.targetName}/-/${packageBaseName}-${item.version}.tgz`;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch (error) {
    throw new Error(
      `${item.targetName}@${item.version} registry tarball URL has invalid encoding`,
      { cause: error },
    );
  }
  if (
    url.origin !== npmRegistryOrigin ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    decodedPath !== expectedPath
  ) {
    throw new Error(
      `${item.targetName}@${item.version} registry tarball URL is not the pinned npm endpoint ${npmRegistryOrigin}${expectedPath}`,
    );
  }
  return url.href;
}

const registryTarballAttempts = 8;
const registryTarballRetryDelayMs = 15_000;
const registryTarballStatusPattern = /registry tarball \S+ returned HTTP (\d{3})$/u;

// npm can list a freshly published version before its tarball is served. A
// missing, throttled or failing tarball response is retried for about two
// minutes; a byte mismatch never is.
async function verifyRegistryTarball(
  item,
  dist,
  fetchImpl = globalThis.fetch,
  wait = sleep,
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await verifyRegistryTarballOnce(item, dist, fetchImpl);
    } catch (error) {
      const status = Number(
        registryTarballStatusPattern.exec(
          error instanceof Error ? error.message : '',
        )?.[1],
      );
      const transient =
        status === 404 || status === 429 || status >= 500 ||
        (error instanceof Error && / registry tarball request failed: /u.test(error.message));
      if (attempt >= registryTarballAttempts || !transient) throw error;
      await wait(registryTarballRetryDelayMs);
    }
  }
}

async function verifyRegistryTarballOnce(item, dist, fetchImpl) {
  const packageLabel = `${item.targetName}@${item.version}`;
  const tarballUrl = pinnedRegistryTarballUrl(item, dist?.tarball);
  if (typeof fetchImpl !== 'function') {
    throw new Error(`${packageLabel} registry tarball fetch is unavailable`);
  }
  let response;
  try {
    response = await fetchImpl(tarballUrl, {
      headers: { accept: 'application/octet-stream' },
      method: 'GET',
      redirect: 'error',
    });
  } catch (error) {
    throw new Error(
      `${packageLabel} registry tarball request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  if (!response?.ok) {
    throw new Error(
      `${packageLabel} registry tarball ${tarballUrl} returned HTTP ${String(
        response?.status ?? '<unknown>',
      )}`,
    );
  }
  if (typeof response.arrayBuffer !== 'function') {
    throw new Error(`${packageLabel} registry tarball response is malformed`);
  }
  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new Error(`${packageLabel} registry tarball body could not be read`, {
      cause: error,
    });
  }

  const actual = assertRegistryTarballBytes(item, bytes);
  return { ...actual, tarballUrl };
}

function assertRegistryTarballBytes(item, bytes) {
  const packageLabel = `${item.targetName}@${item.version}`;
  const actual = {
    integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
    size: bytes.length,
  };
  const mismatches = [];
  for (const field of ['size', 'sha256', 'shasum', 'integrity']) {
    if (actual[field] !== item[field]) {
      mismatches.push(
        `${field} expected ${String(item[field])}, found ${String(actual[field])}`,
      );
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Registry tarball byte mismatch for ${packageLabel}: ${mismatches.join(
        '; ',
      )}`,
    );
  }
  return actual;
}

export {
  assertRegistryDistMatches,
  fetchRegistryPackageMetadata,
  pinnedRegistryTarballUrl,
  registryOriginRequestInit,
  isRegistryNotFoundError,
  isRegistryMetadataNotFoundError,
  isThrottledRegistryMetadataError,
  isTransientNpmPublishError,
  lookupRegistryDistTag,
  lookupRegistryPackageDist,
  lookupRegistryPackument,
  mapWithConcurrency,
  registryPackumentDist,
  registryPackumentDistTag,
  verifyRegistryTarball,
  resolveRegistryPackageDist,
  assertRegistryTarballBytes,
};
