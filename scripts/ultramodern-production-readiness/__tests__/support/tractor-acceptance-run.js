const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse: parseYaml } = require('yaml');

// Runs the real Tractor downstream acceptance producer against a strict release
// manifest, faking only the process and browser boundaries it drives. Every
// report the recorder tests read is therefore produced by the producer itself,
// so a report shape change on either side fails a test instead of a release.

const baselineRevision = 'cb6974e31bc919c86ae5bb86044409f0f1e036d5';
const verticalIds = ['checkout', 'decide', 'explore'];
const product = { detailName: 'Example', sku: 'EX-01', slug: 'example' };

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

// Raw evidence the downstream `scripts/proof-public-workflow.mjs` writes.
function visibleWorkflowEvidence() {
  const pass = fields => ({ status: 'pass', ...fields });
  return {
    assertions: [
      pass({ route: '/en/tractors', type: 'catalog' }),
      pass({
        route: `/en/tractors/${product.slug}?sku=${product.sku}`,
        type: 'product-detail',
      }),
      pass({
        cartLine: {
          id: product.sku,
          name: product.detailName,
          slug: product.slug,
        },
        route: `/en/cart?sku=${product.sku}`,
        type: 'cart-product-match',
      }),
      pass({ route: '/en/checkout', type: 'checkout' }),
      pass({ route: '/en/checkout/thank-you', type: 'thank-you' }),
    ],
    product,
    status: 'pass',
    ui: pass({
      accessibility: pass({
        controls: [
          ['link', 'Add to basket'],
          ['link', 'Checkout'],
          ['textbox', 'Name'],
          ['textbox', 'Email'],
          ['textbox', 'Delivery address'],
          ['button', 'Place order'],
          ['heading', 'Thank you for your order'],
        ].map(([role, name]) => pass({ name, role })),
      }),
      computedStyles: pass({
        samples: [
          'product-grid',
          'product-page',
          'cart-page',
          'checkout-page',
          'thanks-page',
        ].map(subject => ({
          display: 'block',
          opacity: 1,
          subject,
          visibility: 'visible',
        })),
      }),
      dom: pass({
        boundaries: [
          ['explore', './ProductGrid'],
          ['decide', './ProductPage'],
          ['checkout', './CartPage'],
          ['checkout', './CheckoutPage'],
          ['checkout', './ThanksPage'],
        ].map(([boundaryId, expose]) => ({
          boundaryId,
          expose,
          visible: true,
        })),
      }),
      runtime: pass({
        interactions: [
          'open-product',
          'add-to-basket',
          'begin-checkout',
          'place-order',
        ].map(type => pass({ type })),
      }),
    }),
  };
}

// What the Node proof's server-rendered SSR validation returns.
function nodeSsrEvidence() {
  const assertions = types => types.map(type => ({ status: 'pass', type }));
  const result = (appId, noJavaScriptType) => {
    const shell = appId === 'shell-super-app';
    const httpAssertionTypes = [
      'ssr-route',
      'ui-marker-html',
      'css-root-marker',
      'mf-manifest',
      'mf-manifest-json',
      'locale-json',
    ];
    const noJavaScriptAssertionTypes = [
      'no-js-ssr-css-root-marker',
      'no-js-stylesheet-href-dedupe',
      'no-js-ssr-failed-responses',
      noJavaScriptType,
      ...(shell ? ['no-js-shell-composition-boundary'] : []),
    ];
    const noJavaScriptAssertions = assertions(noJavaScriptAssertionTypes);
    if (shell) {
      const find = type =>
        noJavaScriptAssertions.find(assertion => assertion.type === type);
      find('no-js-distributed-ssr-route').route = '/en/tractors/example';
      Object.assign(find('no-js-shell-composition-boundary'), {
        declaredRemoteIds: verticalIds,
        matchedRemoteBoundaries: verticalIds.map(remoteId => ({
          boundaryId: remoteId,
          remoteId,
        })),
        triedRemoteBoundaries: verticalIds.map(remoteId => ({
          matchedBoundaryId: remoteId,
          remoteId,
          triedBoundaryIds: [
            remoteId,
            `vertical${remoteId[0].toUpperCase()}${remoteId.slice(1)}`,
          ],
        })),
      });
    }
    return {
      appId,
      httpAssertions: assertions(httpAssertionTypes),
      httpAssertionTypes,
      noJavaScriptAssertions,
      noJavaScriptAssertionTypes,
    };
  };
  return {
    appCount: verticalIds.length + 1,
    distributedSsrRoute: '/en/tractors/example',
    results: [
      ...verticalIds.map(appId => result(appId, 'no-js-ssr-ui-marker')),
      result('shell-super-app', 'no-js-distributed-ssr-route'),
    ],
    status: 'pass',
  };
}

// A clean Tractor checkout whose one framework dependency is catalog-managed.
function writeTractorWorkspace(workspace) {
  writeJson(path.join(workspace, 'package.json'), {
    packageManager: 'pnpm@11.24.0',
    dependencies: { '@modern-js/i18n-utils': 'catalog:ultramodern' },
  });
  writeJson(path.join(workspace, 'tsconfig.base.json'), {
    compilerOptions: {
      strict: true,
      plugins: [{ name: '@effect/language-service' }],
    },
  });
  fs.writeFileSync(
    path.join(workspace, '.mise.toml'),
    '[tools]\nnode = "26.7.0"\npnpm = "11.24.0"\n',
  );
  fs.writeFileSync(
    path.join(workspace, 'pnpm-workspace.yaml'),
    "catalogs:\n  ultramodern:\n    '@modern-js/i18n-utils': npm:@bleedingdev/modern-js-i18n-utils@0.0.0-previous\ntrustPolicyExclude:\n  - tsrs@0.18.0-ts7.1.0-dev.20260929\n",
  );
  writeJson(path.join(workspace, 'ultramodern.compiler-trust.json'), [
    'tsrs@0.18.0-ts7.1.0-dev.20260929',
  ]);
  writeJson(path.join(workspace, 'topology/reference-topology.json'), {
    verticals: verticalIds.map(id => ({ api: true, id, kind: 'vertical' })),
  });
}

// What `pnpm install` leaves behind for the exact release cohort.
function installReleaseCohort(workspace, release) {
  writeJson(
    path.join(
      workspace,
      'node_modules/@modern-js/ultramodern-create/release-cohort.json',
    ),
    release.cohortProjection.value,
  );
  writeJson(
    path.join(workspace, 'node_modules/@modern-js/i18n-utils/package.json'),
    {
      name: release.aliases['@modern-js/i18n-utils'],
      version: release.release.version,
    },
  );
}

async function runTractorAcceptanceFixture({
  manifestPath,
  mode = 'published',
  nodeSsr = nodeSsrEvidence(),
  root,
}) {
  const [{ runTractorDownstreamAcceptance }, { readReleaseManifest }] =
    await Promise.all([
      import('../../tractor-downstream/main.mjs'),
      import(
        '../../../ultramodern-publish/lib/source-create-proof/release-manifest.mjs'
      ),
    ]);
  const release = readReleaseManifest({ manifestPath });
  const workspace = path.join(root, 'tractor');
  const outPath = path.join(root, 'tractor-downstream-acceptance.json');
  const releaseAgePolicyPath = path.join(root, 'release-age-policy.json');
  const pnpmExecutable = path.join(root, 'bin/pnpm');
  writeTractorWorkspace(workspace);
  writeJson(releaseAgePolicyPath, {
    entries: [],
    schema: 'bleedingdev.ultramodern.release-age-exceptions',
    schemaVersion: 2,
  });

  const runImpl = (command, args) => {
    if (command === 'node' && args[0] === '--version') {
      return release.tools.node;
    }
    if (
      command === pnpmExecutable &&
      args.includes('dlx') &&
      !args.includes('ultramodern')
    ) {
      const generated = args[args.indexOf('dlx') + 3];
      fs.mkdirSync(generated, { recursive: true });
      writeJson(path.join(generated, 'package.json'), {
        devDependencies: {
          effect: '4.0.0',
          '@effect/opentelemetry': '4.0.0',
          '@effect/tsgo': '0.53.1',
          react: '19.3.0',
          'react-dom': '19.3.0',
          '@types/react': '19.3.0',
          '@types/react-dom': '19.3.0',
        },
      });
      fs.writeFileSync(
        path.join(generated, 'pnpm-workspace.yaml'),
        `overrides: {}\nminimumReleaseAge: 1440\nminimumReleaseAgeStrict: true\nminimumReleaseAgeIgnoreMissingTime: false\ntrustPolicy: no-downgrade\ntrustPolicyIgnoreAfter: 1440\nminimumReleaseAgeExclude:\n${[
          ...release.packages.map(item => `${item.targetName}@${item.version}`),
          ...(release.sidecars?.packages ?? []).map(
            item => `${item.name}@${item.version}`,
          ),
        ]
          .sort()
          .map(selector => `  - ${JSON.stringify(selector)}`)
          .join('\n')}\n`,
      );
    }
    if (command === 'git') {
      return args[0] === 'rev-parse' ? baselineRevision : '';
    }
    if (command === 'pnpm' && args[0] === 'exec' && args[1] === 'node') {
      return pnpmExecutable;
    }
    if (command === pnpmExecutable && args[0] === '--version') {
      return release.tools.pnpm;
    }
    if (command === pnpmExecutable && args.includes('--no-frozen-lockfile')) {
      // This producer needs no compiler trust exception. Remove the baseline's
      // old approval before the very first upgrade install, not during sync.
      assert.deepEqual(
        parseYaml(
          fs.readFileSync(path.join(workspace, 'pnpm-workspace.yaml'), 'utf8'),
        ).trustPolicyExclude,
        [],
      );
      installReleaseCohort(workspace, release);
    }
    if (command === pnpmExecutable && args[0] === 'node:proof') {
      writeJson(
        path.join(
          workspace,
          '.codex/reports/node-backend-federation-proof/proof.json',
        ),
        {
          results: verticalIds.map(appId => ({ appId, status: 'pass' })),
          status: 'pass',
        },
      );
    }
    if (command === process.execPath) {
      writeJson(args[args.indexOf('--out') + 1], visibleWorkflowEvidence());
    }
    return '';
  };
  const runtime = baseUrl => async () => ({ baseUrl, stop: async () => {} });

  const registry =
    mode === 'published'
      ? { registryUrl: 'https://registry.npmjs.org/' }
      : {
          registryEnv: {
            PNPM_CONFIG_TRUST_POLICY_EXCLUDE: JSON.stringify(
              release.packages
                .map(item => `${item.targetName}@${item.version}`)
                .sort(),
            ),
            npm_config_cache: path.join(root, 'npm-cache'),
            npm_config_userconfig: path.join(root, '.npmrc'),
          },
          registryUrl: 'http://127.0.0.1:4873/',
        };
  await runTractorDownstreamAcceptance(
    {
      manifestPath,
      mode,
      outPath,
      releaseAgePolicyPath,
      workspace,
      ...registry,
    },
    {
      runImpl,
      startNodeProofImpl: async () => ({
        ...(await runtime('http://127.0.0.1:3000')()),
        ssrEvidence: nodeSsr,
      }),
      startWorkerdProofImpl: runtime('http://127.0.0.1:8787'),
    },
  );
  return { baselineRevision, reportPath: outPath };
}

module.exports = { nodeSsrEvidence, runTractorAcceptanceFixture };
