import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { assertCohortResolutionProvenance } from '../../../../../../scripts/ultramodern-production-readiness/published-create-proof/acceptance-profile.mjs';
import {
  assertBootstrapReleaseAgePolicy,
  resolveCreatePackage,
} from '../../../../../../scripts/ultramodern-production-readiness/published-create-proof/package-cohort.mjs';
import {
  inspectNpmTarball,
  readVerifiedPackageArtifactBytes,
} from '../../../../../../scripts/ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import { readReleaseManifest } from '../../../../../../scripts/ultramodern-publish/lib/source-create-proof/release-manifest.mjs';
import { startEphemeralRegistry } from '../../../../../../scripts/ultramodern-publish/lib/source-create-proof/runtime-proof/registry.mjs';

const minimumNode = '26.13.1';
const renderers = ['react', 'solid', 'octane'];
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../',
);

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

/** The caller retains its active disk-guardian ownership through downstream acceptance. */
export function assertConsumerRoot(consumerRoot) {
  assert.ok(path.isAbsolute(consumerRoot), 'consumerRoot must be absolute');
  const stat = fs.lstatSync(consumerRoot);
  assert.ok(
    stat.isDirectory() && !stat.isSymbolicLink(),
    'consumerRoot must be an existing ordinary leased directory',
  );
  assert.equal(
    fs.readdirSync(consumerRoot).length,
    0,
    'consumerRoot must be empty',
  );
  const real = fs.realpathSync.native(consumerRoot);
  assert.equal(
    inside(fs.realpathSync.native(sourceRoot), real),
    false,
    'Bare consumer must be outside the source worktree',
  );
  for (let current = real; ; current = path.dirname(current)) {
    assert.equal(
      fs.existsSync(path.join(current, 'node_modules')),
      false,
      `Ambient node_modules ancestor is forbidden: ${current}`,
    );
    if (path.dirname(current) === current) break;
  }
  return real;
}

export function createBareManifest(release) {
  assert.match(release.tools.pnpm, /^\d+\.\d+\.\d+$/u);
  return {
    name: 'ultramodern-bare-generator-proof',
    private: true,
    type: 'module',
    engines: { node: `>=${minimumNode}` },
    packageManager: `pnpm@${release.tools.pnpm}`,
    dependencies: {
      [release.createPackage.targetName]: release.createPackage.version,
    },
  };
}

/** Install exceptions belong to the authenticated bootstrap, never authored YAML. */
export function createBareInstallSetup(createPackage, allowBuilds, runtimeEnv) {
  const policy = assertBootstrapReleaseAgePolicy(createPackage);
  assert.ok(
    allowBuilds &&
      typeof allowBuilds === 'object' &&
      !Array.isArray(allowBuilds),
    'Bare install requires the repository dependency build approval policy',
  );
  const env = { ...runtimeEnv };
  const ageSettings = new Set([
    'minimumreleaseage',
    'minimumreleaseageexclude',
    'minimumreleaseagestrict',
    'minimumreleaseageignoremissingtime',
  ]);
  for (const name of Object.keys(env)) {
    const setting = /^(?:npm|pnpm)[_-]config[_-](.+)$/iu.exec(name)?.[1];
    if (setting && ageSettings.has(setting.replace(/[_-]/gu, '').toLowerCase()))
      delete env[name];
  }
  Object.assign(env, {
    pnpm_config_minimum_release_age: String(policy.minimumReleaseAge),
    pnpm_config_minimum_release_age_exclude: JSON.stringify(
      policy.minimumReleaseAgeExclude,
    ),
    pnpm_config_minimum_release_age_strict: String(
      policy.minimumReleaseAgeStrict,
    ),
    pnpm_config_minimum_release_age_ignore_missing_time: String(
      policy.minimumReleaseAgeIgnoreMissingTime,
    ),
  });
  const workspaceBytes = Buffer.from(
    stringifyYaml({
      packages: ['.'],
      allowBuilds,
      minimumReleaseAge: policy.minimumReleaseAge,
      minimumReleaseAgeStrict: policy.minimumReleaseAgeStrict,
      minimumReleaseAgeIgnoreMissingTime:
        policy.minimumReleaseAgeIgnoreMissingTime,
    }),
  );
  return { env, bootstrapReleaseAgePolicy: policy, workspaceBytes };
}

export function assertBareWorkspacePolicyUnchanged(file, authoredBytes) {
  const stat = fs.lstatSync(file);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink(),
    'Bare workspace policy must remain an ordinary file',
  );
  const installedBytes = fs.readFileSync(file);
  assert.ok(
    installedBytes.equals(authoredBytes),
    'Install changed the strict exception-free bare workspace policy',
  );
  return {
    path: file,
    authoredSha256: hash(authoredBytes),
    installedSha256: hash(installedBytes),
    byteLength: installedBytes.length,
    unchangedByInstall: true,
  };
}

function runtimeEnv(qualifiedNode, registryEnv = {}) {
  return {
    ...process.env,
    ...registryEnv,
    PATH: `${path.dirname(qualifiedNode)}${path.delimiter}${process.env.PATH ?? ''}`,
    npm_node_execpath: qualifiedNode,
    NODE_ENV: 'development',
    NODE_OPTIONS: '',
    NODE_PATH: '',
    FORCE_COLOR: '0',
    CODESMITH_ENV: 'production',
  };
}

function run(command, args, { cwd, env, input, logFile }) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (logFile) fs.writeFileSync(logFile, output);
  if (result.error || result.status !== 0) {
    throw new Error(
      `${path.basename(command)} exited ${result.status ?? 'before start'}; see ${logFile ?? 'runtime probe output'}`,
      { cause: result.error },
    );
  }
  return { output: output.trim(), sha256: hash(output), status: result.status };
}

export function assertInstalledGeneratorBytes(item, packageRoot) {
  const accepted = inspectNpmTarball(
    readVerifiedPackageArtifactBytes(item, item.artifactPath),
  );
  for (const [relative, bytes] of accepted.fileContents) {
    const installed = path.join(packageRoot, relative);
    assert.ok(
      fs.lstatSync(installed).isFile(),
      `Installed generator file must be regular: ${relative}`,
    );
    assert.equal(
      hash(fs.readFileSync(installed)),
      hash(bytes),
      `Installed generator bytes differ from authenticated tarball: ${relative}`,
    );
  }
  return {
    fileCount: accepted.fileCount,
    fileListSha256: accepted.fileListSha256,
  };
}

const packageProbe = `
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const {targetName, version} = JSON.parse(fs.readFileSync(0, 'utf8'));
const require = createRequire(path.join(process.cwd(), 'package.json'));
let current = path.dirname(require.resolve(targetName + '/ultramodern-workspace'));
while (path.dirname(current) !== current) {
  const filename = path.join(current, 'package.json');
  if (fs.existsSync(filename)) {
    const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (manifest.name === targetName) {
      if (manifest.version !== version) throw new Error('Installed generator version differs');
      const bin = manifest.bin?.['ultramodern-create'];
      if (typeof bin !== 'string') throw new Error('Installed generator bin missing');
      const resolvedBin = path.resolve(current, bin);
      if (!fs.existsSync(resolvedBin)) throw new Error('Installed generator bin bytes missing');
      process.stdout.write(JSON.stringify({packageRoot:current, bin:resolvedBin, manifestSha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(filename)).digest('hex')}));
      break;
    }
  }
  current = path.dirname(current);
}
if (path.dirname(current) === current) throw new Error('Installed generator package root missing');
`;

const artifactProbe = `
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const {packageRoot, workspaceRoot, renderer} = JSON.parse(fs.readFileSync(0, 'utf8'));
const require = createRequire(path.join(packageRoot, 'package.json'));
const {assertUltramodernBuildArtifact} = require('@modern-js/backend-federation-contracts');
const topology = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'topology/reference-topology.json'), 'utf8'));
const directory = topology.shell.path;
if (typeof directory !== 'string' || path.isAbsolute(directory)) throw new Error('Generated shell directory invalid');
const appRoot = path.resolve(workspaceRoot, directory);
const relative = path.relative(workspaceRoot, appRoot);
if (!relative || relative === '..' || relative.startsWith('../')) throw new Error('Generated app escaped workspace');
const artifact = JSON.parse(fs.readFileSync(path.join(appRoot, 'shared/ultramodern-build.json'), 'utf8'));
assertUltramodernBuildArtifact(artifact);
if (artifact.surfaces.ui?.rendererIdentity.renderer !== renderer) throw new Error('Generated renderer differs');
if (fs.existsSync(path.join(workspaceRoot, 'node_modules')) || fs.existsSync(path.join(appRoot, 'node_modules'))) throw new Error('App dependencies installed before generation proof');
process.stdout.write(JSON.stringify({workspaceRoot,appRoot,renderer,identity:artifact.surfaces.ui.rendererIdentity,profile:artifact.surfaces.ui.rendererProfile,routerBindings:artifact.surfaces.ui.routerBindings}));
`;

const conformanceGeneration = `
import fs from 'node:fs';
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
const {generateUltramodernWorkspace} = await import(payload.targetName + '/ultramodern-workspace');
await generateUltramodernWorkspace(payload.options);
`;

export function assertConformanceOutputRoot({
  consumerRoot,
  bareRoot,
  outputRoot,
}) {
  const consumerStat = fs.lstatSync(consumerRoot);
  assert.ok(
    consumerStat.isDirectory() && !consumerStat.isSymbolicLink(),
    'Conformance consumer must remain an ordinary leased directory',
  );
  const canonicalConsumerRoot = fs.realpathSync.native(consumerRoot);
  const canonicalBareRoot = fs.realpathSync.native(bareRoot);
  assert.ok(
    path.isAbsolute(outputRoot) &&
      path.dirname(outputRoot) === canonicalConsumerRoot,
    'Conformance output must be a direct sibling under the canonical consumer lease',
  );
  assert.equal(
    inside(canonicalBareRoot, outputRoot),
    false,
    'Generated app must not inherit bare generator node_modules',
  );
  let outputStat;
  try {
    outputStat = fs.lstatSync(outputRoot);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  assert.equal(outputStat, undefined, 'Conformance output already exists');
}

/** Only the installed package's public APIs run; authored overlays precede its sole capture. */
export function generateInstalledConformance({
  release,
  bareRoot,
  installed,
  qualifiedNode,
  env,
  consumerRoot,
  outputRoot,
  renderer,
  overlays,
  logFile,
}) {
  assert.ok(renderers.includes(renderer));
  assertConformanceOutputRoot({ consumerRoot, bareRoot, outputRoot });
  run(qualifiedNode, ['--input-type=module', '--eval', conformanceGeneration], {
    cwd: bareRoot,
    env,
    logFile,
    input: JSON.stringify({
      targetName: release.createPackage.targetName,
      options: {
        targetDir: outputRoot,
        packageName: `generated-${renderer}`,
        renderer,
        modernVersion: release.release.version,
        generateAgentFiles: false,
        packageSource: {
          strategy: 'install',
          modernPackageVersion: release.release.version,
          aliasScope: release.targetScope,
          aliasPackageNamePrefix: 'modern-js-',
        },
        overlays,
      },
    }),
  });
  return JSON.parse(
    run(qualifiedNode, ['--input-type=module', '--eval', artifactProbe], {
      cwd: bareRoot,
      env,
      input: JSON.stringify({
        packageRoot: installed.packageRoot,
        workspaceRoot: outputRoot,
        renderer,
      }),
    }).output,
  );
}

/** Keeps the authenticated registry alive only for the caller's bounded consumer work. */
export async function withBareGeneratorProof(
  options,
  consume = ({ report }) => report,
) {
  const consumerRoot = assertConsumerRoot(options.consumerRoot);
  assert.ok(
    path.isAbsolute(options.qualifiedNode),
    'qualifiedNode must be absolute',
  );
  const release = readReleaseManifest({ manifestPath: options.manifestPath });
  const createPackage = resolveCreatePackage(release);
  const baseEnv = runtimeEnv(options.qualifiedNode);
  const observedNode = run(
    options.qualifiedNode,
    ['--print', 'process.versions.node'],
    { cwd: consumerRoot, env: baseEnv },
  ).output;
  assert.equal(
    observedNode,
    minimumNode,
    'Proof must execute the actual minimum Node runtime',
  );
  assert.equal(
    run('pnpm', ['--version'], { cwd: consumerRoot, env: baseEnv }).output,
    release.tools.pnpm,
    'pnpm must match accepted release tools',
  );
  const registry = await startEphemeralRegistry({
    release,
    releaseDir: path.dirname(options.manifestPath),
    rootDir: path.join(consumerRoot, 'registry'),
  });
  try {
    const bareRoot = path.join(consumerRoot, 'bare-generator');
    const logs = path.join(consumerRoot, 'logs');
    fs.mkdirSync(bareRoot);
    fs.mkdirSync(logs);
    const manifest = createBareManifest(release);
    fs.writeFileSync(
      path.join(bareRoot, 'package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(bareRoot, '.npmrc'),
      'engine-strict=true\npackage-import-method=clone-or-copy\nignore-scripts=false\n',
    );
    const rootWorkspace = parseYaml(
      fs.readFileSync(path.join(sourceRoot, 'pnpm-workspace.yaml'), 'utf8'),
    );
    const env = runtimeEnv(options.qualifiedNode, registry.env);
    const installSetup = createBareInstallSetup(
      createPackage,
      rootWorkspace?.allowBuilds,
      env,
    );
    const bareWorkspacePath = path.join(bareRoot, 'pnpm-workspace.yaml');
    fs.writeFileSync(bareWorkspacePath, installSetup.workspaceBytes, {
      flag: 'wx',
    });
    console.log(
      '[bare-generator] normal install of the sole direct generator dependency',
    );
    const installArgs = [
      'install',
      '--config.engineStrict=true',
      '--ignore-scripts=false',
    ];
    const install = run('pnpm', installArgs, {
      cwd: bareRoot,
      env: installSetup.env,
      logFile: path.join(logs, 'bare-install.log'),
    });
    const bareWorkspacePolicy = assertBareWorkspacePolicyUnchanged(
      bareWorkspacePath,
      installSetup.workspaceBytes,
    );
    const cohortResolution = assertCohortResolutionProvenance(
      bareRoot,
      release,
      registry.registryUrl,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(bareRoot, 'package.json'), 'utf8')),
      manifest,
      'Install changed the sole-direct-dependency contract',
    );
    const installed = JSON.parse(
      run(
        options.qualifiedNode,
        ['--input-type=module', '--eval', packageProbe],
        {
          cwd: bareRoot,
          env,
          input: JSON.stringify({
            targetName: release.createPackage.targetName,
            version: release.createPackage.version,
          }),
        },
      ).output,
    );
    assert.equal(
      fs.realpathSync.native(
        path.join(bareRoot, 'node_modules', release.createPackage.targetName),
      ),
      installed.packageRoot,
      'Generator must be the actually installed sole direct dependency',
    );
    assert.equal(
      inside(fs.realpathSync.native(sourceRoot), installed.packageRoot),
      false,
      'Generator must not link to the source worktree',
    );
    const installedBytes = assertInstalledGeneratorBytes(
      release.createPackage,
      installed.packageRoot,
    );
    const generated = [];
    for (const renderer of renderers) {
      console.log(
        `[bare-generator] published bin generates ${renderer} before app install`,
      );
      const outputRoot = path.join(consumerRoot, `baseline-${renderer}`);
      assert.equal(fs.existsSync(outputRoot), false);
      run(
        options.qualifiedNode,
        [installed.bin, outputRoot, '--renderer', renderer, '--no-agents-md'],
        {
          cwd: bareRoot,
          env,
          logFile: path.join(logs, `generate-${renderer}.log`),
        },
      );
      const projection = JSON.parse(
        run(
          options.qualifiedNode,
          ['--input-type=module', '--eval', artifactProbe],
          {
            cwd: bareRoot,
            env,
            input: JSON.stringify({
              packageRoot: installed.packageRoot,
              workspaceRoot: outputRoot,
              renderer,
            }),
          },
        ).output,
      );
      generated.push(projection);
    }
    const report = {
      kind: 'bare-packed-generator-proof',
      version: 1,
      sourceRevision: release.source.commit,
      cohortDigest: release.cohortDigest,
      minimumNode: observedNode,
      nodeExecutable: options.qualifiedNode,
      nodeSha256: hash(fs.readFileSync(options.qualifiedNode)),
      manifestSha256: hash(fs.readFileSync(options.manifestPath)),
      generator: {
        targetName: release.createPackage.targetName,
        version: release.createPackage.version,
        artifactSha256: release.createPackage.sha256,
        ...installed,
      },
      directDependencies: manifest.dependencies,
      cohortResolution,
      installedBytes,
      bootstrapReleaseAgePolicy: installSetup.bootstrapReleaseAgePolicy,
      bareWorkspacePolicy,
      installCommand: {
        command: 'pnpm',
        args: installArgs,
        releaseAgeEnv: {
          pnpm_config_minimum_release_age:
            installSetup.env.pnpm_config_minimum_release_age,
          pnpm_config_minimum_release_age_exclude:
            installSetup.env.pnpm_config_minimum_release_age_exclude,
          pnpm_config_minimum_release_age_strict:
            installSetup.env.pnpm_config_minimum_release_age_strict,
          pnpm_config_minimum_release_age_ignore_missing_time:
            installSetup.env
              .pnpm_config_minimum_release_age_ignore_missing_time,
        },
      },
      installOutputSha256: install.sha256,
      generated,
    };
    return await consume({
      report,
      release,
      registry,
      bareRoot,
      installed,
      qualifiedNode: options.qualifiedNode,
      env,
      consumerRoot,
      generateInstalledConformance,
    });
  } finally {
    await registry.stop();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const [manifestPath, qualifiedNode, consumerRoot] = process.argv.slice(2);
  if (
    !manifestPath ||
    !qualifiedNode ||
    !consumerRoot ||
    process.argv.length !== 5
  )
    throw new Error(
      'Usage: node bare-generator-proof.mjs <manifest.json> <official-node> <leased-empty-consumer-root>',
    );
  const report = await withBareGeneratorProof({
    manifestPath: path.resolve(manifestPath),
    qualifiedNode,
    consumerRoot,
  });
  console.log(JSON.stringify(report, null, 2));
}
