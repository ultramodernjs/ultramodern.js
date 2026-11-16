import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../ultramodern-artifacts/protocol.mjs';
import { isolatedEnvironment } from './proof.mjs';
import { qualifyReactRouter } from './qualify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const inputs = JSON.parse(fs.readFileSync(path.join(here, 'inputs.json')));
const patchSha256 =
  '186e54be20a0d481731091924921ec409a15968fa13de5bfc3888a0ddbaf18d9';

/** Packed qualification has no registry or synthesized-core fallback. */
export function readCoreArchive(
  filename = process.env.SUPPORT_REACT_CORE_ARCHIVE,
) {
  assert(
    filename && path.isAbsolute(filename),
    'Packed React support qualification requires SUPPORT_REACT_CORE_ARCHIVE: absolute path to the actual corrected @tanstack/router-core@1.171.39 archive (reviewed patch 546a4a8ecd4cc45419bff0c99c860ab2c9e2d1a8ffd4b1512cedd748e9b5cac8)',
  );
  assert(fs.statSync(filename).isFile(), 'Core archive must be a regular file');
  return fs.readFileSync(filename);
}

export function sourceEvidence(result, { packed = false } = {}) {
  assert.equal(result.correctionRequired, true);
  assert.deepEqual(result.gates, {
    normal: true,
    freshFrozen: true,
    allInstalledBytes: true,
    singleton: true,
    publicRouting: true,
    strictTS7: true,
    wrongRegistryPeer: true,
    actualTransportedPayloads: packed,
  });
  assert.equal(result.corePatchSha256, inputs.corePatchSha256);
  assert.equal(result.artifacts.length, 1);
  const [artifact] = result.artifacts;
  assert.equal(artifact.name, '@tanstack/react-router');
  assert.equal(artifact.version, '1.170.46');
  assert.equal(artifact.upstream.integrity, inputs.identities[0].integrity);
  assert.equal(
    artifact.upstream.authentication.scheme,
    'npm-registry-ecdsa-sha256+sha512',
  );
  for (const [key, expected] of Object.entries(inputs.source))
    assert.deepEqual(artifact.source[key], expected);
  assert.equal(sha256(artifact.patchBytes), patchSha256);
  assert.equal(
    sha256(artifact.licenseBytes),
    'a405ee70c632bb938acb7ac5f210e814409b3760ea9d2329d8ed8ffcfd11a0e7',
  );
  return {
    sourceArchiveBytes: artifact.source.archiveBytes,
    builtPatchBytes: artifact.patchBytes,
    licenseBytes: artifact.licenseBytes,
  };
}

/**
 * Reuses owning normal/frozen/runtime/strict-TS gates against supplied archive bytes.
 * Core is independently reconstructed from signed npm bytes + the reviewed patch by
 * the owning qualifier, then compared file-for-file (including modes) to the input.
 */
export async function qualifyReactSupport({
  workDirectory,
  toolchain,
  reactArchiveBytes,
  coreArchiveBytes,
  log = console.log,
}) {
  const packed = reactArchiveBytes !== undefined;
  if (packed) {
    assert(Buffer.isBuffer(reactArchiveBytes));
    coreArchiveBytes ??= readCoreArchive();
    assert(Buffer.isBuffer(coreArchiveBytes));
  } else {
    assert.equal(coreArchiveBytes, undefined);
  }
  assert(path.isAbsolute(workDirectory));
  const work = fs.mkdtempSync(path.join(workDirectory, 'support-react-'));
  const env = isolatedEnvironment(work);
  const owner = `support-react-${process.pid}-${path.basename(work)}`;
  const guardian = '/Users/satan/bin/disk-guardian-artifacts';
  const lifecycle =
    process.platform === 'darwin'
      ? {
          register(directory) {
            execFileSync(
              guardian,
              [
                'register',
                directory,
                '--owner',
                owner,
                '--owner-pid',
                String(process.pid),
                '--kind',
                'dependencies',
              ],
              { env, stdio: 'pipe' },
            );
          },
          release(directory) {
            execFileSync(guardian, ['release', directory, '--owner', owner], {
              env,
              stdio: 'pipe',
            });
          },
        }
      : undefined;
  try {
    let sourceRepository =
      toolchain.sourceRepository ?? process.env.SUPPORT_REACT_SOURCE_REPOSITORY;
    if (!sourceRepository) {
      sourceRepository = path.join(work, 'source');
      const run = args =>
        execFileSync('git', args, {
          env,
          stdio: 'pipe',
          timeout: 120000,
          maxBuffer: 4 * 1024 * 1024,
        });
      run(['init', sourceRepository]);
      run([
        '-C',
        sourceRepository,
        'fetch',
        '--depth=1',
        'https://github.com/TanStack/router.git',
        inputs.source.commit,
      ]);
    }
    assert(path.isAbsolute(sourceRepository));
    const result = await qualifyReactRouter({
      workDirectory: work,
      toolchain: { ...toolchain, sourceRepository },
      lifecycle,
      ...(packed
        ? {
            payloads: {
              '@tanstack/react-router': reactArchiveBytes,
              '@tanstack/router-core': coreArchiveBytes,
            },
          }
        : {}),
      log,
    });
    const evidence = sourceEvidence(result, { packed });
    if (packed) {
      assert(result.artifacts[0].archiveBytes.equals(reactArchiveBytes));
      assert(result.coreBytes.equals(coreArchiveBytes));
    }
    return evidence;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
