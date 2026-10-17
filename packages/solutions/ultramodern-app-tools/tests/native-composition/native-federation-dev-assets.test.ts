import { describe, expect, it } from '@rstest/core';
import {
  type NativeDevelopmentAsset,
  nativeFederationDevRevision,
  resolveNativeFederationDevAsset,
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
