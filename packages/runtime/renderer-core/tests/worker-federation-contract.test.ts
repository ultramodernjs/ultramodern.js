import {
  admitWorkerFederationExpose,
  readWorkerFederationEnvelope,
  workerFederationEnvelope,
  workerFederationWireJson,
} from '../src/worker-federation/contract';
import {
  manifestFixture,
  requestCoordinate,
} from './worker-federation.fixture';

function admitted() {
  return admitWorkerFederationExpose({
    ...requestCoordinate,
    manifest: manifestFixture(),
  });
}

test('pins the complete canonical publication and the exact locale endpoint', () => {
  const manifest = manifestFixture();
  const result = admitWorkerFederationExpose({
    ...requestCoordinate,
    manifest,
  });
  expect(result.endpoint).toBe(
    'https://tractor.example/en/_mf/fragment/widget',
  );
  expect(result.identity.buildId).toBe('built-remote');
  expect(result.authority.renderer).toEqual(
    manifest.metaData.ultramodernRenderer,
  );
  manifest.metaData.ultramodernRenderer.identities.index.buildId =
    'later-build';
  manifest.metaData.ultramodernWorkerFederation.exposes['./Widget'].paths.en =
    '/other';
  expect(result.identity.buildId).toBe('built-remote');
  expect(result.authority.worker.exposes['./Widget'].paths.en).toBe(
    '/en/_mf/fragment/widget',
  );
  expect(Object.isFrozen(result.authority.renderer.identities.index)).toBe(
    true,
  );
});

test.each(['runtime', 'bootstrap'] as const)(
  'rejects incompatible canonical %s before any endpoint can be selected',
  field => {
    const manifest = manifestFixture();
    manifest.metaData.ultramodernRenderer[field].version = 'foreign-version';
    expect(() =>
      admitWorkerFederationExpose({ ...requestCoordinate, manifest }),
    ).toThrow();
  },
);

test('delegates renderer profile and every entry identity to the canonical validator', () => {
  const manifest = manifestFixture();
  manifest.metaData.ultramodernRenderer.identities.index.renderer = 'solid';
  expect(() =>
    admitWorkerFederationExpose({ ...requestCoordinate, manifest }),
  ).toThrow();
  const profile = manifestFixture();
  profile.metaData.ultramodernRenderer.profile.compiler.version =
    'foreign-compiler';
  expect(() =>
    admitWorkerFederationExpose({ ...requestCoordinate, manifest: profile }),
  ).toThrow();
});

test.each([
  { remote: 'another-remote' },
  { expose: './Missing' },
  { locale: 'de' },
])('rejects unpublished request coordinates %j', coordinate => {
  expect(() =>
    admitWorkerFederationExpose({
      ...requestCoordinate,
      ...coordinate,
      manifest: manifestFixture(),
    }),
  ).toThrow();
});

test.each([
  'file:///tmp/mf-manifest.json',
  'data:application/json,{}',
  'https://user:password@tractor.example/mf-manifest.json',
  'https://tractor.example/mf-manifest.json#another-publication',
])('rejects a non-publication URL %s', manifestUrl => {
  expect(() =>
    admitWorkerFederationExpose({
      ...requestCoordinate,
      manifestUrl,
      manifest: manifestFixture(),
    }),
  ).toThrow();
});

test.each([
  '//another.example/fragment',
  '/{locale}/fragment',
  '/en/../fragment',
  '/en/%2e%2e/fragment',
  '/en/%252e%252e/fragment',
  '/en/fragment?import=another',
  '/en/fragment#another',
  '/en\\fragment',
])('rejects an endpoint which could change its selected path %s', path => {
  const manifest = manifestFixture();
  manifest.metaData.ultramodernWorkerFederation.exposes['./Widget'].paths.en =
    path;
  expect(() =>
    admitWorkerFederationExpose({ ...requestCoordinate, manifest }),
  ).toThrow();
});

test('rejects unbuilt entries, duplicate endpoints and undeclared publication fields', () => {
  const unbuilt = manifestFixture();
  unbuilt.metaData.ultramodernWorkerFederation.exposes['./Widget'].entryName =
    'other';
  expect(() =>
    admitWorkerFederationExpose({ ...requestCoordinate, manifest: unbuilt }),
  ).toThrow('no built entry');
  const duplicate = manifestFixture();
  duplicate.metaData.ultramodernWorkerFederation.exposes['./Widget'].paths.fr =
    duplicate.metaData.ultramodernWorkerFederation.exposes['./Widget'].paths.en;
  expect(() =>
    admitWorkerFederationExpose({ ...requestCoordinate, manifest: duplicate }),
  ).toThrow('conflicting endpoint');
  const unknown = manifestFixture();
  Object.assign(unknown.metaData.ultramodernWorkerFederation, {
    import: './foreign.ts',
  });
  expect(() =>
    admitWorkerFederationExpose({ ...requestCoordinate, manifest: unknown }),
  ).toThrow('unsupported fields');
});

test('accepts structural field ordering and returns native payload without interpreting it', () => {
  const authority = admitted();
  const payload = {
    nativeCodec: { arbitrary: ['<div>native bytes</div>', { seeds: [1, 2] }] },
  };
  const envelope = JSON.parse(
    workerFederationWireJson(
      workerFederationEnvelope('response', authority, payload),
    ),
  );
  expect(readWorkerFederationEnvelope(envelope, 'response', authority)).toEqual(
    payload,
  );
  expect(
    readWorkerFederationEnvelope(
      workerFederationEnvelope('response', authority, payload),
      'response',
      authority,
    ),
  ).toBe(payload);
});

test.each(['build', 'origin', 'path', 'locale', 'protocol', 'extra'])(
  'rejects changed response authority %s',
  field => {
    const authority = admitted();
    const envelope = JSON.parse(
      workerFederationWireJson(
        workerFederationEnvelope('response', authority, {}),
      ),
    );
    if (field === 'build')
      envelope.authority.renderer.identities.index.buildId = 'new-build';
    if (field === 'origin')
      envelope.authority.origin = 'https://foreign.example';
    if (field === 'path')
      envelope.authority.worker.exposes['./Widget'].paths.en = '/foreign';
    if (field === 'locale') envelope.locale = 'fr';
    if (field === 'protocol') envelope.schemaVersion = 2;
    if (field === 'extra') envelope.import = './foreign.ts';
    expect(() =>
      readWorkerFederationEnvelope(envelope, 'response', authority),
    ).toThrow();
  },
);

test('rejects native values that have not passed the native wire codec', () => {
  expect(() => workerFederationWireJson({ callback: () => 1 })).toThrow();
  expect(() => workerFederationWireJson({ seed: undefined })).toThrow();
  expect(() => workerFederationWireJson({ seed: Number.NaN })).toThrow();
});
