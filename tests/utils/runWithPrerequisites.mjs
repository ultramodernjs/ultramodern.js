import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { yaml } from '@modern-js/utils';
import spawn from 'cross-spawn';
import { inspectNpmTarball } from '../../scripts/ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import {
  collectSidecarPackages,
  stageSidecarPackages,
  validateAliasConsistency,
  writeSidecarStagingManifest,
} from '../../scripts/ultramodern-publish/lib/prepare-bleedingdev-packages/sidecars.mjs';
import { packProjects, runPackingCommand } from './packagePacking.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export function runPnpm(args, options) {
  const result = spawn.sync('pnpm', args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `pnpm ${args.join(' ')} failed in ${options.cwd}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
  return result.stdout;
}

export function runPnpmAsync(args, options) {
  return runPackingCommand('pnpm', args, options, spawn);
}

/** Every edge onto a `@bleedingdev/*` package: an `npm:` alias or a direct name. */
export function bleedingdevEdges(packageJson) {
  const edges = [];
  for (const block of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
  ]) {
    for (const [name, spec] of Object.entries(packageJson[block] ?? {})) {
      if (typeof spec !== 'string') continue;
      const alias = /^npm:(@bleedingdev\/[^@]+)@(.+)$/u.exec(spec);
      if (alias) {
        edges.push({ name, spec, target: alias[1], version: alias[2] });
      } else if (name.startsWith('@bleedingdev/')) {
        edges.push({ name, spec, target: name, version: spec });
      }
    }
  }
  return edges;
}

/** Stage and pack the release sidecars with the publish workflow's own code. */
export async function packTestSidecars(outputDir) {
  const staged = await stageSidecarPackages(
    collectSidecarPackages(),
    outputDir,
  );
  validateAliasConsistency([], staged);
  const { manifest } = writeSidecarStagingManifest(outputDir, staged);
  return Object.fromEntries(
    manifest.packages.map(item => {
      const tarball = path.join(outputDir, item.tarballPath);
      return [
        item.name,
        { tarball, version: item.version, integrity: item.sha256 },
      ];
    }),
  );
}

// The runner is the only writer. Workers consume tarballs and framework dist
// after this phase finishes; no worker discovers or rebuilds stale packages.
export async function packTestPackages(outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const manifest = path.join(outputDir, 'packages.json');
  // A failed refresh cannot leave an older successful manifest consumable.
  fs.rmSync(manifest, { force: true });
  const projects = JSON.parse(
    runPnpm(['--filter', '@modern-js/*', 'list', '--depth', '-1', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }),
  ).filter(
    project =>
      !project.private &&
      path
        .normalize(project.path)
        .startsWith(path.join(repoRoot, 'packages') + path.sep),
  );
  const packages = await packProjects(projects, outputDir, {
    run: runPnpmAsync,
  });
  const sidecars = await packTestSidecars(outputDir);
  // Edges inside packed manifests; generated workspaces add their own.
  const edges = [
    ...Object.values(packages),
    ...Object.values(sidecars),
  ].flatMap(({ tarball }) =>
    bleedingdevEdges(
      JSON.parse(inspectNpmTarball(fs.readFileSync(tarball)).packageJsonBytes),
    ),
  );
  const { allowBuilds, minimumReleaseAgeExclude = [] } = yaml.load(
    fs.readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'),
  );
  fs.writeFileSync(
    manifest,
    `${JSON.stringify({ packages, sidecars, edges, allowBuilds, minimumReleaseAgeExclude: minimumReleaseAgeExclude.filter(selector => !selector.includes('*')) }, null, 2)}\n`,
  );
  return manifest;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--pack-only' && args.length === 2) {
    console.log(await packTestPackages(path.resolve(args[1])));
    return;
  }
  const prepared = args[0] === '--prepared';
  if (prepared) args.shift();
  if (args.shift() !== '--' || args.length === 0) {
    throw new Error(
      'Usage: runWithPrerequisites.mjs [--prepared] -- <command> [args]',
    );
  }
  const inheritedManifest =
    process.env.MODERN_TEST_PACKAGE_MANIFEST || undefined;
  if (!prepared && !inheritedManifest) {
    runPnpm(['run', 'prepare-build'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  }
  const outputDir = inheritedManifest
    ? undefined
    : fs.mkdtempSync(path.join(os.tmpdir(), 'modern-test-packages-'));
  try {
    const manifest = inheritedManifest ?? (await packTestPackages(outputDir));
    const child = spawn(args[0], args.slice(1), {
      cwd: process.cwd(),
      env: { ...process.env, MODERN_TEST_PACKAGE_MANIFEST: manifest },
      stdio: 'inherit',
    });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    try {
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
      });
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    }
  } finally {
    if (outputDir) fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
