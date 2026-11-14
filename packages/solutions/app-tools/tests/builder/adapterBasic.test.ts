import { createRsbuild } from '@rsbuild/core';
import { describe, expect, it } from '@rstest/core';
import { builderPluginAdapterBasic } from '../../src/builder/shared/builderPlugins/adapterBasic';

describe('watch ignored paths', () => {
  it.each([
    {
      metaName: 'modern-js',
      internalDirectory: '/app/node_modules/.modern-js',
    },
    { metaName: 'custom', internalDirectory: '/app/node_modules/.custom' },
    { metaName: 'custom', internalDirectory: '/app/node_modules/.cache+test' },
    { metaName: 'custom', internalDirectory: '/app/.generated' },
    { metaName: 'modern-js' },
  ])('keeps generated files watched for %j', async appContext => {
    const internalDirectory =
      'internalDirectory' in appContext
        ? appContext.internalDirectory
        : `/app/node_modules/.${appContext.metaName}`;
    const rsbuild = await createRsbuild({
      rsbuildConfig: {
        source: { entry: { main: __filename } },
        plugins: [
          builderPluginAdapterBasic({
            appContext,
          }),
        ],
      },
    });
    const [config] = await rsbuild.initConfigs();
    const watchIgnored = config.watchOptions?.ignored;
    expect(Array.isArray(watchIgnored)).toBe(true);
    const ignored = Array.isArray(watchIgnored) ? watchIgnored[0] : undefined;

    expect(ignored).toBeInstanceOf(RegExp);
    if (!(ignored instanceof RegExp)) {
      return;
    }

    for (const separator of ['/', '\\']) {
      const matches = (file: string) =>
        ignored.test(file.replaceAll('/', separator));

      expect(matches('/app/node_modules/react/index.js')).toBe(true);
      expect(matches('/app/.git/index')).toBe(true);
      expect(matches(`${internalDirectory}/entry.ts`)).toBe(false);
      expect(matches(`${internalDirectory}/node_modules/pkg/index.js`)).toBe(
        true,
      );
      expect(matches('/app/src/index.ts')).toBe(false);
      expect(matches('/app/agit/index.ts')).toBe(false);
    }
  });
});
