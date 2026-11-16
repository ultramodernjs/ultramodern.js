import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateSolidModuleManifest } from '../../../packages/runtime/renderer-solid/src/manifest.ts';

const identity = {
  renderer: 'solid',
  appId: 'admission',
  entryName: 'index',
  protocolVersion: 1,
  buildId: 'build-a',
};

function currentManifest() {
  return {
    schemaVersion: 1,
    renderer: 'solid',
    compilerVersion: '2.0.0-rc.22',
    rendererIdentity: { ...identity },
    modules: {
      _base: '/',
      'src/Lazy.tsx': {
        file: 'static/js/solid-lazy.a.js',
        css: ['static/css/lazy.a.css'],
      },
    },
  };
}

test('accepts the exact current native module inventory', () => {
  const manifest = currentManifest();
  assert.equal(
    validateSolidModuleManifest(manifest, identity, ['src/Lazy.tsx']),
    manifest,
  );
  assert.deepEqual(
    validateSolidModuleManifest(manifest, identity, ['src/Lazy.tsx']).modules[
      'src/Lazy.tsx'
    ],
    manifest.modules['src/Lazy.tsx'],
  );
});

test('checks a reused manifest object against each expected identity', () => {
  const manifest = currentManifest();
  assert.equal(validateSolidModuleManifest(manifest, identity), manifest);
  assert.equal(validateSolidModuleManifest(manifest, identity), manifest);
  assert.throws(
    () =>
      validateSolidModuleManifest(manifest, {
        ...identity,
        buildId: 'build-b',
      }),
    /Stale Solid module manifest identity/,
  );
  assert.throws(
    () => validateSolidModuleManifest(manifest, identity, ['src/Missing.tsx']),
    /is missing src\/Missing.tsx/,
  );
});

test('rejects a missing module manifest before renderer lookup', () => {
  assert.throws(
    () => validateSolidModuleManifest(undefined, identity),
    /Missing Solid module manifest/,
  );
});

test('rejects a manifest produced by another compiler ABI', () => {
  const manifest = currentManifest();
  manifest.compilerVersion = '2.0.0-rc.15';
  assert.throws(
    () => validateSolidModuleManifest(manifest, identity),
    /compiler ABI mismatch/,
  );
});

test('rejects a manifest without the application build identity', () => {
  const manifest = currentManifest();
  delete manifest.rendererIdentity;
  assert.throws(
    () => validateSolidModuleManifest(manifest, identity),
    /current Solid application build identity/,
  );
});

test('rejects identity drift in every request namespace field', () => {
  for (const [field, value] of [
    ['renderer', 'octane'],
    ['appId', 'another-app'],
    ['entryName', 'another-entry'],
    ['protocolVersion', 2],
    ['buildId', 'build-b'],
  ]) {
    const manifest = currentManifest();
    manifest.rendererIdentity[field] = value;
    assert.throws(
      () => validateSolidModuleManifest(manifest, identity),
      /Stale Solid module manifest identity/,
    );
  }
});

test('rejects a missing lazy module before native hydration import', () => {
  assert.throws(
    () =>
      validateSolidModuleManifest(currentManifest(), identity, [
        'src/Missing.tsx',
      ]),
    /is missing src\/Missing.tsx/,
  );
});

test('rejects malformed asset records before native entry scanning', () => {
  for (const [description, mutate] of [
    [
      'unrelated null chunk',
      modules => {
        modules.Unrelated = null;
      },
    ],
    [
      'class instance chunk',
      modules => {
        modules.Unrelated = new (class {
          file = 'private.js';
        })();
      },
    ],
    [
      'invalid base URL type',
      modules => {
        modules._base = null;
      },
    ],
    [
      'malformed base URL',
      modules => {
        modules._base = 'https://[';
      },
    ],
    [
      'malformed module URL',
      modules => {
        modules['src/Lazy.tsx'].file = 'https://[';
      },
    ],
    [
      'missing file',
      modules => {
        delete modules['src/Lazy.tsx'].file;
      },
    ],
    [
      'empty file',
      modules => {
        modules['src/Lazy.tsx'].file = '';
      },
    ],
    [
      'CSS string iterated as characters',
      modules => {
        modules['src/Lazy.tsx'].css = 'styles.css';
      },
    ],
    [
      'invalid CSS URL',
      modules => {
        modules['src/Lazy.tsx'].css = [null];
      },
    ],
    [
      'imports string iterated as characters',
      modules => {
        modules['src/Lazy.tsx'].imports = 'Missing';
      },
    ],
    [
      'invalid import key',
      modules => {
        modules['src/Lazy.tsx'].imports = [17];
      },
    ],
    [
      'invalid preload URL',
      modules => {
        modules['src/Lazy.tsx'].preloads = [false];
      },
    ],
    [
      'invalid entry flag',
      modules => {
        modules['src/Lazy.tsx'].isEntry = 'yes';
      },
    ],
  ]) {
    const manifest = currentManifest();
    mutate(manifest.modules);
    assert.throws(
      () => validateSolidModuleManifest(manifest, identity),
      Error,
      description,
    );
  }
});

test('rejects missing and inherited chunk dependencies', () => {
  for (const key of ['src/Missing.tsx', 'constructor', 'toString']) {
    const manifest = currentManifest();
    manifest.modules['src/Lazy.tsx'].imports = [key];
    assert.throws(
      () => validateSolidModuleManifest(manifest, identity),
      Error,
      key,
    );
  }
});

test('accepts native cyclic asset graphs with valid own chunks', () => {
  const manifest = currentManifest();
  manifest.modules['src/Lazy.tsx'].imports = ['shared-runtime'];
  manifest.modules['shared-runtime'] = {
    file: 'static/js/runtime.js',
    imports: ['src/Lazy.tsx'],
    css: [],
    preloads: [],
    isEntry: false,
  };
  assert.equal(validateSolidModuleManifest(manifest, identity), manifest);
});

test('accepts native preload objects, responsive images and CDN assets', () => {
  const manifest = currentManifest();
  manifest.modules._base = 'https://cdn.example.test/assets/';
  manifest.modules['src/Lazy.tsx'].preloads = [
    { as: 'fetch', href: 'data.json', crossorigin: 'anonymous' },
    { as: 'font', href: 'font.woff2', type: 'font/woff2', crossorigin: true },
    {
      as: 'image',
      imagesrcset: '/small.webp 1x, /large.webp 2x',
      imagesizes: '100vw',
    },
  ];
  assert.equal(validateSolidModuleManifest(manifest, identity), manifest);
});

test('rejects inventory accessors without reading them', () => {
  const manifest = currentManifest();
  let reads = 0;
  Object.defineProperty(manifest.modules, 'private', {
    enumerable: true,
    get() {
      reads++;
      return { file: 'private.js' };
    },
  });
  assert.throws(
    () => validateSolidModuleManifest(manifest, identity),
    /data properties are required/,
  );
  assert.equal(reads, 0);
});
