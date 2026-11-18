const crypto = require('node:crypto');
const fs = require('node:fs');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

// The resolved closure every fixture receipt binds. Keys are already in the
// canonical (sorted) order, so JSON.stringify is its canonical JSON.
const fixtureClosureIdentities = Object.freeze([
  Object.freeze({
    integrity: 'sha512-Zml4dHVyZQ==',
    name: 'fixture-dependency',
    version: '1.0.0',
  }),
]);
const fixtureClosureSha256 = digest(JSON.stringify(fixtureClosureIdentities));
const fixtureWorkspaceFiles = Object.freeze([
  Object.freeze({ path: 'package.json', sha256: digest('package.json') }),
]);
const fixtureWorkspaceSha256 = digest(JSON.stringify(fixtureWorkspaceFiles));

// Historical publish-outcome reconstruction needs the archived schema-v4
// receipt shape. Current fixtures never create or consume this digest.
function legacyCanonicalSerialize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(legacyCanonicalSerialize).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      key => `${JSON.stringify(key)}:${legacyCanonicalSerialize(value[key])}`,
    )
    .join(',')}}`;
}

const defaultOptions = {
  apps: {
    changed: 'inventory',
    shell: 'shell-super-app',
    sibling: 'finance',
  },
  identity: {
    baselineRevision: '1'.repeat(40),
    changedRevision: '2'.repeat(40),
    releaseVersion: '0.1.0',
    runtimeReleaseVersion: '0.1.0',
    runtimeSourceRevision: '1'.repeat(40),
  },
  mutations: {
    apiResponse: {
      path: 'verticals/inventory/api/index.ts',
      value: 'Inventory C1 operational proof response',
    },
    uiLocalization: {
      path: 'verticals/inventory/locales/en/inventory.json',
      value:
        'C1 operational independence: inventory UI and localization moved together.',
    },
  },
  ownerPath: 'verticals/inventory',
  verticalCount: 10,
};

function fixtureOptions(overrides) {
  return {
    ...defaultOptions,
    ...overrides,
    apps: { ...defaultOptions.apps, ...overrides.apps },
    identity: { ...defaultOptions.identity, ...overrides.identity },
    mutations: {
      apiResponse: {
        ...defaultOptions.mutations.apiResponse,
        ...overrides.mutations?.apiResponse,
      },
      uiLocalization: {
        ...defaultOptions.mutations.uiLocalization,
        ...overrides.mutations?.uiLocalization,
      },
    },
  };
}

function operationalDetails(receipt, evidencePath, options) {
  const { identity, mutations } = options;
  return {
    artifactMode: receipt.mode,
    baselineRevision: identity.baselineRevision,
    changedPaths: [mutations.apiResponse.path, mutations.uiLocalization.path],
    changedRevision: identity.changedRevision,
    durationMs: 1,
    evidencePath,
    mutations,
  };
}

async function operationalEvidence(details, options) {
  const { releaseIdentityCoherence, rendererReleaseCoherence } = await import(
    '../../published-create-proof/acceptance-contract.mjs'
  );
  const { identity, mutations } = options;
  const beforeIdentity = {
    buildMarker: `${options.apps.changed}-before`,
    releaseVersion: identity.releaseVersion,
    sourceRevision: identity.baselineRevision,
    unitId: `acceptance/${options.apps.changed}`,
  };
  const afterIdentity = {
    ...beforeIdentity,
    buildMarker: `${options.apps.changed}-after`,
    sourceRevision: identity.changedRevision,
  };
  const afterIdentities = {
    node: { ...afterIdentity, buildMarker: '3'.repeat(64) },
    cloudflare: { ...afterIdentity, buildMarker: '6'.repeat(64) },
  };
  const rendererProfile = {
    renderer: 'react',
    protocolVersion: 1,
    compiler: { name: '@rsbuild/plugin-react', version: '2.1.1' },
    hydration: { name: 'react-dom', version: '19.3.0' },
    router: {
      name: '@tanstack/react-router',
      version: '1.170.44',
      coreName: '@tanstack/router-core',
      coreVersion: '1.171.37',
    },
  };
  const provider = { framework: 'tanstack', ...rendererProfile.router };
  const ui = platform => ({
    rendererIdentity: {
      renderer: 'react',
      appId: options.apps.changed,
      entryName: 'main',
      protocolVersion: 1,
      buildId: afterIdentities[platform].buildMarker,
    },
    rendererProfile,
    routerBindings: {
      main: {
        owner: '@fixture/router-owner',
        evidence: 'file-routes',
        defaultProvider: provider,
        providers: [provider],
      },
    },
  });
  const target = platform => {
    const afterIdentity = afterIdentities[platform];
    const changed = {
      afterIdentity,
      afterUi: ui(platform),
      afterTreeDigest: digest(`${platform}-${options.apps.changed}-after`),
      beforeIdentity,
      beforeTreeDigest: digest(`${platform}-${options.apps.changed}-before`),
      surfaces: Object.fromEntries(
        ['uiClient', 'ssr', 'apiBackend', 'backendFederation'].map(surface => [
          surface,
          {
            afterDigest: digest(`${platform}-${surface}-after`),
            beforeDigest: digest(`${platform}-${surface}-before`),
            changed: true,
          },
        ]),
      ),
    };
    const runtimePlatform = platform === 'cloudflare' ? 'workerd' : 'node';
    const shell = {
      byteIdentical: true,
      envelopeIdentical: true,
      treeDigest: digest(`${platform}-${options.apps.shell}`),
    };
    const sibling = {
      byteIdentical: true,
      envelopeIdentical: true,
      treeDigest: digest(`${platform}-${options.apps.sibling}`),
    };
    return {
      comparison: {
        target: platform,
        changed: { ...changed, changed: true },
        shell,
        sibling,
      },
      servedBehavior: {
        appId: options.apps.changed,
        baseUrls: {
          app: `http://127.0.0.1/${runtimePlatform}/${options.apps.changed}`,
          shell: `http://127.0.0.1/${runtimePlatform}/${options.apps.shell}`,
        },
        identity: {
          build: afterIdentity.buildMarker,
          buildMarker: afterIdentity.buildMarker,
          sourceRevision: afterIdentity.sourceRevision,
          unitId: afterIdentity.unitId,
          version: afterIdentity.releaseVersion,
        },
        platform: runtimePlatform,
        result: 'pass',
        routes: {
          api: `/${options.apps.changed}-api/${options.apps.changed}`,
          ssr: '/en',
          ui: '/en',
        },
        responses: {
          api: {
            bodySha256: digest(`${platform}-api-body`),
            contentType: 'application/json',
            status: 200,
            value: mutations.apiResponse.value,
          },
          ssr: {
            bodySha256: digest(`${platform}-ssr-body`),
            buildMarker: afterIdentity.buildMarker,
            contentType: 'text/html',
            status: 200,
          },
          ui: {
            bodySha256: digest(`${platform}-ui-body`),
            boundaryId: 'verticalInventory',
            contentType: 'text/html',
            expose: './Widget',
            status: 200,
            value: mutations.uiLocalization.value,
            visiblyRendered: true,
          },
        },
      },
    };
  };
  const evidence = {
    schemaVersion: 1,
    kind: 'ultramodern-operational-independence-proof',
    commits: {
      baseline: details.baselineRevision,
      changed: details.changedRevision,
      changedPaths: details.changedPaths,
      ownerPath: options.ownerPath,
    },
    apps: {
      shell: { id: options.apps.shell },
      changed: { id: options.apps.changed },
      sibling: { id: options.apps.sibling },
    },
    targets: {
      node: target('node'),
      cloudflare: target('cloudflare'),
    },
    crossTarget: {
      equal: true,
      identity: releaseIdentityCoherence(afterIdentities.node),
      renderer: rendererReleaseCoherence(ui('node')),
      nodeIdentity: structuredClone(afterIdentities.node),
      cloudflareIdentity: structuredClone(afterIdentities.cloudflare),
    },
    result: 'pass',
  };
  return evidence;
}

function legacyOperationalDetails(
  compactDetails,
  evidence,
  evidenceSource,
  options,
) {
  const targets = Object.fromEntries(
    ['node', 'cloudflare'].map(target => {
      const { comparison, servedBehavior } = evidence.targets[target];
      return [
        target,
        {
          changed: {
            afterIdentity: comparison.changed.afterIdentity,
            afterTreeDigest: comparison.changed.afterTreeDigest,
            beforeIdentity: comparison.changed.beforeIdentity,
            beforeTreeDigest: comparison.changed.beforeTreeDigest,
            surfaces: comparison.changed.surfaces,
          },
          servedBehavior,
          shell: comparison.shell,
          sibling: comparison.sibling,
        },
      ];
    }),
  );
  return {
    ...compactDetails,
    crossTargetIdentity: evidence.crossTarget.identity,
    evidenceDigest: evidence.evidenceDigest,
    evidenceFileSha256: digest(evidenceSource),
    selectedApps: options.apps,
    targets,
  };
}

async function createOperationalAcceptanceReceiptFixture({
  evidencePath,
  legacyOperationalSummary = false,
  overrides = {},
  receipt,
  receiptApi,
}) {
  const options = fixtureOptions(overrides);
  const compactOperationalDetails = evidencePath
    ? operationalDetails(receipt, evidencePath, options)
    : undefined;
  const evidence = compactOperationalDetails
    ? await operationalEvidence(compactOperationalDetails, options)
    : undefined;
  if (evidence && legacyOperationalSummary) {
    evidence.evidenceDigest = digest(legacyCanonicalSerialize(evidence));
  }
  const evidenceSource = evidence
    ? `${JSON.stringify(evidence, null, 2)}\n`
    : undefined;
  const recordedOperationalDetails =
    compactOperationalDetails && evidence && evidenceSource
      ? legacyOperationalSummary
        ? legacyOperationalDetails(
            compactOperationalDetails,
            evidence,
            evidenceSource,
            options,
          )
        : compactOperationalDetails
      : undefined;
  const runtimeIdentity = Object.fromEntries(
    ['node', 'workerd'].map(platform => [
      platform,
      Array.from({ length: options.verticalCount }, (_, index) => ({
        appId: `vertical-${index + 1}`,
        buildMarker: `marker-${index + 1}`,
        moduleFederation: receipt.binding.artifacts.moduleFederation,
        releaseVersion: options.identity.runtimeReleaseVersion,
        sourceRevision: options.identity.runtimeSourceRevision,
      })),
    ]),
  );
  for (const id of receipt.profile.requiredResults) {
    const runtime =
      /^(?<platform>node|workerd)-(?<dimension>ssr|browser-mf|api|backend|backend-driven-ui|failure-isolation|release-identity)$/u.exec(
        id,
      )?.groups;
    await receiptApi.recordAcceptanceResult(receipt, id, async () =>
      id === 'operational-independence'
        ? recordedOperationalDetails
        : id === 'vertical-additions'
          ? {
              workspaceFiles: structuredClone(fixtureWorkspaceFiles),
              workspaceSha256: fixtureWorkspaceSha256,
            }
          : id === 'dependency-closure-audit'
            ? {
                advisories: { auditLevel: 'high', acknowledged: [] },
                closureIdentities: structuredClone(fixtureClosureIdentities),
              }
            : id === 'resolution-parity'
              ? {
                  closureSha256: fixtureClosureSha256,
                  packageCount: fixtureClosureIdentities.length,
                  workspaceSha256: fixtureWorkspaceSha256,
                }
              : runtime
                ? {
                    artifactMode: receipt.mode,
                    assertionCount: 1,
                    dimension: runtime.dimension,
                    durationMs: 0,
                    platform: runtime.platform,
                    ...(runtime.dimension === 'release-identity'
                      ? { apps: runtimeIdentity[runtime.platform] }
                      : {}),
                  }
                : { id },
    );
  }
  if (receipt.mode === 'source') {
    receiptApi.bindRuntimeIdentityEvidence(receipt, runtimeIdentity);
  }
  receiptApi.finalizeAcceptanceReceipt(receipt);

  const operationalResult = receipt.results.find(
    result => result.id === 'operational-independence',
  );
  if (operationalResult) {
    if (!evidenceSource) {
      throw new Error('Operational evidence fixture source is missing');
    }
    fs.writeFileSync(evidencePath, evidenceSource);
  }

  return {
    evidencePath: operationalResult ? evidencePath : undefined,
    evidenceSource,
    runtimeIdentity,
  };
}

module.exports = {
  createOperationalAcceptanceReceiptFixture,
  fixtureClosureSha256,
};
