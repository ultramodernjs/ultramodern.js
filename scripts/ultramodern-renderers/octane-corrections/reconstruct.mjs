import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packages, references, source } from './inputs.mjs';
import { assertSharedCoreManifest } from './shared-core-peer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../..');
const patchFile = path.join(
  repository,
  'patches/@octanejs__tanstack-router@0.3.4.shared-core-peer.patch',
);
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function verifyIntegrity(bytes, integrity) {
  assert.equal(
    `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    integrity,
    'Archive integrity mismatch',
  );
}
function run(command, args, cwd, options = {}) {
  return execFileSync(command, args, { cwd, stdio: 'inherit', ...options });
}
function disk() {
  run('df', ['-h', '/System/Volumes/Data']);
  const { bavail, bsize } = fs.statfsSync('/System/Volumes/Data');
  assert(bavail * bsize >= 20 * 1024 ** 3, 'Below 20 GiB; stop allocating');
}
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  assert(response.ok, `${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
export function assertIdentity(directory, expected) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, 'package.json')),
  );
  assert.equal(manifest.name, expected.name);
  assert.equal(manifest.version, expected.version);
  return manifest;
}
export function assertSameTree(actual, expected) {
  const files = root =>
    fs
      .readdirSync(root, { recursive: true })
      .filter(file => fs.lstatSync(path.join(root, file)).isFile())
      .sort();
  assert.deepEqual(
    files(actual),
    files(expected),
    'Package file inventory changed',
  );
  for (const file of files(actual))
    assert.deepEqual(
      fs.readFileSync(path.join(actual, file)),
      fs.readFileSync(path.join(expected, file)),
      file,
    );
}
export function applyExactPatch(directory, patch) {
  const args = ['apply', '--verbose', '--check', patch];
  const checked = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
  assert(!/offset|fuzz/i.test(checked.stderr), checked.stderr);
  run('git', ['apply', patch], directory);
}
export async function main() {
  assert(
    process.env.OWNED_TEMP_DIR,
    'Run with owned-temp-dir --need-gib 20 --run octane-corrections -- node .../reconstruct.mjs',
  );
  const root = fs.realpathSync(process.env.OWNED_TEMP_DIR);
  assert(
    !fs.existsSync(path.join(root, '.git')),
    'Build inputs must not be a git checkout',
  );
  const work = path.join(root, 'octane-corrections');
  fs.mkdirSync(work); // Never overwrite another operation's tree.
  const owner = `octane-corrections-${process.pid}`;
  const registered = [];
  function register(dir, kind) {
    fs.mkdirSync(dir, { recursive: true });
    run('/Users/satan/bin/disk-guardian-artifacts', [
      'register',
      dir,
      '--owner',
      owner,
      '--owner-pid',
      String(process.pid),
      '--grace-hours',
      '24',
      '--kind',
      kind,
    ]);
    registered.push(dir);
  }
  try {
    disk();
    const sourceBytes = await download(source.url);
    assert.equal(digest(sourceBytes), source.sha256);
    fs.writeFileSync(path.join(work, 'source.tgz'), sourceBytes);
    const sourceRoot = path.join(work, 'source');
    fs.mkdirSync(sourceRoot);
    run(
      'tar',
      [
        '-xzf',
        path.join(work, 'source.tgz'),
        '--strip-components=1',
        '-C',
        sourceRoot,
      ],
      work,
    );
    for (const input of packages) {
      const bytes = await download(input.url);
      verifyIntegrity(bytes, input.integrity);
      const archive = path.join(work, `${input.directory}.tgz`);
      fs.writeFileSync(archive, bytes);
      const original = path.join(work, input.directory);
      fs.mkdirSync(original);
      run(
        'tar',
        ['-xzf', archive, '--strip-components=1', '-C', original],
        work,
      );
      assertIdentity(original, input);
      // Octane's published runtime is dist, not source. Router and Rspack ship
      // source, so prove their npm inputs match the exact source commit.
      if (input.name !== 'octane')
        assertSameTree(
          path.join(original, 'src'),
          path.join(sourceRoot, 'packages', input.directory, 'src'),
        );
    }
    const adapter = packages[1];
    const corrected = path.join(work, 'package');
    fs.cpSync(path.join(work, adapter.directory), corrected, {
      recursive: true,
    });
    applyExactPatch(corrected, patchFile);
    const manifest = assertIdentity(corrected, adapter);
    assertSharedCoreManifest(manifest);
    assert.equal(
      digest(
        fs.readFileSync(
          path.join(corrected, 'src/ssr/routerRenderSnapshot.ts'),
        ),
      ),
      references.snapshotSourceSha256,
    );
    const authored = fs.readFileSync(
      path.join(here, 'routerRenderSnapshot.ts.txt'),
    );
    assert.deepEqual(
      authored,
      fs.readFileSync(path.join(corrected, 'src/ssr/routerRenderSnapshot.ts')),
    );
    // Adapter 0.3.4's actual npm layout is source. It has no build/prepack or
    // dist to invent. Octane's separate runtime patch still needs owning build.
    run(
      'tar',
      ['-czf', path.join(work, 'corrected-adapter.tgz'), 'package'],
      work,
    );
    const roundtrip = path.join(work, 'roundtrip');
    fs.mkdirSync(roundtrip);
    run(
      'tar',
      [
        '-xzf',
        path.join(work, 'corrected-adapter.tgz'),
        '--strip-components=1',
        '-C',
        roundtrip,
      ],
      work,
    );
    assertSameTree(roundtrip, corrected);
    const { qualify } = await import('./qualify.mjs');
    await qualify({
      work,
      sourceRoot,
      corrected: roundtrip,
      here,
      run,
      disk,
      register,
      applyExactPatch,
      verifyIntegrity,
    });
    console.log(
      JSON.stringify(
        {
          scope: 'router-adapter-only',
          source: source.commit,
          input: adapter,
          correctionSha256: digest(fs.readFileSync(patchFile)),
          tarballSha512: `sha512-${createHash('sha512')
            .update(fs.readFileSync(path.join(work, 'corrected-adapter.tgz')))
            .digest('base64')}`,
          runtimePublisherHydration: 'NOT PORTED',
          stableTypeScript7: 'NOT ACCEPTED',
          frameworkBrowserAndCI: 'PENDING',
        },
        null,
        2,
      ),
    );
  } finally {
    for (const dir of registered.reverse())
      run('/Users/satan/bin/disk-guardian-artifacts', [
        'release',
        dir,
        '--owner',
        owner,
      ]);
    fs.rmSync(work, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
