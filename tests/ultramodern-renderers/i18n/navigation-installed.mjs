#!/usr/bin/env node
// owned-temp-dir --run navigation-installed -- node navigation-installed.mjs \
//   --cohort-dir <prepared-cohort> --store-dir <external-store> --pnpm <pnpm> \
//   --expected-native-tuples <accepted-native-tuples.json>
// A source-only lane can use --toolchain-root <installed-checkout> for harness
// dependencies. Application code always comes from the authenticated cohort.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { rendererFeatureBinding } from '../../../scripts/ultramodern-renderers/feature-gates.mjs';
import {
  localizedNavigationBrowserRequest,
  localizedNavigationInputs,
  localizedNavigationRegistry,
  localizedNavigationSharedCheckCommand,
  verifyLocalizedNavigationCore,
} from '../../../scripts/ultramodern-renderers/native-localized-navigation.mjs';
import { assertLocalizedNavigation } from './navigation-browser.mjs';
import { localizedNavigationFixture } from './navigation-fixtures.mjs';
import {
  assertInstalledNavigationTuple,
  installedPackage,
} from './navigation-tuple.mjs';

const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const writeJson = (filename, value) =>
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
const { values } = parseArgs({
  options: {
    'cohort-dir': { type: 'string' },
    'store-dir': { type: 'string' },
    pnpm: { type: 'string' },
    'toolchain-root': { type: 'string' },
    'browser-executable': { type: 'string' },
    'expected-native-tuples': { type: 'string' },
    'browser-dependency-root': { type: 'string' },
    'proof-context': { type: 'string' },
    'proof-result': { type: 'string' },
    'work-dir': { type: 'string' },
    renderers: { type: 'string', default: 'solid,octane' },
  },
});
for (const option of ['cohort-dir', 'store-dir', 'pnpm'])
  assert(values[option], `Missing --${option}`);
assert(process.env.OWNED_TEMP_DIR, 'Run through owned-temp-dir');
const temporary = fs.realpathSync(process.env.OWNED_TEMP_DIR);
const workRoot = path.resolve(
  values['work-dir'] ?? path.join(temporary, 'navigation-installed'),
);
const relativeWork = path.relative(temporary, workRoot);
assert(
  relativeWork &&
    !relativeWork.startsWith('..') &&
    !path.isAbsolute(relativeWork),
  'Navigation output must belong to the active release lease',
);
assert(!fs.existsSync(workRoot), 'Navigation proof output must be new');
const toolchain = fs.realpathSync(
  values['toolchain-root'] ??
    fileURLToPath(new URL('../../../', import.meta.url)),
);
const toolRequire = createRequire(path.join(toolchain, 'package.json'));
const browserRequire = localizedNavigationBrowserRequest(
  values['browser-dependency-root'] ?? path.join(toolchain, 'tests'),
);
const harness = relative =>
  import(pathToFileURL(path.join(toolchain, relative)));
const { parse: parseYaml, stringify: stringifyYaml } = toolRequire('yaml');
const { readReleaseManifest } = await harness(
  'scripts/ultramodern-publish/lib/source-create-proof/release-manifest.mjs',
);
const { readVerifiedPackageArtifactBytes, inspectNpmTarball } = await harness(
  'scripts/ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs',
);
const { startEphemeralRegistry } = await harness(
  'scripts/ultramodern-publish/lib/source-create-proof/runtime-proof/registry.mjs',
);
const { readCohort, checkInstalledCohort } = await harness(
  'scripts/ultramodern-renderers/installed-cohort.mjs',
);
const { releaseAgeExemptions } = await harness(
  'scripts/ultramodern-production-readiness/published-create-proof/release-age-audit.mjs',
);
const { captureReleaseAgeExclusions, assertReleaseAgeExclusionsUnchanged } =
  await harness('scripts/ultramodern-renderers/release-age-policy.mjs');
const { registerOwnedRoot } = await harness(
  'scripts/ultramodern-production-readiness/react-rsc-worker-proof/lifecycle.mjs',
);
const {
  installedBin,
  runPackedNativeFederationCommand,
  retirePackedNativeFederationInstaller,
  recordPackedNativeFederationProcess,
  verifyPackedNativeFederationInputs,
} = await harness('scripts/ultramodern-renderers/native-federation-packed.mjs');
const { launchServer, ready, reservePort } = await harness(
  'scripts/ultramodern-production-readiness/renderer-mf-lifecycle-proof/runtime.mjs',
);

const renderers = values.renderers.split(',');
// The integrator derives this input from the exact accepted native cohort.
// Keep the separate original Solid and Octane router request identities.
const proofContext = values['proof-context']
  ? readJson(values['proof-context'])
  : undefined;
assert(
  proofContext || values['expected-native-tuples'],
  'Missing --expected-native-tuples or --proof-context',
);
assert.equal(Boolean(values['proof-result']), Boolean(proofContext));
const expectedNativeTuples =
  proofContext?.expectedNativeTuples ??
  readJson(values['expected-native-tuples']);
assert(renderers.length > 0 && new Set(renderers).size === renderers.length);
for (const renderer of renderers)
  assert(
    ['solid', 'octane'].includes(renderer),
    `Unknown renderer ${renderer}`,
  );
const releaseDir = fs.realpathSync(values['cohort-dir']);
const release = readReleaseManifest({
  manifestPath: path.join(releaseDir, 'manifest.json'),
});
const cohort = readCohort(release.manifestPath);
if (proofContext) {
  assert.deepEqual(proofContext.binding, rendererFeatureBinding(cohort));
  assert.match(proofContext.nonce, /^[a-f0-9-]{36}$/u);
  assert(['source', 'published'].includes(proofContext.mode));
  assert.deepEqual(renderers, ['solid', 'octane']);
  const acceptedInputs = localizedNavigationInputs(
    release,
    proofContext.nativeInputs,
  );
  assert.deepEqual(acceptedInputs.expectedNativeTuples, expectedNativeTuples);
  assert.equal(
    proofContext.solidUsesNativeCore,
    acceptedInputs.solidUsesNativeCore,
  );
  const resultPath = path.resolve(values['proof-result']);
  const relative = path.relative(temporary, resultPath);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.equal(
    fs.realpathSync(path.dirname(resultPath)),
    path.dirname(resultPath),
  );
  assert(
    !resultPath.startsWith(`${workRoot}${path.sep}`),
    'Navigation evidence must outlive proof cleanup',
  );
  assert(!fs.existsSync(resultPath), 'Navigation result must be new');
}
const pnpm = fs.realpathSync(values.pnpm);
assert.equal(
  execFileSync(pnpm, ['--version'], {
    encoding: 'utf8',
    timeout: 15_000,
  }).trim(),
  release.tools.pnpm,
  'The consumer must use the cohort package manager',
);
const storeDir = fs.realpathSync(values['store-dir']);
assert(
  !storeDir.startsWith(`${temporary}${path.sep}`),
  'Use the external store',
);
const { allowBuilds } = parseYaml(
  fs.readFileSync(path.join(toolchain, 'pnpm-workspace.yaml'), 'utf8'),
);
const artifact = name => {
  const value = release.packages.find(item => item.sourceName === name);
  assert(value, `Candidate cohort omits ${name}`);
  return value;
};
const request = name => {
  const item = artifact(name);
  return `npm:${item.targetName}@${item.version}`;
};
const i18nArtifact = artifact('@modern-js/i18n-runtime-extensions');
const i18nPackage = JSON.parse(
  inspectNpmTarball(
    readVerifiedPackageArtifactBytes(i18nArtifact, i18nArtifact.artifactPath),
  ).fileContents.get('package.json'),
);
const i18next = i18nPackage.devDependencies?.i18next;
assert(
  /^\d+\.\d+\.\d+$/u.test(i18next),
  'The candidate must pin i18next exactly',
);
const owner = `renderer-navigation-${process.pid}`;
const registration = registerOwnedRoot({
  workDir: workRoot,
  owner,
  ownerPid: process.pid,
});
const controller = new AbortController();
const interrupt = () =>
  controller.abort(new Error('Navigation proof interrupted'));
for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.once(event, interrupt);
const witnesses = [];
const servers = [];
let registry;
let browser;
let failure;
const observations = {};
try {
  // A release lane uses its existing source or published registry. Never replay
  // source archives while claiming published-consumer acceptance.
  registry = proofContext
    ? localizedNavigationRegistry(
        proofContext.mode,
        proofContext.registryUrl,
        process.env,
        release.targetScope,
      )
    : await startEphemeralRegistry({
        release,
        releaseDir,
        rootDir: path.join(workRoot, 'registry'),
        storeDir,
      });
  const env = {
    ...process.env,
    ...registry.env,
    NODE_PATH: '',
    CI: 'true',
    npm_config_store_dir: storeDir,
    pnpm_config_store_dir: storeDir,
    npm_config_package_import_method: 'clone-or-copy',
    pnpm_config_package_import_method: 'clone-or-copy',
    pnpm_config_minimum_release_age: '1440',
    pnpm_config_minimum_release_age_strict: 'true',
    pnpm_config_minimum_release_age_ignore_missing_time: 'false',
    pnpm_config_minimum_release_age_exclude: JSON.stringify(
      releaseAgeExemptions(release, {
        policyPath: path.join(
          toolchain,
          'scripts/ultramodern-publish/release-age-exceptions-2026-08-10.json',
        ),
      }),
    ),
  };
  const command = async (executable, args, cwd, label) => {
    const witness = path.join(workRoot, `${label}-process.json`);
    const log = path.join(workRoot, `${label}.log`);
    witnesses.push(witness);
    try {
      await runPackedNativeFederationCommand(executable, args, {
        witness,
        cwd,
        env,
        log,
        signal: controller.signal,
      });
    } catch (error) {
      if (fs.existsSync(log))
        process.stderr.write(fs.readFileSync(log, 'utf8').slice(-16_000));
      throw error;
    }
  };
  const generatorRoot = path.join(workRoot, 'generator');
  fs.mkdirSync(generatorRoot);
  writeJson(path.join(generatorRoot, 'package.json'), {
    private: true,
    dependencies: {
      [release.createPackage.targetName]: release.createPackage.version,
    },
  });
  fs.writeFileSync(
    path.join(generatorRoot, 'pnpm-workspace.yaml'),
    stringifyYaml({
      packages: ['.'],
      allowBuilds,
      packageImportMethod: 'clone-or-copy',
      minimumReleaseAge: 1440,
      minimumReleaseAgeStrict: true,
      minimumReleaseAgeIgnoreMissingTime: false,
      minimumReleaseAgeExclude: JSON.parse(
        env.pnpm_config_minimum_release_age_exclude,
      ),
    }),
  );
  const generatorPolicy = captureReleaseAgeExclusions(generatorRoot, {
    release,
  });
  await command(pnpm, ['install'], generatorRoot, 'generator-install');
  assertReleaseAgeExclusionsUnchanged(generatorPolicy);
  checkInstalledCohort({ appRoot: generatorRoot, cohort });
  const generatorRequire = createRequire(
    path.join(generatorRoot, 'package.json'),
  );
  const sdk = generatorRequire(
    `${release.createPackage.targetName}/ultramodern-workspace`,
  );
  const generatorPackage = path.join(
    generatorRoot,
    'node_modules',
    release.createPackage.targetName,
  );
  const createBin = path.join(
    generatorPackage,
    readJson(path.join(generatorPackage, 'package.json')).bin[
      'ultramodern-create'
    ],
  );
  const puppeteer = browserRequire('puppeteer');
  const executablePath =
    values['browser-executable'] ??
    browserRequire('playwright').chromium.executablePath();
  assert(
    fs.existsSync(executablePath),
    `Browser is not installed: ${executablePath}`,
  );
  browser = await puppeteer.launch({ headless: true, executablePath });
  const closeBrowser = () => {
    void browser.close();
  };
  controller.signal.addEventListener('abort', closeBrowser, { once: true });
  try {
    for (const renderer of renderers) {
      controller.signal.throwIfAborted();
      const workspaceRoot = path.join(workRoot, renderer);
      const result = await sdk.generateUltramodernWorkspace({
        targetDir: workspaceRoot,
        packageName: `navigation-${renderer}`,
        renderer,
        generateAgentFiles: false,
        enableTailwind: false,
        modernVersion: release.release.version,
        packageSource: {
          strategy: 'install',
          modernPackageVersion: release.release.version,
          registry: registry.registryUrl,
          aliasScope: release.targetScope,
          aliasPackageNamePrefix: 'modern-js-',
        },
      });
      const shell = result.createdApps.find(app => app.kind === 'shell');
      assert(shell, 'Public generator omitted the shell');
      const appRoot = path.resolve(workspaceRoot, shell.directory);
      assert(
        appRoot.startsWith(`${workspaceRoot}${path.sep}`),
        'Generated shell escapes workspace',
      );
      // This is the standard authored fixture-copy stage before the build.
      // Generator metadata, public scripts and dependency selections remain.
      fs.rmSync(path.join(appRoot, 'src'), { recursive: true });
      for (const [relative, source] of Object.entries(
        localizedNavigationFixture(renderer),
      )) {
        const filename = path.join(appRoot, relative);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, source);
      }
      const manifest = readJson(path.join(appRoot, 'package.json'));
      writeJson(path.join(appRoot, 'package.json'), {
        ...manifest,
        dependencies: {
          ...manifest.dependencies,
          '@modern-js/i18n-runtime-extensions': request(
            '@modern-js/i18n-runtime-extensions',
          ),
          i18next,
        },
      });
      const consumerPolicy = captureReleaseAgeExclusions(workspaceRoot, {
        release,
      });
      await command(pnpm, ['install'], workspaceRoot, `${renderer}-install`);
      assertReleaseAgeExclusionsUnchanged(consumerPolicy);
      checkInstalledCohort({ appRoot, cohort });
      const nativeTuple = assertInstalledNavigationTuple({
        appRoot,
        renderer,
        expected: expectedNativeTuples[renderer],
      });
      if (proofContext && renderer === 'octane')
        verifyPackedNativeFederationInputs(appRoot, proofContext.nativeInputs);
      if (proofContext && renderer === 'solid') {
        const adapter = installedPackage(appRoot, '@modern-js/renderer-solid');
        const core = installedPackage(
          adapter.directory,
          '@tanstack/router-core',
        );
        verifyLocalizedNavigationCore(
          core.directory,
          proofContext.nativeInputs['@tanstack/router-core'],
          proofContext.solidUsesNativeCore,
        );
      }
      process.stdout.write(
        `Installed ${renderer} navigation tuple: ${JSON.stringify(nativeTuple)}\n`,
      );
      await command(
        process.execPath,
        [createBin, 'ultramodern', 'sync-delivery-unit'],
        workspaceRoot,
        `${renderer}-sync`,
      );
      await command(
        pnpm,
        [...localizedNavigationSharedCheckCommand],
        workspaceRoot,
        `${renderer}-shared-typecheck`,
      );
      await command(
        process.execPath,
        [installedBin(appRoot), 'build'],
        appRoot,
        `${renderer}-build`,
      );
      await command(
        pnpm,
        ['run', 'typecheck'],
        appRoot,
        `${renderer}-typecheck`,
      );
      const port = await reservePort();
      const origin = `http://127.0.0.1:${port}`;
      const server = launchServer(process.execPath, installedBin(appRoot), {
        cwd: appRoot,
        env: { ...env, PORT: String(port), [shell.portEnv]: String(port) },
        log: path.join(workRoot, `${renderer}-serve.log`),
        signal: controller.signal,
      });
      servers.push(server);
      const witness = path.join(workRoot, `${renderer}-serve-process.json`);
      recordPackedNativeFederationProcess(witness, server.child.pid);
      witnesses.push(witness);
      await ready(server, `${origin}/en/about`, controller.signal);
      const page = await browser.newPage();
      let checks;
      try {
        checks = await assertLocalizedNavigation(page, origin);
      } finally {
        await page.close();
      }
      await server.stop();
      servers.pop();
      assertReleaseAgeExclusionsUnchanged(consumerPolicy);
      observations[renderer] = {
        strictGeneratedTypes: true,
        nativeTuple: Object.fromEntries(
          ['routerCore', 'history'].map(key => [
            key,
            { name: nativeTuple[key].name, version: nativeTuple[key].version },
          ]),
        ),
        checks,
      };
      process.stdout.write(
        `PASS ${renderer}: generated candidate strict types and native localized browser navigation\n`,
      );
    }
  } finally {
    controller.signal.removeEventListener('abort', closeBrowser);
  }
} catch (error) {
  failure = error;
} finally {
  const cleanup = [];
  const attempt = async operation => {
    try {
      await operation();
    } catch (error) {
      cleanup.push(error);
    }
  };
  for (const server of servers.reverse()) await attempt(() => server.stop());
  if (browser) await attempt(() => browser.close());
  if (registry?.stop) await attempt(() => registry.stop());
  for (const witness of witnesses)
    if (fs.existsSync(witness))
      await attempt(() =>
        retirePackedNativeFederationInstaller(readJson(witness)),
      );
  for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.removeListener(event, interrupt);
  if (!cleanup.length) {
    if (registration.status === 'registered')
      await attempt(() =>
        execFileSync(
          'disk-guardian-artifacts',
          ['release', workRoot, '--owner', owner],
          { stdio: 'pipe' },
        ),
      );
    if (!cleanup.length) fs.rmSync(workRoot, { recursive: true });
  }
  if (cleanup.length)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...cleanup],
      `Navigation cleanup failed; retained ${workRoot}`,
    );
}
if (failure) throw failure;

if (proofContext) {
  fs.writeFileSync(
    values['proof-result'],
    `${JSON.stringify({ schemaVersion: 1, binding: rendererFeatureBinding(cohort), nonce: proofContext.nonce, mode: proofContext.mode, registryUrl: registry.registryUrl, renderers: observations }, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
}
