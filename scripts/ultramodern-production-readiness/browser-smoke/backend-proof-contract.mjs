const sha256Pattern = /^[a-f\d]{64}$/u;
const nodeReleaseEnvelopeSuffix =
  '/release/microvertical-release-envelope.json';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isHttpUrl(value) {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function sameUrl(left, right) {
  return (
    isHttpUrl(left) &&
    isHttpUrl(right) &&
    new URL(left).href === new URL(right).href
  );
}

function haveSameOrigin(...values) {
  if (values.length === 0 || values.some(value => !isHttpUrl(value))) {
    return false;
  }
  const [expectedOrigin, ...origins] = values.map(
    value => new URL(value).origin,
  );
  return origins.every(origin => origin === expectedOrigin);
}

function loopbackTransportUrl(value) {
  if (!isHttpUrl(value)) {
    return undefined;
  }
  const url = new URL(value);
  return url.protocol === 'http:' &&
    url.hostname === '127.0.0.1' &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
    ? url
    : undefined;
}

function isPassingStatusCode(value) {
  return Number.isSafeInteger(value) && value >= 200 && value < 300;
}

function isNormalizedReleaseEnvelopePath(value) {
  if (
    typeof value !== 'string' ||
    value.includes('\\') ||
    value.startsWith('/')
  ) {
    return false;
  }
  const segments = value.split('/');
  return (
    segments.every(
      segment => segment.length > 0 && !['.', '..'].includes(segment),
    ) && value.endsWith(nodeReleaseEnvelopeSuffix)
  );
}

function isNormalizedNodeApiBackendArtifactPath(value) {
  if (
    typeof value !== 'string' ||
    value.includes('\\') ||
    value.startsWith('/')
  ) {
    return false;
  }
  const segments = value.split('/');
  return (
    ['api', 'shared'].includes(segments[0]) &&
    segments.length > 1 &&
    segments.every(
      segment => segment.length > 0 && !['.', '..'].includes(segment),
    ) &&
    /\.(?:c|m)?js$/u.test(segments.at(-1))
  );
}

function validateLiveArtifact(failures, artifact, expected) {
  if (!isRecord(artifact)) {
    failures.push(`${expected.label} live artifact is missing`);
    return;
  }
  if (
    artifact.status !== 'pass' ||
    !sameUrl(artifact.url, expected.url) ||
    loopbackTransportUrl(artifact.transportUrl)?.pathname !==
      `/${expected.logicalPath}` ||
    artifact.logicalPath !== expected.logicalPath ||
    !isPassingStatusCode(artifact.statusCode) ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength <= 0 ||
    !sha256Pattern.test(artifact.sha256)
  ) {
    failures.push(
      `${expected.label} live artifact is not byte- and URL-correlated`,
    );
  }
}

function isValidRpcOperations(liveApi) {
  const operations = liveApi?.operations;
  if (
    liveApi?.method !== 'RPC' ||
    liveApi.protocol !== 'rpc' ||
    liveApi.serialization !== 'json' ||
    typeof liveApi.group !== 'string' ||
    liveApi.group.length === 0 ||
    !Array.isArray(operations) ||
    operations.length !== 3
  ) {
    return false;
  }
  const [listed, fetched, missing] = operations;
  const expectedErrorTag = `${liveApi.group
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')}NotFoundRpc`;
  return (
    listed?.method === 'list' &&
    listed.status === 'pass' &&
    typeof listed.itemId === 'string' &&
    listed.itemId.length > 0 &&
    fetched?.method === 'get' &&
    fetched.status === 'pass' &&
    fetched.itemId === listed.itemId &&
    missing?.method === 'get' &&
    missing.status === 'pass' &&
    missing.errorTag === expectedErrorTag &&
    typeof missing.missingId === 'string' &&
    missing.missingId.length > 0 &&
    missing.missingId !== listed.itemId
  );
}

function validateNodeBackendFederationProofResult(result) {
  const failures = [];
  const appId =
    typeof result?.appId === 'string' && result.appId.length > 0
      ? result.appId
      : '<unknown>';

  if (!isRecord(result) || result.status !== 'pass') {
    failures.push(`${appId} proof result did not pass`);
    return { appId, failures, ok: false };
  }
  if (
    !isHttpUrl(result.manifestUrl) ||
    !isHttpUrl(result.containerEntry) ||
    !sameUrl(result.runtimeEntry, result.containerEntry) ||
    !haveSameOrigin(
      result.manifestUrl,
      result.containerEntry,
      result.runtimeEntry,
    )
  ) {
    failures.push(
      `${appId} federation runtime was not loaded from its HTTP container`,
    );
  }

  const envelope = result.releaseEnvelope;
  if (
    !isRecord(envelope) ||
    envelope.target !== 'node' ||
    !isNormalizedReleaseEnvelopePath(envelope.path) ||
    !sha256Pattern.test(envelope.envelopeDigest)
  ) {
    failures.push(`${appId} release envelope evidence is missing or invalid`);
  }

  validateLiveArtifact(failures, result.liveArtifacts?.manifest, {
    label: `${appId} backend manifest`,
    logicalPath: 'backend-mf-manifest.json',
    url: result.manifestUrl,
  });
  validateLiveArtifact(failures, result.liveArtifacts?.container, {
    label: `${appId} backend container`,
    logicalPath: 'backendRemoteEntry.cjs',
    url: result.containerEntry,
  });

  const boundary = result.versionBoundary;
  const liveApi = result.liveApi;
  const liveApiUrl = loopbackTransportUrl(liveApi?.url);
  if (
    !isRecord(boundary) ||
    !isRecord(liveApi) ||
    liveApi.status !== 'pass' ||
    typeof liveApi.route !== 'string' ||
    !liveApi.route.startsWith('/') ||
    liveApiUrl?.pathname !== liveApi.route ||
    !haveSameOrigin(
      result.liveArtifacts?.manifest?.transportUrl,
      result.liveArtifacts?.container?.transportUrl,
      liveApi.url,
    ) ||
    // This producer-result validator can only require and correlate the digest
    // reference. runtime-evidence.verifyEnvelope independently recomputes the
    // Current canonical envelope digest and every artifact digest from executed
    // bytes, and matches its renderer identity/profile to immutable build
    // artifact evidence before this digest-only proof summary is accepted.
    liveApi.envelopeDigest !== envelope?.envelopeDigest ||
    (liveApi.protocol === 'rpc'
      ? !isValidRpcOperations(liveApi)
      : liveApi.method !== 'GET' ||
        !isPassingStatusCode(liveApi.statusCode) ||
        liveApi.marker?.unitId !== boundary.unitId ||
        liveApi.marker?.buildMarker !== boundary.buildVersion ||
        liveApi.marker?.sourceRevision !== boundary.sourceRevision ||
        liveApi.marker?.releaseVersion !== boundary.version)
  ) {
    failures.push(
      `${appId} live API is not correlated to its release envelope and identity`,
    );
  }
  if (
    !Array.isArray(liveApi?.apiBackendArtifacts) ||
    liveApi.apiBackendArtifacts.length === 0 ||
    liveApi.apiBackendArtifacts.some(
      artifact =>
        !isRecord(artifact) ||
        !isNormalizedNodeApiBackendArtifactPath(artifact.logicalPath) ||
        !Number.isSafeInteger(artifact.byteLength) ||
        artifact.byteLength <= 0 ||
        !sha256Pattern.test(artifact.sha256),
    )
  ) {
    failures.push(
      `${appId} live API has no envelope-bound backend artifact evidence`,
    );
  }

  if (
    !Array.isArray(result.smokeChecks) ||
    result.smokeChecks.length === 0 ||
    result.smokeChecks.some(
      check =>
        check?.status !== 'pass' ||
        !isPassingStatusCode(check.statusCode) ||
        !Array.isArray(check.assertions) ||
        check.assertions.some(assertion => assertion?.status !== 'pass'),
    )
  ) {
    failures.push(`${appId} backend runtime smoke checks are empty or failed`);
  }
  if (
    liveApi?.protocol === 'rpc' &&
    (!Array.isArray(result.smokeChecks) ||
      !result.smokeChecks.some(
        check => check.method === 'POST' && check.route === liveApi.route,
      ))
  ) {
    failures.push(`${appId} native RPC route has no passing POST smoke check`);
  }

  return { appId, failures, ok: failures.length === 0 };
}

export { validateNodeBackendFederationProofResult };
