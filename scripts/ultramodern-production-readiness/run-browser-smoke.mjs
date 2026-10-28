#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fsKit from '../lib/fs-kit.js';
import processKit from '../lib/process-kit.js';
import {
  readNodeBackendFederationProof,
  runNodeBackendFederationProof,
} from './browser-smoke/backend-evidence.mjs';
import {
  assertLocalPortsAvailable,
  launchBrowser,
  startServer,
  startWorkerdProof,
} from './browser-smoke/bootstrap.mjs';
import { validateBrowserTarget } from './browser-smoke/browser-validate.mjs';
import {
  BrowserSmokeError,
  normalizeSmokeContract,
  parseArgs,
  readSmokeContract,
} from './browser-smoke/contract.mjs';
import { validateFailureIsolation } from './browser-smoke/failure-isolation.mjs';
import {
  validateHttpTarget,
  waitForTarget,
} from './browser-smoke/http-validate.mjs';
import { readCombinedLogTail } from './browser-smoke/log-tail.mjs';
import {
  bindContractToReleaseIdentity,
  createRuntimeEvidence,
  readNodeBackendArtifactEvidence,
} from './browser-smoke/runtime-evidence.mjs';
import {
  createSmokeTargets,
  orderTargetsForLocalStartup,
} from './browser-smoke/targets.mjs';
import { authenticatedCompilerTrustExclusions } from './published-create-proof/package-cohort.mjs';
import { createAcceptanceWorkspaceEnv } from './published-create-proof/process.mjs';
import {
  parseYamlFile,
  validateExactExclusions,
} from './published-create-proof/release-age-audit.mjs';

export {
  findDuplicateStylesheetHrefs,
  isFatalConsoleMessage,
  remoteBoundaryCandidates,
  validateBrowserTarget,
} from './browser-smoke/browser-validate.mjs';
export {
  BrowserSmokeError,
  normalizeSmokeContract,
  parseArgs,
  readSmokeContract,
} from './browser-smoke/contract.mjs';
export {
  validateHttpTarget,
  waitForTarget,
} from './browser-smoke/http-validate.mjs';
export {
  createSmokeTargets,
  orderTargetsForLocalStartup,
} from './browser-smoke/targets.mjs';
export { assertLocalPortsAvailable };

const { writeJsonFile } = fsKit;
const { writeStream } = processKit;

export function assertStrictRuntimeEvidence(evidence) {
  const failedEvidence = Object.entries(evidence).filter(
    ([, dimension]) => dimension?.status !== 'pass',
  );
  if (failedEvidence.length > 0) {
    throw new BrowserSmokeError(
      `Strict runtime evidence failed: ${failedEvidence
        .map(([dimension]) => dimension)
        .join(', ')}`,
      {
        failedEvidence: Object.fromEntries(failedEvidence),
      },
    );
  }
}

function pinnedJson(filename) {
  const resolved = path.resolve(filename);
  const stat = fs.lstatSync(resolved);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(resolved) !== resolved
  ) {
    throw new BrowserSmokeError(
      'Continuation evidence must be an ordinary physical file',
      { path: resolved },
    );
  }
  const bytes = fs.readFileSync(resolved);
  return {
    value: JSON.parse(bytes.toString('utf8')),
    pin: {
      path: resolved,
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}

export function createAcceptedNodeProofEnvironment(
  projectDir,
  environment = process.env,
  context = {},
) {
  const {
    value: { settings },
  } = pinnedJson(
    path.join(projectDir, 'node_modules/.pnpm-workspace-state-v1.json'),
  );
  if (
    settings?.minimumReleaseAge !== 1440 ||
    settings.minimumReleaseAgeStrict !== true ||
    settings.minimumReleaseAgeIgnoreMissingTime !== false ||
    settings.trustPolicy !== 'no-downgrade' ||
    (settings.enableGlobalVirtualStore !== undefined &&
      typeof settings.enableGlobalVirtualStore !== 'boolean') ||
    !['minimumReleaseAgeExclude'].every(
      key =>
        Array.isArray(settings[key]) &&
        settings[key].length > 0 &&
        settings[key].every(
          value => typeof value === 'string' && value.length > 0,
        ) &&
        new Set(settings[key]).size === settings[key].length,
    )
  )
    throw new BrowserSmokeError(
      'Continuation requires the original strict pnpm install settings',
    );
  const policy = parseYamlFile(
    path.join(projectDir, 'pnpm-workspace.yaml'),
    undefined,
    { singleDocument: true },
  );
  if (
    policy?.minimumReleaseAge !== 1440 ||
    policy.minimumReleaseAgeStrict !== true ||
    policy.minimumReleaseAgeIgnoreMissingTime !== false ||
    policy.trustPolicy !== 'no-downgrade' ||
    policy.trustPolicyIgnoreAfter !== 1440 ||
    JSON.stringify(policy.minimumReleaseAgeExclude) !==
      JSON.stringify(settings.minimumReleaseAgeExclude)
  ) {
    throw new BrowserSmokeError(
      'Continuation requires unchanged native pnpm workspace policy',
    );
  }
  validateExactExclusions(
    policy.minimumReleaseAgeExclude,
    'Continuation native release-age exclusions',
  );
  const nativeTrustExclusions = validateExactExclusions(
    policy.trustPolicyExclude === undefined ? [] : policy.trustPolicyExclude,
    'Continuation native trust exclusions',
  );
  const savedTrustExclusions = validateExactExclusions(
    settings.trustPolicyExclude === undefined
      ? []
      : settings.trustPolicyExclude,
    'Continuation installed trust exclusions',
  );
  // Plain consumer browser continuation has no release harness context. It
  // may retain this reviewed exact compiler exception, never another release.
  const compilerTrustExclusions = context.release
    ? authenticatedCompilerTrustExclusions(context.release)
    : nativeTrustExclusions.includes('tsrs@0.20.1-ts7.1.0-beta')
      ? ['tsrs@0.20.1-ts7.1.0-beta']
      : [];
  if (
    JSON.stringify(nativeTrustExclusions) !==
    JSON.stringify(compilerTrustExclusions)
  ) {
    throw new BrowserSmokeError(
      'Continuation requires native consumer trust policy without exclusions other than the authenticated exact compiler',
    );
  }
  let trustContext;
  if (
    !compilerTrustExclusions.every(selector =>
      savedTrustExclusions.includes(selector),
    )
  ) {
    throw new BrowserSmokeError(
      'Continuation requires the installed authenticated exact compiler trust exclusions',
    );
  }
  const candidateTrustExclusions = savedTrustExclusions.filter(
    selector => !compilerTrustExclusions.includes(selector),
  );
  if (candidateTrustExclusions.length > 0) {
    if (context.mode !== 'source' || !context.release) {
      throw new BrowserSmokeError(
        'Saved source candidate trust exclusions require an authenticated release. Use run-release-acceptance.mjs --continue-from source-node or source-workerd.',
      );
    }
    trustContext = {
      mode: 'source',
      release: context.release,
      registryEnv: {
        PNPM_CONFIG_TRUST_POLICY_EXCLUDE: JSON.stringify(
          candidateTrustExclusions,
        ),
      },
    };
  }
  return createAcceptanceWorkspaceEnv(
    {
      ...environment,
      CI: 'true',
      ...(settings.enableGlobalVirtualStore === undefined
        ? {}
        : {
            pnpm_config_enable_global_virtual_store: String(
              settings.enableGlobalVirtualStore,
            ),
          }),
    },
    trustContext,
  );
}

export function readNodeBrowserContinuation({
  options,
  contract,
  contractPath,
  targets,
}) {
  const { value: prior, pin } = pinnedJson(options.continueFrom);
  const reject = () => {
    throw new BrowserSmokeError(
      'Continuation requires the unchanged passed Node browser stage',
      { priorReport: pin },
    );
  };
  if (
    prior.schemaVersion !== 1 ||
    prior.status !== 'fail' ||
    prior.error !== 'Node backend federation proof failed' ||
    prior.errorDetails?.exitCode !== 1 ||
    prior.errorDetails?.signal !== null ||
    prior.mode !== 'local' ||
    prior.artifactMode !== 'source' ||
    prior.platform !== 'node' ||
    prior.shellRuntime !== 'node' ||
    path.resolve(prior.projectDir ?? '') !== path.resolve(options.projectDir) ||
    prior.contractPath !== contractPath ||
    !Array.isArray(prior.skipped) ||
    prior.skipped.length ||
    !Array.isArray(prior.results) ||
    prior.results.length !== targets.length ||
    new Set(prior.results.map(result => result.appId)).size !==
      targets.length ||
    Object.keys(prior.targetRuntimes ?? {}).length !== targets.length ||
    path.resolve(options.out) === pin.path ||
    path.resolve(prior.artifactDir ?? '') === path.resolve(options.artifactDir)
  )
    reject();
  for (const target of targets) {
    const result = prior.results.find(item => item.appId === target.app.id);
    if (
      !result ||
      result.status !== 'pass' ||
      result.baseUrl !== target.baseUrl ||
      prior.targetRuntimes?.[target.app.id] !== 'node' ||
      !Array.isArray(result.assertions) ||
      result.assertions.some(
        assertion =>
          assertion.status !== 'pass' ||
          ['backend-federation-network', 'failure-isolation'].includes(
            assertion.type,
          ),
      )
    )
      reject();
    const requiredTypes = [
      'ssr-route',
      'css-root-marker',
      'mf-manifest',
      'mf-manifest-json',
      'locale-json',
      'browser-css-root-marker',
      'stylesheet-evidence',
      'stylesheet-href-dedupe',
      'browser-diagnostics',
      'no-js-ssr-css-root-marker',
      'no-js-stylesheet-href-dedupe',
      'no-js-ssr-failed-responses',
      ...(target.app.kind === 'shell'
        ? [
            'shell-server-rendered-composition',
            'shell-hydration-dom-identity',
            'shell-mf-network-evidence',
            'shell-composition-boundary',
            'no-js-shell-composition-boundary',
          ]
        : [
            'effect-readiness',
            'backend-json-smoke',
            'backend-driven-ui',
            'localized-router-navigation',
          ]),
    ];
    if (
      requiredTypes.some(
        type => !result.assertions.some(assertion => assertion.type === type),
      )
    )
      reject();
    for (const type of [
      'ui-marker-html',
      'browser-ui-marker',
      'no-js-ssr-ui-marker',
    ]) {
      const assertions = result.assertions.filter(
        assertion => assertion.type === type,
      );
      if (
        assertions.length !== 1 ||
        assertions[0].actual !== target.app.marker.build ||
        assertions[0].expected !== target.app.marker.build
      )
        reject();
    }
    if (target.app.kind === 'vertical') {
      const observed = result.assertions.find(
        assertion => assertion.type === 'backend-driven-ui',
      );
      const marker = observed?.apiResponse?.body?.items?.[0]?.marker;
      if (
        !marker ||
        marker.buildMarker !== target.app.marker.build ||
        marker.sourceRevision !== target.app.marker.sourceRevision ||
        marker.version !== target.app.deliveryUnit.version ||
        marker.unitId !== target.app.deliveryUnit.unitId
      )
        reject();
    }
  }
  const evidence = createRuntimeEvidence({
    artifactMode: 'source',
    contract,
    platform: 'node',
    projectDir: options.projectDir,
    results: prior.results,
  });
  for (const dimension of [
    'ssr',
    'browser-mf',
    'api',
    'backend-driven-ui',
    'release-identity',
  ]) {
    if (evidence[dimension]?.status !== 'pass') reject();
  }
  return { priorReport: pin, results: structuredClone(prior.results) };
}

export async function runUltramodernBrowserSmoke(options) {
  if (options.backendReport && !options.continueFrom) {
    throw new BrowserSmokeError('backendReport requires continueFrom');
  }
  if (
    options.continueFrom &&
    (options.mode !== 'local' ||
      options.artifactMode !== 'source' ||
      options.platform !== 'node' ||
      (options.shellRuntime ?? 'node') !== 'node')
  ) {
    throw new BrowserSmokeError(
      'Continuation requires local source/node release smoke',
    );
  }
  if (
    (options.artifactMode === undefined) !==
    (options.platform === undefined)
  ) {
    throw new BrowserSmokeError(
      'artifactMode and platform must be provided together for strict release smoke',
    );
  }
  if (
    options.artifactMode &&
    options.mode === 'local' &&
    (options.shellRuntime ?? 'node') !== options.platform
  ) {
    throw new BrowserSmokeError(
      'Strict local release smoke requires shellRuntime to match platform',
    );
  }
  const { contract: sourceContract, contractPath } = options.contract
    ? {
        contract: normalizeSmokeContract(options.contract, {
          sourcePath: options.contractPath,
        }),
        contractPath: options.contractPath ?? '<provided>',
      }
    : readSmokeContract(options.projectDir);
  const contract =
    options.artifactMode && options.platform
      ? bindContractToReleaseIdentity({
          contract: sourceContract,
          platform: options.platform,
          projectDir: options.projectDir,
        })
      : sourceContract;
  const { skipped, targets } = createSmokeTargets(contract, options);
  if (
    options.artifactMode &&
    (targets.length === 0 ||
      targets.length !== contract.apps.length ||
      skipped.length > 0)
  ) {
    throw new BrowserSmokeError(
      'Strict release smoke requires one executable target for every contract app',
      {
        appIds: contract.apps.map(app => app.id),
        skipped,
        targetAppIds: targets.map(target => target.app.id),
      },
    );
  }
  const continuation = options.continueFrom
    ? readNodeBrowserContinuation({ options, contract, contractPath, targets })
    : undefined;
  const executionOptions = continuation
    ? {
        ...options,
        processEnv: createAcceptedNodeProofEnvironment(options.projectDir, {
          ...process.env,
          ...options.processEnv,
        }),
      }
    : options;
  const currentBackendArtifacts = () =>
    contract.apps
      .filter(app => app.kind === 'vertical')
      .map(app => {
        const evidence = readNodeBackendArtifactEvidence(
          options.projectDir,
          app,
        );
        return {
          ...evidence,
          identity: {
            ...evidence.identity,
            unitId: app.deliveryUnit.unitId,
            packageName: app.deliveryUnit.packageName,
          },
        };
      });
  const expectedBackendArtifacts = continuation
    ? currentBackendArtifacts()
    : undefined;
  const compilerPins = continuation
    ? contract.apps
        .filter(app => app.surfaceProfile !== 'api-only')
        .map(
          app =>
            pinnedJson(
              path.join(
                options.projectDir,
                app.path,
                '.output/renderer-build.json',
              ),
            ).pin,
        )
    : [];
  const report = {
    schemaVersion: 1,
    artifactMode: options.artifactMode,
    artifactDir: options.artifactDir,
    contractPath,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    mode: options.mode,
    platform: options.platform,
    projectDir: options.projectDir,
    shellRuntime:
      options.mode === 'public'
        ? (options.platform ?? 'workerd')
        : (options.shellRuntime ?? 'node'),
    results: continuation?.results ?? [],
    ...(continuation
      ? {
          continuation: {
            priorReport: continuation.priorReport,
            reusedStages: ['http-browser-no-js'],
            completedStages: [],
          },
        }
      : {}),
    skipped,
    status: 'running',
    targetRuntimes: {},
  };
  const servers = [];
  const serversByAppId = new Map();
  let browser;
  const localStartupOrder =
    options.mode === 'local' ? orderTargetsForLocalStartup(targets) : undefined;
  const startServerImpl = options.startServerImpl ?? startServer;
  const validateBrowserTargetImpl =
    options.validateBrowserTargetImpl ?? validateBrowserTarget;

  try {
    if (localStartupOrder) {
      const preflightLocalPortsImpl =
        options.preflightLocalPortsImpl ?? assertLocalPortsAvailable;
      await preflightLocalPortsImpl(localStartupOrder.validation);
      if (report.shellRuntime === 'workerd') {
        if (localStartupOrder.shells.length !== 1) {
          throw new BrowserSmokeError(
            'workerd browser smoke requires exactly one shell target',
          );
        }
        const startWorkerdProofImpl =
          options.startWorkerdProofImpl ?? startWorkerdProof;
        const server = await startWorkerdProofImpl({
          ...options,
          requireTargetUrls: true,
        });
        servers.push(server);
        if (!server.targetUrls) {
          throw new BrowserSmokeError(
            'strict all-workerd browser smoke requires a workerd URL for every target',
          );
        }
        for (const target of localStartupOrder.validation) {
          const targetUrl = server.targetUrls[target.app.id];
          if (typeof targetUrl !== 'string' || targetUrl.length === 0) {
            throw new BrowserSmokeError(
              `workerd proof did not publish a URL for ${target.app.id}`,
            );
          }
          target.baseUrl = targetUrl;
          target.port = Number(new URL(targetUrl).port);
          serversByAppId.set(target.app.id, server);
          report.targetRuntimes[target.app.id] = 'workerd';
          await waitForTarget(target, {
            fetchImpl: options.fetchImpl ?? fetch,
            requireManifest: target.app.kind !== 'shell',
            retryDelayMs: options.retryDelayMs,
            serverExit: server.exited,
            serverLogPath: server.logPath,
            timeoutMs: options.timeoutMs,
          });
        }
      } else {
        for (const layer of localStartupOrder.remoteLayers) {
          const layerServers = layer.map(target => {
            const server = startServerImpl(target, executionOptions);
            servers.push(server);
            serversByAppId.set(target.app.id, server);
            report.targetRuntimes[target.app.id] = 'node';
            return server;
          });
          await Promise.all(
            layer.map((target, index) => {
              const server = layerServers[index];
              return waitForTarget(target, {
                fetchImpl: options.fetchImpl ?? fetch,
                requireManifest: true,
                retryDelayMs: options.retryDelayMs,
                serverExit: server.exited,
                serverLogPath: server.logPath,
                timeoutMs: options.timeoutMs,
              });
            }),
          );
        }
        for (const target of localStartupOrder.shells) {
          const server = startServerImpl(target, executionOptions);
          servers.push(server);
          serversByAppId.set(target.app.id, server);
          report.targetRuntimes[target.app.id] = 'node';
          await waitForTarget(target, {
            fetchImpl: options.fetchImpl ?? fetch,
            retryDelayMs: options.retryDelayMs,
            serverExit: server.exited,
            serverLogPath: server.logPath,
            timeoutMs: options.timeoutMs,
          });
        }
      }
    }

    if (targets.length === 0) {
      report.status = 'skipped';
      writeJsonFile(options.out, report, { atomic: false });
      return report;
    }

    const validationTargets = localStartupOrder?.validation ?? targets;
    if (!continuation) {
      browser = await launchBrowser(options.browserProvider);
      for (const target of validationTargets) {
        try {
          const httpAssertions = await validateHttpTarget(target, {
            fetchImpl: options.fetchImpl ?? fetch,
          });
          const runtime =
            report.targetRuntimes[target.app.id] ??
            options.platform ??
            (options.mode === 'public'
              ? 'workerd'
              : (options.shellRuntime ?? 'node'));
          report.targetRuntimes[target.app.id] ??= runtime;
          const browserAssertions = await validateBrowserTargetImpl(
            target,
            browser,
            {
              artifactDir: options.artifactDir,
              runtime,
              targets,
            },
          );
          report.results.push({
            appId: target.app.id,
            assertions: [...httpAssertions, ...browserAssertions],
            baseUrl: target.baseUrl,
            status: 'pass',
          });
        } catch (error) {
          if (error instanceof BrowserSmokeError) {
            error.details = {
              ...error.details,
              appId: target.app.id,
            };
          }
          throw error;
        }
      }
    }

    if (options.artifactMode && options.platform) {
      if (options.platform === 'node') {
        const backendReportPin = options.backendReport
          ? pinnedJson(options.backendReport).pin
          : undefined;
        const backendAssertions = options.backendReport
          ? readNodeBackendFederationProof({
              projectDir: options.projectDir,
              reportPath: options.backendReport,
              expectedArtifacts: expectedBackendArtifacts,
            })
          : runNodeBackendFederationProof({
              artifactDir: options.artifactDir,
              projectDir: options.projectDir,
              ...(continuation
                ? {
                    processEnv: executionOptions.processEnv,
                    expectedArtifacts: expectedBackendArtifacts,
                  }
                : {}),
            });
        for (const assertion of backendAssertions) {
          const result = report.results.find(
            candidate => candidate.appId === assertion.appId,
          );
          result?.assertions.push(assertion);
        }
        if (continuation) {
          if (backendReportPin) {
            report.continuation.backendReport = backendReportPin;
            if (
              pinnedJson(options.backendReport).pin.sha256 !==
              backendReportPin.sha256
            )
              throw new BrowserSmokeError(
                'Reused backend report changed during continuation',
              );
            report.continuation.reusedStages.push('node-backend-federation');
          } else {
            report.continuation.completedStages.push('node-backend-federation');
          }
        }
      }
      const failureIsolationAssertions = await validateFailureIsolation({
        fetchImpl: options.fetchImpl ?? fetch,
        options: executionOptions,
        platform: options.platform,
        servers,
        serversByAppId,
        startServerImpl,
        targets: validationTargets,
      });
      for (const assertion of failureIsolationAssertions) {
        const result = report.results.find(
          candidate => candidate.appId === assertion.appId,
        );
        result?.assertions.push(assertion);
      }
      if (continuation)
        report.continuation.completedStages.push('node-failure-isolation');
      report.evidence = createRuntimeEvidence({
        artifactMode: options.artifactMode,
        contract,
        platform: options.platform,
        projectDir: options.projectDir,
        results: report.results,
      });
      assertStrictRuntimeEvidence(report.evidence);
      if (continuation) {
        if (
          pinnedJson(options.continueFrom).pin.sha256 !==
            continuation.priorReport.sha256 ||
          compilerPins.some(
            pin => pinnedJson(pin.path).pin.sha256 !== pin.sha256,
          ) ||
          JSON.stringify(expectedBackendArtifacts) !==
            JSON.stringify(currentBackendArtifacts())
        ) {
          throw new BrowserSmokeError(
            'Pinned Node evidence changed during continuation',
          );
        }
        report.continuation.compilerManifests = compilerPins;
        report.continuation.completedStages.push('strict-runtime-evidence');
      }
    }
    report.status = 'pass';
    writeJsonFile(options.out, report, { atomic: false });
    return report;
  } catch (error) {
    report.status = 'fail';
    report.error = error instanceof Error ? error.message : String(error);
    if (error instanceof BrowserSmokeError && error.details) {
      const details = { ...error.details };
      const owningServer =
        typeof details.appId === 'string'
          ? serversByAppId.get(details.appId)
          : undefined;
      if (owningServer?.logPath) {
        details.logPath ??= owningServer.logPath;
        details.logTail ??= readCombinedLogTail(owningServer.logPath);
      }
      report.errorDetails = details;
    }
    writeJsonFile(options.out, report, { atomic: false });
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
    await Promise.allSettled(servers.map(server => server.stop()));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runUltramodernBrowserSmoke(options);
  await writeStream(
    process.stdout,
    `[ultramodern-browser-smoke] ${report.status}: ${options.out}\n`,
  );
  process.exit(report.status === 'pass' || report.status === 'skipped' ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`[ultramodern-browser-smoke] ${error.message}\n`);
    process.exitCode = 1;
  });
}
