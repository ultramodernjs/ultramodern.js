import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import {
  nativeFederationArtifacts,
  nativeFederationPackageRequests,
  nativeStartArchiveRequests,
  nativeStartSharedPeers,
  stageNativeFederationInputs,
} from './native-federation-inputs.mjs';

// Fabricated unit controls exercise staging; they never qualify a release.
assert(
  process.env.OWNED_TEMP_DIR,
  'Run these filesystem controls through owned-temp-dir',
);
const names = {
  octane: 'octane',
  '@octanejs/tanstack-router': 'octanejs-tanstack-router',
  '@octanejs/rspack-plugin': 'octanejs-rspack-plugin',
  '@tanstack/router-core': 'tanstack-router-core',
};

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
  for (const shared of [
    ...Object.keys(nativeStartSharedPeers),
    '@octanejs/tanstack-start',
  ])
    assert.throws(
      () =>
        nativeFederationPackageRequests({
          optionalDependencies: { [shared]: request },
        }),
      /cannot be optional/u,
    );
});

function fixture(t, start = false, mutate = () => {}) {
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'native-input-control-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true }));
  const payloads = new Map();
  const manifest = {
    name: '@bleedingdev/modern-js-renderer-octane',
    ultramodern: {
      sourceName: '@modern-js/renderer-octane',
      nativeArtifacts: {},
    },
    devDependencies: {},
    peerDependencies: {},
  };
  for (const [name, basename] of Object.entries({
    ...names,
    ...(start
      ? Object.fromEntries(
          Object.keys(nativeStartSharedPeers).map(name => [
            name,
            `tanstack-${name.slice('@tanstack/'.length)}`,
          ]),
        )
      : {}),
  })) {
    const packageRoot = path.join(root, basename, 'package');
    fs.mkdirSync(packageRoot, { recursive: true });
    const packed = {
      name,
      version: '1.0.0',
      ...(name === '@octanejs/tanstack-router' || nativeStartSharedPeers[name]
        ? {
            peerDependencies: Object.fromEntries(
              (nativeStartSharedPeers[name] ?? ['@tanstack/router-core']).map(
                name => [name, '1.0.0'],
              ),
            ),
          }
        : {}),
    };
    mutate(packed);
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify(packed),
    );
    fs.writeFileSync(
      path.join(packageRoot, 'index.mjs'),
      'export const native = true;\n',
    );
    const archivePath = path.join(root, `${basename}.tgz`);
    execFileSync(
      'tar',
      ['-czf', archivePath, '-C', path.dirname(packageRoot), 'package'],
      { env: { ...process.env, COPYFILE_DISABLE: '1' } },
    );
    const bytes = fs.readFileSync(archivePath);
    const profile = {
      '@tanstack/start-storage-context': 'storage',
      '@tanstack/start-client-core': 'client',
      '@tanstack/start-server-core': 'server',
    }[name];
    const repository = name.startsWith('@tanstack/') ? 'router' : 'octane';
    const tag = profile
      ? `ultramodern-start-${profile}-cccccccccccc`
      : repository === 'router'
        ? 'ultramodern-router-core-bbbbbbbbbbbb'
        : 'ultramodern-octane-aaaaaaaaaaaa';
    const request = `https://github.com/BleedingDev/${repository}/releases/download/${tag}/${basename}-1.0.0.tgz`;
    manifest.ultramodern.nativeArtifacts[name] = {
      request,
      version: '1.0.0',
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    };
    manifest.devDependencies[name] = request;
    manifest.peerDependencies[name] = '1.0.0';
    payloads.set(request, bytes);
  }
  return {
    root,
    payloads,
    rendererPackage: {
      sourceName: '@modern-js/renderer-octane',
      targetName: manifest.name,
      packageJson: manifest,
    },
  };
}
async function server(
  t,
  f,
  responseFor = request => ({ status: 200, bytes: f.payloads.get(request) }),
) {
  const requested = [];
  const server = http.createServer((incoming, response) => {
    const request = decodeURIComponent(incoming.url.slice(1));
    requested.push(request);
    const result = responseFor(request);
    response.writeHead(result.status).end(result.bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  });
  return {
    requested,
    // The production URL policy remains exact HTTPS release URLs. Only this
    // unit control routes those requests through an owned local HTTP server.
    fetchArtifact: (request, options) =>
      fetch(
        `http://127.0.0.1:${server.address().port}/${encodeURIComponent(request)}`,
        options,
      ),
  };
}

test('stages all four exact hosted archive bytes from the packed renderer descriptor', async t => {
  const f = fixture(t);
  const manifest = f.rendererPackage.packageJson;
  manifest.dependencies = { ...manifest.devDependencies };
  manifest.optionalDependencies = { ...manifest.devDependencies };
  const transport = await server(t, f);
  const filename = await stageNativeFederationInputs({
    rendererPackage: f.rendererPackage,
    directory: path.join(f.root, 'staged'),
    fetchArtifact: transport.fetchArtifact,
  });
  const inputs = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.deepEqual(Object.keys(inputs).sort(), Object.keys(names).sort());
  assert.deepEqual(transport.requested.sort(), [...f.payloads.keys()].sort());
  for (const [name, input] of Object.entries(inputs)) {
    assert.deepEqual(
      fs.readFileSync(input.archivePath),
      f.payloads.get(input.request),
    );
    assert.equal(
      input.integrity,
      f.rendererPackage.packageJson.ultramodern.nativeArtifacts[name].integrity,
    );
  }
});

test('stages the complete declared Start peer authority and rejects partial or foreign requests', async t => {
  const f = fixture(t, true);
  const manifest = f.rendererPackage.packageJson;
  const requests = nativeStartArchiveRequests(manifest.devDependencies);
  assert.equal(Object.keys(requests).length, 4);
  const transport = await server(t, f);
  const filename = await stageNativeFederationInputs({
    rendererPackage: f.rendererPackage,
    directory: path.join(f.root, 'staged'),
    fetchArtifact: transport.fetchArtifact,
  });
  const inputs = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.equal(Object.keys(inputs).length, 7);
  for (const [name, request] of Object.entries(requests))
    assert.equal(inputs[name].request, request);
  const partial = structuredClone(f.rendererPackage);
  delete partial.packageJson.ultramodern.nativeArtifacts[
    '@tanstack/start-server-core'
  ];
  assert.throws(() => nativeFederationArtifacts(partial), /complete/u);
  const missing = { ...manifest.devDependencies };
  delete missing['@tanstack/start-client-core'];
  assert.throws(
    () => nativeStartArchiveRequests(missing),
    /Incomplete native Start closure/u,
  );
  assert.throws(
    () =>
      nativeStartArchiveRequests({
        ...manifest.devDependencies,
        '@tanstack/start-client-core': '1.0.0',
      }),
    /owning hosted/u,
  );
});

for (const conflict of ['version', 'dependency', 'optional'])
  test(`rejects authenticated Start archives with a conflicting shared ${conflict}`, async t => {
    const f = fixture(t, true, packed => {
      if (packed.name !== '@tanstack/start-client-core') return;
      if (conflict === 'version')
        packed.peerDependencies['@tanstack/router-core'] = '2.0.0';
      if (conflict === 'dependency')
        packed.dependencies = { '@tanstack/router-core': '1.0.0' };
      if (conflict === 'optional')
        packed.peerDependenciesMeta = {
          '@tanstack/router-core': { optional: true },
        };
    });
    const transport = await server(t, f);
    const directory = path.join(f.root, 'staged');
    await assert.rejects(
      stageNativeFederationInputs({
        rendererPackage: f.rendererPackage,
        directory,
        fetchArtifact: transport.fetchArtifact,
      }),
    );
    assert.equal(fs.existsSync(directory), false);
  });

test('rejects a conflicting production or optional request even when the dev request matches', t => {
  const f = fixture(t);
  for (const block of ['dependencies', 'optionalDependencies']) {
    const candidate = structuredClone(f.rendererPackage);
    candidate.packageJson[block] = { octane: '1.0.0' };
    assert.throws(
      () => nativeFederationArtifacts(candidate),
      new RegExp(
        block === 'dependencies'
          ? 'Conflicting native request: octane'
          : `octane differs from its packed renderer ${block} request`,
        'u',
      ),
    );
  }
  const optionalOnly = structuredClone(f.rendererPackage);
  optionalOnly.packageJson.optionalDependencies =
    optionalOnly.packageJson.devDependencies;
  delete optionalOnly.packageJson.devDependencies;
  assert.deepEqual(
    nativeFederationArtifacts(optionalOnly),
    nativeFederationArtifacts(f.rendererPackage),
  );
  delete optionalOnly.packageJson.optionalDependencies.octane;
  assert.throws(
    () => nativeFederationArtifacts(optionalOnly),
    /octane is missing its packed renderer request/u,
  );
});

test('rejects absent, extra, mixed-cohort and unhosted descriptor requests before staging', t => {
  const f = fixture(t);
  const original = f.rendererPackage;
  const rejects = alter => {
    const candidate = structuredClone(original);
    alter(candidate.packageJson);
    assert.throws(() => nativeFederationArtifacts(candidate));
  };
  rejects(manifest => {
    manifest.devDependencies['@octanejs/tanstack-start'] = '1.0.0';
  });
  rejects(manifest => {
    delete manifest.ultramodern.nativeArtifacts;
  });
  rejects(manifest => {
    delete manifest.ultramodern.nativeArtifacts.octane;
  });
  rejects(manifest => {
    manifest.ultramodern.nativeArtifacts.unexpected = {};
  });
  rejects(manifest => {
    manifest.ultramodern.nativeArtifacts.octane.request =
      'http://github.com/BleedingDev/octane/releases/download/ultramodern-octane-aaaaaaaaaaaa/octane-1.0.0.tgz';
  });
  rejects(manifest => {
    manifest.ultramodern.nativeArtifacts.octane.request += '?download=true';
  });
  rejects(manifest => {
    manifest.ultramodern.nativeArtifacts.octane.request =
      'https://registry.npmjs.org/octane/-/octane-1.0.0.tgz';
  });
  rejects(manifest => {
    manifest.ultramodern.nativeArtifacts.octane.request =
      manifest.ultramodern.nativeArtifacts.octane.request.replace(
        'aaaaaaaaaaaa',
        'cccccccccccc',
      );
  });
  rejects(manifest => {
    manifest.devDependencies.octane = '1.0.0';
  });
  rejects(manifest => {
    manifest.peerDependencies.octane = '2.0.0';
  });
});

for (const failure of ['HTTP', 'bytes', 'identity'])
  test(`preserves the ${failure} failure and retires only partially staged outputs`, async t => {
    const f = fixture(t);
    const callerFile = path.join(f.root, 'caller-original');
    fs.writeFileSync(callerFile, 'preserve');
    const coreRequest =
      f.rendererPackage.packageJson.ultramodern.nativeArtifacts[
        '@tanstack/router-core'
      ].request;
    const transport = await server(t, f, request => {
      if (request !== coreRequest)
        return { status: 200, bytes: f.payloads.get(request) };
      if (failure === 'HTTP')
        return { status: 503, bytes: Buffer.from('unavailable') };
      if (failure === 'identity') {
        const bytes = f.payloads.get(
          f.rendererPackage.packageJson.ultramodern.nativeArtifacts.octane
            .request,
        );
        return { status: 200, bytes };
      }
      return { status: 200, bytes: Buffer.from('altered bytes') };
    });
    // The descriptor is fixed before staging starts; this control intentionally
    // binds the wrong package bytes to prove the independent tar identity check.
    if (failure === 'identity') {
      const bytes = f.payloads.get(
        f.rendererPackage.packageJson.ultramodern.nativeArtifacts.octane
          .request,
      );
      f.rendererPackage.packageJson.ultramodern.nativeArtifacts[
        '@tanstack/router-core'
      ].integrity =
        `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    }
    const directory = path.join(f.root, 'staged');
    await assert.rejects(
      stageNativeFederationInputs({
        rendererPackage: f.rendererPackage,
        directory,
        fetchArtifact: transport.fetchArtifact,
      }),
      failure === 'HTTP'
        ? /HTTP 503/u
        : failure === 'identity'
          ? /another package identity/u
          : /integrity mismatch/u,
    );
    assert.equal(fs.existsSync(directory), false);
    assert.equal(fs.readFileSync(callerFile, 'utf8'), 'preserve');
    assert.equal(transport.requested.length, 4);
  });

test('does not reuse or remove an existing caller directory', async t => {
  const f = fixture(t);
  const directory = path.join(f.root, 'existing');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'original'), 'preserve');
  await assert.rejects(
    stageNativeFederationInputs({
      rendererPackage: f.rendererPackage,
      directory,
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
  const f = fixture(t);
  const cancellation = new AbortController();
  const reason = new Error('owned staging interrupted');
  let calls = 0;
  const directory = path.join(f.root, 'interrupted');
  await assert.rejects(
    stageNativeFederationInputs({
      rendererPackage: f.rendererPackage,
      directory,
      signal: cancellation.signal,
      fetchArtifact: async request => {
        if (++calls === 2) {
          cancellation.abort(reason);
          cancellation.signal.throwIfAborted();
        }
        return new Response(f.payloads.get(request));
      },
    }),
    error => error === reason,
  );
  assert.equal(calls, 2);
  assert.equal(fs.existsSync(directory), false);
  assert(fs.existsSync(path.join(f.root, 'octane.tgz')));
});
