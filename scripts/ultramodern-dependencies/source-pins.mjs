import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { targets } from './snapshot.mjs';
import { publicSources } from './sync-skill-sources.mjs';

// Supplemental, bounded lookups; the full dependency snapshot is not requeried.
export const sourcePinQueries = {
  start: '2026-11-16T02:26:55.917Z',
  end: '2026-11-16T02:27:52.603Z',
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
const reviewed = {
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
    "packageManager: 'pnpm@12.21.0'",
    "node: '>=26.13.1'",
    "pnpm: '>=12.21.0'",
    ...Object.entries({
      effect: targets.effect,
      i18next: targets.i18next,
      tailwindcss: targets.tailwindcss,
      tsrs: '0.25.0-ts7.1.0-beta',
    }).map(([name, version]) => `${name}: '${version}'`),
    "'@effect/tsgo': '0.69.0'",
    `'@types/node': '^${targets['@types/node']}'`,
  ],
};

// These identities are inventoried, not silently claimed current. Their owners
// must qualify replacements, including source/integrity and native contracts.
const delegated = {
  'scripts/ultramodern-support-artifacts/prepare-react-core.mjs':
    'support owner: authenticated native corrected-core qualification input; hosted publication and adoption pending',
  'scripts/ultramodern-artifacts/protocol.mjs':
    'artifact transport owner: fixed native/support policies bind concrete source and asset URLs; hosted acceptance pending',
  'scripts/ultramodern-artifacts/transport.mjs':
    'artifact transport owner: authenticated source/run/tag and exact immutable asset inventory; hosted acceptance pending',
  'scripts/ultramodern-renderers/native-artifacts/protocol.mjs':
    'native producer owner: closed authenticated asset transport',
  'scripts/ultramodern-renderers/native-artifacts/transport.mjs':
    'native producer owner: closed authenticated asset transport',
  'scripts/ultramodern-renderers/native-artifacts/recipes.mjs':
    'native producer owner: corrected cohort still requires full owning qualification',
  'scripts/ultramodern-renderers/native-artifacts/source-qualification.mjs':
    'native producer owner: owning router/adapter pnpm 11.21.0, not framework toolchain',
  'scripts/ultramodern-renderers/octane-corrections/qualify.mjs':
    'Octane owner: corrected router source and packed qualification',
  'scripts/ultramodern-renderers/octane-corrections/reconstruct.mjs':
    'Octane owner: authenticated adapter patch identity',
  'scripts/ultramodern-renderers/octane-corrections/regenerate-shared-core-peer.mjs':
    'Octane owner: deterministic distinct shared-core peer correction; hosted acceptance pending',
  'scripts/ultramodern-renderers/octane-corrections/shared-core-peer.mjs':
    'Octane owner: exact required shared core peer; hosted consumer singleton acceptance pending',
  'scripts/ultramodern-renderers/octane-corrections/qualify-runtime.mjs':
    'Octane owner: full runtime/Rspack owning qualification and inventory completeness pending',
  'scripts/ultramodern-renderers/octane-corrections/oxc-latest/qualify.mjs':
    'Octane owner: actual corrected archive and OXC 0.24 source/packed qualification passed; hosted consumer adoption pending',
  'scripts/ultramodern-renderers/octane-corrections/typescript-compat/qualify-followup.mjs':
    'Octane owner: baseline and corrected stable TypeScript cohort comparison',
  'scripts/ultramodern-renderers/router-corrections/qualify.mjs':
    'router owner: owning source build uses pnpm 11.21.0',
  'scripts/ultramodern-renderers/router-corrections/reconstruct.mjs':
    'router owner: authenticated correction and owning build toolchain',
  'scripts/ultramodern-renderers/react-router-corrections/proof.mjs':
    'React router owner: actual latest package and corrected shared-core install qualification pending',
  'scripts/ultramodern-renderers/react-router-corrections/qualify.mjs':
    'React router owner: actual packed routing runtime and types qualification pending',
  'scripts/ultramodern-renderers/react-router-corrections/support-adapter.mjs':
    'React router owner: reviewed shared-core qualification input; hosted support distribution and consumer acceptance pending',
  [`${generator}package-source.ts`]:
    'generator owner: exact support artifact URL identity checks; hosted descriptor and generated consumer acceptance pending',
  'scripts/ultramodern-renderers/solid-corrections/qualify.mjs':
    'Solid owner: authenticated RC22 native compiler/runtime and repository serializer policy qualified; installed browser/worker/downstream acceptance pending',
  'scripts/ultramodern-renderers/solid-corrections/qualify-held-read.mjs':
    'Solid owner: portable source and actual transported archive qualification; hosted corrected distribution and consumer acceptance pending',
  'packages/cli/builder/src/shared/tsgo.ts': 'compiler owner',
  'packages/runtime/renderer-octane/src/manifest.ts': 'renderer owner',
  'packages/runtime/renderer-solid/src/manifest.ts': 'renderer owner',
  'packages/runtime/renderer-octane/src/plugin/profile.ts':
    'renderer owner: corrected immutable source URLs',
  'packages/runtime/renderer-solid/src/plugin/profile.ts':
    'renderer owner: corrected immutable source URLs',
  'scripts/check-renderer-router-core.cjs':
    'renderer owner: corrected router source URL',
  'scripts/ultramodern-renderers/native-federation-inputs.mjs':
    'renderer owner: source URL authentication contract',
  'packages/server/utils/src/compilers/tsgo.ts': 'compiler owner',
  'packages/solutions/app-tools-extensions/src/build-config/internal-effect-discovery.ts':
    'compiler owner',
  'packages/solutions/ultramodern-app-tools/src/renderers/react/redact-integration-plugin.ts':
    'supply owner',
  'packages/toolkit/ultramodern-create/src/ultramodern-workspace/patch-inventory.ts':
    'generator/supply owner',
  'packages/toolkit/ultramodern-create/src/ultramodern-workspace/versions.ts':
    'generator owner',
  'packages/toolkit/ultramodern-create/templates/workspace-scripts/ultramodern-compiler-prepare.mjs':
    'compiler owner',
  'scripts/tsrs-dts/compiler.cjs': 'compiler owner',
  'scripts/ultramodern-node-policy/check-node-version.mjs': 'Node policy owner',
  [`${proof}package-cohort.mjs`]: 'release cohort owner',
  'scripts/ultramodern-renderers/provision-browser.mjs':
    'renderer owner: CfT fix identity; not a normal latest replacement',
  'scripts/ultramodern-supply/verify-sidecars.mjs': 'supply owner',
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
  'scripts/security/braces-correction.mjs': 'authenticated correction identity',
  'scripts/security/braces-installed-graph.mjs':
    'authenticated correction identity',
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
  const inventory = [];
  const fixtureEvidence = [];
  const errors = [];
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
      'Native/compiler/supply/renderer identities are reported, not accepted by this guard.',
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
