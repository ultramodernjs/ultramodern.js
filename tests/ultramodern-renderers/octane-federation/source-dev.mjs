#!/usr/bin/env node
// owned-temp-dir --run native-source-dev -- node source-dev.mjs <source-input.json>
// Source-only normal archive consumption. This entry never creates a release receipt.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  installedBin,
  recordPackedNativeFederationProcess,
  retirePackedNativeFederationInstaller,
  runPackedNativeFederationCommand,
} from '../../../scripts/ultramodern-renderers/native-federation-packed.mjs';

export { installedBin, recordPackedNativeFederationProcess };

const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
function normalRequest(request) {
  assert.equal(typeof request, 'string');
  if (request.startsWith('file:')) return;
  const selected = request.startsWith('npm:')
    ? request.slice(request.lastIndexOf('@') + 1)
    : request;
  assert(
    exactVersion.test(selected),
    'Use an exact normal registry or archive request',
  );
}
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};
const archivePath = request => {
  if (!request.startsWith('file:')) return undefined;
  const filename = request.slice('file:'.length);
  assert(path.isAbsolute(filename) && filename.endsWith('.tgz'));
  assert.equal(fs.realpathSync(filename), filename);
  assert(fs.statSync(filename).isFile());
  return filename;
};
const archiveDigest = filename =>
  createHash('sha512').update(fs.readFileSync(filename)).digest('base64');

export function sourceDevManifest(manifest, input) {
  const select = name => {
    const request = input.packageRequests[name];
    assert.equal(
      typeof request,
      'string',
      `Missing installed request: ${name}`,
    );
    assert(
      !/^(?:workspace:|link:|catalog:)/u.test(request),
      `${name} must use a normal archive or exact registry request`,
    );
    normalRequest(request);
    return request;
  };
  const dependencies = Object.fromEntries(
    Object.keys(manifest.dependencies ?? {}).map(name => [name, select(name)]),
  );
  for (const name of [
    'typescript',
    '@types/node',
    '@module-federation/runtime',
    '@modern-js/federation-runtime',
    '@tanstack/router-core',
  ])
    if (input.packageRequests[name]) dependencies[name] = select(name);
  return { ...manifest, dependencies };
}

export function readSourceDevContext(filename) {
  assert(!process.env.ULTRAMODERN_MF_PACKED_CONTEXT);
  assert(!process.env.ULTRAMODERN_MF_DEV_OBSERVATIONS);
  assert(process.env.OWNED_TEMP_DIR, 'Run source dev through owned-temp-dir');
  const input = readJson(filename);
  assert.equal(input.schemaVersion, 1);
  for (const field of ['packageRequests', 'frameworkOverrides', 'allowBuilds'])
    assert(input[field] && typeof input[field] === 'object');
  assert(path.isAbsolute(input.pnpmExecutable));
  assert.equal(fs.realpathSync(input.storeDir), input.storeDir);
  const externalRoot = input.virtualStoreRoot;
  assert(
    typeof externalRoot === 'string' &&
      path.isAbsolute(externalRoot) &&
      path.resolve(externalRoot) === externalRoot,
    'Provide a fresh physical external virtualStoreRoot for this operation',
  );
  assert.equal(
    fs.realpathSync(path.dirname(externalRoot)),
    path.dirname(externalRoot),
  );
  assert(
    !fs.existsSync(externalRoot),
    'Never reuse another operation dependency tree',
  );
  const workRoot = fs.realpathSync(process.env.OWNED_TEMP_DIR);
  for (const label of ['remote', 'host'])
    assert(
      !fs.existsSync(path.join(workRoot, label)),
      'Source dev apps must belong to a fresh owned invocation',
    );
  assert(!inside(workRoot, externalRoot), 'Use an external virtual store');
  const archives = new Map();
  for (const [name, request] of Object.entries({
    ...input.packageRequests,
    ...input.frameworkOverrides,
  })) {
    normalRequest(request);
    const archive = archivePath(request);
    if (archive) {
      const metadata = JSON.parse(
        execFileSync('tar', ['-xOf', archive, 'package/package.json'], {
          encoding: 'utf8',
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        }),
      );
      assert.equal(
        metadata.name,
        name,
        'The local archive must retain its real package name',
      );
      archives.set(name, {
        archive,
        integrity: `sha512-${archiveDigest(archive)}`,
        metadata,
      });
    }
  }
  for (const name of [
    'octane',
    '@octanejs/tanstack-router',
    '@octanejs/rspack-plugin',
  ])
    assert(
      archives.has(name),
      `Missing exact native candidate archive: ${name}`,
    );
  assert.equal(typeof input.browserExecutable, 'string');
  assert(fs.statSync(input.browserExecutable).isFile());
  return {
    ...input,
    workRoot,
    externalRoot,
    externalCreated: false,
    archives,
    installations: [],
    installerWitnesses: [],
  };
}

export async function prepareSourceDevApp({
  directory,
  context,
  registerArtifact,
  signal,
}) {
  const appRoot = fs.realpathSync(directory);
  assert(inside(context.workRoot, appRoot));
  const label = path.basename(appRoot);
  assert(['host', 'remote'].includes(label));
  if (!context.externalCreated) {
    fs.mkdirSync(context.externalRoot);
    context.externalCreated = true;
  }
  const virtualStore = path.join(
    context.externalRoot,
    label,
    'node_modules/.pnpm',
  );
  const externalDependencies = path.dirname(virtualStore);
  fs.mkdirSync(path.dirname(externalDependencies), { recursive: true });
  await registerArtifact(externalDependencies, 'dependencies');
  const manifestPath = path.join(appRoot, 'package.json');
  const manifest = sourceDevManifest(readJson(manifestPath), context);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const policyPath = path.join(appRoot, 'pnpm-workspace.yaml');
  fs.writeFileSync(
    policyPath,
    stringifyYaml({
      packages: ['.'],
      packageImportMethod: 'clone-or-copy',
      minimumReleaseAge: 1440,
      minimumReleaseAgeStrict: true,
      minimumReleaseAgeIgnoreMissingTime: false,
      minimumReleaseAgeExclude: [],
      overrides: context.frameworkOverrides,
      allowBuilds: context.allowBuilds,
    }),
  );
  await registerArtifact(path.join(appRoot, 'node_modules'), 'dependencies');
  assert.equal(
    execFileSync(context.pnpmExecutable, ['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
    }).trim(),
    '12.11.2',
  );
  const witness = path.join(appRoot, 'source-mf-install-process.json');
  context.installerWitnesses.push(witness);
  await runPackedNativeFederationCommand(
    context.pnpmExecutable,
    [
      'install',
      '--store-dir',
      context.storeDir,
      '--virtual-store-dir',
      virtualStore,
      '--config.package-import-method=clone-or-copy',
      '--config.minimum-release-age=1440',
      '--config.minimum-release-age-strict=true',
      '--config.minimum-release-age-ignore-missing-time=false',
    ],
    {
      cwd: appRoot,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !/^(?:npm|pnpm)_config_minimum_release_age_exclude$/iu.test(key),
          ),
        ),
        NODE_PATH: '',
        NODE_OPTIONS: '',
        NODE_ENV: 'development',
        CI: 'true',
      },
      witness,
      signal,
      log: path.join(appRoot, 'source-mf-install.log'),
    },
  );
  const policy = parseYaml(fs.readFileSync(policyPath, 'utf8'));
  assert.equal(policy.minimumReleaseAge, 1440);
  assert.equal(policy.minimumReleaseAgeStrict, true);
  assert.equal(policy.minimumReleaseAgeIgnoreMissingTime, false);
  assert.deepEqual(policy.minimumReleaseAgeExclude ?? [], []);
  assert.deepEqual(policy.overrides, context.frameworkOverrides);
  assert.equal(fs.realpathSync(virtualStore), virtualStore);
  const installed = {};
  for (const name of Object.keys(manifest.dependencies)) {
    const owner = fs.realpathSync(path.join(appRoot, 'node_modules', name));
    assert(
      inside(virtualStore, owner),
      `${name} escaped the independent installed store`,
    );
    const metadata = readJson(path.join(owner, 'package.json'));
    const expected = context.archives.get(name);
    if (expected) {
      assert.equal(
        `sha512-${archiveDigest(expected.archive)}`,
        expected.integrity,
      );
      assert.deepEqual(
        metadata,
        expected.metadata,
        `${name} differs from its normal archive`,
      );
    } else {
      const selected =
        context.frameworkOverrides[name] ?? manifest.dependencies[name];
      normalRequest(selected);
      const alias = selected.startsWith('npm:');
      const separator = selected.lastIndexOf('@');
      assert.equal(metadata.name, alias ? selected.slice(4, separator) : name);
      assert.equal(
        metadata.version,
        alias ? selected.slice(separator + 1) : selected,
      );
    }
    installed[name] = {
      owner,
      name: metadata.name,
      version: metadata.version,
      ...(expected
        ? { archive: expected.archive, integrity: expected.integrity }
        : {}),
    };
  }
  const compilerOwner = fs.realpathSync(
    createRequire(
      path.join(installed['@octanejs/rspack-plugin'].owner, 'package.json'),
    ).resolve('octane/compiler'),
  );
  assert(
    inside(installed.octane.owner, compilerOwner),
    'The compiler must belong to the same installed native runtime archive',
  );
  context.installations.push({
    appRoot,
    virtualStore,
    compilerOwner,
    packages: installed,
  });
}

export function cleanupSourceDevContext(context) {
  if (context.externalCreated) {
    // Creation above was exclusive and this path belongs only to this invocation.
    assert.equal(fs.realpathSync(context.externalRoot), context.externalRoot);
    fs.rmSync(context.externalRoot, { recursive: true });
    context.externalCreated = false;
  }
}

export async function retireSourceDevInstallers(context) {
  const errors = [];
  for (const witness of context.installerWitnesses) {
    try {
      if (fs.existsSync(witness))
        await retirePackedNativeFederationInstaller(readJson(witness));
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, 'Source dev installers did not retire');
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert.equal(
    process.argv.length,
    3,
    'Usage: source-dev.mjs <source-input.json>',
  );
  assert(!process.env.ULTRAMODERN_MF_PACKED_CONTEXT);
  assert(!process.env.ULTRAMODERN_MF_DEV_OBSERVATIONS);
  process.env.ULTRAMODERN_MF_SOURCE_DEV_CONTEXT = fs.realpathSync(
    process.argv[2],
  );
  process.env.NODE_PATH = '';
  process.env.NODE_OPTIONS = '';
  process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`;
  // Finish evaluating this helper before the proof imports it for preparation.
  setImmediate(() => {
    void import('./dev.mjs').catch(error => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    });
  });
}
