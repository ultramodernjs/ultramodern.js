// @effect-diagnostics asyncFunction:off strictBooleanExpressions:off

import {
  getGlobalEnableRsc,
  getGlobalInternalRuntimeContext,
  type TInternalRuntimeContext,
} from '@modern-js/runtime/context';
import type { StaticHandlerContext } from '@modern-js/runtime-utils/router';
import { time } from '@modern-js/runtime-utils/time';
import { SSR_HYDRATION_ID_PREFIX } from '@modern-js/utils/universal/constants';
import type React from 'react';
import ReactDomServer from 'react-dom/server';
import { RenderLevel } from '../../constants';
import { getMonitors } from '../../context/monitors';
import {
  wrapRuntimeComponentResolver,
  wrapRuntimeContextProvider,
} from '../../react/wrapper';
import type { SSRServerContext } from '../../types';
import {
  CHUNK_CSS_PLACEHOLDER,
  CHUNK_JS_PLACEHOLDER,
  HTML_PLACEHOLDER,
  SSR_DATA_PLACEHOLDER,
} from '../constants';
import {
  createReplaceHelemt,
  getHelmetData,
  hasTitleTagBefore,
} from '../helmet';
import {
  type BuildHtmlCb,
  buildHtml,
  createSSRRenderLifecycle,
  type RenderString,
  replaceSSRTemplateChunk,
} from '../shared';
import { SSRErrors, SSRTimings, type Tracer } from '../tracer';
import { getSSRConfigByEntry, safeReplace } from '../utils';
import { LoadableCollector } from './loadable';
import { SSRDataCollector } from './ssrData';
import type { ChunkSet, Collector } from './types';

export const renderString: RenderString = async (
  request,
  serverRoot,
  options,
) => {
  const { resource, runtimeContext, config, onError, onTiming } = options;

  const tracer: Tracer = { onError, onTiming };

  const routerContext = runtimeContext.routerContext as StaticHandlerContext;

  const { htmlTemplate, entryName, loadableStats, routeManifest } = resource;

  const ssrConfig = getSSRConfigByEntry(
    entryName,
    config.ssr,
    config.ssrByEntries,
  );

  const chunkSet: ChunkSet = {
    renderLevel: RenderLevel.CLIENT_RENDER,
    ssrScripts: '',
    jsChunk: '',
    cssChunk: '',
  };

  const collectors: Collector[] = [];
  const lifecycle = createSSRRenderLifecycle(collectors);
  const loadableCollector = new LoadableCollector({
    stats: loadableStats,
    nonce: config.nonce,
    routeManifest,
    template: htmlTemplate,
    entryName,
    chunkSet,
    config,
    lifecycle,
  });
  collectors.push(
    loadableCollector,
    new SSRDataCollector({
      runtimeContext,
      request,
      ssrConfig,
      ssrContext: runtimeContext.ssrContext! as SSRServerContext,
      chunkSet,
      routerContext,
      nonce: config.nonce,
      useJsonScript: config.useJsonScript,
      lifecycle,
    }),
  );

  const internalRuntimeContext = getGlobalInternalRuntimeContext();
  const hooks = internalRuntimeContext.hooks;

  const extraCollectors = hooks.extendStringSSRCollectors.call({
    chunkSet,
    render: {
      runtimeContext,
      request,
      resource,
      config,
      platform: 'node',
      mode: 'string',
      monitors: getMonitors(),
      isRsc: getGlobalEnableRsc() === true,
    },
  });

  for (const c of extraCollectors) {
    if (c) collectors.unshift(c);
  }

  let rootElement = wrapRuntimeContextProvider(
    serverRoot,
    Object.assign(runtimeContext, { ssr: true }),
  );
  if (getGlobalEnableRsc() === true && runtimeContext.isBrowser === false) {
    rootElement = wrapRuntimeComponentResolver(rootElement, hooks);
  }

  const html = await generateHtml(
    rootElement,
    htmlTemplate,
    chunkSet,
    collectors,
    runtimeContext.ssrContext?.htmlModifiers || [],
    tracer,
    request.signal,
    lifecycle,
    loadableCollector.stylesheetInfo,
  );

  return html;
};

async function generateHtml(
  App: React.ReactElement,
  htmlTemplate: string,
  chunkSet: ChunkSet,
  collectors: Collector[],
  htmlModifiers: BuildHtmlCb[],
  { onError, onTiming }: Tracer,
  signal: AbortSignal,
  lifecycle: ReturnType<typeof createSSRRenderLifecycle>,
  stylesheetInfo: LoadableCollector['stylesheetInfo'],
): Promise<string> {
  let html = '';
  let helmetData;

  try {
    signal.throwIfAborted();
    try {
      const finalApp = collectors.reduce(
        (pre, creator) => creator.collect?.(pre) || pre,
        App,
      );
      lifecycle.beforeReact();
      const end = time();
      html = ReactDomServer.renderToString(finalApp, {
        identifierPrefix: SSR_HYDRATION_ID_PREFIX,
      });
      html = lifecycle.completedBody(html, 'complete');
      chunkSet.renderLevel = RenderLevel.SERVER_RENDER;
      helmetData = getHelmetData(collectors);

      const cost = end();
      onTiming(SSRTimings.RENDER_HTML, cost);
    } catch (error) {
      lifecycle.finish({ status: 'fallback', error });
      html = '';
      chunkSet.renderLevel = RenderLevel.CLIENT_RENDER;
      onError(error, SSRErrors.RENDER_HTML);
    }

    // Existing effects remain concurrent and run on the fallback path too.
    await Promise.all(collectors.map(component => component.effect()));
    signal.throwIfAborted();

    const { ssrScripts, cssChunk, jsChunk } = chunkSet;

    const replaceChunks: BuildHtmlCb[] = [
      template =>
        replaceSSRTemplateChunk(
          {
            name: 'scripts',
            template,
            placeholder: CHUNK_JS_PLACEHOLDER,
            content: jsChunk,
          },
          lifecycle,
        ),
      template =>
        replaceSSRTemplateChunk(
          {
            name: 'styles',
            template,
            placeholder: CHUNK_CSS_PLACEHOLDER,
            content: cssChunk,
            ...stylesheetInfo,
          },
          lifecycle,
        ),
    ];
    const replaceData: BuildHtmlCb = template =>
      replaceSSRTemplateChunk(
        {
          name: 'data',
          template,
          placeholder: SSR_DATA_PLACEHOLDER,
          content: ssrScripts,
        },
        lifecycle,
      );
    const replaceHelmet = createReplaceHelemt(helmetData);
    const appHtmlMayHaveFirstTitle =
      html.includes('<title') &&
      !hasTitleTagBefore(htmlTemplate, htmlTemplate.indexOf(HTML_PLACEHOLDER));
    // Template observers can inspect the completed app and earlier replacements.
    // Keep that ordering for them; optimize the observer-free path only.
    const needsCompleteTemplate =
      appHtmlMayHaveFirstTitle ||
      collectors.some(
        collector => collector.transformTemplateChunk !== undefined,
      );
    const finalHtml = await buildHtml(htmlTemplate, [
      ...(needsCompleteTemplate
        ? [
            createReplaceHtml(html),
            ...replaceChunks,
            replaceData,
            replaceHelmet,
          ]
        : [
            (template: string) =>
              safeReplace(
                safeReplace(template, HTML_PLACEHOLDER, HTML_MARKER),
                SSR_DATA_PLACEHOLDER,
                SSR_DATA_MARKER,
              ),
            ...replaceChunks,
            replaceHelmet,
            (template: string) =>
              safeReplace(template, SSR_DATA_MARKER, ssrScripts),
            (template: string) => safeReplace(template, HTML_MARKER, html),
          ]),
      ...htmlModifiers,
    ]);

    signal.throwIfAborted();
    lifecycle.finish({ status: 'complete' });
    return finalHtml;
  } catch (error) {
    lifecycle.finish(
      signal.aborted
        ? { status: 'cancelled', reason: signal.reason }
        : { status: 'error', error },
    );
    throw error;
  }
}

const markerId = Math.random().toString(36).slice(2);
const HTML_MARKER = `<!--modern-html-${markerId}-->`;
const SSR_DATA_MARKER = `<!--modern-ssr-data-${markerId}-->`;

function createReplaceHtml(html: string): BuildHtmlCb {
  return (template: string) => safeReplace(template, HTML_PLACEHOLDER, html);
}
