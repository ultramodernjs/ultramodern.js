import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { packFiles } from '../ultramodern-artifacts/reconstruct.mjs';
import { fixture } from '../ultramodern-renderers/native-artifacts/fixtures.test-support.mjs';
import * as native from '../ultramodern-renderers/native-artifacts/protocol.mjs';
import { releaseBody } from '../ultramodern-renderers/native-artifacts/transport.mjs';
import { prepareReactCore } from './prepare-react-core.mjs';

// Synthetic GitHub controls, never an accepted release receipt.
function control() {
  const value = fixture();
  const provenance = JSON.parse(
    fs.readFileSync(
      new URL(
        '../ultramodern-renderers/router-corrections/provenance.json',
        import.meta.url,
      ),
    ),
  );
  const license = Buffer.from(
    'MIT License\n\nCopyright (c) 2021-present Tanner Linsley\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n',
  );
  const core = value.manifest.packages['@tanstack/router-core'];
  core.patchSha256 = provenance.patchSha256;
  core.upstream = {
    request:
      'https://registry.npmjs.org/@tanstack/router-core/-/router-core-1.171.39.tgz',
    integrity: provenance.upstreamNpmIntegrity,
    repository: 'TanStack/router',
    commit: provenance.upstreamCommit,
    sourceArchiveIntegrity: `sha512-${Buffer.from(provenance.sourceArchiveSha512, 'hex').toString('base64')}`,
    licenseSha256: provenance.licenseSha256,
  };
  const archive = packFiles(
    new Map([
      [
        'package.json',
        {
          bytes: Buffer.from(
            JSON.stringify({
              name: '@tanstack/router-core',
              version: '1.171.39',
            }),
          ),
          mode: 0o644,
        },
      ],
      ['LICENSE', { bytes: license, mode: 0o644 }],
    ]),
  );
  core.integrity = native.integrity(archive);
  const filename = native.assetFilename('@tanstack/router-core', '1.171.39');
  value.payloads.set(filename, archive);
  value.payloads.set(
    native.manifestFilename,
    native.manifestBytes(value.manifest),
  );
  const descriptor = native.descriptorFor(value.manifest);
  value.evidence.release.body = releaseBody(descriptor);
  for (const asset of value.evidence.release.assets)
    asset.digest = `sha256:${native.sha256(value.payloads.get(asset.name))}`;
  return { ...value, descriptor, archive, filename };
}

test('native input authentication downloads exact bytes outside support assets', async t => {
  assert(process.env.OWNED_TEMP_DIR, 'Use owned-temp-dir --run');
  const directory = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'core-control-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const c = control();
  const target = await prepareReactCore({
    manifestUrl: c.descriptor.manifest.request,
    directory,
    readGithub: c.readGithub,
    fetchArtifact: c.fetchArtifact,
  });
  assert.equal(target, path.join(directory, 'support-react-core.tgz'));
  assert(fs.readFileSync(target).equals(c.archive));
  assert.deepEqual(fs.readdirSync(directory), ['support-react-core.tgz']);
});

for (const [label, mutate] of Object.entries({
  'wrong source run': c => {
    c.evidence.run.head_sha = 'b'.repeat(40);
  },
  'failed owning qualification': c => {
    c.evidence.jobs.jobs[1].conclusion = 'failure';
  },
  'draft release': c => {
    c.evidence.release.draft = true;
  },
  'missing native asset': c => {
    c.evidence.release.assets.pop();
  },
  'core GitHub SHA256': c => {
    c.evidence.release.assets.find(a => a.name === c.filename).digest =
      `sha256:${'b'.repeat(64)}`;
  },
  'altered actual archive': c => {
    c.payloads.set(c.filename, Buffer.from('altered'));
  },
  'unreviewed patch': c => {
    c.manifest.packages['@tanstack/router-core'].patchSha256 = 'b'.repeat(64);
    c.payloads.set(native.manifestFilename, native.manifestBytes(c.manifest));
  },
  'noncanonical manifest': c => {
    c.payloads.set(
      native.manifestFilename,
      Buffer.from(JSON.stringify(c.manifest)),
    );
  },
})) {
  test(`native core preparation rejects ${label} before saving input`, async () => {
    const c = control();
    mutate(c);
    await assert.rejects(
      prepareReactCore({
        manifestUrl: c.descriptor.manifest.request,
        directory: process.env.OWNED_TEMP_DIR,
        readGithub: c.readGithub,
        fetchArtifact: c.fetchArtifact,
      }),
    );
    assert(
      !fs.existsSync(
        path.join(process.env.OWNED_TEMP_DIR, 'support-react-core.tgz'),
      ),
    );
  });
}

test('only an explicit same-repository immutable manifest URL may be fetched', async () => {
  for (const manifestUrl of [
    undefined,
    'https://example.com/native-artifacts.json',
    'https://github.com/ultramodernjs/ultramodern.js/releases/latest/download/native-artifacts.json',
    `${control().descriptor.manifest.request}?redirect=untrusted`,
  ])
    await assert.rejects(
      prepareReactCore({
        manifestUrl,
        directory: process.env.OWNED_TEMP_DIR,
        fetchArtifact() {
          throw new Error('URL validation must precede fetch');
        },
      }),
    );
});
