import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { packFiles } from '../ultramodern-artifacts/reconstruct.mjs';
import {
  authSupportDescriptor,
  verifyPackedSupportInputs,
} from '../ultramodern-publish/lib/support-artifact-inputs.mjs';
import * as native from '../ultramodern-renderers/native-artifacts/protocol.mjs';
import { releaseRecipe } from '../ultramodern-renderers/native-artifacts/recipes.mjs';
import { reconstruct } from '../ultramodern-renderers/native-artifacts/reconstruct.mjs';
import {
  authenticateDescriptor,
  githubReader,
  readBytes,
} from '../ultramodern-renderers/native-artifacts/transport.mjs';
import { nativeFederationArtifacts } from '../ultramodern-renderers/native-federation-inputs.mjs';
import { supportProtocol } from '../ultramodern-support-artifacts/protocol.mjs';
import { githubReader as supportReader } from '../ultramodern-support-artifacts/transport.mjs';

const admitted = new WeakMap();
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Opaque, process-local capability: JSON, a URL map, or a cloned receipt is not authority. */
export function admittedArtifacts(authority) {
  if (authority === undefined) return {};
  assert(
    admitted.has(authority),
    'Verified artifact admission authority required',
  );
  return admitted.get(authority);
}

/** No activation or owning-source builds: authenticate CI and reconstruct its reviewed archive inputs. */
export async function admitArtifactDescriptors({
  nativeDescriptor,
  supportDescriptor,
  fetchArtifact = fetch,
  readNativeGithub,
  readSupportGithub,
  signal,
}) {
  assert(
    nativeDescriptor || supportDescriptor,
    'Explicit artifact descriptor required',
  );
  assert(process.env.OWNED_TEMP_DIR, 'Admit artifacts through owned-temp-dir');
  // Snapshot before the first await; mutable caller data cannot change the authority.
  const descriptors = freeze(
    structuredClone({
      ...(nativeDescriptor ? { nativeArtifacts: nativeDescriptor } : {}),
      ...(supportDescriptor ? { supportArtifacts: supportDescriptor } : {}),
    }),
  );
  signal?.throwIfAborted();
  if (descriptors.nativeArtifacts) {
    const descriptor = descriptors.nativeArtifacts;
    native.validateDescriptor(descriptor);
    const recipe = releaseRecipe();
    for (const [name, item] of Object.entries(recipe.packages)) {
      assert.equal(
        descriptor.packages[name].patchSha256,
        item.patchSha256,
        `${name}: unreviewed native patch`,
      );
      assert.deepEqual(
        descriptor.packages[name].upstream,
        item.upstream,
        `${name}: unreviewed native upstream`,
      );
    }
    const release = await authenticateDescriptor(descriptor, {
      readGithub:
        readNativeGithub ??
        githubReader({ token: process.env.GH_TOKEN, fetchArtifact, signal }),
      fetchArtifact,
      signal,
    });
    // Reuse the typed renderer admission contract without asserting a real packed
    // owner was accepted. The updater separately enforces the actual source edges.
    nativeFederationArtifacts({
      sourceName: '@modern-js/renderer-octane',
      targetName: '@modern-js/renderer-octane',
      packageJson: {
        name: '@modern-js/renderer-octane',
        peerDependencies: native.cohort,
        devDependencies: Object.fromEntries(
          Object.entries(descriptor.packages).map(([name, item]) => [
            name,
            item.request,
          ]),
        ),
        ultramodern: {
          sourceName: '@modern-js/renderer-octane',
          nativeArtifacts: descriptor,
        },
      },
    });
    const scratch = fs.mkdtempSync(
      path.join(fs.realpathSync(process.env.OWNED_TEMP_DIR), 'updater-native-'),
    );
    try {
      const directory = path.join(scratch, 'canonical');
      await reconstruct({
        recipe,
        producer: descriptor.producer,
        directory,
        fetchArtifact,
        signal,
      });
      for (const [name, item] of Object.entries(descriptor.packages)) {
        signal?.throwIfAborted();
        const bytes = await readBytes(item.request, { fetchArtifact, signal });
        assert.equal(
          native.integrity(bytes),
          item.integrity,
          `${name}: native archive SHA512 mismatch`,
        );
        const filename = native.assetFilename(name, item.version);
        assert.equal(
          release.assets.find(asset => asset.name === filename).digest,
          `sha256:${native.sha256(bytes)}`,
          `${name}: GitHub asset digest mismatch`,
        );
        // gzip headers/providers are not canonical; authenticated compressed identity
        // and exact canonical tar identity are distinct obligations.
        assert(
          gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 }).equals(
            gunzipSync(fs.readFileSync(path.join(directory, filename)), {
              maxOutputLength: 128 * 1024 * 1024,
            }),
          ),
          `${name}: canonical native tar bytes mismatch`,
        );
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (descriptors.supportArtifacts) {
    const descriptor = descriptors.supportArtifacts;
    const authority = await authSupportDescriptor({
      descriptor,
      readGithub:
        readSupportGithub ??
        supportReader({ token: process.env.GH_TOKEN, fetchArtifact, signal }),
      fetchArtifact,
      signal,
    });
    // This is a selection envelope, NOT evidence of a published framework owner.
    // The packed-input verifier currently requires a selector to reconstruct all six.
    const selector = {
      name: '@ultramodern-internal/updater-artifact-selection',
      version: '0.0.0',
      peerDependencies: supportProtocol.cohort,
      ultramodern: { supportArtifacts: descriptor },
    };
    await verifyPackedSupportInputs({
      authority,
      fetchArtifact,
      signal,
      owningPackages: [
        {
          role: 'framework-peer',
          supportPackages: Object.keys(supportProtocol.cohort),
          bytes: packFiles(
            new Map([
              [
                'package.json',
                {
                  bytes: Buffer.from(JSON.stringify(selector)),
                  mode: 0o644,
                },
              ],
            ]),
          ),
        },
      ],
    });
  }
  signal?.throwIfAborted();
  const authority = Object.freeze({});
  admitted.set(authority, descriptors);
  return authority;
}
