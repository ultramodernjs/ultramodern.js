import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { rspack } from '@rsbuild/core';
import {
  CssExtractRuntimePlugin,
  normalizeCssExtractRuntimeStylesheetLookup,
} from '../src/css-extract-runtime-plugin';

const tempDirectories: string[] = [];
const cssLoaderPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../node_modules/@rsbuild/core/compiled/css-loader/index.js',
);

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map(directory => fs.rm(directory, { recursive: true, force: true })),
  );
});

const compile = async (context: string, outputPath: string) =>
  new Promise<void>((resolve, reject) => {
    rspack.rspack(
      {
        context,
        entry: { main: './entry.js' },
        experiments: { css: true },
        mode: 'production',
        module: {
          rules: [
            {
              test: /\.css$/u,
              use: [rspack.CssExtractRspackPlugin.loader, cssLoaderPath],
            },
          ],
        },
        optimization: { minimize: false },
        output: {
          chunkFilename: 'static/js/[name].js',
          cssChunkFilename: 'static/css/[name].css',
          cssFilename: 'static/css/[name].css',
          filename: 'static/js/[name].js',
          path: outputPath,
          publicPath: 'auto',
        },
        plugins: [
          new rspack.CssExtractRspackPlugin({
            chunkFilename: 'static/css/[name].css',
            filename: 'static/css/[name].css',
          }),
          new CssExtractRuntimePlugin(),
        ],
      },
      (error, stats) => {
        if (error) {
          reject(error);
        } else if (!stats || stats.hasErrors()) {
          reject(
            new Error(
              stats?.toString({ all: false, errors: true }) ??
                'Rspack returned no build stats.',
            ),
          );
        } else {
          resolve();
        }
      },
    );
  });

interface BrowserSandbox {
  __loadLazyCss?: () => Promise<unknown>;
  clearTimeout: () => undefined;
  document: object;
  globalThis: unknown;
  self: unknown;
  setTimeout: () => number;
  URL: typeof URL;
}

describe('CssExtractRuntimePlugin', () => {
  it('rejects an unsupported CSS extraction runtime instead of skipping normalization', () => {
    expect(() =>
      normalizeCssExtractRuntimeStylesheetLookup(
        'var href = __webpack_require__.miniCssF(chunkId);',
      ),
    ).toThrow(
      'Unsupported CssExtractRspackPlugin runtime shape: expected one stylesheet lookup, found 0.',
    );
  });

  it('reuses the equivalent SSR stylesheet without crossing runtime origins', async () => {
    const context = await fs.mkdtemp(
      path.join(os.tmpdir(), 'modern-css-extract-runtime-'),
    );
    tempDirectories.push(context);
    const outputPath = path.join(context, 'dist');

    await Promise.all([
      fs.writeFile(
        path.join(context, 'entry.js'),
        "globalThis.__loadLazyCss = () => import(/* webpackChunkName: 'lazy' */ './lazy.js');\n",
      ),
      fs.writeFile(
        path.join(context, 'lazy.js'),
        "import './lazy.css'; export default 'lazy';\n",
      ),
      fs.writeFile(path.join(context, 'lazy.css'), '.lazy { color: blue; }\n'),
    ]);

    await compile(context, outputPath);
    const runtime = await fs.readFile(
      path.join(outputPath, 'static/js/main.js'),
      'utf8',
    );

    const executeWithStylesheet = (attributeHref: string) => {
      const appendedStylesheets: Array<{ href?: string }> = [];
      const currentScript = {
        getAttribute: (name: string) =>
          name === 'src'
            ? 'https://inventory.example/static/js/main.js'
            : undefined,
        src: 'https://inventory.example/static/js/main.js',
        tagName: 'SCRIPT',
      };
      const existingStylesheet = {
        getAttribute: (name: string) =>
          name === 'href' ? attributeHref : undefined,
        href: new URL(attributeHref, 'https://inventory.example/').href,
        rel: 'stylesheet',
      };
      const document = {
        baseURI: 'https://inventory.example/',
        createElement: (tagName: string) => {
          const attributes = new Map<string, string>();
          return {
            getAttribute: (name: string) => attributes.get(name),
            parentNode: { removeChild: () => undefined },
            setAttribute: (name: string, value: string) =>
              attributes.set(name, value),
            tagName: tagName.toUpperCase(),
          };
        },
        currentScript,
        getElementsByTagName: (tagName: string) => {
          if (tagName === 'link') {
            return [existingStylesheet];
          }
          if (tagName === 'script') {
            return [currentScript];
          }
          return [];
        },
        head: {
          appendChild: (element: { href?: string; rel?: string }) => {
            if (element.rel === 'stylesheet') {
              appendedStylesheets.push(element);
            }
          },
        },
      };
      const browser: BrowserSandbox = {
        clearTimeout: () => undefined,
        document,
        globalThis: undefined,
        self: undefined,
        setTimeout: () => 1,
        URL,
      };
      browser.globalThis = browser;
      browser.self = browser;

      vm.runInNewContext(runtime, browser);
      if (!browser.__loadLazyCss) {
        throw new Error('Compiled runtime did not expose the lazy CSS loader.');
      }
      browser.__loadLazyCss().catch(() => undefined);

      return appendedStylesheets;
    };

    expect(executeWithStylesheet('/static/css/lazy.css')).toEqual([]);
    expect(
      executeWithStylesheet('https://inventory.example/static/css/lazy.css'),
    ).toEqual([]);
    expect(executeWithStylesheet('/static/css/./lazy.css')).toEqual([]);
    expect(
      executeWithStylesheet('https://other.example/static/css/lazy.css'),
    ).toHaveLength(1);
    expect(
      executeWithStylesheet('http://inventory.example/static/css/lazy.css'),
    ).toHaveLength(1);
    expect(
      executeWithStylesheet(
        'https://inventory.example:444/static/css/lazy.css',
      ),
    ).toHaveLength(1);
    expect(
      executeWithStylesheet('/static/css/lazy.css?version=stale'),
    ).toHaveLength(1);
  });
});
