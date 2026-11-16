import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qualifyOtel } from '../ultramodern-dependencies/otel-corrections/portable.mjs';
import { qualifyPeerCorrections } from '../ultramodern-dependencies/test-peer-corrections/qualify.mjs';
import { qualifyReactSupport } from '../ultramodern-renderers/react-router-corrections/support-adapter.mjs';
import {
  qualifyHeldRead,
  qualifyHeldReadPacked,
  readHeldReadRecipeBytes,
} from '../ultramodern-renderers/solid-corrections/qualify-held-read.mjs';
import { inputs, supportProtocol as protocol } from './protocol.mjs';
import { validateRecipe, verifySourceQualification } from './reconstruct.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const peers = ['@rstest/core', 'ioredis-mock', '@types/ioredis-mock'];
export function readRecipes() {
  const packages = Object.fromEntries(
    Object.entries(inputs).map(([name, input]) => {
      const patchPath = path.join(root, input.patchPath);
      assert.equal(
        protocol.sha256(fs.readFileSync(patchPath)),
        input.patchSha256,
        `${name}: owning patch changed; freeze a reviewed handoff`,
      );
      return [
        name,
        { patchPath, patchSha256: input.patchSha256, upstream: input.upstream },
      ];
    }),
  );
  return packages;
}
function context(workDirectory) {
  assert(path.isAbsolute(workDirectory));
  assert(fs.statSync(workDirectory).isDirectory());
  const toolchain = {
    node: process.execPath,
    pnpm: process.env.SUPPORT_PNPM_BINARY ?? 'pnpm',
    storeDirectory:
      process.env.SUPPORT_PNPM_STORE ??
      path.join(process.env.HOME, '.local/share/pnpm/store'),
  };
  assert(
    path.isAbsolute(toolchain.storeDirectory),
    'Absolute external pnpm store required',
  );
  assert(
    path.relative(workDirectory, toolchain.storeDirectory).startsWith('..'),
    'Package store must be outside qualification scratch',
  );
  assert.equal(process.versions.node, '26.13.1');
  return { toolchain, workDirectory };
}
function peerEvidence(result) {
  assert(
    result.gates && result.artifacts.length === 3,
    'metadata owning gates/closed3 receipt required',
  );
  const evidence = {};
  for (const item of result.artifacts) {
    assert(peers.includes(item.name));
    assert.equal(item.version, protocol.cohort[item.name]);
    assert.equal(
      item.upstream.authentication.scheme,
      'npm-registry-ecdsa-sha256+sha512',
    );
    const license = item.licenses.find(
      license => license.path === inputs[item.name].upstream.licensePath,
    );
    assert(license);
    evidence[item.name] = {
      sourceArchiveBytes: Buffer.from(item.upstream.archiveBytes),
      builtPatchBytes: Buffer.from(item.patchBytes),
      licenseBytes: Buffer.from(license.bytes),
    };
  }
  return evidence;
}
function solidEvidence(result) {
  assert.equal(result.status, 'passed');
  return {
    sourceArchiveBytes: result.sourceArchive.bytes,
    builtPatchBytes: result.patches['held-read-declarations.patch'].bytes,
    licenseBytes: result.license.bytes,
  };
}
export function releaseRecipe() {
  const recipe = {
    packages: readRecipes(),
    async qualifySource({ workDirectory }) {
      const { toolchain } = context(workDirectory);
      const solid = await qualifyHeldRead({
        workDirectory: path.join(
          workDirectory,
          `support-solid-${process.pid}-${Date.now()}`,
        ),
        storeDirectory: toolchain.storeDirectory,
        nodeBinary: toolchain.node,
        pnpmBinary: toolchain.pnpm,
        recipeBytes: readHeldReadRecipeBytes(),
      });
      const metadata = await qualifyPeerCorrections({
        workDirectory,
        toolchain,
      });
      const otel = await qualifyOtel({
        workDirectory: path.join(
          workDirectory,
          `support-otel-${process.pid}-${Date.now()}`,
        ),
        toolchain,
      });
      const react = await qualifyReactSupport({ workDirectory, toolchain });
      const evidence = {
        '@tanstack/react-router': react,
        'solid-js': solidEvidence(solid),
        ...peerEvidence(metadata),
        '@effect/opentelemetry': otel,
      };
      verifySourceQualification(recipe, evidence);
      return evidence;
    },
    async qualifyPacked({ directory, manifest, workDirectory }) {
      protocol.validateManifest(manifest);
      const { toolchain } = context(workDirectory);
      const payloads = new Map(
        Object.entries(protocol.cohort).map(([name, version]) => {
          const bytes = fs.readFileSync(
            path.join(directory, protocol.assetFilename(name, version)),
          );
          assert.equal(
            protocol.integrity(bytes),
            manifest.packages[name].integrity,
          );
          return [name, bytes];
        }),
      );
      // React requires the actual core archive explicitly; its qualifier authenticates
      // it against the reviewed correction, never the registry's uncorrected core.
      await qualifyReactSupport({
        workDirectory,
        toolchain,
        reactArchiveBytes: payloads.get('@tanstack/react-router'),
      });
      const solid = await qualifyHeldReadPacked({
        workDirectory: path.join(
          workDirectory,
          `support-solid-packed-${process.pid}-${Date.now()}`,
        ),
        toolchain,
        recipeBytes: readHeldReadRecipeBytes(),
        payloads: new Map([['solid-js', payloads.get('solid-js')]]),
        manifest: {
          name: 'solid-js',
          version: protocol.cohort['solid-js'],
          integrity: manifest.packages['solid-js'].integrity,
        },
      });
      assert.equal(solid.evidence.transport.installedActualPayload, true);
      await qualifyPeerCorrections({
        workDirectory,
        toolchain,
        payloads: Object.fromEntries(
          peers.map(name => [name, payloads.get(name)]),
        ),
      });
      await qualifyOtel({
        workDirectory: path.join(
          workDirectory,
          `support-otel-packed-${process.pid}-${Date.now()}`,
        ),
        toolchain,
        payloads: new Map([
          ['@effect/opentelemetry', payloads.get('@effect/opentelemetry')],
        ]),
      });
    },
  };
  validateRecipe(recipe);
  return recipe;
}
