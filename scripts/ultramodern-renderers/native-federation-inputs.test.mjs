import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture as producerFixture } from './native-artifacts/fixtures.test-support.mjs';
import {
  integrity,
  manifestBytes,
  manifestFilename,
  sha256,
} from './native-artifacts/protocol.mjs';
import { packFiles } from './native-artifacts/reconstruct.mjs';
import { releaseBody } from './native-artifacts/transport.mjs';
import {
  assertNativeStartPeers,
  nativeFederationArtifacts,
  nativeFederationPackageRequests,
  nativeStartArchiveRequests,
  nativeStartSharedPeers,
  stageNativeFederationInputs,
} from './native-federation-inputs.mjs';

// Fabricated unit controls exercise admission and staging; they never qualify
// a release. Producer identities come from the owning protocol's test fixture.
assert(
  process.env.OWNED_TEMP_DIR,
  'Run these filesystem controls through owned-temp-dir',
);
const startNames = [
  '@octanejs/tanstack-start',
  ...Object.keys(nativeStartSharedPeers),
];

function renderer(t) {
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'native-input-control-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true }));
  const producer = producerFixture();
  const { packages } = producer.descriptor;
  const requested = [];
  const rendererPackage = {
    sourceName: '@modern-js/renderer-octane',
    targetName: '@bleedingdev/modern-js-renderer-octane',
    packageJson: {
      name: '@bleedingdev/modern-js-renderer-octane',
      ultramodern: {
        sourceName: '@modern-js/renderer-octane',
        nativeArtifacts: producer.descriptor,
      },
      devDependencies: Object.fromEntries(
        Object.entries(packages).map(([name, item]) => [name, item.request]),
      ),
      peerDependencies: Object.fromEntries(
        Object.entries(packages).map(([name, item]) => [name, item.version]),
      ),
    },
  };
  const fetchArtifact = (request, init) => {
    requested.push(new URL(request).pathname.split('/').at(-1));
    return producer.fetchArtifact(request, init);
  };
  return {
    root,
    producer,
    requested,
    rendererPackage,
    stage: (directory, options = {}) =>
      stageNativeFederationInputs({
        rendererPackage,
        directory: path.join(root, directory),
        readGithub: producer.readGithub,
        fetchArtifact,
        ...options,
      }),
  };
}

/** Republish one fabricated archive with a consistent manifest and release. */
function republish(producer, name, bytes) {
  const item = producer.descriptor.packages[name];
  producer.payloads.set(
    new URL(item.request).pathname.split('/').at(-1),
    bytes,
  );
  item.integrity = integrity(bytes);
  const manifest = manifestBytes(producer.manifest);
  producer.payloads.set(manifestFilename, manifest);
  producer.descriptor.manifest.integrity = integrity(manifest);
  producer.evidence.release.body = releaseBody(producer.descriptor);
  for (const asset of producer.evidence.release.assets)
    asset.digest = `sha256:${sha256(producer.payloads.get(asset.name))}`;
}
const pack = packageJson =>
  packFiles(
    new Map([
      [
        'package.json',
        { bytes: Buffer.from(JSON.stringify(packageJson)), mode: 0o644 },
      ],
    ]),
  );

/** The retired pre-activation layout: an untyped map of BleedingDev URLs. */
function retiredFlatLayout(start = false) {
  const digest = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
  const entries = {
    octane: ['octane', 'ultramodern-octane-aaaaaaaaaaaa', 'octane'],
    '@octanejs/tanstack-router': [
      'octane',
      'ultramodern-octane-aaaaaaaaaaaa',
      'octanejs-tanstack-router',
    ],
    '@octanejs/rspack-plugin': [
      'octane',
      'ultramodern-octane-aaaaaaaaaaaa',
      'octanejs-rspack-plugin',
    ],
    '@tanstack/router-core': [
      'router',
      'ultramodern-router-core-bbbbbbbbbbbb',
      'tanstack-router-core',
    ],
    ...(start
      ? Object.fromEntries(
          Object.entries({
            '@tanstack/start-storage-context': 'storage',
            '@tanstack/start-client-core': 'client',
            '@tanstack/start-server-core': 'server',
          }).map(([name, profile]) => [
            name,
            [
              'router',
              `ultramodern-start-${profile}-cccccccccccc`,
              `tanstack-${name.slice('@tanstack/'.length)}`,
            ],
          ]),
        )
      : {}),
  };
  return Object.fromEntries(
    Object.entries(entries).map(([name, [repository, tag, basename]]) => [
      name,
      {
        request: `https://github.com/BleedingDev/${repository}/releases/download/${tag}/${basename}-1.0.0.tgz`,
        version: '1.0.0',
        integrity: digest,
      },
    ]),
  );
}

test('shared native requests reject conflicting blocks and optional Start authority', () => {
  const name = '@tanstack/start-client-core';
  const request = 'https://example.test/client.tgz';
  assert.deepEqual(
    nativeFederationPackageRequests({
      dependencies: { [name]: request },
      devDependencies: { [name]: request },
    }),
    { [name]: request },
  );
  for (const shared of [
    '@tanstack/router-core',
    name,
    '@octanejs/tanstack-start',
  ])
    assert.throws(
      () =>
        nativeFederationPackageRequests({
          dependencies: { [shared]: request },
          devDependencies: { [shared]: '1.0.0' },
        }),
      /Conflicting native request/u,
    );
  for (const shared of startNames)
    assert.throws(
      () =>
        nativeFederationPackageRequests({
          optionalDependencies: { [shared]: request },
        }),
      /cannot be optional/u,
    );
});

test('stages the four authenticated producer archives from the packed renderer descriptor', async t => {
  const f = renderer(t);
  const filename = await f.stage('staged');
  const inputs = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const { packages } = f.producer.descriptor;
  assert.deepEqual(Object.keys(inputs).sort(), Object.keys(packages).sort());
  assert.deepEqual(
    f.requested.toSorted(),
    [...f.producer.payloads.keys()].toSorted(),
  );
  for (const [name, input] of Object.entries(inputs)) {
    assert.equal(input.request, packages[name].request);
    assert.equal(input.integrity, packages[name].integrity);
    assert.deepEqual(
      fs.readFileSync(input.archivePath),
      f.producer.payloads.get(path.basename(input.archivePath)),
    );
  }
});

test('rejects the retired flat BleedingDev layout before any staging', async t => {
  for (const start of [false, true]) {
    const f = renderer(t);
    const manifest = f.rendererPackage.packageJson;
    const flat = retiredFlatLayout(start);
    manifest.ultramodern.nativeArtifacts = flat;
    manifest.devDependencies = Object.fromEntries(
      Object.entries(flat).map(([name, item]) => [name, item.request]),
    );
    manifest.peerDependencies = Object.fromEntries(
      Object.entries(flat).map(([name, item]) => [name, item.version]),
    );
    assert.throws(
      () => nativeFederationArtifacts(f.rendererPackage),
      /native descriptor: unknown or missing fields/u,
    );
    const directory = path.join(f.root, 'flat');
    await assert.rejects(
      f.stage('flat', {
        readGithub: () => assert.fail('must not authenticate'),
        fetchArtifact: () => assert.fail('must not fetch'),
      }),
      /native descriptor: unknown or missing fields/u,
    );
    assert.equal(fs.existsSync(directory), false);
  }
  const mixed = renderer(t).rendererPackage;
  Object.assign(
    mixed.packageJson.ultramodern.nativeArtifacts,
    retiredFlatLayout(),
  );
  assert.throws(
    () => nativeFederationArtifacts(mixed),
    /native descriptor: unknown or missing fields/u,
  );
});

test('typed producer v1 rejects any declared Start closure', t => {
  for (const name of startNames)
    for (const block of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const candidate = structuredClone(renderer(t).rendererPackage);
      candidate.packageJson[block] = {
        ...candidate.packageJson[block],
        [name]: '1.0.0',
      };
      assert.throws(
        () => nativeFederationArtifacts(candidate),
        /does not qualify a Start closure|Native Start authority cannot be optional/u,
      );
    }
  const extra = structuredClone(renderer(t).rendererPackage);
  extra.packageJson.ultramodern.nativeArtifacts.packages[
    '@tanstack/start-client-core'
  ] = structuredClone(
    extra.packageJson.ultramodern.nativeArtifacts.packages[
      '@tanstack/router-core'
    ],
  );
  assert.throws(
    () => nativeFederationArtifacts(extra),
    /complete closed native cohort/u,
  );
});

test('explicit Start closure guards stay separate from the typed producer', () => {
  const requests = Object.fromEntries(
    Object.entries(retiredFlatLayout(true)).map(([name, item]) => [
      name,
      item.request,
    ]),
  );
  assert.deepEqual(nativeStartArchiveRequests({ octane: requests.octane }), {});
  assert.deepEqual(
    Object.keys(nativeStartArchiveRequests(requests)).sort(),
    ['@tanstack/router-core', ...Object.keys(nativeStartSharedPeers)].sort(),
  );
  const missing = { ...requests };
  delete missing['@tanstack/start-client-core'];
  assert.throws(
    () => nativeStartArchiveRequests(missing),
    /Incomplete native Start closure/u,
  );
  assert.throws(
    () =>
      nativeStartArchiveRequests({
        ...requests,
        '@tanstack/start-client-core': '1.0.0',
      }),
    /owning hosted/u,
  );
  const versions = {
    '@tanstack/router-core': '1.0.0',
    '@tanstack/start-storage-context': '1.0.0',
    '@tanstack/start-client-core': '1.0.0',
  };
  const client = () => ({
    name: '@tanstack/start-client-core',
    peerDependencies: {
      '@tanstack/router-core': '1.0.0',
      '@tanstack/start-storage-context': '1.0.0',
    },
  });
  assertNativeStartPeers(client(), versions);
  for (const [conflict, alter, error] of [
    [
      'version',
      packed => {
        packed.peerDependencies['@tanstack/router-core'] = '2.0.0';
      },
      /selected exact shared/u,
    ],
    [
      'dependency',
      packed => {
        packed.dependencies = { '@tanstack/router-core': '1.0.0' };
      },
      /Expected values to be strictly equal/u,
    ],
    [
      'optional',
      packed => {
        packed.peerDependenciesMeta = {
          '@tanstack/router-core': { optional: true },
        };
      },
      /Expected "actual" to be strictly unequal/u,
    ],
  ]) {
    const packed = client();
    alter(packed);
    assert.throws(
      () => assertNativeStartPeers(packed, versions),
      error,
      conflict,
    );
  }
  assert.throws(
    () =>
      assertNativeStartPeers(client(), {
        '@tanstack/router-core': '1.0.0',
      }),
    /Missing shared Start authority/u,
  );
});

test('typed renderer owns exact peers without archive implementation edges', t => {
  const f = renderer(t);
  const { packages } = f.producer.descriptor;
  const peerOnly = structuredClone(f.rendererPackage);
  delete peerOnly.packageJson.devDependencies;
  const admitted = nativeFederationArtifacts(peerOnly);
  assert.deepEqual(admitted, nativeFederationArtifacts(f.rendererPackage));
  assert.deepEqual(Object.keys(admitted).sort(), Object.keys(packages).sort());
  const rejects = (alter, error) => {
    const candidate = structuredClone(f.rendererPackage);
    alter(candidate.packageJson);
    assert.throws(() => nativeFederationArtifacts(candidate), error);
  };
  rejects(manifest => {
    manifest.dependencies = { octane: packages.octane.request };
  }, /implementation dependency/u);
  rejects(manifest => {
    manifest.dependencies = { octane: packages.octane.version };
  }, /Conflicting native request: octane/u);
  rejects(manifest => {
    manifest.optionalDependencies = { octane: packages.octane.request };
  }, /optional dependency/u);
  rejects(manifest => {
    manifest.devDependencies.octane = packages.octane.version;
  }, /octane differs from its packed renderer devDependencies request/u);
  rejects(manifest => {
    manifest.peerDependencies.octane = '0.0.1';
  }, /octane differs from its packed renderer peer/u);
  rejects(manifest => {
    delete manifest.peerDependencies['@tanstack/router-core'];
  }, /router-core differs from its packed renderer peer/u);
  rejects(manifest => {
    manifest.peerDependenciesMeta = {
      '@tanstack/router-core': { optional: true },
    };
  }, /shared core peer must be required/u);
});

test('rejects absent, incomplete, extra, foreign and non-canonical descriptors before staging', t => {
  const f = renderer(t);
  const rejects = alter => {
    const candidate = structuredClone(f.rendererPackage);
    alter(
      candidate.packageJson,
      candidate.packageJson.ultramodern.nativeArtifacts,
    );
    assert.throws(() => nativeFederationArtifacts(candidate));
  };
  rejects(manifest => {
    delete manifest.ultramodern.nativeArtifacts;
  });
  rejects((_, descriptor) => {
    delete descriptor.producer;
  });
  rejects((_, descriptor) => {
    delete descriptor.packages.octane;
  });
  rejects((_, descriptor) => {
    descriptor.packages.unexpected = descriptor.packages.octane;
  });
  rejects((_, descriptor) => {
    descriptor.protocol = 'ultramodern.native-artifacts.v0';
  });
  rejects((_, descriptor) => {
    descriptor.packages.octane.request =
      descriptor.packages.octane.request.replace('https:', 'http:');
  });
  rejects((_, descriptor) => {
    descriptor.packages.octane.request += '?download=true';
  });
  rejects((_, descriptor) => {
    descriptor.packages.octane.request =
      descriptor.packages.octane.upstream.request;
  });
  rejects((_, descriptor) => {
    descriptor.packages.octane.request =
      descriptor.packages.octane.request.replace(
        'ultramodernjs/ultramodern.js',
        'BleedingDev/octane',
      );
  });
  rejects((_, descriptor) => {
    descriptor.manifest.request = descriptor.packages.octane.request;
  });
  rejects((_, descriptor) => {
    descriptor.packages.octane.version = '0.0.1';
  });
});

for (const failure of ['HTTP', 'bytes', 'identity', 'router peer'])
  test(`preserves the ${failure} failure and retires only partially staged outputs`, async t => {
    const f = renderer(t);
    const callerFile = path.join(f.root, 'caller-original');
    fs.writeFileSync(callerFile, 'preserve');
    const core = f.producer.descriptor.packages['@tanstack/router-core'];
    const coreFile = new URL(core.request).pathname.split('/').at(-1);
    // The descriptor is fixed before staging starts; identity controls publish
    // consistent wrong bytes to prove the independent tar identity checks.
    if (failure === 'identity')
      republish(
        f.producer,
        '@tanstack/router-core',
        f.producer.payloads.get(
          new URL(f.producer.descriptor.packages.octane.request).pathname
            .split('/')
            .at(-1),
        ),
      );
    if (failure === 'router peer')
      republish(
        f.producer,
        '@octanejs/tanstack-router',
        pack({
          name: '@octanejs/tanstack-router',
          version:
            f.producer.descriptor.packages['@octanejs/tanstack-router'].version,
          peerDependencies: { '@tanstack/router-core': '0.0.1' },
        }),
      );
    const fetchArtifact = async (request, init) => {
      f.requested.push(new URL(request).pathname.split('/').at(-1));
      if (new URL(request).pathname.endsWith(`/${coreFile}`)) {
        if (failure === 'HTTP')
          return new Response('unavailable', { status: 503 });
        if (failure === 'bytes') return new Response('altered bytes');
      }
      return f.producer.fetchArtifact(request, init);
    };
    const directory = path.join(f.root, 'staged');
    await assert.rejects(
      f.stage('staged', { fetchArtifact }),
      {
        HTTP: /HTTP 503/u,
        bytes: /GitHub asset digest mismatch/u,
        identity: /another package identity/u,
        'router peer': /selected exact shared core/u,
      }[failure],
    );
    assert.equal(fs.existsSync(directory), false);
    assert.equal(fs.readFileSync(callerFile, 'utf8'), 'preserve');
    assert(f.requested.includes(manifestFilename));
  });

for (const failure of ['attempt', 'manifest', 'assetDigest'])
  test(`admits producer archives only after authentication: ${failure}`, async t => {
    const f = renderer(t);
    if (failure === 'attempt') f.producer.evidence.run.run_attempt++;
    if (failure === 'manifest')
      f.producer.payloads.set(manifestFilename, Buffer.from('{}'));
    if (failure === 'assetDigest')
      f.producer.evidence.release.assets[0].digest = `sha256:${'0'.repeat(64)}`;
    const directory = path.join(f.root, failure);
    await assert.rejects(f.stage(failure));
    assert.equal(fs.existsSync(directory), false);
  });

test('does not reuse or remove an existing caller directory', async t => {
  const f = renderer(t);
  const directory = path.join(f.root, 'existing');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'original'), 'preserve');
  await assert.rejects(
    f.stage('existing', {
      readGithub: () => assert.fail('must not authenticate'),
      fetchArtifact: () => assert.fail('must not fetch'),
    }),
    /EEXIST/u,
  );
  assert.equal(
    fs.readFileSync(path.join(directory, 'original'), 'utf8'),
    'preserve',
  );
});

test('interruption preserves its original error and removes only staged downloads', async t => {
  const f = renderer(t);
  const cancellation = new AbortController();
  const reason = new Error('owned staging interrupted');
  let calls = 0;
  const callerFile = path.join(f.root, 'caller-original');
  fs.writeFileSync(callerFile, 'preserve');
  const directory = path.join(f.root, 'interrupted');
  await assert.rejects(
    f.stage('interrupted', {
      signal: cancellation.signal,
      fetchArtifact: async (request, init) => {
        // The first fetch is the authenticated manifest; interrupt an archive.
        if (++calls === 3) {
          cancellation.abort(reason);
          cancellation.signal.throwIfAborted();
        }
        return f.producer.fetchArtifact(request, init);
      },
    }),
    error => error === reason,
  );
  assert.equal(calls, 3);
  assert.equal(fs.existsSync(directory), false);
  assert.equal(fs.readFileSync(callerFile, 'utf8'), 'preserve');
});
