import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from '@rstest/core';
import { verifyCloudflareOutputMutationPolicy } from '../../src/cloudflare-output-verifier/mutation-policy';

const temporaryRoots: string[] = [];
const serverOutputPath = ['.output', 'server', 'index.mjs'].join('/');
const workerOutputPath = ['.output', 'worker', 'api.mjs'].join('/');
const handlerArity = ['handler', 'length'].join('.');
const pathJoin = ['path', 'join'].join('.');
const pathResolve = ['path', 'resolve'].join('.');
const sourceReplace = ['source', 'replaceAll'].join('.');
const drizzleMarker = ['', 'entityKind,entityKind', ''].join(';');
const dispatchProperty = ['runtime', 'dispatchEffectBffRequest'].join('.');
const historicalSource = `writeFileSync('${serverOutputPath}', ${handlerArity} ? patched : source)`;

const fixture = (files: Record<string, string>): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'cloudflare-mutation-policy-'));
  temporaryRoots.push(root);
  for (const [relativePath, source] of Object.entries(files)) {
    const filename = path.join(root, relativePath);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, source);
  }
  return root;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('Cloudflare output mutation policy', () => {
  test('skips generated output while checking adjacent source and lifecycle scripts', async () => {
    const root = fixture({
      [`apps/example/${serverOutputPath}`]: historicalSource,
      'apps/example/.output/server/package.json': JSON.stringify({
        scripts: { postbuild: historicalSource },
      }),
      'apps/example/package.json': JSON.stringify({
        scripts: { postbuild: historicalSource },
      }),
      'apps/example/server/cleanup.mts': historicalSource,
    });
    const result = await verifyCloudflareOutputMutationPolicy({
      scanRoots: [root],
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(4);
    expect(new Set(result.issues.map(issue => issue.path))).toEqual(
      new Set([
        path.join(root, 'apps/example/server/cleanup.mts'),
        path.join(root, 'apps/example/package.json'),
      ]),
    );
  });

  test('allows historical source and provenance in archival JSON', async () => {
    const root = fixture({
      'artifacts/historical/provenance.json': JSON.stringify({
        previousImplementation: historicalSource,
      }),
      'artifacts/historical/source.json': JSON.stringify({
        source: historicalSource,
      }),
      'locales/en/history.json': JSON.stringify({
        explanation: historicalSource,
      }),
    });
    expect(
      await verifyCloudflareOutputMutationPolicy({ scanRoots: [root] }),
    ).toEqual({ issues: [], ok: true });
  });

  test.each(['d.ts', 'd.mts', 'd.cts'])(
    'allows historical path literals in .%s declarations',
    async extension => {
      const root = fixture({
        [`types/historical.${extension}`]: `declare const historical: ${JSON.stringify(historicalSource)};`,
      });
      expect(
        await verifyCloudflareOutputMutationPolicy({ scanRoots: [root] }),
      ).toEqual({ issues: [], ok: true });
    },
  );

  test('checks executable cleanup scripts inside artifact directories', async () => {
    const root = fixture({ 'artifacts/cleanup.mts': historicalSource });
    const result = await verifyCloudflareOutputMutationPolicy({
      scanRoots: [root],
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(
      result.issues.every(
        issue => issue.path === path.join(root, 'artifacts/cleanup.mts'),
      ),
    ).toBe(true);
  });

  test('allows descriptive package metadata while checking its safe scripts', async () => {
    const root = fixture({
      'package.json': JSON.stringify({
        description: historicalSource,
        name: 'safe-package',
        scripts: {
          build: 'modern build',
          postbuild: 'node scripts/verify.mjs',
        },
        ultramodern: { historicalImplementation: historicalSource },
      }),
    });
    expect(
      await verifyCloudflareOutputMutationPolicy({ scanRoots: [root] }),
    ).toEqual({ issues: [], ok: true });
  });

  test('checks each decoded package script independently', async () => {
    const root = fixture({
      'package.json': JSON.stringify({
        scripts: { first: 'handler', second: '.length' },
      }),
    });
    expect(
      await verifyCloudflareOutputMutationPolicy({ scanRoots: [root] }),
    ).toEqual({ issues: [], ok: true });
  });

  test('allows descriptive package metadata without lifecycle scripts', async () => {
    const root = fixture({
      'package.json': JSON.stringify({
        description: historicalSource,
        name: 'safe-package',
      }),
    });
    expect(
      await verifyCloudflareOutputMutationPolicy({ scanRoots: [root] }),
    ).toEqual({ issues: [], ok: true });
  });

  test('rejects generated worker rewrites and handler probing in lifecycle scripts', async () => {
    const root = fixture({
      'apps/example/package.json': JSON.stringify({
        scripts: { postbuild: `node -e "${historicalSource}"` },
      }),
    });
    const result = await verifyCloudflareOutputMutationPolicy({
      scanRoots: [root],
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'forbidden-mutation-pattern',
          path: path.join(root, 'apps/example/package.json'),
        }),
      ]),
    );
  });

  test('decodes JSON escapes before checking executable package scripts', async () => {
    const escapedManifest = JSON.stringify({
      scripts: { postbuild: `node rewrite '${serverOutputPath}'` },
    })
      .replace('.output', '\\u002eoutput')
      .replaceAll('/', '\\u002f');
    const root = fixture({ 'package.json': escapedManifest });
    const result = await verifyCloudflareOutputMutationPolicy({
      scanRoots: [root],
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
  });

  test.each(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'])(
    'checks executable .%s files',
    async extension => {
      const relativePath = `scripts/rewrite.${extension}`;
      const root = fixture({ [relativePath]: historicalSource });
      const result = await verifyCloudflareOutputMutationPolicy({
        scanRoots: [root],
      });
      expect(result.ok).toBe(false);
      expect(result.issues).toHaveLength(2);
      expect(
        result.issues.every(
          issue => issue.path === path.join(root, relativePath),
        ),
      ).toBe(true);
    },
  );

  test.each([
    ['server output literal', `writeFileSync('${serverOutputPath}', patched)`],
    [
      'server output path construction',
      `${pathJoin}('.output', 'server', 'index.mjs')`,
    ],
    ['worker output literal', `writeFileSync('${workerOutputPath}', patched)`],
    [
      'worker output path construction',
      `${pathResolve}('.output', 'worker', 'api.cjs')`,
    ],
    ['Drizzle marker rewrite', `${sourceReplace}('${drizzleMarker}', '')`],
    ['dispatch helper probing', `typeof ${dispatchProperty} === 'function'`],
    ['handler arity probing', `if (${handlerArity} === 2) dispatch();`],
  ])('retains detection of %s', async (_name, source) => {
    const root = fixture({ 'scripts/unsafe.mjs': source });
    const result = await verifyCloudflareOutputMutationPolicy({
      scanRoots: [root],
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
  });

  test('honors an exact excluded path and still checks its sibling', async () => {
    const root = fixture({
      'scripts/application-rewrite.mjs': historicalSource,
      'scripts/framework-proof.mjs': historicalSource,
    });
    const result = await verifyCloudflareOutputMutationPolicy({
      excludePaths: [path.join(root, 'scripts/framework-proof.mjs')],
      scanRoots: [root],
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(
      result.issues.every(
        issue =>
          issue.path === path.join(root, 'scripts/application-rewrite.mjs'),
      ),
    ).toBe(true);
  });

  test('fails closed when a package manifest is malformed JSON', async () => {
    const root = fixture({ 'package.json': '{"scripts":' });
    const result = await verifyCloudflareOutputMutationPolicy({
      scanRoots: [root],
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'invalid-package',
        path: path.join(root, 'package.json'),
      }),
    );
  });

  test.each([
    ['null', null],
    ['array', []],
    ['number', 42],
    ['string', 'package'],
  ])('fails closed for %s package metadata', async (_name, manifest) => {
    const root = fixture({ 'package.json': JSON.stringify(manifest) });
    const result = await verifyCloudflareOutputMutationPolicy({
      scanRoots: [root],
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'invalid-package',
        path: path.join(root, 'package.json'),
      }),
    );
  });

  test.each([
    ['array', [historicalSource]],
    ['scalar', historicalSource],
    ['null', null],
    ['nonstring command', { postbuild: { command: historicalSource } }],
  ])('fails closed for %s package scripts', async (_name, scripts) => {
    const root = fixture({ 'package.json': JSON.stringify({ scripts }) });
    const result = await verifyCloudflareOutputMutationPolicy({
      scanRoots: [root],
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'invalid-package',
        path: path.join(root, 'package.json'),
      }),
    );
  });
});
