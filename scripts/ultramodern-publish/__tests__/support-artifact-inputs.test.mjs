import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { packFiles } from '../../ultramodern-artifacts/reconstruct.mjs';
import { releaseBody } from '../../ultramodern-artifacts/transport.mjs';
import {
  inputs,
  supportProtocol as p,
} from '../../ultramodern-support-artifacts/protocol.mjs';
import { releaseRecipe } from '../../ultramodern-support-artifacts/recipes.mjs';
import { reconstruct } from '../../ultramodern-support-artifacts/reconstruct.mjs';
import {
  authSupportDescriptor,
  verifyPackedSupportInputs,
  verifySupportInputs,
} from '../lib/support-artifact-inputs.mjs';

// Explicit synthetic GitHub producer/API evidence; never a hosted acceptance receipt.
// Archive bytes are REAL pinned npm inputs + the actual reviewed canonical patches.
// No installs/builds/qualification callbacks. Run under owned-temp-dir.
let directory;
let canonical;
const upstreamBytes = new Map();
const source = 'a'.repeat(40);
const producer = {
  repository: p.repository,
  repositoryId: p.repositoryId,
  workflow: p.workflow,
  source,
  runId: 123,
  runAttempt: 2,
  tag: `support-artifacts-${source}-123-2`,
};
async function upstreamFetch(url) {
  assert(
    Object.values(inputs).some(input => input.upstream.request === url),
    `Unexpected upstream request ${url}`,
  );
  if (!upstreamBytes.has(url)) {
    const response = await fetch(url);
    assert(response.ok);
    upstreamBytes.set(url, Buffer.from(await response.arrayBuffer()));
  }
  return new Response(upstreamBytes.get(url));
}
before(async () => {
  assert(process.env.OWNED_TEMP_DIR, 'Run tests under owned-temp-dir');
  directory = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'support-test-'),
  );
  canonical = await reconstruct({
    recipe: releaseRecipe(),
    producer,
    directory: path.join(directory, 'canonical'),
    fetchArtifact: upstreamFetch,
  });
});
after(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const manifest = structuredClone(canonical);
  const payloads = new Map(
    Object.entries(p.cohort).map(([name, version]) => {
      const filename = p.assetFilename(name, version);
      return [
        filename,
        fs.readFileSync(path.join(directory, 'canonical', filename)),
      ];
    }),
  );
  const repo = { id: p.repositoryId, full_name: p.repository };
  const run = {
    id: producer.runId,
    run_attempt: producer.runAttempt,
    repository: { ...repo },
    head_repository: { ...repo },
    head_sha: source,
    path: p.workflow,
    event: 'workflow_dispatch',
    head_branch: 'main-ultramodern',
    actor: { login: 'BleedingDev' },
    triggering_actor: { login: 'BleedingDev' },
    status: 'completed',
    conclusion: 'success',
  };
  const jobs = {
    total_count: 2,
    jobs: ['produce', 'qualify'].map(name => ({
      name,
      head_sha: source,
      status: 'completed',
      conclusion: 'success',
    })),
  };
  const ref = {
    ref: `refs/tags/${producer.tag}`,
    object: { type: 'commit', sha: source },
  };
  const f = { manifest, payloads, repo, run, jobs, ref, downloads: [] };
  f.seal = () => {
    f.descriptor = p.descriptorFor(manifest);
    f.owningPackages = [owner(f)];
    payloads.set(p.manifestFilename, p.manifestBytes(manifest));
    f.release = {
      tag_name: producer.tag,
      target_commitish: source,
      draft: false,
      prerelease: false,
      html_url: `https://github.com/${p.repository}/releases/tag/${producer.tag}`,
      body: releaseBody({ protocol: p, descriptor: f.descriptor }),
      assets: [...payloads].map(([name, bytes], index) => ({
        id: index + 1,
        name,
        state: 'uploaded',
        digest: `sha256:${p.sha256(bytes)}`,
        browser_download_url: p.releaseUrl(producer, name),
      })),
    };
  };
  f.seal();
  f.readGithub = async route => {
    const base = `/repos/${p.repository}`;
    const routes = new Map([
      [`/repositories/${p.repositoryId}`, f.repo],
      [`${base}/actions/runs/123/attempts/2`, f.run],
      [`${base}/actions/runs/123/attempts/2/jobs?per_page=100`, f.jobs],
      [`${base}/git/ref/tags/${producer.tag}`, f.ref],
      [`${base}/releases/tags/${producer.tag}`, f.release],
    ]);
    assert(routes.has(route), `Unexpected GitHub route ${route}`);
    return routes.get(route);
  };
  f.fetchArtifact = async url => {
    f.downloads.push(url);
    if (url.startsWith('https://registry.npmjs.org/'))
      return upstreamFetch(url);
    const entry = [...payloads].find(
      ([name]) => p.releaseUrl(producer, name) === url,
    );
    return new Response(entry?.[1] ?? 'missing', { status: entry ? 200 : 404 });
  };
  return f;
}
function owner(f, mutate = () => {}) {
  const manifest = {
    name: '@unit/packed-owner',
    version: '1.0.0',
    ultramodern: { supportArtifacts: f.descriptor },
    dependencies: Object.fromEntries(
      Object.entries(f.descriptor.packages).map(([name, item]) => [
        name,
        item.request,
      ]),
    ),
    peerDependencies: { ...p.cohort },
  };
  mutate(manifest);
  return {
    bytes: packFiles(
      new Map([
        [
          'package.json',
          { bytes: Buffer.from(JSON.stringify(manifest)), mode: 0o644 },
        ],
      ]),
    ),
    role: 'root-direct',
    supportPackages: Object.keys(p.cohort),
  };
}
test('full byte-backed admission returns immutable canonical pins and checks packed owners', async () => {
  const f = fixture();
  const pins = await verifySupportInputs({ ...f, owningPackages: [owner(f)] });
  assert.deepEqual(Object.keys(pins).sort(), Object.keys(p.cohort).sort());
  for (const [name, pin] of Object.entries(pins)) {
    assert.equal(pin.integrity, p.integrity(f.payloads.get(pin.filename)));
    assert(f.downloads.includes(pin.request));
    assert(Object.isFrozen(pin) && Object.isFrozen(pin.upstream));
    assert.throws(() => {
      pin.upstream.request = 'https://evil.invalid';
    });
    assert.equal(pin.version, p.cohort[name]);
  }
  assert(Object.isFrozen(pins));
  assert(f.downloads.includes(f.descriptor.manifest.request));
});
test('validation-only or forged authority cannot admit pins', async () => {
  const f = fixture();
  await assert.rejects(
    verifyPackedSupportInputs({ authority: { descriptor: f.descriptor } }),
  );
  await assert.rejects(
    verifySupportInputs({
      ...f,
      fetchArtifact: async () => new Response('not manifest'),
    }),
  );
  const authority = await authSupportDescriptor(f);
  await assert.rejects(
    verifyPackedSupportInputs({
      authority,
      fetchArtifact: async () => new Response('not archive'),
    }),
  );
});
for (const [label, mutate] of Object.entries({
  source: f => {
    f.run.head_sha = 'b'.repeat(40);
  },
  attempt: f => {
    f.run.run_attempt++;
  },
  repository: f => {
    f.run.repository.id++;
  },
  'head repository': f => {
    f.run.head_repository.id++;
  },
  workflow: f => {
    f.run.path = '.github/workflows/native-renderer-artifacts.yml';
  },
  tag: f => {
    f.ref.object.sha = 'b'.repeat(40);
  },
  'failed qualification': f => {
    f.jobs.jobs[1].conclusion = 'failure';
  },
  'missing asset': f => {
    f.release.assets.pop();
  },
  'extra asset': f => {
    f.release.assets.push({ ...f.release.assets[0], name: 'other.tgz' });
  },
  'asset digest': f => {
    f.release.assets[1].digest = `sha256:${'0'.repeat(64)}`;
  },
  'manifest digest': f => {
    f.release.assets.find(a => a.name === p.manifestFilename).digest =
      `sha256:${'0'.repeat(64)}`;
  },
}))
  test(`rejects authenticated evidence mutation: ${label}`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(verifySupportInputs(f));
  });
for (const [label, mutate] of Object.entries({
  legacy: d => {
    delete d.protocol;
  },
  native: d => {
    d.protocol = 'ultramodern.native-artifacts.v1';
  },
  mixed: d => {
    d.packages.octane = d.packages['solid-js'];
  },
  cohort: d => {
    delete d.packages['@rstest/core'];
  },
  version: d => {
    d.packages['solid-js'].version = '2.0.0-rc.21';
  },
  source: d => {
    d.packages['solid-js'].upstream.commit = 'b'.repeat(40);
  },
  patch: d => {
    d.packages['solid-js'].patchSha256 = '0'.repeat(64);
  },
  unknown: d => {
    d.skip = true;
  },
  'nested unknown': d => {
    d.packages['solid-js'].bypass = true;
  },
}))
  test(`typed presence commits, rejecting ${label}`, async () => {
    const f = fixture();
    mutate(f.descriptor);
    await assert.rejects(verifySupportInputs(f));
  });
for (const [label, mutate] of Object.entries({
  request: m => {
    m.dependencies['solid-js'] = '2.0.0-rc.22';
  },
  peer: m => {
    m.peerDependencies['solid-js'] = '^2.0.0-rc.22';
  },
  missing: m => {
    delete m.dependencies['solid-js'];
  },
  conflict: m => {
    m.devDependencies = { 'solid-js': 'wrong' };
  },
  optional: m => {
    m.peerDependenciesMeta = { 'solid-js': { optional: true } };
  },
  descriptor: m => {
    m.ultramodern.supportArtifacts = { 'solid-js': 'legacy' };
  },
}))
  test(`packed owner rejects ${label}`, async () => {
    const f = fixture();
    await assert.rejects(
      verifySupportInputs({ ...f, owningPackages: [owner(f, mutate)] }),
    );
  });
for (const variant of ['name', 'version', 'root', 'substitution'])
  test(`re-sealed ${variant} bytes cannot substitute canonical reconstruction`, async () => {
    const f = fixture();
    const name = 'solid-js';
    const filename = p.assetFilename(name, p.cohort[name]);
    let bytes = packFiles(
      new Map([
        [
          'package.json',
          {
            mode: 0o644,
            bytes: Buffer.from(
              JSON.stringify({
                name: variant === 'name' ? 'octane' : name,
                version: variant === 'version' ? '1.0.0' : p.cohort[name],
              }),
            ),
          },
        ],
      ]),
    );
    if (variant === 'root') {
      const tar = gunzipSync(bytes);
      tar.write('foreign/package.json\0', 0);
      tar.fill(32, 148, 156);
      tar.write(
        `${tar
          .subarray(0, 512)
          .reduce((sum, byte) => sum + byte, 0)
          .toString(8)
          .padStart(6, '0')}\0 `,
        148,
      );
      bytes = gzipSync(tar);
    }
    f.payloads.set(filename, bytes);
    f.manifest.packages[name].integrity = p.integrity(bytes);
    f.seal();
    await assert.rejects(
      verifySupportInputs(f),
      /canonical corrected archive authority/,
    );
  });

test('authenticated transport may use another gzip provider but must preserve every canonical tar byte', async () => {
  const f = fixture();
  for (const [name, item] of Object.entries(f.manifest.packages)) {
    const filename = p.assetFilename(name, item.version);
    const original = f.payloads.get(filename);
    const recompressed = gzipSync(gunzipSync(original), { level: 1 });
    assert(!recompressed.equals(original), 'Control must change encoded bytes');
    f.payloads.set(filename, recompressed);
    item.integrity = p.integrity(recompressed);
  }
  f.seal();
  const pins = await verifySupportInputs(f);
  for (const item of Object.values(pins))
    assert.equal(item.integrity, p.integrity(f.payloads.get(item.filename)));
});

test('re-sealing gzip and metadata cannot hide changed canonical tar content', async () => {
  const f = fixture();
  const filename = p.assetFilename('solid-js', p.cohort['solid-js']);
  const tar = gunzipSync(f.payloads.get(filename));
  const source = Buffer.from('heldRead');
  const index = tar.indexOf(source);
  assert(index >= 0);
  tar[index] = 'H'.charCodeAt(0);
  const bytes = gzipSync(tar, { level: 1 });
  f.payloads.set(filename, bytes);
  f.manifest.packages['solid-js'].integrity = p.integrity(bytes);
  f.seal();
  await assert.rejects(verifySupportInputs(f), /canonical.*tar|tar.*canonical/);
});

test('transport corruption with unchanged descriptor fails SHA512, and abort is honored', async () => {
  const f = fixture();
  f.payloads.set(
    p.assetFilename('solid-js', p.cohort['solid-js']),
    Buffer.from('corrupt'),
  );
  await assert.rejects(verifySupportInputs(f), /SHA512 mismatch/);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(
    verifySupportInputs({ ...fixture(), signal: controller.signal }),
    /cancelled/,
  );
});

test('a packed owner may own a subset, but cannot conceal another support edge', async () => {
  const f = fixture();
  const packed = owner(f, manifest => {
    manifest.dependencies = {
      'solid-js': f.descriptor.packages['solid-js'].request,
    };
    manifest.peerDependencies = { 'solid-js': p.cohort['solid-js'] };
  });
  packed.supportPackages = ['solid-js'];
  assert.equal(
    Object.keys(await verifySupportInputs({ ...f, owningPackages: [packed] }))
      .length,
    1,
  );
  await assert.rejects(
    verifySupportInputs({ ...f, owningPackages: [packed, frameworkOwner(f)] }),
    /requires a selected direct host/,
  );
  const concealed = owner(f);
  concealed.supportPackages = ['solid-js'];
  await assert.rejects(
    verifySupportInputs({ ...f, owningPackages: [concealed] }),
    /undeclared owner edge/,
  );
});

test('authenticated descriptor is a frozen snapshot, not mutable caller authority', async () => {
  const f = fixture();
  const authority = await authSupportDescriptor(f);
  f.descriptor.packages['solid-js'].request =
    'https://evil.invalid/substitute.tgz';
  assert(Object.isFrozen(authority.descriptor.packages['solid-js']));
  const pins = await verifyPackedSupportInputs({
    authority,
    owningPackages: f.owningPackages,
    fetchArtifact: f.fetchArtifact,
  });
  assert.equal(
    pins['solid-js'].request,
    canonical.packages['solid-js'].request,
  );
});

test('a caller source expectation never bypasses actual GitHub source authentication', async () => {
  const f = fixture();
  f.run.head_sha = 'b'.repeat(40);
  await assert.rejects(
    verifySupportInputs({ ...f, expectedSource: f.run.head_sha }),
  );
});

// pnpm12.21 blockExoticSubdeps rejects a framework's transitive URL even when
// the root has the identical direct URL. Framework peers and root authorities
// therefore have distinct contracts, exercised through actual packed bytes.
test('role regression: framework semver peers need no implementation URL', async () => {
  const f = fixture();
  const packed = owner(f, manifest => {
    delete manifest.dependencies;
  });
  packed.role = 'framework-peer';
  const pins = await verifySupportInputs({ ...f, owningPackages: [packed] });
  assert.equal(pins['solid-js'].version, p.cohort['solid-js']);
});

test('role regression: root direct URL authority does not need redundant peers', async () => {
  const f = fixture();
  const packed = owner(f, manifest => {
    delete manifest.peerDependencies;
  });
  packed.role = 'root-direct';
  const pins = await verifySupportInputs({ ...f, owningPackages: [packed] });
  assert.equal(
    pins['solid-js'].request,
    f.descriptor.packages['solid-js'].request,
  );
});

test('role regression: ambiguous packed input has no default role', async () => {
  const f = fixture();
  const packed = owner(f);
  delete packed.role;
  await assert.rejects(verifySupportInputs({ ...f, owningPackages: [packed] }));
});

function frameworkOwner(f, mutate = () => {}) {
  const packed = owner(f, manifest => {
    delete manifest.dependencies;
    mutate(manifest);
  });
  packed.role = 'framework-peer';
  return packed;
}

for (const [label, mutate] of Object.entries({
  'URL runtime dependency': (m, f) => {
    m.dependencies = { 'solid-js': f.descriptor.packages['solid-js'].request };
  },
  'semver runtime dependency': m => {
    m.dependencies = { 'solid-js': p.cohort['solid-js'] };
  },
  'optional URL dependency': (m, f) => {
    m.optionalDependencies = {
      'solid-js': f.descriptor.packages['solid-js'].request,
    };
  },
  'missing peer': m => {
    delete m.peerDependencies['solid-js'];
  },
  'range peer': m => {
    m.peerDependencies['solid-js'] = '^2.0.0-rc.22';
  },
  'URL peer': (m, f) => {
    m.peerDependencies['solid-js'] = f.descriptor.packages['solid-js'].request;
  },
  'optional peer': m => {
    m.peerDependenciesMeta = { 'solid-js': { optional: true } };
  },
  'wrong dev URL': m => {
    m.devDependencies = { 'solid-js': 'https://evil.invalid/solid.tgz' };
  },
  'range dev request': m => {
    m.devDependencies = { 'solid-js': '^2.0.0-rc.22' };
  },
  'mixed descriptor': m => {
    m.ultramodern = {
      supportArtifacts: { protocol: 'ultramodern.native-artifacts.v1' },
    };
  },
  'missing descriptor': m => {
    delete m.ultramodern;
  },
}))
  test(`framework-peer rejects ${label} even beside a valid root`, async () => {
    const f = fixture();
    const framework = frameworkOwner(f, manifest => mutate(manifest, f));
    await assert.rejects(
      verifySupportInputs({ ...f, owningPackages: [owner(f), framework] }),
    );
  });

test('framework dev-only exact URL or version is not required as a shipping dependency', async () => {
  const f = fixture();
  for (const request of [
    f.descriptor.packages['solid-js'].request,
    p.cohort['solid-js'],
  ]) {
    const framework = frameworkOwner(f, manifest => {
      manifest.devDependencies = { 'solid-js': request };
      manifest.ultramodern = { supportArtifacts: f.descriptor };
    });
    const pins = await verifySupportInputs({
      ...f,
      owningPackages: [owner(f), framework],
    });
    assert.equal(
      pins['solid-js'].request,
      f.descriptor.packages['solid-js'].request,
    );
  }
});

for (const [label, mutate] of Object.entries({
  'missing descriptor': m => {
    delete m.ultramodern;
  },
  'peer-only selection': m => {
    delete m.dependencies;
  },
  'optional-only selection': m => {
    m.optionalDependencies = m.dependencies;
    delete m.dependencies;
  },
  'optional duplicate': m => {
    m.optionalDependencies = { 'solid-js': m.dependencies['solid-js'] };
  },
  'wrong dev authority': m => {
    m.devDependencies = { 'solid-js': p.cohort['solid-js'] };
  },
}))
  test(`root-direct rejects ${label}`, async () => {
    const f = fixture();
    await assert.rejects(
      verifySupportInputs({ ...f, owningPackages: [owner(f, mutate)] }),
    );
  });

test('root-direct accepts exact dev authority without imposing framework peers', async () => {
  const f = fixture();
  const root = owner(f, manifest => {
    manifest.devDependencies = manifest.dependencies;
    delete manifest.dependencies;
    delete manifest.peerDependencies;
  });
  assert.equal(
    Object.keys(await verifySupportInputs({ ...f, owningPackages: [root] }))
      .length,
    6,
  );
});

for (const role of ['framework-peer', 'root-direct'])
  test(`${role} rejects concealed support edges`, async () => {
    const f = fixture();
    const packed = role === 'framework-peer' ? frameworkOwner(f) : owner(f);
    packed.supportPackages = ['solid-js'];
    await assert.rejects(
      verifySupportInputs({ ...f, owningPackages: [packed] }),
      /undeclared owner edge/,
    );
  });

test('only the owning Effect integration may declare a descriptor-bound optional peer', async () => {
  const f = fixture();
  const name = '@effect/opentelemetry';
  const framework = frameworkOwner(f, manifest => {
    manifest.peerDependencies = { [name]: p.cohort[name] };
    manifest.peerDependenciesMeta = { [name]: { optional: true } };
  });
  framework.supportPackages = [name];
  const pins = await verifySupportInputs({
    ...f,
    owningPackages: [owner(f), framework],
  });
  assert.equal(pins[name].request, f.descriptor.packages[name].request);
  await assert.rejects(
    verifySupportInputs({ ...f, owningPackages: [framework] }),
    /Effect.*direct|direct.*Effect/,
  );
  const wrong = frameworkOwner(f, manifest => {
    manifest.peerDependenciesMeta = { 'solid-js': { optional: true } };
  });
  await assert.rejects(
    verifySupportInputs({ ...f, owningPackages: [owner(f), wrong] }),
    /optional.*Effect|Effect.*optional/,
  );
});

for (const [label, mutate] of Object.entries({
  'unknown role': packed => {
    packed.role = 'source-build';
  },
  'manifest projection': packed => {
    packed.packageJson = { peerDependencies: p.cohort };
  },
  'manifest instead of bytes': packed => {
    packed.bytes = { name: '@unit/projected' };
  },
  'duplicate ownership': packed => {
    packed.supportPackages.push('solid-js');
  },
  'unknown ownership': packed => {
    packed.supportPackages.push('octane');
  },
}))
  test(`closed packed boundary rejects ${label}`, async () => {
    const f = fixture();
    const packed = owner(f);
    mutate(packed);
    await assert.rejects(
      verifySupportInputs({ ...f, owningPackages: [packed] }),
    );
  });
