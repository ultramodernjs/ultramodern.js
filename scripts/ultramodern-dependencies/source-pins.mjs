import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { coordinatedTransitions, targets } from './snapshot.mjs';
import { publicSources } from './sync-skill-sources.mjs';

// Supplemental, bounded lookups; the full dependency snapshot is not requeried.
export const sourcePinQueries = {
  start: '2026-11-16T02:26:55.917Z',
  end: '2026-11-16T02:27:52.603Z',
};
// Bounded follow-up: npm latest metadata and Miniflare's exact runtime dependency.
// This supplements source-only pins; it does not refresh the dependency snapshot.
export const supplementalSourcePins = {
  queriedAt: '2026-11-16T17:20:52Z',
  'node-fetch': '3.3.2',
  lefthook: '2.2.2',
  '@bleedingdev/braces': '3.0.4',
  '@tanstack/history': '1.162.5',
  '@rsbuild/plugin-tailwindcss': '2.0.3',
  sharp: '0.35.5',
  miniflareWorkerd: '1.20261113.1',
  chromeForTesting: { version: '157.0.8103.6', revision: '1717349' },
};
export const verdaccioIntegrity =
  'sha512-CGqccLmg4/G76kk6BVx2epzqm0aKIBBn34FJTUHi5zuat+X484eSiJ4SpVQKNwiduE9xWx8BsddzHiiXgtFNzg==';

const proof =
  'scripts/ultramodern-production-readiness/published-create-proof/';
const sandpack = 'packages/toolkit/ultramodern-sandpack-profile/src/index.ts';
const registry =
  'scripts/ultramodern-publish/lib/source-create-proof/runtime-proof/registry.mjs';
const devcert = 'packages/server/server/src/dev-tools/https/index.ts';
const generator =
  'packages/toolkit/ultramodern-create/src/ultramodern-workspace/';
const octane = 'scripts/ultramodern-renderers/octane-corrections/';
const router = 'scripts/ultramodern-renderers/router-corrections/';
const reactRouter = 'scripts/ultramodern-renderers/react-router-corrections/';
// Framework toolchain reviewed in the supplemental query window.
const toolchain = { node: '26.13.1', pnpm: '12.21.0' };
// Native run 43904193604 attempt 1 (source 48b9eef7) built and qualified the
// owning router/adapter sources with this pnpm; it is not the framework toolchain.
const owningPnpm = '11.21.0';
// The updater activates the authenticated native descriptor into this owner.
const nativeOwner = 'packages/runtime/renderer-octane/package.json';
const nativeCohort = [
  'octane',
  '@octanejs/rspack-plugin',
  '@octanejs/tanstack-router',
  '@tanstack/router-core',
];
const patch = (name, suffix = '') =>
  `patches/${name.replace('/', '__')}@${targets[name]}${suffix}.patch`;
const coreTarball = `https://registry.npmjs.org/@tanstack/router-core/-/router-core-${targets['@tanstack/router-core']}.tgz`;

/**
 * Exact reviewed tokens per file. Identity selection only: snapshot targets,
 * coordinated transitions and the activated native descriptor. Consumer and
 * hosted acceptance remain CI obligations.
 */
function reviewedSourcePins(read) {
  const descriptor =
    JSON.parse(read(nativeOwner)).ultramodern?.nativeArtifacts ?? {};
  const native = name => descriptor.packages?.[name] ?? {};
  const errors = nativeCohort
    .filter(name => native(name).version !== targets[name])
    .map(
      name =>
        `${nativeOwner}: activated native ${name} must be snapshot ${targets[name]}, found ${native(name).version}`,
    );
  const core = targets['@tanstack/router-core'];
  const tsgo = coordinatedTransitions['@effect/tsgo'].to;
  const tsgoCheck = [`@effect/tsgo@${tsgo}`, `effect.version !== '${tsgo}'`];
  const pnpmManager = version => `packageManager: 'pnpm@${version}'`;
  const solidVersion = JSON.parse(
    read('packages/runtime/renderer-solid/package.json'),
  ).version;
  const forkVersion = name => coordinatedTransitions[name].to.split('@').at(-1);
  const generatedVersions = {
    TANSTACK_ROUTER_VERSION: targets['@tanstack/react-router'],
    TANSTACK_ROUTER_CORE_VERSION: core,
    TANSTACK_HISTORY_VERSION: supplementalSourcePins['@tanstack/history'],
    MODULE_FEDERATION_VERSION: targets['@module-federation/bridge-react'],
    MODULE_FEDERATION_BRIDGE_REACT_FORK_VERSION: forkVersion(
      '@module-federation/bridge-react',
    ),
    MODULE_FEDERATION_RUNTIME_FORK_VERSION: forkVersion(
      '@module-federation/runtime',
    ),
    MODULE_FEDERATION_MODERN_JS_V3_FORK_VERSION: forkVersion(
      '@module-federation/modern-js-v3',
    ),
    MODULE_FEDERATION_NODE_VERSION: targets['@module-federation/node'],
    ZEPHYR_RSPACK_PLUGIN_VERSION: targets['zephyr-rspack-plugin'],
    ZEPHYR_AGENT_VERSION: targets['zephyr-agent'],
    WRANGLER_VERSION: coordinatedTransitions.wrangler.to,
    TAILWIND_VERSION: targets.tailwindcss,
    RSBUILD_PLUGIN_TAILWINDCSS_VERSION:
      supplementalSourcePins['@rsbuild/plugin-tailwindcss'],
    EFFECT_VERSION: targets.effect,
    EFFECT_TSGO_VERSION: tsgo,
    TSRS_VERSION: coordinatedTransitions.tsrs.to,
    TYPESCRIPT_STABLE_VERSION: targets.typescript,
    OXLINT_VERSION: targets.oxlint,
    OXFMT_VERSION: targets.oxfmt,
    ULTRACITE_VERSION: targets.ultracite,
    LEFTHOOK_VERSION: supplementalSourcePins.lefthook,
    I18NEXT_VERSION: targets.i18next,
    MINIFLARE_VERSION: coordinatedTransitions.miniflare.to,
    WORKERD_VERSION: supplementalSourcePins.miniflareWorkerd,
    CLOUDFLARE_WORKERS_TYPES_VERSION:
      coordinatedTransitions['@cloudflare/workers-types'].to,
    NODE_FETCH_VERSION: supplementalSourcePins['node-fetch'],
    REACT_VERSION: targets.react,
    REACT_DOM_VERSION: targets['react-dom'],
    TYPES_NODE_VERSION: targets['@types/node'],
    TYPES_REACT_VERSION: targets['@types/react'],
    TYPES_REACT_DOM_VERSION: targets['@types/react-dom'],
    NODE_VERSION: toolchain.node,
    PNPM_VERSION: toolchain.pnpm,
    BRACES_FORK_VERSION: supplementalSourcePins['@bleedingdev/braces'],
    SHARP_VERSION: supplementalSourcePins.sharp,
    RSBUILD_PLUGIN_DTS_VERSION: targets['rsbuild-plugin-dts'],
    RSLIB_CORE_VERSION: targets['@rslib/core'],
  };
  const comparisonDependencies = JSON.parse(
    read(`${octane}typescript-compat/latest-build-package.json`),
  ).dependencies;
  const reviewed = {
    [`${generator}versions.ts`]: Object.entries(generatedVersions).map(
      ([name, version]) => `const ${name} = '${version}'`,
    ),
    // Current producer/sidecar correction inputs plus exact historical mask
    // controls. The inventory's repository/workspace flags are checked by its
    // owning patch synchronizer and repository-patches tests.
    [`${generator}patch-inventory.ts`]: [
      coordinatedTransitions['@tanstack/redact'].to.slice('npm:'.length),
      patch('@tanstack/router-core'),
      patch('@effect/opentelemetry'),
      ...[
        'bridge-react',
        'dts-plugin',
        'enhanced',
        'manifest',
        'modern-js-v3',
        'rspack',
        'runtime-core',
        'sdk',
        'node',
      ].map(name => patch(`@module-federation/${name}`)),
      'patches/@tanstack__router-core@1.171.34.patch',
      'patches/@tanstack__router-core@1.171.37.patch',
      'patches/@svgr__babel-plugin-transform-svg-component@8.0.0.patch',
      `patches/@tanstack__redact@${targets['@tanstack/redact']}.patch`,
    ],
    [`${octane}typescript-compat/qualify-followup.mjs`]: [
      `@tsrx+core@${comparisonDependencies['@tsrx/core']}`,
      `esrap@${comparisonDependencies.esrap}`,
      "assert(!Object.keys(bundled.metafile.inputs).some(n=>n.includes('@tsrx+core@0.5.5'))",
    ],
    // CfT CL 8508456 is an explicit browser-behavior prerequisite, not a
    // moving installer. The known-good CfT catalog confirms this exact build.
    'scripts/ultramodern-renderers/provision-browser.mjs': [
      `const rendererBrowserVersion = '${supplementalSourcePins.chromeForTesting.version}'`,
    ],
    [`${generator}policy.ts`]: [
      "'isomorphic-ws@5.0.0>ws:peer': '*'",
      "'ws@>=8.0.0 <8.23.0': '8.23.0'",
    ],
    [`${generator}mise-bootstrap.ts`]: [
      'https://github.com/jdx/mise/releases/download/v2026.11.8/',
      '180897216',
      '32b6abe844efa43d37d7ac4ed21d2ec41e9479d66feb19b0db8d2c548cd6e36d',
      '157476520',
      '0de1450dcc3f838e372e05e8c5231423760ad3f22d14275ef340bc0a250303ce',
      "hash.digest('hex') !== asset.sha256",
    ],
    [`${proof}constants.mjs`]: [`playwright@${targets.playwright}`],
    [registry]: ["const VERDACCIO_VERSION = '7.1.1", verdaccioIntegrity],
    [devcert]: ['devcert@1.2.3'],
    [`${proof}release-age-audit.mjs`]: ["const YAML_VERSION = '5.5.0"],
    'scripts/ultramodern-renderers/provision-agent-browser.mjs': [
      "const version = '0.43.0'",
      '8e69c9fb662514c9cf36e4911e94e913742ba066e55102486350e049dd847612',
      `https://github.com/vercel-labs/agent-browser/releases/download/v\${version}/agent-browser-linux-x64`,
    ],
    [sandpack]: [
      pnpmManager(toolchain.pnpm),
      `node: '>=${toolchain.node}'`,
      `pnpm: '>=${toolchain.pnpm}'`,
      ...Object.entries({
        effect: targets.effect,
        i18next: targets.i18next,
        tailwindcss: targets.tailwindcss,
        tsrs: coordinatedTransitions.tsrs.to,
      }).map(([name, version]) => `${name}: '${version}'`),
      `'@effect/tsgo': '${tsgo}'`,
      `'@types/node': '^${targets['@types/node']}'`,
    ],
    'scripts/ultramodern-node-policy/check-node-version.mjs': [
      `const MINIMUM_NODE_VERSION = '${toolchain.node}'`,
    ],
    // Compiler identities: snapshot TypeScript and the coordinated Effect tsgo.
    'packages/cli/builder/src/shared/tsgo.ts': [
      `typescript@${targets.typescript}`,
      `packageJson.version !== '${targets.typescript}'`,
    ],
    'packages/solutions/app-tools-extensions/src/server-compiler/tsgo.ts': [
      `typescript@${targets.typescript}`,
      `pkg.version !== '${targets.typescript}'`,
    ],
    'packages/solutions/app-tools-extensions/src/build-config/internal-effect-discovery.ts':
      [tsgoCheck[0], `const EFFECT_TSRS_PROVIDER_VERSION = '${tsgo}'`],
    'packages/toolkit/ultramodern-create/templates/workspace-scripts/ultramodern-compiler-prepare.mjs':
      tsgoCheck,
    'scripts/tsrs-dts/compiler.cjs': tsgoCheck,
    'packages/solutions/ultramodern-app-tools/src/renderers/react/redact-integration-plugin.ts':
      [coordinatedTransitions['@tanstack/redact'].to],
    [`${proof}package-cohort.mjs`]: [
      `'effect@${targets.effect}'`,
      `'@effect/opentelemetry@${targets['@effect/opentelemetry']}'`,
      `'tsrs@${coordinatedTransitions.tsrs.to}'`,
    ],
    // Producer templates bind identity to the authenticated descriptor.
    'scripts/ultramodern-artifacts/protocol.mjs': [
      `https://github.com/\${repository}/releases/download/\${producer.tag}/\${filename}`,
    ],
    'scripts/ultramodern-artifacts/transport.mjs': [
      `https://github.com/\${repository}/releases/download/\${tag}/\${asset.name}`,
    ],
    // Explicit Start requests have a URL grammar, not an independent version.
    // Packed renderer inputs themselves require the typed producer descriptor.
    'scripts/ultramodern-renderers/native-federation-inputs.mjs': [
      `https://github\\\\.com/BleedingDev/router/releases/download/\${prefix}-[a-f0-9]{12}/tanstack-\${basename}-[0-9]+\\\\.[0-9]+\\\\.[0-9]+(?:-[0-9A-Za-z.-]+)?\\\\.tgz$`,
    ],
    [`${generator}package-source.ts`]: [
      `https://github.com/${descriptor.producer?.repository}/releases/download/`,
      `\${releaseBase}\${producer.tag}/`,
      "tagPrefix: 'native-renderers'",
      "tagPrefix: 'support-artifacts'",
      `https://github.com/${descriptor.producer?.repository}/releases/download/support-artifacts-`,
    ],
    'scripts/ultramodern-production-readiness/tractor-downstream/cohort-install.mjs':
      [
        `https://github.com/${descriptor.producer?.repository}/releases/download/native-renderers-`,
      ],
    // Inputs the native run reconstructed into the admitted descriptor.
    'scripts/ultramodern-renderers/native-artifacts/recipes.mjs': [
      `\`\${candidateDirectory}/\${adapterFilename}\``,
      patch('@tanstack/router-core'),
      coreTarball,
    ],
    // Active runtime inputs come from the authenticated 0.20 handoff.
    'scripts/ultramodern-renderers/native-artifacts/source-qualification.mjs': [
      `pnpm: '${owningPnpm}'`,
      pnpmManager(owningPnpm),
    ],
    [`${octane}qualify.mjs`]: [
      patch('@tanstack/router-core'),
      coreTarball,
      `assetFilename('@tanstack/router-core', '${core}')`,
    ],
    [`${octane}shared-core-peer.mjs`]: [
      `const sharedCoreVersion = '${core}'`,
      `@octanejs/tanstack-router@${targets['@octanejs/tanstack-router']}`,
    ],
    [`${router}qualify.mjs`]: [pnpmManager(owningPnpm)],
    [`${router}reconstruct.mjs`]: [
      coreTarball,
      patch('@tanstack/router-core'),
      pnpmManager(owningPnpm),
      `assert.equal(publishedManifest.version, '${core}')`,
    ],
    // Support run 43912289696 attempt 1 qualified these inputs.
    [`${reactRouter}proof.mjs`]: [
      patch('@tanstack/router-core'),
      pnpmManager(toolchain.pnpm),
    ],
    [`${reactRouter}qualify.mjs`]: [
      `.pnpm/@tanstack+router-core@${core}/`,
      `strict exact required peer ${core}`,
    ],
    [`${reactRouter}support-adapter.mjs`]: [
      `@tanstack/router-core@${core} archive`,
      'reviewed patch ${inputs.corePatchSha256}',
    ],
    'scripts/ultramodern-support-artifacts/prepare-react-core.mjs': [
      coreTarball,
      patch('@tanstack/router-core'),
      `assert.equal(core.version, '${core}')`,
    ],
    // Support run 43934193068 attempt 2 qualified the corrected plugin with
    // the framework toolchain.
    'scripts/ultramodern-support-artifacts/dts-plugin.mjs': [
      `rsbuild-plugin-dts@${targets['rsbuild-plugin-dts']}`,
      pnpmManager(toolchain.pnpm),
    ],
    // Comment text only: patch provenance and a lockfile suffix example.
    'scripts/ultramodern-supply/verify-sidecars.mjs': [
      '`@bleedingdev/mf-runtime@2.9.2` reaches',
      '`2.2.11(core-js@3.50.0)`',
    ],
    // Comment text only: the measured run 43804632305 propagation incident.
    'scripts/ultramodern-publish/lib/prepare-bleedingdev-packages/registry-propagation.mjs':
      ['@bleedingdev/mf-dts-plugin@2.9.5 in run'],
    'scripts/ultramodern-publish/publish-sidecars.mjs': [
      "@bleedingdev/mf-dts-plugin@2.9.5's tarball",
    ],
    // Renderer sources select the activated native cohort.
    'packages/runtime/renderer-octane/src/manifest.ts': [
      `const OCTANE_RUNTIME_VERSION = '${targets.octane}'`,
      `const OCTANE_COMPILER_VERSION = '${targets['@octanejs/rspack-plugin']}'`,
    ],
    'packages/runtime/renderer-octane/src/plugin/profile.ts': nativeCohort.map(
      name => String(native(name).request),
    ),
    'packages/runtime/renderer-solid/src/manifest.ts': [
      `const SOLID_COMPILER_VERSION = '${targets['@solidjs/compiler']}'`,
    ],
    'packages/runtime/renderer-solid/src/plugin/profile.ts': [
      String(native('@tanstack/router-core').request),
    ],
    'tests/ultramodern-renderers/solid-admission/packages.mjs': [
      "ownerNativeArtifacts.packages['@tanstack/router-core']",
    ],
    'tests/ultramodern-renderers/solid-admission/run.mjs': [
      `router: '@modern-js/renderer-solid@${solidVersion}'`,
    ],
    'scripts/ultramodern-renderers/native-solid-generated.mjs': [
      `const solidVersion = '${targets['solid-js']}'`,
    ],
    'tests/ultramodern-renderers/i18n/navigation-tuple.mjs': [
      `const solidVersion = '${targets['solid-js']}'`,
    ],
  };
  return { reviewed, errors };
}

export function reviewedSourcePaths(read) {
  return Object.keys(reviewedSourcePins(read).reviewed).sort();
}

// These identities lack snapshot or producer evidence; owners must supply it.
const delegated = {
  'scripts/upstream-sync/reconcile-manifests.mjs':
    'supply reconciliation owner',
};
const evidenceOnly = {
  'packages/toolkit/ultramodern-create/src/locale/en.ts':
    'CLI help examples, not execution',
  'packages/toolkit/ultramodern-create/src/locale/zh.ts':
    'CLI help examples, not execution',
  [`${proof}resolution-parity.mjs`]: 'diagnostic text, not execution',
  'packages/runtime/renderer-core/src/data/codec.ts': 'wire protocol identity',
  'scripts/security/validate-github-workflows.mjs':
    'legacy workflow validation contract',
  'scripts/ultramodern-publish/verify-sidecar-consumer.mjs':
    'comment example, not executable default',
  'scripts/ultramodern-renderers/native-localized-navigation.mjs':
    'comment explaining dependency-resolved public build script',
};
const dependencyResolved = {
  [`${generator}zerops.ts`]:
    'renderMiseBootstrap supplies authenticated immutable assets; framework tools resolve from mise config',
  'scripts/check-dependencies.js':
    'pnpm exec resolves declared workspace dependency',
  [`${proof}acceptance-profile.mjs`]:
    'workspace Playwright and authenticated create/YAML runners; defaults checked separately',
  'scripts/ultramodern-production-readiness/tractor-downstream/main.mjs':
    'authenticated packed create command and workspace Playwright; no independent tool version',
};
const liveRendererAcceptance = file =>
  file.startsWith('tests/ultramodern-renderers/') &&
  !/(?:^|\/)(?:__tests__|fixtures?)(?:\/|$)|\.(?:test|spec)\./u.test(file);
const excluded = file =>
  !liveRendererAcceptance(file) &&
  /(?:^|\/)(?:__tests__|tests|fixtures|skills|document)(?:\/|$)|\.(?:test|spec)\./u.test(
    file,
  );

function pinTokens(source) {
  return [
    ...new Set(
      [
        ...source.matchAll(
          /(?<![\w./-])((?:@[a-z0-9_.-]+\/)?[a-z][a-z0-9_.-]*)@(\d+(?:\.\d+){2,3}(?:[-+][\w.-]+)?)/gu,
        ),
        ...source.matchAll(
          /\b(?:const|let)\s+(\w*[Vv][Ee][Rr][Ss][Ii][Oo][Nn]\w*)\s*=\s*['"](\d+(?:\.\d+){2,3}(?:[-+][\w.-]+)?)/gu,
        ),
        ...source.matchAll(
          /https:\/\/[^\s'"`]+\/releases\/download\/[^\s'"`]+/gu,
        ),
      ].map(match => match[0]),
    ),
  ].sort();
}

export function inspectSourcePins({ files, read }) {
  const { reviewed, errors } = reviewedSourcePins(read);
  const inventory = [];
  const fixtureEvidence = [];
  let executableFiles = 0;
  let fixtureFiles = 0;
  for (const file of [...files].sort()) {
    if (!/\.(?:[cm]?js|jsx|tsx?|sh|bash|zsh)$/u.test(file)) continue;
    // Do not treat the inventory's own expected strings as executable pins.
    if (file.startsWith('scripts/ultramodern-dependencies/')) continue;
    if (excluded(file)) {
      fixtureFiles++;
      const source = read(file);
      const pins = pinTokens(source);
      if (pins.length)
        fixtureEvidence.push({
          path: file,
          pins,
          status: 'test-fixture-or-history-review',
        });
      continue;
    }
    executableFiles++;
    const acceptanceOwner = liveRendererAcceptance(file)
      ? 'renderer acceptance owner: executable qualification inputs require latest-cohort review'
      : undefined;
    const source = read(file);
    const tokens = pinTokens(source);
    const invocations = source
      .split('\n')
      .flatMap((line, index) =>
        /\b(?:npx|dlx|(?:npm|pnpm) exec|curl|wget)\b|releases\/download/u.test(
          line,
        )
          ? [{ line: index + 1, text: line.trim() }]
          : [],
      );
    if (reviewed[file]) {
      for (const expected of reviewed[file])
        if (!source.includes(expected))
          errors.push(`${file}: missing reviewed source pin ${expected}`);
      // A reviewed file cannot acquire an unnoticed second installer/version.
      const allowed = pinTokens(reviewed[file].join('\n'));
      for (const token of tokens)
        if (!allowed.includes(token))
          errors.push(`${file}: unreviewed source pin ${token}`);
    } else if (
      tokens.length &&
      !delegated[file] &&
      !evidenceOnly[file] &&
      !acceptanceOwner
    ) {
      errors.push(`${file}: unclassified source pins ${tokens.join(', ')}`);
    }
    if (tokens.length || invocations.length || reviewed[file])
      inventory.push({
        path: file,
        status: reviewed[file]
          ? 'reviewed'
          : delegated[file] || acceptanceOwner
            ? 'owner-review'
            : evidenceOnly[file]
              ? 'evidence-only'
              : dependencyResolved[file]
                ? 'dependency-resolved'
                : 'invocation-review',
        reason:
          delegated[file] ??
          acceptanceOwner ??
          evidenceOnly[file] ??
          dependencyResolved[file],
        pins: tokens,
        invocations,
      });
  }
  for (const file of Object.keys(reviewed))
    if (!files.includes(file)) errors.push(`${file}: missing reviewed source`);
  return { executableFiles, fixtureFiles, fixtureEvidence, inventory, errors };
}

export function repositorySourceFiles(root) {
  const list = flags =>
    execFileSync('git', ['-C', root, 'ls-files', '-z', ...flags], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean);
  const deleted = new Set(list(['--deleted']));
  return [...new Set(list(['--cached', '--others', '--exclude-standard']))]
    .filter(file => !deleted.has(file))
    .sort();
}

export function sourcePinCoverage(root) {
  const files = repositorySourceFiles(root);
  const result = inspectSourcePins({
    files,
    read: file => fs.readFileSync(path.join(root, file), 'utf8'),
  });
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  const skillLock = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        'packages/toolkit/ultramodern-create/template-workspace/.codex/skills-lock.json',
      ),
      'utf8',
    ),
  );
  const auxiliary = auxiliarySourcePins(rootPackage, skillLock);
  const unresolved = [
    ...result.inventory.filter(item =>
      ['owner-review', 'invocation-review'].includes(item.status),
    ),
    ...auxiliary,
  ];
  return {
    ...result,
    queriedAt: sourcePinQueries,
    complete: result.errors.length === 0 && unresolved.length === 0,
    limitations: [
      'Lexical inventory, not a whole-program dataflow proof; dynamically assembled versions may need owner review.',
      'Reviewed means identity selection matches snapshot, coordinated-transition or activated native-descriptor evidence; consumer and hosted acceptance remain CI obligations.',
      'Unit-test/fixture/history pins are inventoried separately without rewriting; live renderer acceptance runners remain unresolved owner-review, not historical exclusions.',
    ],
    unresolved,
  };
}

export function auxiliarySourcePins(rootPackage, skillLock) {
  const unresolved = [];
  for (const group of ['rspress', 'rsbuild'])
    if (
      rootPackage.scripts?.[`update-${group}`] !==
      `npx --yes taze@21.3.0 major --include /${group}/ -w -r -l`
    )
      unresolved.push({
        path: 'package.json',
        reason: `update-${group} must select exact reviewed Taze 21.3.0`,
      });
  for (const expected of publicSources)
    if (
      !skillLock.sources?.some(
        source =>
          source.id === expected.id &&
          source.repository === `https://github.com/${expected.repository}` &&
          source.commit === expected.commit,
      )
    )
      unresolved.push({
        path: 'packages/toolkit/ultramodern-create/template-workspace/.codex/skills-lock.json',
        reason: `Skill source ${expected.id} must select its reviewed immutable commit`,
      });
  return unresolved;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const result = sourcePinCoverage(
    fileURLToPath(new URL('../../', import.meta.url)),
  );
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.errors.length, 0, result.errors.join('\n'));
}
