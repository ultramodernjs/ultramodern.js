import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import {
  assertSameFiles,
  packArchive,
  readArchive,
} from '../../ultramodern-dependencies/test-peer-corrections/archive.mjs';

export function correctReactArchive(originalBytes) {
  const original = readArchive(originalBytes);
  const files = new Map(original);
  files.modes = new Map(original.modes);
  const manifest = JSON.parse(original.get('package.json'));
  assert.equal(manifest.name, '@tanstack/react-router');
  assert.equal(manifest.version, '1.170.46');
  assert.equal(manifest.dependencies['@tanstack/router-core'], '1.171.39');
  assert(!manifest.peerDependencies['@tanstack/router-core']);
  assert(!manifest.peerDependenciesMeta?.['@tanstack/router-core']);
  delete manifest.dependencies['@tanstack/router-core'];
  manifest.peerDependencies['@tanstack/router-core'] = '1.171.39';
  const newline = original.get('package.json').toString().endsWith('\n')
    ? '\n'
    : '';
  files.set(
    'package.json',
    Buffer.from(`${JSON.stringify(manifest, null, 2)}${newline}`),
  );
  for (const [file, bytes] of original) {
    if (file !== 'package.json')
      assert(bytes.equals(files.get(file)), `Non-metadata change: ${file}`);
  }
  const reverted = JSON.parse(files.get('package.json'));
  delete reverted.peerDependencies['@tanstack/router-core'];
  reverted.dependencies['@tanstack/router-core'] = '1.171.39';
  assert.deepEqual(reverted, JSON.parse(original.get('package.json')));
  return { files, archiveBytes: packArchive(files) };
}

export function canonicalPatch({ work, originalBytes, correctedBytes }) {
  const before = path.join(work, 'before');
  const after = path.join(work, 'after');
  for (const [directory, bytes] of [
    [before, originalBytes],
    [after, correctedBytes],
  ]) {
    fs.mkdirSync(directory);
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      readArchive(bytes).get('package.json'),
    );
  }
  const diff = spawnSync(
    'git',
    [
      'diff',
      '--no-index',
      '--diff-algorithm=histogram',
      '--unified=3',
      '--indent-heuristic',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--full-index',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      path.join(before, 'package.json'),
      path.join(after, 'package.json'),
    ],
    {
      cwd: work,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: devNull,
        GIT_CONFIG_NOSYSTEM: '1',
      },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(diff.status, 1);
  const patchBytes = Buffer.from(
    diff.stdout
      .replaceAll(`a/${before.slice(1)}/`, 'a/')
      .replaceAll(`b/${after.slice(1)}/`, 'b/'),
  );
  execFileSync('patch', ['-p1', '--fuzz=0', '--batch'], {
    cwd: before,
    input: patchBytes,
    stdio: 'pipe',
  });
  assert(
    fs
      .readFileSync(path.join(before, 'package.json'))
      .equals(readArchive(correctedBytes).get('package.json')),
  );
  return patchBytes;
}

export function verifyPayload(actual, expected) {
  assertSameFiles(readArchive(actual), readArchive(expected));
  return actual;
}

export function qualifySource({
  work,
  originalBytes,
  sourceRepository,
  source,
}) {
  const archiveBytes = execFileSync(
    'git',
    ['-C', sourceRepository, 'archive', source.commit, ...source.paths],
    { maxBuffer: 30 * 1024 ** 2 },
  );
  assert.equal(
    `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`,
    source.archiveIntegrity,
    'Pinned React source archive mismatch',
  );
  const directory = path.join(work, 'react-source');
  fs.mkdirSync(directory);
  execFileSync('tar', ['-xf', '-', '-C', directory], { input: archiveBytes });
  const published = readArchive(originalBytes);
  let sourceFiles = 0;
  for (const [file, bytes] of published) {
    if (!file.startsWith('src/')) continue;
    assert(
      fs
        .readFileSync(path.join(directory, 'packages/react-router', file))
        .equals(bytes),
      `React git/npm source mismatch: ${file}`,
    );
    sourceFiles++;
  }
  assert(sourceFiles > 40);
  const licenseBytes = fs.readFileSync(path.join(directory, 'LICENSE'));
  assert(
    published.get('LICENSE').equals(licenseBytes),
    'React git/npm license mismatch',
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, 'packages/react-router/package.json')),
  );
  assert.equal(manifest.name, '@tanstack/react-router');
  assert.equal(manifest.version, '1.170.46');
  return { archiveBytes, licenseBytes, sourceFiles };
}
