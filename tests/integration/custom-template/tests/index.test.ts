import { readFileSync } from 'fs';
import path from 'path';
import { modernBuild } from '../../../utils/modernTestUtils';

describe('custom template', () => {
  const appDir = path.resolve(__dirname, '..');

  test(`should allow to custom template by html.template option`, async () => {
    const result = await modernBuild(appDir);
    expect(result.code).toBe(0);

    const html = readFileSync(
      path.resolve(appDir, `dist/html/index/index.html`),
      'utf8',
    );
    const title = html.match(/<title[^>]*>([^<]*)<\/title>/iu)?.[1];
    const viewportTags = html
      .match(/<meta\b[^>]*>/giu)
      ?.filter(tag => /\bname=["']viewport["']/iu.test(tag));
    const viewport = viewportTags?.[0]?.match(
      /\bcontent=["']([^"']*)["']/iu,
    )?.[1];
    const rootContent = html.match(
      /<div\b[^>]*\bid=["']root["'][^>]*>([\s\S]*?)<\/div>/iu,
    )?.[1];

    expect(title).toBe('Hello World');
    expect(viewportTags).toHaveLength(1);
    expect(viewport).toBe('width=device-width,initial-scale=1');
    expect(rootContent).toMatch(/^\s*$/u);
  });

  test('should allow opting in to mobile meta tags without duplicating the viewport', async () => {
    const result = await modernBuild(appDir, ['-c', 'modern.meta.config.ts']);
    expect(result.code).toBe(0);

    const html = readFileSync(
      path.resolve(appDir, 'dist/meta/html/index/index.html'),
      'utf8',
    );

    expect(html.match(/<meta name="viewport"/g)).toHaveLength(1);
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    );
    expect(html).toContain(
      '<meta name="format-detection" content="telephone=no">',
    );
  });
});
