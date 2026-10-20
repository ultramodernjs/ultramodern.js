import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectNpmTarball } from '../ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import { readReleaseManifest } from '../ultramodern-publish/lib/source-create-proof/release-manifest.mjs';
import {
  digestFile,
  normalizeRegistryUrl,
  rendererAcceptanceRegistryUrl,
  rendererFeatureBinding,
} from './feature-gates.mjs';
import {
  readCohort,
  readInstalledPackageFiles,
  verifyInstalledPackage,
} from './installed-cohort.mjs';
import { nativeFederationArtifacts } from './native-federation-inputs.mjs';
import {
  retirePackedNativeFederationInstaller,
  runPackedNativeFederationCommand,
} from './native-federation-packed.mjs';

const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const writeJson = (filename, value) =>
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
const identity = (name, version) => {
  assert.match(
    version,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u,
    `${name} must have an exact accepted version`,
  );
  return { name, version };
};
export const localizedNavigationChecks = Object.freeze([
  'nativeMasks',
  'intentPreload',
  'history',
  'relativeNavigation',
  'blockers',
  'documentLifetime',
  'noRuntimeErrors',
]);

// Native shared packages export authored source and declare typecheck, not a
// build script. Use their generated public script rather than pnpm exec.
export const localizedNavigationSharedCheckCommand = Object.freeze([
  '--filter',
  './packages/*',
  'run',
  'typecheck',
]);

/** Derive expected identities from authenticated packs, never a historical recipe. */
export function localizedNavigationInputs(release, nativeInputs) {
  const renderer = name => {
    const item = release.packages.find(
      item => item.sourceName === `@modern-js/renderer-${name}`,
    );
    assert(item, `Missing packed ${name} renderer`);
    return item;
  };
  const artifacts = nativeFederationArtifacts(renderer('octane'));
  const manifests = {};
  for (const [name, artifact] of Object.entries(artifacts)) {
    const input = nativeInputs?.[name];
    assert(
      input,
      `Localized navigation requires authenticated native input ${name}`,
    );
    assert.equal(input.request, artifact.request);
    assert.equal(input.integrity, artifact.integrity);
    assert(path.isAbsolute(input.archivePath));
    assert.equal(fs.realpathSync(input.archivePath), input.archivePath);
    const bytes = fs.readFileSync(input.archivePath);
    assert.equal(
      `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      artifact.integrity,
    );
    const manifest = inspectNpmTarball(bytes).packageJson;
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, artifact.version);
    manifests[name] = manifest;
  }
  const core = manifests['@tanstack/router-core'];
  assert.equal(
    manifests['@octanejs/tanstack-router'].peerDependencies?.[
      '@tanstack/router-core'
    ],
    core.version,
  );
  const octane = {
    routerCore: identity(core.name, core.version),
    history: identity(
      '@tanstack/history',
      core.dependencies?.['@tanstack/history'],
    ),
  };
  const solid = renderer('solid').packageJson;
  const coreRequest = solid.dependencies?.['@tanstack/router-core'];
  const solidUsesNativeCore =
    coreRequest === artifacts['@tanstack/router-core'].request;
  const expectedNativeTuples = {
    solid: {
      routerCore: identity(
        '@tanstack/router-core',
        solidUsesNativeCore ? core.version : coreRequest,
      ),
      history: identity(
        '@tanstack/history',
        solid.dependencies?.['@tanstack/history'],
      ),
    },
    octane,
  };
  return { expectedNativeTuples, nativeInputs, solidUsesNativeCore };
}

/** A fresh nonce and exact registry mode bind both independently executed browsers. */
export function verifyLocalizedNavigationResult(result, expected) {
  assert.equal(result?.schemaVersion, 1);
  assert.equal(result.nonce, expected.nonce);
  assert.deepEqual(result.binding, expected.binding);
  assert.equal(result.mode, expected.mode);
  assert.equal(
    normalizeRegistryUrl(result.registryUrl),
    normalizeRegistryUrl(expected.registryUrl),
  );
  assert.deepEqual(Object.keys(result.renderers).sort(), ['octane', 'solid']);
  for (const renderer of ['solid', 'octane']) {
    const actual = result.renderers[renderer];
    assert.equal(
      actual.strictGeneratedTypes,
      true,
      `${renderer} strict generated types did not pass`,
    );
    assert.deepEqual(
      actual.nativeTuple,
      expected.expectedNativeTuples[renderer],
    );
    for (const check of localizedNavigationChecks)
      assert.equal(
        actual.checks[check],
        true,
        `${renderer} did not execute ${check}`,
      );
  }
  return {
    solidNavigation: true,
    octaneNavigation: true,
    strictGeneratedTypes: true,
    acceptedNativeTuples: true,
    nativeMasks: true,
    blockers: true,
    documentLifetime: true,
  };
}

/** Puppeteer resolves only through its declared, directly installed test owner. */
export function localizedNavigationBrowserRequest(ownerRoot) {
  const owner = fs.realpathSync(ownerRoot);
  const manifest = readJson(path.join(owner, 'package.json'));
  assert(
    manifest.dependencies?.puppeteer || manifest.devDependencies?.puppeteer,
    'Navigation browser owner must declare Puppeteer',
  );
  const packageRoot = fs.realpathSync(
    path.join(owner, 'node_modules/puppeteer'),
  );
  assert.equal(
    readJson(path.join(packageRoot, 'package.json')).name,
    'puppeteer',
  );
  const request = createRequire(path.join(owner, 'package.json'));
  const entry = fs.realpathSync(request.resolve('puppeteer'));
  const relative = path.relative(packageRoot, entry);
  assert(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    'Navigation browser must resolve from its directly installed Puppeteer',
  );
  return request;
}

/** Keep the source userconfig and npm default; only its cohort scope is ephemeral. */
export function localizedNavigationRegistry(
  mode,
  registryUrl,
  environment,
  targetScope,
) {
  const selected = rendererAcceptanceRegistryUrl(mode, {
    sourceRegistry: { registryUrl },
    publishedRegistryUrl: registryUrl,
  });
  if (mode === 'published')
    return {
      registryUrl: selected,
      env: {
        npm_config_registry: selected,
        pnpm_config_registry: selected,
      },
    };
  const userconfig = environment.npm_config_userconfig;
  assert(
    userconfig && fs.existsSync(userconfig),
    'Source navigation needs its inherited registry userconfig',
  );
  const scoped = fs
    .readFileSync(userconfig, 'utf8')
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.startsWith(`@${targetScope}:registry=`));
  assert.equal(
    scoped.length,
    1,
    'Source navigation needs one cohort registry selection',
  );
  assert.equal(
    normalizeRegistryUrl(scoped[0].slice(scoped[0].indexOf('=') + 1)),
    selected,
    'Source navigation userconfig selects another cohort registry',
  );
  return { registryUrl: selected, env: {} };
}

/** Equal package versions do not make registry and fork archive requests equal. */
export function verifyLocalizedNavigationCore(
  directory,
  nativeInput,
  solidUsesNativeCore,
) {
  const bytes = fs.readFileSync(nativeInput.archivePath);
  assert.equal(
    `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    nativeInput.integrity,
  );
  const packed = inspectNpmTarball(bytes);
  const files = packed.files
    .map(file => ({
      path: file.path,
      size: file.size,
      sha256: createHash('sha256')
        .update(packed.fileContents.get(file.path))
        .digest('hex'),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (solidUsesNativeCore)
    return verifyInstalledPackage(directory, {
      targetName: packed.packageJson.name,
      files,
    });
  const actual = readInstalledPackageFiles(directory).map(file => ({
    path: file.path,
    size: file.byteLength,
    sha256: file.sha256,
  }));
  assert.notDeepEqual(
    actual,
    files,
    'Solid registry core unexpectedly contains the fork archive bytes',
  );
}

/** Preserve a failed command together with any failed process retirement. */
export async function runLocalizedNavigationCommand(
  command,
  args,
  options,
  {
    run = runPackedNativeFederationCommand,
    retire = retirePackedNativeFederationInstaller,
  } = {},
) {
  const failures = [];
  try {
    await run(command, args, options);
  } catch (error) {
    failures.push(error);
    try {
      if (fs.existsSync(options.log))
        process.stderr.write(
          fs.readFileSync(options.log, 'utf8').slice(-16_000),
        );
    } catch (diagnosticError) {
      failures.push(diagnosticError);
    }
  }
  try {
    if (fs.existsSync(options.witness)) await retire(readJson(options.witness));
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(
      failures,
      'Navigation command and process cleanup failed',
    );
}

/** Run the original public-generator navigation proof against this acceptance registry. */
export async function runPackedLocalizedNavigationProof(context) {
  assert(['source', 'published'].includes(context.acceptanceMode));
  assert(context.binding && context.receiptPath && context.storeDir);
  const release = readReleaseManifest({ manifestPath: context.manifestPath });
  assert.deepEqual(
    rendererFeatureBinding(readCohort(release.manifestPath)),
    context.binding,
  );
  const inputs = localizedNavigationInputs(release, context.nativeInputs);
  const ownerRoot = fs.realpathSync(process.env.OWNED_TEMP_DIR);
  for (const filename of [context.receiptPath, context.log, context.workDir]) {
    assert(path.isAbsolute(filename));
    const relative = path.relative(ownerRoot, filename);
    assert(
      relative && !relative.startsWith('..') && !path.isAbsolute(relative),
      'Navigation output must belong to the active release lease',
    );
    assert.equal(
      fs.realpathSync(path.dirname(filename)),
      path.dirname(filename),
    );
    assert(!fs.existsSync(filename), 'Navigation output must be new');
  }
  const proofPath = `${context.receiptPath}.proof.json`;
  const inputPath = `${context.receiptPath}.input.json`;
  const witness = `${context.receiptPath}.process.json`;
  const input = {
    ...inputs,
    binding: context.binding,
    nonce: randomUUID(),
    mode: context.acceptanceMode,
    registryUrl: rendererAcceptanceRegistryUrl(context.acceptanceMode, {
      sourceRegistry: { registryUrl: context.registryUrl },
      publishedRegistryUrl: context.registryUrl,
    }),
  };
  writeJson(inputPath, input);
  const script = fileURLToPath(
    new URL(
      '../../tests/ultramodern-renderers/i18n/navigation-installed.mjs',
      import.meta.url,
    ),
  );
  await runLocalizedNavigationCommand(
    process.execPath,
    [
      script,
      '--cohort-dir',
      path.dirname(release.manifestPath),
      '--store-dir',
      context.storeDir,
      '--pnpm',
      context.pnpmExecutable,
      '--browser-dependency-root',
      context.browserDependencyRoot,
      '--browser-executable',
      context.browserExecutable,
      '--proof-context',
      inputPath,
      '--proof-result',
      proofPath,
      '--work-dir',
      context.workDir,
    ],
    {
      witness,
      cwd: path.dirname(release.manifestPath),
      env: { ...context.env, OWNED_TEMP_DIR: ownerRoot },
      log: context.log,
      signal: context.signal,
    },
  );
  const checks = verifyLocalizedNavigationResult(readJson(proofPath), input);
  const receipt = {
    status: 'passed',
    binding: context.binding,
    checks,
    evidence: [proofPath, inputPath, witness, context.log].map(filename => ({
      path: filename,
      sha256: digestFile(filename),
    })),
  };
  writeJson(context.receiptPath, receipt);
  return receipt;
}
