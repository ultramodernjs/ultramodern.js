import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const missing = Symbol('missing');
const dependencyFields = new Set([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);
const acceptedCohort = {
  '@module-federation/enhanced': 'npm:@bleedingdev/mf-enhanced@2.9.3',
  '@rsbuild/core': '2.3.2',
  // 1.0.5 switched to typescript/sync; the accepted Effect compiler exposes
  // unstable/sync. Keep the working declaration emitter rather than bypass it.
  '@rslib/core': '1.0.3',
  '@swc/core': '1.16.21',
  '@types/node': '^26.6.5',
  autoprefixer: '10.6.2',
  'i18next-browser-languagedetector': '^8.3.0',
  postcss: '^8.5.31',
  'tsconfig-paths': '4.2.0',
  typescript: '7.0.2',
};
const forkContracts = new Set([
  'scripts',
  'exports',
  'typesVersions',
  'peerDependenciesMeta',
  'engines',
  'packageManager',
  'pnpm',
  'lint-staged',
]);
const same = (a, b) =>
  a === b ||
  (a !== missing && b !== missing && JSON.stringify(a) === JSON.stringify(b));
const object = value =>
  value !== missing &&
  value !== null &&
  !Array.isArray(value) &&
  typeof value === 'object';
const version = value =>
  typeof value === 'string' && /^[~^]?\d+\.\d+\.\d+$/.test(value)
    ? value.replace(/^[~^]/, '').split('.').map(Number)
    : null;

// A different major is an API decision, not a merge heuristic. Keep the
// fork's accepted major and exact pins unless upstream has a newer patch/minor.
function newerWithinMajor(ours, theirs) {
  const a = version(ours);
  const b = version(theirs);
  if (!a || !b || a[0] !== b[0]) return ours;
  return b[1] > a[1] || (b[1] === a[1] && b[2] > a[2]) ? theirs : ours;
}

export function reconcile(base, ours, theirs, keys = []) {
  const field = keys[0];
  if (forkContracts.has(field)) return ours;
  if (same(ours, theirs) || same(theirs, base)) return ours;
  if (same(ours, base)) return theirs;
  if (ours === missing || theirs === missing) return ours;
  if (dependencyFields.has(field) && keys.length === 2) {
    return newerWithinMajor(ours, theirs);
  }
  if (keys.length === 1 && keys[0] === 'version')
    return newerWithinMajor(ours, theirs);
  if (object(ours) && object(theirs)) {
    const result = {};
    for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
      const value = reconcile(
        object(base) && Object.hasOwn(base, key) ? base[key] : missing,
        Object.hasOwn(ours, key) ? ours[key] : missing,
        Object.hasOwn(theirs, key) ? theirs[key] : missing,
        [...keys, key],
      );
      if (value !== missing) result[key] = value;
    }
    return result;
  }
  return ours;
}

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function read(ref, file) {
  try {
    return JSON.parse(git('show', `${ref}:${file}`));
  } catch (error) {
    if (error.status === 128) return missing;
    throw error;
  }
}

function run() {
  const [base, ours, theirs, mode] = process.argv.slice(2);
  assert(
    base && ours && theirs,
    'Usage: reconcile-manifests.mjs <base> <fork> <upstream> [--write]',
  );
  assert(mode === undefined || mode === '--write');
  const files = git(
    'diff',
    '--name-only',
    base,
    theirs,
    '--',
    '**/package.json',
    'package.json',
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  let written = 0;
  for (const file of files) {
    const original = read(base, file);
    const target = file.replace('/bff-corss-project/', '/bff-cross-project/');
    const fork = read(ours, target);
    const upstream = read(theirs, file);
    const retiredExample = /^examples\/test-(cypress|jest)\//.test(file);
    const result = retiredExample
      ? missing
      : reconcile(original, fork, upstream);
    if (result === missing) {
      if (mode === '--write') fs.rmSync(target, { force: true });
      continue;
    }
    // Root orchestration remains the qualified fork toolchain.
    if (file === 'package.json') {
      result.scripts = fork.scripts;
      result.devDependencies = { ...result.devDependencies };
      delete result.devDependencies.rstack;
    }
    if (mode === '--write') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
      if (target !== file) fs.rmSync(file, { force: true });
    }
    written++;
  }
  if (mode === '--write') {
    const manifests = git('ls-files', '-z', '**/package.json', 'package.json')
      .split('\0')
      .filter(file => file && fs.existsSync(file));
    for (const file of new Set(manifests)) {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (manifest.name?.startsWith('@examples/')) continue;
      for (const field of dependencyFields) {
        for (const [dependency, value] of Object.entries(
          manifest[field] ?? {},
        )) {
          if (
            Object.hasOwn(acceptedCohort, dependency) &&
            !value.startsWith('workspace:')
          ) {
            manifest[field][dependency] = acceptedCohort[dependency];
          }
        }
      }
      const config = path.join(path.dirname(file), 'rslib.config.mts');
      if (fs.existsSync(config)) {
        manifest.devDependencies ??= {};
        manifest.devDependencies['@rslib/core'] = acceptedCohort['@rslib/core'];
      }
      if (file === 'packages/toolkit/types/package.json') {
        delete manifest.dependencies['@jest/types'];
      }
      fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }
  console.log(
    `${mode === '--write' ? 'Reconciled' : 'Checked'} ${written} manifests; fork API/toolchain contracts retained.`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  run();
