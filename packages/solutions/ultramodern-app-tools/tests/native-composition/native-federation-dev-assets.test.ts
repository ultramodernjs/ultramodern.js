import { describe, expect, it } from '@rstest/core';
import {
  type NativeDevelopmentAsset,
  nativeFederationDevRevision,
  resolveNativeFederationDevAsset,
  retainNativeFederationDevAssets,
} from '../../src/native-composition/native-federation-dev-assets';

const origin = 'http://localhost:43123';
const asset: NativeDevelopmentAsset = {
  bytes: Buffer.from('module.exports = "native-container";'),
  contentType: 'application/javascript',
};
const assets = new Map([
  [`${origin}/bundles/remoteEntry.js`, asset],
  [`${origin}/bundles/Widget%20space.js`, asset],
]);

describe('native federation development asset lookup', () => {
  it('revises the whole admitted graph independently of asset iteration order', () => {
    const graph = new Map([
      [`${origin}/bundles/remoteEntry.js`, asset],
      [
        `${origin}/bundles/lazy.js`,
        { ...asset, bytes: Buffer.from('first lazy') },
      ],
    ]);
    const revision = nativeFederationDevRevision(graph);
    expect(revision).toMatch(/^[a-f0-9]{64}$/u);
    expect(nativeFederationDevRevision(new Map([...graph].reverse()))).toBe(
      revision,
    );
    graph.set(`${origin}/bundles/lazy.js`, {
      ...asset,
      bytes: Buffer.from('second lazy'),
    });
    expect(nativeFederationDevRevision(graph)).not.toBe(revision);
    graph.delete(`${origin}/bundles/lazy.js`);
    expect(nativeFederationDevRevision(graph)).not.toBe(revision);
  });

  it('matches the emitted URL and permits request query strings', () => {
    for (const target of [
      '/bundles/remoteEntry.js',
      '/bundles/remoteEntry.js?build=second',
      '/bundles/Widget%20space.js',
    ])
      expect(resolveNativeFederationDevAsset(assets, target, origin)).toBe(
        asset,
      );
  });

  it('requires the container public origin and an admitted asset name', () => {
    expect(
      resolveNativeFederationDevAsset(
        assets,
        '/bundles/remoteEntry.js',
        'http://foreign.example:43123',
      ),
    ).toBeUndefined();
    for (const target of [
      '/remoteEntry.js',
      '/bundles/main.js',
      '/bundles/renderer-build.json',
      '/bundles/remoteEntry.js.map',
      '/bundles/container.hot-update.js',
      '/bundles/module-federation.config.ts',
    ])
      expect(
        resolveNativeFederationDevAsset(assets, target, origin),
      ).toBeUndefined();
  });

  it.each([
    '/bundles/../bundles/remoteEntry.js',
    '/bundles/./remoteEntry.js',
    '/bundles/%2e%2e/bundles/remoteEntry.js',
    '/bundles/%2E/remoteEntry.js',
    '/bundles/%2fremoteEntry.js',
    '/bundles/%5cremoteEntry.js',
    '/bundles/%00remoteEntry.js',
    '/bundles/%remoteEntry.js',
    '/bundles/%252e%252e/remoteEntry.js',
    '/bundles\\remoteEntry.js',
    '//localhost:43123/bundles/remoteEntry.js',
    'http://localhost:43123/bundles/remoteEntry.js',
    '/bundles/remoteEntry.js#fragment',
  ])('rejects ambiguous request path %s', target => {
    expect(
      resolveNativeFederationDevAsset(assets, target, origin),
    ).toBeUndefined();
  });
});

describe('native federation immutable graph retention', () => {
  const firstUrl = `${origin}/__ultramodern_mf__/a1/remoteEntry.js`;
  const secondUrl = `${origin}/__ultramodern_mf__/b2/remoteEntry.js`;
  const first = { ...asset, immutable: true };
  const second = {
    ...asset,
    bytes: Buffer.from('second completed graph'),
    immutable: true,
  };
  const cost = (url: string, value: NativeDevelopmentAsset) =>
    Buffer.byteLength(url) + value.bytes.length;

  it('admits only immutable assets and reuses the existing accepted bytes', () => {
    const retained = new Map([[firstUrl, first]]);
    const candidate = new Map([
      [firstUrl, { ...first, bytes: Buffer.from(first.bytes) }],
      [`${origin}/mf-manifest.json`, { ...asset, immutable: false }],
      [secondUrl, second],
    ]);
    const next = retainNativeFederationDevAssets(
      retained,
      candidate,
      cost(firstUrl, first) + cost(secondUrl, second),
    );
    expect(next.size).toBe(2);
    expect(next.get(firstUrl)).toBe(first);
    expect(next.get(secondUrl)).toBe(second);
    expect(retained.size).toBe(1);
    expect(retained.has(secondUrl)).toBe(false);
  });

  it('rejects the entire next publication without losing any admitted graph', () => {
    const retained = new Map([[firstUrl, first]]);
    const thirdUrl = `${origin}/__ultramodern_mf__/c3/remoteEntry.js`;
    const candidate = new Map([
      [secondUrl, second],
      [thirdUrl, second],
    ]);
    expect(() =>
      retainNativeFederationDevAssets(
        retained,
        candidate,
        cost(firstUrl, first) + cost(secondUrl, second),
      ),
    ).toThrow('restart the development server');
    expect([...retained]).toEqual([[firstUrl, first]]);
    expect(
      resolveNativeFederationDevAsset(
        retained,
        new URL(firstUrl).pathname,
        origin,
      ),
    ).toBe(first);
    expect(retained.has(secondUrl)).toBe(false);
    expect(retained.has(thirdUrl)).toBe(false);
  });

  it('does not replace accepted bytes at an existing immutable URL', () => {
    const retained = new Map([[firstUrl, first]]);
    expect(() =>
      retainNativeFederationDevAssets(retained, new Map([[firstUrl, second]])),
    ).toThrow('immutable graph changed');
    expect(retained.get(firstUrl)).toBe(first);
  });

  it('charges empty assets for their URL instead of creating zero-cost history', () => {
    const empty = { ...asset, bytes: Buffer.alloc(0), immutable: true };
    expect(() =>
      retainNativeFederationDevAssets(
        new Map(),
        new Map([[firstUrl, empty]]),
        0,
      ),
    ).toThrow('graph budget exceeded');
  });
});
