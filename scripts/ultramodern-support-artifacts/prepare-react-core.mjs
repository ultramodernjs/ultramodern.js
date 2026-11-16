#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBytes } from '../ultramodern-artifacts/transport.mjs';
import { inspectNpmTarball } from '../ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import * as native from '../ultramodern-renderers/native-artifacts/protocol.mjs';
import { authenticateDescriptor } from '../ultramodern-renderers/native-artifacts/transport.mjs';

const coreName = '@tanstack/router-core';
const corePatch =
  '546a4a8ecd4cc45419bff0c99c860ab2c9e2d1a8ffd4b1512cedd748e9b5cac8';
const coreUpstream = Object.freeze({
  request:
    'https://registry.npmjs.org/@tanstack/router-core/-/router-core-1.171.39.tgz',
  integrity:
    'sha512-qUhoJ0meuSUqGYQbHbcJYdASr06YtK+bulbj6vtrhKYFkLgkSsZ6tXmMyym7sFxiSJSPYgasgozrL01LyyR/6A==',
  repository: 'TanStack/router',
  commit: '6b9fe6d29552270836c511bc9b343d73541f4424',
  sourceArchiveIntegrity:
    'sha512-2kt6Ugd5Dbc8kNtlUk6R7xo3u+kqgO/N+4VH30wUUvs3p4mpQwj0AhYJXMv/zqZ3wNZAuYzwEA+GmNz5yNQMmA==',
  licenseSha256:
    'a405ee70c632bb938acb7ac5f210e814409b3760ea9d2329d8ed8ffcfd11a0e7',
});

export async function prepareReactCore({
  manifestUrl,
  directory,
  readGithub,
  fetchArtifact = fetch,
  signal = AbortSignal.timeout(120000),
}) {
  assert.equal(typeof manifestUrl, 'string');
  assert.match(
    manifestUrl,
    /^https:\/\/github\.com\/ultramodernjs\/ultramodern\.js\/releases\/download\/native-renderers-[a-f0-9]{40}-[1-9][0-9]*-[1-9][0-9]*\/native-artifacts\.json$/u,
    'An exact same-repository native manifest release URL is required',
  );
  assert(path.isAbsolute(directory), 'Absolute RUNNER_TEMP required');
  assert(fs.statSync(directory).isDirectory());
  assert.equal(
    native.sha256(
      fs.readFileSync(
        new URL(
          '../../patches/@tanstack__router-core@1.171.39.patch',
          import.meta.url,
        ),
      ),
    ),
    corePatch,
    'Reviewed core patch changed',
  );
  const bytes = await readBytes(manifestUrl, {
    fetchArtifact,
    signal,
    limit: 1024 * 1024,
  });
  const manifest = native.validateManifest(JSON.parse(bytes));
  assert(
    bytes.equals(native.manifestBytes(manifest)),
    'Noncanonical native manifest',
  );
  const descriptor = native.descriptorFor(manifest);
  assert.equal(
    descriptor.manifest.request,
    manifestUrl,
    'Manifest source/tag URL mismatch',
  );
  const core = descriptor.packages[coreName];
  assert.equal(core.version, '1.171.39');
  assert.equal(core.patchSha256, corePatch, 'Unreviewed corrected core patch');
  assert.deepEqual(
    core.upstream,
    coreUpstream,
    'Unreviewed core source identity',
  );
  const release = await authenticateDescriptor(descriptor, {
    readGithub,
    fetchArtifact,
    signal,
  });
  const archive = await readBytes(core.request, { fetchArtifact, signal });
  assert.equal(
    native.integrity(archive),
    core.integrity,
    'Actual core SHA512 mismatch',
  );
  const asset = release.assets.find(
    item => item.name === native.assetFilename(coreName, core.version),
  );
  assert.equal(
    asset.digest,
    `sha256:${native.sha256(archive)}`,
    'Actual core GitHub SHA256 mismatch',
  );
  const inspected = inspectNpmTarball(archive);
  assert.equal(inspected.packageJson.name, coreName);
  assert.equal(inspected.packageJson.version, core.version);
  assert.equal(
    native.sha256(inspected.fileContents.get('LICENSE')),
    coreUpstream.licenseSha256,
  );
  const destination = path.join(directory, 'support-react-core.tgz');
  fs.writeFileSync(destination, archive, { flag: 'wx', mode: 0o600 });
  return destination;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [manifestUrl, ...extra] = process.argv.slice(2);
  assert.equal(
    extra.length,
    0,
    'Use prepare-react-core.mjs <exact-native-manifest-url>',
  );
  console.log(
    await prepareReactCore({
      manifestUrl,
      directory: process.env.RUNNER_TEMP,
    }),
  );
}
