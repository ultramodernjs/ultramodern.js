#!/usr/bin/env node
// Consumer: publish-bleedingdev.yml prepare-release package build.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fsKit from '../lib/fs-kit.js';
import processKit from '../lib/process-kit.js';
import { collectPackageJsonFiles } from './lib/fs-utils.mjs';
import { assertCleanCommittedSource } from './lib/release-source-state.mjs';

const { readJsonFile, repoRoot } = fsKit;
const { runCommand } = processKit;
const excludedPackages = new Set([
  '@modern-js/main-doc',
  '@modern-js/module-tools-docs',
  '@modern-js/create',
]);

function collectPublicModernPackages() {
  return collectPackageJsonFiles(path.join(repoRoot, 'packages'))
    .map(packageJsonPath => readJsonFile(packageJsonPath))
    .filter(packageJson => packageJson.name?.startsWith('@modern-js/'))
    .filter(packageJson => !packageJson.private)
    .map(packageJson => packageJson.name)
    .filter(packageName => !excludedPackages.has(packageName))
    .sort((a, b) => a.localeCompare(b));
}

function collectBuildProjects() {
  const command = createReleaseCommand([
    'exec',
    'nx',
    'show',
    'projects',
    '--with-target',
    'build',
    '--json',
  ]);
  const output = execFileSync(command.executable, command.args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  return new Set(JSON.parse(output));
}

function run(command, args) {
  const result = runCommand(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      NX_DAEMON: 'false',
    },
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with ${result.exitCode}`,
    );
  }
}

export function createReleaseBuildArgs(packages) {
  return [
    'exec',
    'nx',
    'run-many',
    '-t',
    'build',
    '-p',
    packages.join(','),
    '--maxParallel=8',
    '--skipNxCache',
    '--skipRemoteCache',
  ];
}

function createReleaseCommand(args) {
  return {
    executable: process.execPath,
    args: [
      path.join(repoRoot, 'scripts', 'with-effect-tsrs.mjs'),
      'pnpm',
      ...args,
    ],
  };
}

export function createReleaseBuildCommand(packages) {
  return createReleaseCommand(createReleaseBuildArgs(packages));
}

function main(args) {
  if (args.length > 0) {
    throw new Error(`Unexpected argument(s): ${args.join(' ')}`);
  }

  assertCleanCommittedSource(repoRoot);
  const buildProjects = collectBuildProjects();
  const packages = collectPublicModernPackages().filter(packageName =>
    buildProjects.has(packageName),
  );

  if (packages.length === 0) {
    throw new Error(
      'No publishable @modern-js packages with build targets found.',
    );
  }

  console.log(`Building ${packages.length} publishable @modern-js package(s).`);
  const command = createReleaseBuildCommand(packages);
  run(command.executable, command.args);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
