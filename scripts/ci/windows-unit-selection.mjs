import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const generatorFiles = [
  'packages/toolkit/ultramodern-create/tests/add-shell.test.ts',
  'packages/toolkit/ultramodern-create/tests/workspace-integration.test.ts',
];

// Keep eight ordinary file workers, but place four on each measured 16-core,
// 64-GB runner instead of occupying four VMs with two workers each. Together
// with the two isolated generators this leaves two more VM slots for the
// integration lanes. The cost assignment and complete coverage stay unchanged.
export const windowsOrdinaryLanes = ['1/2', '2/2'];
export const windowsGeneratorLanes = ['generator-shell', 'generator-workspace'];
export const windowsLanes = [...windowsOrdinaryLanes, ...windowsGeneratorLanes];

// Per-file Test-step cost in seconds, measured on Depot Windows in run
// 43825084105: every lane ran with --pool.maxWorkers=1, so one file finishes
// before the next starts and each cost is the gap between consecutive result
// lines. The first file of each lane has that lane's smallest observed
// start-up (5.24 s) deducted, because its gap also contains process start,
// config load, discovery and the Rsbuild build.
//
// This table is what makes the lanes cost-weighted. rstest --shard orders
// files by hash and splits by count, which produced 5.57, 4.67, 4.10 and
// 1.93 min lanes out of the same 15.90 min of ordinary work in that run.
export const windowsUnitTimings = {
  'packages/toolkit/ultramodern-create/tests/add-shell.test.ts': 103.9,
  'packages/toolkit/ultramodern-create/tests/workspace-integration.test.ts': 74.3,
  'packages/toolkit/ultramodern-create/tests/delivery-unit-sync.test.ts': 57.4,
  'packages/toolkit/ultramodern-create/tests/vertical-presets-protocol-horizontal.test.ts': 43.0,
  'packages/toolkit/ultramodern-create/tests/vertical-cli.test.ts': 37.7,
  'packages/toolkit/ultramodern-create/tests/generated-workspace-lint.test.ts': 34.1,
  'packages/toolkit/ultramodern-create/tests/version.test.ts': 27.8,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/renderer-neutral-types.test.ts': 26.2,
  'packages/toolkit/ultramodern-create/tests/add-command-renderer-finalization.test.ts': 24.3,
  'packages/toolkit/ultramodern-create/tests/version-pins.test.ts': 24.2,
  'packages/toolkit/ultramodern-create/tests/add-vertical-transaction.test.ts': 22.3,
  'packages/toolkit/ultramodern-create/tests/create.test.ts': 22.2,
  'packages/toolkit/ultramodern-create/tests/vertical-preflight.test.ts': 21.9,
  'packages/toolkit/ultramodern-create/tests/workspace-determinism.test.ts': 18.2,
  'packages/toolkit/ultramodern-create/tests/structural-thin-shell-gate.test.ts': 17.9,
  'packages/toolkit/ultramodern-create/tests/backend-identity-finalization.test.ts': 15.7,
  'packages/toolkit/ultramodern-create/tests/renderer-identity.test.ts': 15.3,
  'packages/toolkit/ultramodern-create/tests/generated-postinstall-safety.test.ts': 15.1,
  'packages/toolkit/ultramodern-create/tests/vertical-dry-run.test.ts': 13.7,
  'packages/toolkit/ultramodern-create/tests/codesmith-overlays.test.ts': 13.1,
  'packages/toolkit/ultramodern-create/tests/renderer-headless-finalization.test.ts': 11.9,
  'packages/toolkit/ultramodern-create/tests/renderer-generation.test.ts': 11.1,
  'packages/toolkit/ultramodern-create/tests/native-federation-generation.test.ts': 10.8,
  'packages/toolkit/ultramodern-create/tests/workspace-update-transaction.test.ts': 10.7,
  'packages/solutions/app-tools/tests/neutralConfigBacking.test.ts': 9.9,
  'packages/toolkit/ultramodern-create/tests/workspace-script-assets.test.ts': 9.3,
  'packages/solutions/app-tools-extensions/tests/native-type-checker.test.ts': 9.1,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/presetUltramodern.test.ts': 8.8,
  'packages/toolkit/ultramodern-create/tests/native-shell-runtime-validation.test.ts': 8.6,
  'packages/toolkit/ultramodern-create/tests/bridge-router-gate.test.ts': 8.5,
  'packages/toolkit/ultramodern-create/tests/workerd-ssr-proof.test.ts': 8.3,
  'packages/toolkit/ultramodern-create/tests/workspace-profile-coherence.test.ts': 8.3,
  'packages/toolkit/ultramodern-create/tests/zerops-materialize.test.ts': 7.9,
  'packages/toolkit/ultramodern-create/tests/codesmith-adapter.test.ts': 7.9,
  'packages/toolkit/ultramodern-create/tests/tractor-event-bridge.test.ts': 7.8,
  'packages/toolkit/ultramodern-create/tests/bff-runtime-flags.test.ts': 7.7,
  'packages/toolkit/create/tests/create.test.ts': 7.3,
  'packages/toolkit/utils/tests/isPackageInstalled.test.ts': 6.2,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/native-development.test.ts': 6.1,
  'packages/toolkit/ultramodern-create/tests/validate-command.test.ts': 6.1,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/serverRuntimeComposition.test.ts': 6.0,
  'packages/toolkit/utils/tests/compatRequire.test.ts': 5.8,
  'packages/toolkit/utils/tests/lazySignale.test.ts': 5.2,
  'packages/server/utils/tests/ts.test.ts': 5.1,
  'packages/toolkit/ultramodern-create/tests/native-bridge-ssr-loader.test.tsx': 4.9,
  'packages/runtime/renderer-solid/tests/client/hydration-route-completion.test.tsx': 4.9,
  'packages/toolkit/ultramodern-create/tests/api-only-unit-workspace-preset.test.ts': 4.9,
  'packages/toolkit/ultramodern-create/tests/module-federation-remote-refs.test.ts': 4.8,
  'packages/toolkit/ultramodern-create/tests/routes-generate-command.test.ts': 4.4,
  'packages/solutions/app-tools-extensions/tests/package-acceptance.test.ts': 4.2,
  'packages/toolkit/ultramodern-create/tests/build-module-delivery.test.ts': 4.1,
  'packages/cli/plugin-bff-build-extensions/tests/generator-global-vars.test.ts': 3.8,
  'packages/toolkit/utils/tests/prettyInstructions.test.ts': 3.8,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/native-worker-federation-policy.test.ts': 3.6,
  'packages/toolkit/utils/tests/compatRequire.node.test.ts': 3.5,
  'packages/toolkit/ultramodern-create/tests/overlay-baseline-guard.test.ts': 3.5,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/native-module-federation.test.ts': 3.2,
  'packages/solutions/app-tools-extensions/tests/cloudflare-worker-node-compat.test.ts': 3.1,
  'packages/cli/plugin-bff-build-extensions/tests/cli-integration.test.ts': 3.1,
  'packages/toolkit/utils/tests/alias.test.ts': 3.0,
  'packages/toolkit/ultramodern-create/tests/architecture-compiler-inputs.test.ts': 3.0,
  'packages/toolkit/ultramodern-create/tests/cloudflare-output-verify-command.test.ts': 2.9,
  'packages/toolkit/ultramodern-create/tests/installed-template-execution.test.ts': 2.9,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/config-metadata-worker.test.ts': 2.6,
  'packages/toolkit/code-tools/tests/code-tools.test.ts': 2.5,
  'packages/toolkit/ultramodern-create/tests/workspace-artifact-ownership.test.ts': 2.5,
  'packages/toolkit/ultramodern-create/tests/tsrs-adoption.test.ts': 2.4,
  'packages/server/server/tests/watcher.test.ts': 2.3,
  'packages/toolkit/code-tools/tests/microvertical-api-boundary.test.ts': 2.2,
  'packages/toolkit/ultramodern-create/tests/generated-workspace-format.test.ts': 2.1,
  'packages/runtime/renderer-solid/tests/client/route-completion.test.tsx': 2.1,
  'packages/runtime/renderer-octane/tests/federation-client.test.ts': 2.1,
  'packages/solutions/app-tools-extensions/tests/native-server-compiler.test.ts': 2.0,
  'packages/server/core/tests/plugins/ssrCacheLifecycle.test.ts': 2.0,
  'packages/toolkit/ultramodern-create/tests/bridge-config.test.ts': 1.9,
  'packages/toolkit/ultramodern-create/tests/config-strict-dispatch.test.ts': 1.9,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/serverConfigTypes.test.ts': 1.9,
  'packages/server/core/tests/adapters/sendResponse.test.ts': 1.9,
  'packages/toolkit/ultramodern-create/tests/generated-octane-app-types.test.ts': 1.9,
  'packages/toolkit/ultramodern-create/tests/generated-solid-app-types.test.ts': 1.9,
  'packages/toolkit/ultramodern-create/tests/zerops.test.ts': 1.9,
  'packages/toolkit/ultramodern-create/tests/effect-diagnostics.test.ts': 1.8,
  'packages/toolkit/ultramodern-create/tests/generated-config-identity-canonical.test.ts': 1.8,
  'packages/solutions/app-tools/tests/builder/missingCopyContext.test.ts': 1.7,
  'packages/solutions/app-tools/tests/utils/register-esm.test.ts': 1.7,
  'packages/toolkit/ultramodern-create/tests/generated-native-data-policy.test.ts': 1.7,
  'packages/server/core/tests/plugins/ssrCache.test.ts': 1.7,
  'packages/solutions/app-tools-extensions/tests/server-compiler/sourceMaps.test.ts': 1.5,
  'packages/cli/plugin-bff/tests/bffBuildHooks.test.ts': 1.5,
  'packages/toolkit/create/tests/mcp.test.ts': 1.5,
  'packages/solutions/app-tools-extensions/tests/deploy-output/trace-files.test.ts': 1.5,
  'packages/runtime/renderer-core/tests/worker-federation-transport.test.ts': 1.5,
  'packages/solutions/app-tools-extensions/tests/renderer-build-identity.test.ts': 1.4,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/workspace-preset.test.ts': 1.4,
  'packages/toolkit/types/tests/neutralCliTypes.test.ts': 1.3,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/renderer-installed-profile.test.ts': 1.3,
  'packages/toolkit/ultramodern-create/tests/ultramodern-build-module.test.ts': 1.3,
  'packages/solutions/ultramodern-app-tools/tests/deploy-output/cloudflare.test.ts': 1.3,
  'packages/runtime/plugin-runtime/tests/ssr/index.test.ts': 1.2,
  'packages/solutions/app-tools-extensions/tests/backend-federation-build/backendFederationBuild.test.ts': 1.2,
  'packages/solutions/app-tools-extensions/tests/server-compiler/tsgo.test.ts': 1.2,
  'scripts/rslib/tests/source-entry.test.ts': 1.1,
  'packages/solutions/app-tools-extensions/tests/deploy-output/cloudflare-renderer-identity.test.ts': 1.1,
  'packages/toolkit/code-tools/tests/i18n-check-bin.test.ts': 1.1,
  'packages/toolkit/ultramodern-create/tests/renderer-validation.test.ts': 1.1,
  'packages/runtime/plugin-tanstack/tests/router/cli.test.ts': 1.1,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/release-identity-prebuild.test.ts': 1.1,
  'packages/server/bff-effect/tests/package-surface.test.ts': 1.1,
  'packages/toolkit/ultramodern-create/tests/tsconfig-build-input.test.ts': 1.0,
  'packages/runtime/renderer-solid/tests/client/i18n.test.tsx': 1.0,
  'packages/solutions/app-tools-extensions/tests/empty-producer-release.test.ts': 1.0,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/react-build-metadata.test.ts': 1.0,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/index.test.ts': 0.9,
  'packages/toolkit/ultramodern-create/tests/compiler-prepare.test.ts': 0.9,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/type-checker.test.ts': 0.9,
  'packages/solutions/app-tools/tests/types.test.ts': 0.9,
  'packages/solutions/app-tools-extensions/tests/server-compiler/compilerProvider.test.ts': 0.9,
  'packages/solutions/app-tools-extensions/tests/server-compiler/singleEmit.test.ts': 0.9,
  'packages/runtime/render/tests/rsc-html-stream/server.test.ts': 0.9,
  'packages/cli/builder/tests/default.test.ts': 0.9,
  'packages/cli/plugin-bff-build-extensions/tests/compiler-node-target.test.ts': 0.9,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/ultramodern-release-envelope-integration.test.ts': 0.9,
  'packages/solutions/app-tools-extensions/tests/build-config/build-environment.test.ts': 0.9,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/react-rsc-worker-integration.test.ts': 0.9,
  'packages/toolkit/code-tools/tests/oxlint-output.test.ts': 0.8,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/rscDisabledRuntime.test.ts': 0.8,
  'packages/toolkit/ultramodern-create/tests/api-check-build-output.test.ts': 0.8,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/redact-runtime.test.ts': 0.8,
  'packages/runtime/renderer-octane/tests/worker-federation-server.test.ts': 0.8,
  'packages/runtime/plugin-tanstack/tests/router/clientHydration.test.tsx': 0.8,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/renderer-infrastructure.test.ts': 0.8,
  'packages/toolkit/types/tests/reexports.test.ts': 0.8,
  'packages/toolkit/code-tools/tests/cli-react-types.test.ts': 0.8,
  'packages/toolkit/ultramodern-create/tests/backend-artifact-reader.test.ts': 0.8,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/renderer-launcher.test.ts': 0.8,
  'packages/cli/plugin-bff-build-extensions/tests/server-global-vars-native.test.ts': 0.8,
  'packages/cli/builder/tests/cache.test.ts': 0.7,
  'packages/server/bff-effect/tests/effect-public-types.test.ts': 0.7,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/router-integration.test.ts': 0.7,
  'packages/runtime/plugin-tanstack/tests/router/tanstackTypes.test.ts': 0.7,
  'packages/toolkit/ultramodern-create/tests/node-backend-proof-lifecycle.test.ts': 0.7,
  'packages/cli/plugin-bff-extensions/tests/effect-server-runtime.test.ts': 0.7,
  'packages/runtime/renderer-octane/tests/i18n.test.ts': 0.7,
  'packages/toolkit/ultramodern-create/tests/generated-node-types.test.ts': 0.7,
  'packages/solutions/app-tools-extensions/tests/cloudflare-effect-bff-request-scope.test.ts': 0.7,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/ultramodern-release-identity.test.ts': 0.7,
  'packages/solutions/app-tools-extensions/tests/build-config/internal-effect-discovery-publication.test.ts': 0.7,
  'packages/cli/plugin-bff-extensions/tests/plugin-bff-effect-worker-dispatcher.test.ts': 0.7,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/staged-config-metadata.test.ts': 0.7,
  'packages/cli/builder/tests/postcssLegacy.test.ts': 0.7,
  'packages/toolkit/utils/tests/compiledYamlExports.test.ts': 0.7,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/renderer-public-selection.test.ts': 0.6,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/solid-compiler-watch.test.ts': 0.6,
  'packages/cli/builder/tests/tsgo.test.ts': 0.6,
  'packages/cli/builder/tests/lazyBuiltinPlugins.test.ts': 0.6,
  'packages/cli/plugin-bff-build-extensions/tests/hono-client-codegen.test.ts': 0.6,
  'packages/server/runtime-extensions/tests/static-serving/ordering.test.ts': 0.6,
  'packages/toolkit/ultramodern-create/tests/ultramodern-fs-io.test.ts': 0.6,
  'packages/cli/plugin-data-loader/tests/compiler.test.ts': 0.6,
  'packages/toolkit/plugin/tests/configEvaluationContext.test.ts': 0.6,
  'packages/solutions/app-tools-extensions/tests/deploy-output/cloudflare-renderer-guard.test.ts': 0.6,
  'packages/cli/plugin-bff-extensions/tests/effect-source-loader.test.ts': 0.6,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/renderer-entry.test.ts': 0.6,
  'packages/solutions/app-tools-extensions/tests/deploy-output/cloudflare-output-verifier.test.ts': 0.6,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/renderer-assets.test.ts': 0.6,
  'packages/cli/plugin-bff-extensions/tests/effect-operation-contracts.test.ts': 0.5,
  'packages/server/bff-core/tests/client/generateClient.test.ts': 0.5,
  'packages/cli/builder/tests/pluginOptions.test.ts': 0.5,
  'packages/toolkit/ultramodern-create/tests/cloudflare-version-topology.test.ts': 0.5,
  'packages/cli/plugin-bff-extensions/tests/rspack-loader.test.ts': 0.5,
  'packages/solutions/ultramodern-app-tools/tests/native-composition/federationEffect.test.ts': 0.5,
  'packages/toolkit/ultramodern-create/tests/workspace-validation-structured-contract.test.ts': 0.5,
  'packages/solutions/app-tools-extensions/tests/deploy-output/npm-aliases.test.ts': 0.5,
  'packages/runtime/plugin-tanstack/tests/router/dataMutation.test.tsx': 0.5,
};

// Mean of the 522 measured files below this table's 0.5 s floor, rounded
// down. A file the baseline discovers but the table does not name - a new
// test, or one of those 522 - costs this much when the lanes are assigned.
// Coverage never depends on it: assertWindowsCoverage still runs the file.
export const windowsUnmeasuredFileSeconds = 0.2;

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const identity = file => JSON.stringify([file.project, file.testPath]);
const relativeFile = (root, file) =>
  path.relative(root, file).split(path.sep).join('/');
const posixPath = file => file.split(path.sep).join('/');

export const windowsFileSeconds = file =>
  windowsUnitTimings[file] ?? windowsUnmeasuredFileSeconds;

const isGeneratorFile = (root, entry) =>
  generatorFiles.includes(relativeFile(root, entry.testPath));

// Longest-processing-time-first: the heaviest remaining file joins the lane
// with the least work so far, and equal costs break on the path, so every
// runner derives the same lanes from the same baseline. A file is one unit of
// work even when several projects discover it, because a lane excludes paths
// and that excludes every project's copy of the file.
export function assignWindowsOrdinaryLanes(root, ordinary) {
  const files = new Map();
  for (const entry of ordinary) {
    const file = relativeFile(root, entry.testPath);
    const group = files.get(file);
    if (group) group.push(entry);
    else files.set(file, [entry]);
  }
  const lanes = new Map(windowsOrdinaryLanes.map(lane => [lane, []]));
  const seconds = new Map(windowsOrdinaryLanes.map(lane => [lane, 0]));
  const heaviestFirst = [...files.keys()].sort(
    (left, right) =>
      windowsFileSeconds(right) - windowsFileSeconds(left) ||
      (left < right ? -1 : left > right ? 1 : 0),
  );
  for (const file of heaviestFirst) {
    let cheapest = windowsOrdinaryLanes[0];
    for (const lane of windowsOrdinaryLanes) {
      if (seconds.get(lane) < seconds.get(cheapest)) cheapest = lane;
    }
    lanes.get(cheapest).push(...files.get(file));
    seconds.set(cheapest, seconds.get(cheapest) + windowsFileSeconds(file));
  }
  return { lanes, seconds };
}

export function selectWindowsUnitFiles(root, baseline, lane) {
  if (!windowsLanes.includes(lane))
    throw new Error(`Unknown Windows lane: ${lane}`);
  for (const file of generatorFiles) {
    if (!baseline.some(entry => relativeFile(root, entry.testPath) === file)) {
      throw new Error(`Measured Windows generator test is missing: ${file}`);
    }
  }
  if (windowsGeneratorLanes.includes(lane)) {
    const file = generatorFiles[windowsGeneratorLanes.indexOf(lane)];
    return baseline.filter(
      entry => relativeFile(root, entry.testPath) === file,
    );
  }
  return assignWindowsOrdinaryLanes(
    root,
    baseline.filter(entry => !isGeneratorFile(root, entry)),
  ).lanes.get(lane);
}

// Modelled cost of a lane: what the assignment balanced, in seconds.
export function windowsLaneSeconds(root, baseline, lane) {
  const files = new Set(
    selectWindowsUnitFiles(root, baseline, lane).map(entry =>
      relativeFile(root, entry.testPath),
    ),
  );
  return [...files].reduce(
    (total, file) => total + windowsFileSeconds(file),
    0,
  );
}

export function assertWindowsCoverage(baseline, lanes) {
  const expected = new Set(baseline.map(identity));
  if (expected.size !== baseline.length)
    throw new Error('Duplicate baseline project/file identity');
  const actual = new Set();
  for (const files of lanes) {
    for (const file of files) {
      const key = identity(file);
      if (!expected.has(key))
        throw new Error(`Unexpected Windows test identity: ${key}`);
      if (actual.has(key))
        throw new Error(`Windows test runs more than once: ${key}`);
      actual.add(key);
    }
  }
  const missing = [...expected].filter(key => !actual.has(key));
  if (missing.length)
    throw new Error(`Missing Windows test identities: ${missing.join(', ')}`);
}

export function excludeUnselected(project, files) {
  // CLI --exclude replaces project excludes and would rediscover other lanes.
  const exclude = project.exclude;
  const patterns = [
    ...(Array.isArray(exclude) ? exclude : (exclude?.patterns ?? [])),
    ...files,
  ];
  return {
    ...project,
    exclude:
      Array.isArray(exclude) || !exclude ? patterns : { ...exclude, patterns },
  };
}

export async function windowsUnitConfig(
  root,
  base,
  loadConfig,
  lane,
  baseline,
) {
  // Every file the baseline discovered outside this lane is excluded by path,
  // so the lane runs its assigned cost and nothing else. No --shard: the
  // assignment above, not a hash split, decides what a lane runs.
  const selected = new Set(
    selectWindowsUnitFiles(root, baseline, lane).map(entry =>
      posixPath(entry.testPath),
    ),
  );
  const excluded = [
    ...new Set(baseline.map(entry => posixPath(entry.testPath))),
  ].filter(file => !selected.has(file));
  const projects = [];
  for (const pattern of base.projects ?? []) {
    if (typeof pattern !== 'string' || pattern.startsWith('!')) {
      throw new Error('Windows selection requires root project config paths');
    }
    for (const file of fs.globSync(pattern, { cwd: root })) {
      const configPath = path.resolve(root, file);
      const projectRoot = path.dirname(configPath);
      const { content } = await loadConfig({
        cwd: projectRoot,
        path: configPath,
      });
      const name = JSON.parse(
        fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
      ).name;
      // Pinned Rstest resolves nested inline leaves without inheriting the
      // containing file's defaults. Retain leaf extends objects so its native
      // resolver applies the same explicit common config and child overrides.
      const leaves = content.projects ?? [
        {
          ...content,
          name: content.name ?? name,
          root: content.root ?? projectRoot,
        },
      ];
      for (const project of leaves) {
        if (typeof project !== 'object' || project.projects) {
          throw new Error(`Unsupported nested Windows project in ${file}`);
        }
        projects.push(
          excludeUnselected({ root: projectRoot, ...project }, excluded),
        );
      }
    }
  }
  if (!projects.length)
    throw new Error('Windows selection resolved no projects');
  return { ...base, root: base.root ?? root, projects };
}

export async function loadWindowsUnitInputs(root) {
  const require = createRequire(path.join(root, 'package.json'));
  // Load the exact Rsbuild dependency of pinned Rstest; no additional loader.
  const rstestRequire = createRequire(
    require.resolve('@rstest/core/package.json'),
  );
  const [{ createRstest }, { loadConfig }] = await Promise.all([
    import(pathToFileURL(require.resolve('@rstest/core/api')).href),
    import(pathToFileURL(rstestRequire.resolve('@rsbuild/core')).href),
  ]);
  const { content: base } = await loadConfig({
    cwd: root,
    path: path.join(root, 'rstest.config.mts'),
  });
  return { createRstest, loadConfig, base };
}

export async function verifyWindowsUnitSelection(root) {
  const { createRstest, loadConfig, base } = await loadWindowsUnitInputs(root);
  const original = await createRstest({ cwd: root, config: base });
  const baseline = await original.listTests({ filesOnly: true });
  const lanes = [];
  for (const lane of windowsLanes) {
    const config = await windowsUnitConfig(
      root,
      base,
      loadConfig,
      lane,
      baseline,
    );
    const rstest = await createRstest({ cwd: root, config });
    const files = await rstest.listTests({ filesOnly: true });
    // Rstest must resolve exactly the lane it was assigned, not a superset
    // the exclusions missed.
    assertWindowsCoverage(selectWindowsUnitFiles(root, baseline, lane), [
      files,
    ]);
    lanes.push(files);
    console.log(
      JSON.stringify({
        windowsUnitLane: lane,
        testFiles: new Set(files.map(file => file.testPath)).size,
        projectFileIdentities: files.length,
        modelledSeconds: Number(
          windowsLaneSeconds(root, baseline, lane).toFixed(1),
        ),
        testFileWorkers: 1,
      }),
    );
  }
  assertWindowsCoverage(baseline, lanes);
  console.log(
    `Verified ${baseline.length} Windows project/file identities exactly once.`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 3 || process.argv[2] !== '--verify')
    throw new Error('Use --verify to check Windows test coverage');
  await verifyWindowsUnitSelection(repoRoot);
}
