import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  applyExactPatch,
  packFiles,
} from '../../ultramodern-artifacts/reconstruct.mjs';
import { artifactPolicy } from '../../ultramodern-artifacts/protocol.mjs';
import { readBytes } from '../../ultramodern-artifacts/transport.mjs';
import {
  inputs,
  inspectSupportTarball,
  supportProtocol as protocol,
} from '../../ultramodern-support-artifacts/protocol.mjs';
import { releaseRecipe } from '../../ultramodern-support-artifacts/recipes.mjs';
import { authenticateDescriptor } from '../../ultramodern-support-artifacts/transport.mjs';
import { inspectNpmTarball } from './prepare-bleedingdev-packages/release-artifacts.mjs';

const authenticated = new WeakMap();
const blocks = ['dependencies', 'devDependencies', 'optionalDependencies'];
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function reviewedDescriptor(value) {
  protocol.validateDescriptor(value);
  for (const name of Object.keys(protocol.cohort))
    assert.equal(
      value.packages[name].patchSha256,
      inputs[name].patchSha256,
      `${name}: unreviewed support patch`,
    );
  return freeze(structuredClone(value));
}

/** Authenticate a typed support envelope. This does not admit archive bytes. */
export async function authSupportDescriptor({
  descriptor,
  readGithub,
  fetchArtifact = fetch,
  signal,
}) {
  signal?.throwIfAborted();
  const snapshot = reviewedDescriptor(descriptor);
  const release = await authenticateDescriptor({
    descriptor: snapshot,
    readGithub,
    fetchArtifact,
    signal,
  });
  signal?.throwIfAborted();
  const authority = Object.freeze({ descriptor: snapshot });
  authenticated.set(authority, freeze(structuredClone(release)));
  return authority;
}

/**
 * owningPackages entries are {role, bytes: Buffer, supportPackages: string[]}.
 * role is mandatory: 'framework-peer' or 'root-direct'; it is never inferred.
 * bytes is the actual packed archive, never a caller's manifest projection.
 * root-direct requires ultramodern.supportArtifacts and exact URL dependency/dev
 * authority. Every owner commits to the exact descriptor. framework-peer forbids
 * support dependencies/optionalDependencies and requires exact peers. Only Effect's
 * feature-conditional integration may be optional, with a validated direct host.
 * A framework's dev-only edge may select the exact version or URL:
 * devDependencies do not install as transitive implementation dependencies.
 * Reconstruction uses only the support module's reviewed policy, never caller pins.
 * Invoke inside owned-temp-dir; this function retires only its own scratch child.
 */
export async function verifyPackedSupportInputs({
  authority,
  owningPackages = [],
  fetchArtifact = fetch,
  signal,
}) {
  const release = authenticated.get(authority);
  assert(release, 'Authenticated support authority required');
  const { descriptor } = authority;
  assert(Array.isArray(owningPackages), 'Packed owners must be an array');
  const directPackages = new Set();
  const optionalEffectPeers = new Set();
  const frameworkPeers = new Set();
  for (const owner of owningPackages) {
    protocol.exactKeys(
      owner,
      ['role', 'bytes', 'supportPackages'],
      'packed owner',
    );
    assert(
      owner.role === 'framework-peer' || owner.role === 'root-direct',
      'Packed support input requires an explicit framework-peer or root-direct role',
    );
    assert(Buffer.isBuffer(owner.bytes), 'Packed owner archive bytes required');
    assert(
      Array.isArray(owner.supportPackages) && owner.supportPackages.length,
    );
    assert.equal(
      new Set(owner.supportPackages).size,
      owner.supportPackages.length,
    );
    const manifest = inspectNpmTarball(owner.bytes).packageJson;
    assert.deepEqual(
      manifest.ultramodern?.supportArtifacts,
      descriptor,
      'Packed owner must commit to the exact support descriptor',
    );
    for (const name of owner.supportPackages) {
      assert(
        Object.hasOwn(protocol.cohort, name),
        'Unknown owned support package',
      );
      assert(
        !Object.hasOwn(manifest.optionalDependencies ?? {}, name),
        `${name}: support authority cannot be an optional dependency`,
      );
      if (owner.role === 'framework-peer') {
        assert(
          !Object.hasOwn(manifest.dependencies ?? {}, name),
          `${name}: framework peer must not ship a support implementation dependency`,
        );
        const development = manifest.devDependencies?.[name];
        if (development !== undefined)
          assert(
            development === protocol.cohort[name] ||
              development === descriptor.packages[name].request,
            `${name}: framework development input must select exact support authority`,
          );
      } else {
        const declarations = ['dependencies', 'devDependencies'].filter(block =>
          Object.hasOwn(manifest[block] ?? {}, name),
        );
        assert(
          declarations.length,
          `${name}: missing packed root direct request`,
        );
        for (const block of declarations)
          assert.equal(
            manifest[block][name],
            descriptor.packages[name].request,
            `${name}: packed root ${block} differs from support request`,
          );
        directPackages.add(name);
      }
      if (
        (owner.role === 'framework-peer' &&
          (!Object.hasOwn(manifest.devDependencies ?? {}, name) ||
            Object.hasOwn(manifest.peerDependencies ?? {}, name))) ||
        Object.hasOwn(manifest.peerDependencies ?? {}, name) ||
        Object.hasOwn(manifest.peerDependenciesMeta ?? {}, name)
      ) {
        if (owner.role === 'framework-peer') frameworkPeers.add(name);
        assert.equal(
          manifest.peerDependencies?.[name],
          protocol.cohort[name],
          `${name}: packed owner must require exact support peer`,
        );
        if (manifest.peerDependenciesMeta?.[name]?.optional === true) {
          assert(
            owner.role === 'framework-peer' && name === '@effect/opentelemetry',
            `${name}: only Effect integration may declare an optional support peer`,
          );
          optionalEffectPeers.add(name);
        }
      }
    }
    for (const name of Object.keys(protocol.cohort))
      if (
        [...blocks, 'peerDependencies', 'peerDependenciesMeta'].some(block =>
          Object.hasOwn(manifest[block] ?? {}, name),
        )
      )
        assert(
          owner.supportPackages.includes(name),
          `${name}: undeclared owner edge`,
        );
  }
  for (const name of optionalEffectPeers)
    assert(
      directPackages.has(name),
      'Selected Effect integration requires a validated direct host request',
    );
  if (owningPackages.some(owner => owner.role === 'root-direct'))
    for (const name of frameworkPeers)
      assert(
        directPackages.has(name),
        `${name}: framework peer requires a selected direct host`,
      );
  const selected = owningPackages.some(owner => owner.role === 'root-direct')
    ? directPackages
    : new Set(owningPackages.flatMap(owner => owner.supportPackages));
  assert(selected.size, 'Selected packed support owners required');
  signal?.throwIfAborted();
  assert(
    process.env.OWNED_TEMP_DIR,
    'Verify support inputs through owned-temp-dir',
  );
  const scratch = fs.mkdtempSync(
    path.join(fs.realpathSync(process.env.OWNED_TEMP_DIR), 'support-consumer-'),
  );
  try {
    const recipe = releaseRecipe();
    const pins = {};
    for (const name of selected) {
      const artifact = descriptor.packages[name];
      const canonicalBytes = await reconstructSelectedSupport({
        name,
        recipe,
        scratch,
        fetchArtifact,
        signal,
      });
      const canonical = {
        version: protocol.cohort[name],
        request: protocol.releaseUrl(
          descriptor.producer,
          protocol.assetFilename(name, protocol.cohort[name]),
        ),
        upstream: recipe.packages[name].upstream,
        patchSha256: recipe.packages[name].patchSha256,
      };
      // Compressed bytes have their own authenticated identity; only tar bytes
      // are canonical across Node/zlib providers.
      const { integrity: _integrity, ...identity } = artifact;
      assert.deepEqual(
        identity,
        canonical,
        'Support descriptor differs from canonical corrected archive authority',
      );
      signal?.throwIfAborted();
      const bytes = await readBytes(artifact.request, {
        fetchArtifact,
        signal,
      });
      const filename = protocol.assetFilename(name, artifact.version);
      assert.equal(
        protocol.integrity(bytes),
        artifact.integrity,
        `${name}: support archive SHA512 mismatch`,
      );
      assert.equal(
        release.assets.find(asset => asset.name === filename).digest,
        `sha256:${protocol.sha256(bytes)}`,
        `${name}: GitHub asset digest mismatch`,
      );
      assert(
        gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 }).equals(
          gunzipSync(canonicalBytes, { maxOutputLength: 128 * 1024 * 1024 }),
        ),
        `${name}: canonical corrected archive authority: tar bytes mismatch`,
      );
      const packed = inspectSupportTarball(bytes);
      assert.equal(
        packed.packageJson.name,
        name,
        'Support archive identity mismatch',
      );
      assert.equal(
        packed.packageJson.version,
        artifact.version,
        'Support archive version mismatch',
      );
      pins[name] = { ...artifact, filename };
    }
    signal?.throwIfAborted();
    return freeze(pins);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// Reconstruct only selected payloads. The envelope is always the closed cohort;
// an unrelated tool's archive is never admitted on behalf of this importer.
async function reconstructSelectedSupport({
  name,
  recipe,
  scratch,
  fetchArtifact,
  signal,
}) {
  const item = recipe.packages[name];
  const patch = fs.readFileSync(item.patchPath);
  assert.equal(
    protocol.sha256(patch),
    item.patchSha256,
    `${name}: canonical patch digest`,
  );
  const upstream = await readBytes(item.upstream.request, {
    fetchArtifact,
    signal,
  });
  assert.equal(
    protocol.integrity(upstream),
    item.upstream.integrity,
    `${name}: upstream npm integrity`,
  );
  const original = inspectSupportTarball(upstream);
  const validateLicense = files =>
    artifactPolicy(protocol).validateNpmLicense({
      name,
      upstream: item.upstream,
      files,
    });
  validateLicense(original.fileContents);
  const directory = path.join(scratch, name.replaceAll('/', '__'));
  fs.mkdirSync(directory);
  for (const file of original.files) {
    const absolute = path.join(directory, file.path);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, original.fileContents.get(file.path), {
      flag: 'wx',
      mode: file.mode & 0o777,
    });
  }
  applyExactPatch(patch, directory);
  const files = new Map();
  function collect(relative = '') {
    for (const entry of fs.readdirSync(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const file = path.posix.join(relative, entry.name);
      assert(!entry.isSymbolicLink(), 'Symlink in reconstructed archive');
      if (entry.isDirectory()) collect(file);
      else {
        assert(entry.isFile(), 'Non-file in reconstructed archive');
        const absolute = path.join(directory, file);
        files.set(file, {
          bytes: fs.readFileSync(absolute),
          mode: fs.statSync(absolute).mode,
        });
      }
    }
  }
  collect();
  validateLicense(
    new Map([...files].map(([file, value]) => [file, value.bytes])),
  );
  return packFiles(files);
}

/** Full admission: authentication alone never returns validated consumer pins. */
export async function verifySupportInputs({
  descriptor,
  owningPackages,
  readGithub,
  fetchArtifact = fetch,
  signal,
}) {
  const authority = await authSupportDescriptor({
    descriptor,
    readGithub,
    fetchArtifact,
    signal,
  });
  return verifyPackedSupportInputs({
    authority,
    owningPackages,
    fetchArtifact,
    signal,
  });
}
