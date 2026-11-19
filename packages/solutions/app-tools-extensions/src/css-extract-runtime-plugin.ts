import type { Rspack } from '@rsbuild/core';

const PLUGIN_NAME = 'ModernjsCssExtractRuntimePlugin';
const CSS_LOADING_RUNTIME_MODULE = 'webpack/runtime/css loading';
const CSS_EXTRACT_STYLESHEET_MATCH =
  '\t\tif (tag.rel === "stylesheet" && dataHref && matches(dataHref)) return tag;';
const CSS_EXTRACT_STYLESHEET_MATCH_WITH_NORMALIZED_URL = `\t\tvar absoluteHref = tag.href;
\t\tvar absoluteFullHref = new URL(fullhref, document.baseURI).href;
\t\tif (tag.rel === "stylesheet" && ((dataHref && matches(dataHref)) || absoluteHref === absoluteFullHref)) return tag;`;

const isAutomaticPublicPath = (publicPath: unknown) =>
  publicPath === 'auto' || publicPath === 'auto/';

export const normalizeCssExtractRuntimeStylesheetLookup = (
  source: string,
): string => {
  // CssExtractRspackPlugin concatenates automatic public paths and CSS asset
  // names as strings. A path such as `/static/js/../../static/css/lazy.css`
  // is browser-equivalent to the SSR link `/static/css/lazy.css`, but its
  // runtime lookup compares the two raw strings and inserts a duplicate link.
  // Compare the complete resolved URLs as well, while preserving the upstream
  // `data-href`, `href` and HMR timestamp matching behaviour. Query strings
  // remain part of canonical identity so a newly versioned stylesheet is never
  // suppressed by URL normalization.
  if (!source.includes('__webpack_require__.miniCssF')) {
    return source;
  }

  const occurrences = source.split(CSS_EXTRACT_STYLESHEET_MATCH).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Unsupported CssExtractRspackPlugin runtime shape: expected one stylesheet lookup, found ${occurrences}.`,
    );
  }

  return source.replace(
    CSS_EXTRACT_STYLESHEET_MATCH,
    CSS_EXTRACT_STYLESHEET_MATCH_WITH_NORMALIZED_URL,
  );
};

export class CssExtractRuntimePlugin {
  readonly name = PLUGIN_NAME;

  apply(compiler: Rspack.Compiler) {
    if (!isAutomaticPublicPath(compiler.options.output.publicPath)) {
      return;
    }

    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, compilation => {
      compilation.hooks.runtimeModule.tap(PLUGIN_NAME, runtimeModule => {
        if (runtimeModule.identifier() !== CSS_LOADING_RUNTIME_MODULE) {
          return;
        }

        const source = runtimeModule.source;
        if (!source) {
          return;
        }

        const runtimeSource = source.source;
        if (typeof runtimeSource !== 'string') {
          return;
        }

        source.source =
          normalizeCssExtractRuntimeStylesheetLookup(runtimeSource);
      });
    });
  }
}
