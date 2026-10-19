#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from '@babel/parser';
import { yaml } from '@modern-js/utils';
import { execaSync } from '@modern-js/utils/execa';
import { transformSync } from 'esbuild';
import { readWorkspacePackageSource } from '../../dist/esm-node/ultramodern-tooling/config/metadata.js';
import { parseUltramodernReleaseCohort } from '../../dist/esm-node/ultramodern-release-cohort.js';

const workspaceRoot = path.resolve(
  process.env.ULTRAMODERN_WORKSPACE_ROOT ?? process.cwd(),
);
const { values: args } = parseArgs({
  strict: true,
  options: {
    app: { type: 'string' },
    package: { type: 'string' },
    'package-dir': { type: 'string' },
    'finalize-only': { type: 'boolean', default: false },
    'runtime-dir': { type: 'string' },
  },
});

function fail(message) {
  console.error(`[ultramodern:zerops] ${message}`);
  process.exit(1);
}

function readFlag(name) {
  const value = args[name.slice(2)];
  if (value !== undefined && (!value || value.startsWith('--'))) {
    fail(`${name} requires a value`);
  }

  return value;
}

function assertRelativePath(label, value) {
  if (
    !value ||
    path.isAbsolute(value) ||
    value.split(/[\\/]/u).includes('..')
  ) {
    fail(`${label} must be a workspace-relative path`);
  }
}

function assertInsideWorkspace(label, targetPath) {
  const relativePath = path.relative(workspaceRoot, targetPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    fail(`${label} resolved outside the workspace`);
  }
  let existing = targetPath;
  while (!fs.existsSync(existing)) {
    existing = path.dirname(existing);
  }
  const realRelative = path.relative(
    fs.realpathSync(workspaceRoot),
    fs.realpathSync(existing),
  );
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    fail(`${label} resolved outside the workspace through a symlink`);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function run(command, commandArgs, options = {}) {
  const result = execaSync(command, commandArgs, {
    cwd: options.cwd ?? workspaceRoot,
    env: {
      ...process.env,
      MODERNJS_DEPLOY: 'node',
    },
    stdio: 'inherit',
    reject: false,
  });

  if (result.failed && result.exitCode === undefined) {
    fail(result.shortMessage ?? result.message);
  }

  if (result.exitCode !== 0) {
    process.exit(result.exitCode ?? 1);
  }
}

const sourceSnapshotSkipSegments = new Set([
  '.git',
  '.output',
  '.zerops',
  'dist',
  'node_modules',
  'repos',
]);

function shouldSnapshotSourcePath(relativePath) {
  return !relativePath
    .split(path.sep)
    .some((segment) => sourceSnapshotSkipSegments.has(segment));
}

function listWorkspaceSourceFiles() {
  const files = [];
  const queue = [workspaceRoot];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relativePath = path.relative(workspaceRoot, absolute);
      if (!shouldSnapshotSourcePath(relativePath)) {
        continue;
      }
      if (entry.isDirectory()) {
        queue.push(absolute);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }
  return files.sort();
}

function snapshotWorkspaceSourceFiles() {
  return new Map(
    listWorkspaceSourceFiles().map((relativePath) => [
      relativePath,
      fs.readFileSync(path.join(workspaceRoot, relativePath)),
    ]),
  );
}

function restoreWorkspaceSourceFiles(snapshot) {
  for (const relativePath of listWorkspaceSourceFiles()) {
    if (!snapshot.has(relativePath)) {
      fs.rmSync(path.join(workspaceRoot, relativePath), { force: true });
    }
  }
  for (const [relativePath, content] of snapshot) {
    const absolute = path.join(workspaceRoot, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    if (
      !fs.existsSync(absolute) ||
      !fs.readFileSync(absolute).equals(content)
    ) {
      fs.writeFileSync(absolute, content);
    }
  }
}

const appId = readFlag('--app');
const packageName = readFlag('--package');
const packageDir = readFlag('--package-dir');
const finalizeOnly = args['finalize-only'];
const requestedRuntimeDir = readFlag('--runtime-dir');

if (!appId) {
  fail('--app is required');
}

if (!packageName) {
  fail('--package is required');
}

if (!packageDir) {
  fail('--package-dir is required');
}

assertRelativePath('--package-dir', packageDir);
assertRelativePath('--app', appId);
if (appId.split(/[\\/]/u).length !== 1 || appId === '.') {
  fail('--app must be a service identifier');
}
if (Boolean(requestedRuntimeDir) !== finalizeOnly) {
  fail('--finalize-only and --runtime-dir must be used together');
}
if (requestedRuntimeDir) {
  assertRelativePath('--runtime-dir', requestedRuntimeDir);
}

const appRoot = path.resolve(workspaceRoot, packageDir);
const appOutputDir = path.join(appRoot, '.output');
const runtimeDir = requestedRuntimeDir
  ? path.resolve(workspaceRoot, requestedRuntimeDir)
  : path.join(workspaceRoot, '.zerops/runtime', appId);

assertInsideWorkspace('package directory', appRoot);
assertInsideWorkspace('runtime directory', runtimeDir);
const runtimeRelative = path.relative(
  path.join(workspaceRoot, '.zerops/runtime'),
  runtimeDir,
);
if (
  !runtimeRelative ||
  runtimeRelative.startsWith('..') ||
  path.isAbsolute(runtimeRelative)
) {
  fail('--runtime-dir must be a service directory inside .zerops/runtime');
}
// Finalization replaces node_modules. Never follow a staged-runtime symlink,
// including one that points to another directory inside the workspace.
let runtimeAncestor = runtimeDir;
while (runtimeAncestor !== workspaceRoot) {
  if (
    fs.lstatSync(runtimeAncestor, { throwIfNoEntry: false })?.isSymbolicLink()
  ) {
    fail('runtime directory must not contain symlinks');
  }
  runtimeAncestor = path.dirname(runtimeAncestor);
}
if (readJson(path.join(appRoot, 'package.json')).name !== packageName) {
  fail('--package must match --package-dir/package.json name');
}

if (!finalizeOnly) {
  const sourceSnapshot = snapshotWorkspaceSourceFiles();
  try {
    run('pnpm', ['--filter', packageName, 'run', 'deploy', '--skip-build']);
  } finally {
    restoreWorkspaceSourceFiles(sourceSnapshot);
  }

  if (!fs.existsSync(appOutputDir)) {
    fail(
      `Modern.js Node deploy did not produce ${path.relative(workspaceRoot, appOutputDir)}`,
    );
  }

  fs.rmSync(runtimeDir, { force: true, recursive: true });
  fs.mkdirSync(path.dirname(runtimeDir), { recursive: true });
  fs.cpSync(appOutputDir, runtimeDir, { recursive: true });
}

const entryPath = path.join(runtimeDir, 'index.js');
if (!finalizeOnly && !fs.existsSync(entryPath)) {
  fail(
    `Modern.js Node deploy output is missing ${path.relative(workspaceRoot, entryPath)}`,
  );
}

const packageJsonPath = path.join(runtimeDir, 'package.json');
const packageJsonStat = fs.lstatSync(packageJsonPath, {
  throwIfNoEntry: false,
});
if (packageJsonStat?.isSymbolicLink()) {
  fail('runtime package.json must not be a symlink');
}
if (finalizeOnly && !packageJsonStat?.isFile()) {
  fail('--finalize-only requires an existing runtime package.json');
}
const runtimePackage = fs.existsSync(packageJsonPath)
  ? readJson(packageJsonPath)
  : {};
if (
  finalizeOnly &&
  (typeof runtimePackage.scripts?.serve !== 'string' ||
    !runtimePackage.scripts.serve.trim())
) {
  fail('--finalize-only requires an existing runtime serve script');
}
normalizeRuntimePackageDependencies(runtimePackage);
removeIncompatiblePlatformDependencies(runtimePackage);

runtimePackage.private = true;
runtimePackage.name ??= `${appId}-zerops-runtime`;
runtimePackage.scripts = {
  ...(runtimePackage.scripts ?? {}),
  serve: runtimePackage.scripts?.serve ?? 'node index.js',
};

writeJson(packageJsonPath, runtimePackage);
installRuntimeDependencies(runtimePackage);

console.log(
  `[ultramodern:zerops] materialized ${appId} runtime at ${path.relative(
    workspaceRoot,
    runtimeDir,
  )}`,
);

function normalizeRuntimePackageDependencies(packageJson) {
  const cohortFile = path.join(
    workspaceRoot,
    'node_modules/@modern-js/ultramodern-create/release-cohort.json',
  );
  const cohort = fs.existsSync(cohortFile)
    ? parseUltramodernReleaseCohort(readJson(cohortFile))
    : undefined;
  const { modernPackageVersion, aliasScope, aliasPackageNamePrefix } =
    readWorkspacePackageSource(workspaceRoot);
  const aliasPrefix =
    aliasScope && aliasPackageNamePrefix !== undefined
      ? `@${aliasScope}/${aliasPackageNamePrefix}`
      : undefined;
  const officialNames = new Map(
    Object.entries(cohort?.aliases ?? {}).map(([source, target]) => [
      target,
      source,
    ]),
  );
  for (const section of ['dependencies', 'optionalDependencies']) {
    const dependencies = packageJson[section];
    if (
      !dependencies ||
      typeof dependencies !== 'object' ||
      Array.isArray(dependencies)
    ) {
      continue;
    }

    for (const dependencyName of Object.keys(dependencies)) {
      const targetName = cohort?.aliases[dependencyName];
      const officialPackageName =
        officialNames.get(dependencyName) ??
        (!cohort && aliasPrefix && dependencyName.startsWith(aliasPrefix)
          ? `@modern-js/${dependencyName.slice(aliasPrefix.length)}`
          : undefined);
      if (typeof dependencies[dependencyName] !== 'string') {
        fail(`Runtime dependency ${dependencyName} must have a string request`);
      }
      if (dependencies[dependencyName].startsWith('catalog:')) {
        if (
          dependencies[dependencyName] !== 'catalog:ultramodern' ||
          !cohort ||
          (!targetName && !officialPackageName)
        ) {
          fail(
            `Runtime dependency ${dependencyName} has no installed release identity for ${dependencies[dependencyName]}`,
          );
        }
        dependencies[dependencyName] = targetName
          ? `npm:${targetName}@${cohort.release.version}`
          : cohort.release.version;
      }
      if (officialPackageName) {
        const version = cohort?.release.version ?? modernPackageVersion;
        dependencies[dependencyName] = version;
        dependencies[officialPackageName] ??=
          `npm:${dependencyName}@${version}`;
      }
    }
  }
}

function platformFieldAllows(field, current) {
  const values = typeof field === 'string' ? [field] : (field ?? []);
  if (values.includes(`!${current}`) || values.includes('!*')) {
    return false;
  }
  const allowed = values.filter((value) => !value.startsWith('!'));
  return (
    !allowed.length || allowed.includes(current) || allowed.includes('any')
  );
}

function removeIncompatiblePlatformDependencies(manifest) {
  const modulesFile = path.join(workspaceRoot, 'node_modules/.modules.yaml');
  const modules = fs.existsSync(modulesFile)
    ? yaml.load(fs.readFileSync(modulesFile, 'utf8'))
    : {};
  const virtualStore = path.resolve(
    workspaceRoot,
    'node_modules',
    modules?.virtualStoreDir ?? '.pnpm',
  );
  const storeEntries = fs.existsSync(virtualStore)
    ? fs.readdirSync(virtualStore)
    : [];
  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      const candidates = [appRoot, workspaceRoot].map((root) =>
        path.join(root, 'node_modules', name, 'package.json'),
      );
      for (const entry of storeEntries) {
        if (entry.startsWith(`${name.replaceAll('/', '+')}@`)) {
          candidates.push(
            path.join(
              virtualStore,
              entry,
              'node_modules',
              name,
              'package.json',
            ),
          );
        }
      }
      const installed = candidates
        .filter((file) => fs.existsSync(file))
        .map(readJson)
        .find((value) => value.name === name && value.version === version);
      if (
        installed &&
        (!platformFieldAllows(installed.os, process.platform) ||
          !platformFieldAllows(installed.cpu, process.arch))
      ) {
        delete manifest[section][name];
        console.log(
          `[ultramodern:zerops] excluded ${name}@${version} from ${process.platform}/${process.arch} runtime`,
        );
      }
    }
  }
}

function lockedRegistryOverrides(lockfileText) {
  const versions = new Map();
  for (const document of yaml.loadAll(lockfileText)) {
    for (const key of Object.keys(document?.packages ?? {})) {
      const separator = key.lastIndexOf('@');
      const name = key.slice(0, separator);
      const version = key.slice(separator + 1);
      if (
        separator > 0 &&
        !name.includes('@', 1) &&
        /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(version)
      ) {
        if (!versions.has(name)) {
          versions.set(name, new Set());
        }
        versions.get(name).add(version);
      }
    }
  }
  return Object.fromEntries(
    [...versions]
      .filter(([, values]) => values.size === 1)
      .map(([name, values]) => [name, [...values][0]]),
  );
}

function installRuntimeDependencies(runtimePackage) {
  const installDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `ultramodern-zerops-${appId}-`),
  );

  try {
    const workspacePackages = collectWorkspacePackages();
    const installPackage = JSON.parse(JSON.stringify(runtimePackage));
    const localDependencies = removeWorkspaceDependencies(
      installPackage,
      workspacePackages,
    );

    const direct = new Set([
      ...Object.keys(installPackage.dependencies ?? {}),
      ...Object.keys(installPackage.optionalDependencies ?? {}),
    ]);
    const overrides = Object.fromEntries(
      Object.entries(
        lockedRegistryOverrides(
          fs.readFileSync(path.join(workspaceRoot, 'pnpm-lock.yaml'), 'utf8'),
        ),
      ).filter(([name]) => !direct.has(name)),
    );
    writeJson(path.join(installDir, 'package.json'), {
      ...installPackage,
      overrides,
    });
    run(
      'npm',
      [
        'install',
        '--omit=dev',
        '--no-audit',
        '--fund=false',
        '--legacy-peer-deps',
      ],
      {
        cwd: installDir,
      },
    );

    fs.rmSync(path.join(runtimeDir, 'node_modules'), {
      force: true,
      recursive: true,
    });
    if (fs.existsSync(path.join(installDir, 'node_modules'))) {
      fs.cpSync(
        path.join(installDir, 'node_modules'),
        path.join(runtimeDir, 'node_modules'),
        {
          recursive: true,
        },
      );
    }

    for (const dependency of localDependencies) {
      copyWorkspacePackage(dependency, workspacePackages);
    }
  } finally {
    fs.rmSync(installDir, { force: true, recursive: true });
  }
}

function collectWorkspacePackages() {
  const packages = new Map();

  for (const directory of ['packages', 'apps', 'verticals']) {
    const absoluteDirectory = path.join(workspaceRoot, directory);
    if (!fs.existsSync(absoluteDirectory)) {
      continue;
    }

    for (const entry of fs.readdirSync(absoluteDirectory, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const packageDirectory = path.join(absoluteDirectory, entry.name);
      const packageJsonPath = path.join(packageDirectory, 'package.json');
      if (!fs.existsSync(packageJsonPath)) {
        continue;
      }

      const packageJson = readJson(packageJsonPath);
      if (typeof packageJson.name === 'string') {
        packages.set(packageJson.name, packageDirectory);
      }
    }
  }

  return packages;
}

function removeWorkspaceDependencies(packageJson, workspacePackages) {
  const localDependencies = [];
  for (const section of ['dependencies', 'optionalDependencies']) {
    const dependencies = packageJson[section];
    if (
      !dependencies ||
      typeof dependencies !== 'object' ||
      Array.isArray(dependencies)
    ) {
      continue;
    }

    for (const dependencyName of Object.keys(dependencies)) {
      if (workspacePackages.has(dependencyName)) {
        localDependencies.push(dependencyName);
        delete dependencies[dependencyName];
      }
    }
  }

  return localDependencies;
}

function copyWorkspacePackage(packageName, workspacePackages) {
  const sourceDirectory = workspacePackages.get(packageName);
  if (!sourceDirectory) {
    return;
  }

  const targetDirectory = path.join(
    runtimeDir,
    'node_modules',
    ...packageName.split('/'),
  );
  fs.rmSync(targetDirectory, { force: true, recursive: true });
  fs.mkdirSync(path.dirname(targetDirectory), { recursive: true });
  fs.cpSync(sourceDirectory, targetDirectory, {
    filter: (sourcePath) => !sourcePath.includes(`${path.sep}node_modules`),
    recursive: true,
  });
  makeWorkspacePackageRuntimeSafe(targetDirectory);
}

function makeWorkspacePackageRuntimeSafe(packageDirectory) {
  const packageJsonPath = path.join(packageDirectory, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    const packageJson = readJson(packageJsonPath);
    packageJson.exports = rewriteTsExports(packageJson.exports);
    writeJson(packageJsonPath, packageJson);
  }

  for (const tsFile of listTsFiles(packageDirectory)) {
    const jsFile = tsFile.replace(/\.ts$/u, '.js');
    fs.writeFileSync(
      jsFile,
      transpileGeneratedPackageTs(fs.readFileSync(tsFile, 'utf-8'), tsFile),
      'utf-8',
    );
  }
}

function rewriteTsExports(value) {
  if (typeof value === 'string') {
    return value.replace(/\.ts$/u, '.js');
  }

  if (Array.isArray(value)) {
    return value.map(rewriteTsExports);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        rewriteTsExports(entry),
      ]),
    );
  }

  return value;
}

function listTsFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(entryPath));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(entryPath);
    }
  }

  return files;
}

function transpileGeneratedPackageTs(source, sourcefile) {
  let code = transformSync(source, {
    loader: 'ts',
    format: 'esm',
    target: 'node26',
    sourcefile,
    legalComments: 'inline',
  }).code;
  const replacements = [];
  function visit(node) {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node !== 'object' || typeof node.type !== 'string')
      return;

    let specifier;
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ImportExpression'
    ) {
      specifier = node.source;
    } else if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Import'
    ) {
      specifier = node.arguments[0];
    }
    if (
      specifier?.type === 'StringLiteral' &&
      /^\.{1,2}\//u.test(specifier.value) &&
      specifier.value.endsWith('.ts')
    ) {
      replacements.push({
        start: specifier.start,
        end: specifier.end,
        value: JSON.stringify(`${specifier.value.slice(0, -3)}.js`),
      });
    }
    for (const child of Object.values(node)) visit(child);
  }
  visit(parse(code, { sourceType: 'module' }));
  for (const replacement of replacements.sort(
    (left, right) => right.start - left.start,
  )) {
    code =
      code.slice(0, replacement.start) +
      replacement.value +
      code.slice(replacement.end);
  }
  return code;
}
