import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@rstest/core';
import { getBrowserslistWithDefault } from '../../../../../cli/builder/src/shared/utils';
import { ultramodernSandpackFiles } from '../../../../../toolkit/ultramodern-sandpack-profile/src';

const builderRequire = createRequire(
  new URL('../../../../../cli/builder/package.json', import.meta.url),
);
const browserslist = builderRequire('browserslist');
const autoprefixerRequire = createRequire(
  builderRequire.resolve('autoprefixer'),
);
const cssBrowserslist = autoprefixerRequire('browserslist');

const browserTargets = [
  'chrome >= 144',
  'edge >= 144',
  'firefox >= 147',
  'safari >= 27',
];

describe('browser target defaults', () => {
  it('uses the 2026 targets for browsers and web workers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'modern-browser-targets-'));
    try {
      for (const target of ['web', 'web-worker'] as const) {
        expect(await getBrowserslistWithDefault(root, {}, target)).toEqual(
          browserTargets,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves every minimum version without silently dropping a browser', () => {
    for (const [query, minimum] of [
      ['chrome >= 144', 'chrome 144'],
      ['edge >= 144', 'edge 144'],
      ['firefox >= 147', 'firefox 147'],
      ['safari >= 27', 'safari 27'],
    ]) {
      for (const resolveTargets of [browserslist, cssBrowserslist]) {
        expect(resolveTargets(query)).toContain(minimum);
      }
    }
  });

  it('keeps the Sandpack starter on the same browser targets', () => {
    expect(
      ultramodernSandpackFiles['/.browserslistrc'].trim().split('\n'),
    ).toEqual(browserTargets);
  });

  it('keeps the basic app starter on the same browser targets', async () => {
    const config = await readFile(
      new URL(
        '../../../../../toolkit/create/template/.browserslistrc',
        import.meta.url,
      ),
      'utf8',
    );
    expect(config.trim().split(/\r?\n/)).toEqual(browserTargets);
  });

  it('preserves explicit overrides and Browserslist configuration', async () => {
    for (const file of ['.browserslistrc', 'package.json']) {
      const root = await mkdtemp(join(tmpdir(), 'modern-browser-config-'));
      try {
        const configured = ['chrome >= 150'];
        await writeFile(
          join(root, file),
          file === 'package.json'
            ? JSON.stringify({ browserslist: configured })
            : configured.join('\n'),
        );
        for (const target of ['web', 'web-worker'] as const) {
          expect(await getBrowserslistWithDefault(root, {}, target)).toEqual(
            configured,
          );
          expect(
            await getBrowserslistWithDefault(
              root,
              { output: { overrideBrowserslist: ['safari >= 27'] } },
              target,
            ),
          ).toEqual(['safari >= 27']);
        }
        expect(
          await getBrowserslistWithDefault(
            root,
            { output: { overrideBrowserslist: browserTargets } },
            'node',
          ),
        ).toEqual(['node >= 16']);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
