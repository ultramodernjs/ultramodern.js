// @effect-diagnostics asyncFunction:off strictBooleanExpressions:off unnecessaryArrowBlock:off

import { time } from '@modern-js/runtime-utils/time';
import type { OnError } from '@modern-js/types';
import type {
  ClientManifest as RscClientManifest,
  ServerManifest as RscServerManifest,
  SSRManifest as RscSSRManifest,
} from '@modern-js/types/server';
import { isbot as checkIsBot } from 'isbot';
import type React from 'react';
import {
  ESCAPED_SHELL_STREAM_END_MARK,
  JSX_SHELL_STREAM_END_MARK,
} from '../../../common';
import type { TInternalRuntimeContext } from '../../context';
import { wrapRuntimeContextProvider } from '../../react/wrapper';
import type { HandleRequestConfig } from '../requestHandler';
import type { RenderStreaming, SSRConfig } from '../shared';
import { SSRErrors, SSRTimings } from '../tracer';
import { getSSRConfigByEntry } from '../utils';

export type RscManifest = {
  clientManifest?: RscClientManifest;
  serverConsumerModuleMap?: unknown;
  serverManifest?: RscServerManifest;
  entryCssFiles?: Record<string, string[]>;
};

export type CreateReadableStreamFromElementOptions = {
  runtimeContext: TInternalRuntimeContext;
  config: HandleRequestConfig;
  ssrConfig: SSRConfig;
  htmlTemplate: string;
  entryName: string;
  resource?: object;

  rscClientManifest?: RscClientManifest;
  rscSSRManifest?: RscSSRManifest;
  rscServerManifest?: RscServerManifest;
  rscManifest?: RscManifest;
  rscRoot?: React.ReactElement;
  onShellReady?: () => void;
  onShellError?: (error: unknown) => void;
  onAllReady?: () => void;
  onError: OnError;
};

export type CreateReadableStreamFromElement = (
  request: Request,
  rootElement: React.ReactElement,
  options: CreateReadableStreamFromElementOptions,
) => Promise<ReadableStream<Uint8Array>>;

export enum ShellChunkStatus {
  START = 0,
  FINISH = 1,
}

/**
 * Buffers the decoded shell text until `ESCAPED_SHELL_STREAM_END_MARK` shows up,
 * then splits the buffered text at the marker.
 *
 * The marker can straddle two chunks, but the buffered text has already been
 * searched, so a match must end inside the new text: searching the new text
 * plus the last `marker.length - 1` buffered chars is enough. This keeps
 * buffering linear in the shell size instead of re-joining and re-scanning the
 * whole shell for every chunk.
 */
export function createShellEndMarkSplitter() {
  const marker = ESCAPED_SHELL_STREAM_END_MARK;
  const shellChunks: string[] = [];
  let tail = '';

  return (
    text: string,
  ): { beforeMark: string; afterMark: string } | undefined => {
    const searchText = tail + text;
    const markerIndex = searchText.indexOf(marker);
    if (markerIndex === -1) {
      shellChunks.push(text);
      tail = searchText.slice(-(marker.length - 1));
      return undefined;
    }

    // `tail` is always a suffix of the buffered shell text.
    const buffered = shellChunks.join('');
    const result = {
      beforeMark:
        buffered.slice(0, buffered.length - tail.length) +
        searchText.slice(0, markerIndex),
      afterMark: searchText.slice(markerIndex + marker.length),
    };
    shellChunks.length = 0;
    tail = '';
    return result;
  };
}

/**
 * The document head is sealed when the shell end mark is written, so only head
 * tags emitted before it reach `<head>`. React writes a completed Suspense
 * boundary after the shell once the flushed bytes exceed `progressiveChunkSize`,
 * which drops the head of every large route and keeps its content hidden until
 * the inline `$RC` script runs. Completed boundaries therefore stay inline in
 * the shell; pending boundaries still stream when they resolve. Buffering
 * paths (`onAllReady`) thereby seal the head after all content.
 *
 * Measured on a ~1 MB route completed at shell time (React 19.3, Node): the
 * default chunk size reaches the shell end mark in 0.7 ms, this one in 1.2 ms,
 * so the head fix costs no measurable time to first byte.
 */
export const SHELL_PROGRESSIVE_CHUNK_SIZE = Number.MAX_SAFE_INTEGER;

const SHOULD_STREAM_ALL_HEADER = 'x-should-stream-all';

function parseShouldStreamAllFlag(value: string | null): boolean | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();

  // if the header is set to 'false', treat it as false, runtime will not stream all.
  // Otherwise, treat it as true.
  if (normalized === 'false') {
    return false;
  }
  return true;
}

export function resolveStreamingMode(
  request: Request,
  forceStreamToString: boolean,
): {
  onReady: 'onAllReady' | 'onShellReady';
  waitForAllReady: boolean;
} {
  const shouldStreamAll = parseShouldStreamAllFlag(
    request.headers.get(SHOULD_STREAM_ALL_HEADER),
  );

  const isSsgRender = request.headers.get('x-modern-ssg-render') === 'true';

  const isBot = checkIsBot(request.headers.get('user-agent'));

  if (shouldStreamAll) {
    return { onReady: 'onAllReady', waitForAllReady: true };
  }

  if (forceStreamToString) {
    return { onReady: 'onAllReady', waitForAllReady: true };
  }

  if (isBot) {
    return { onReady: 'onAllReady', waitForAllReady: true };
  }

  if (isSsgRender) {
    return { onReady: 'onAllReady', waitForAllReady: true };
  }

  return { onReady: 'onShellReady', waitForAllReady: false };
}

let encoder: TextEncoder;
export function encodeForWebStream(thing: unknown) {
  if (!encoder) {
    encoder = new TextEncoder();
  }
  if (typeof thing === 'string') {
    return encoder.encode(thing);
  }
  return thing;
}

export function getReadableStreamFromString(content: string): ReadableStream {
  const readableStream = new ReadableStream({
    start(controller) {
      controller.enqueue(encodeForWebStream(content));
      controller.close();
    },
  });

  return readableStream;
}

export function createRenderStreaming(
  createReadableStreamPromise: Promise<CreateReadableStreamFromElement>,
): RenderStreaming {
  return async (request, serverRoot, options) => {
    const createReadableStreamFromElement = await createReadableStreamPromise;

    const end = time();
    const { runtimeContext, config, resource } = options;
    const { onError, onTiming } = options;

    const { htmlTemplate, entryName } = resource;

    const ssrConfig = getSSRConfigByEntry(
      entryName,
      config.ssr,
      config.ssrByEntries,
    );

    const StreamServerRootWrapper = ({
      children,
    }: {
      children: React.ReactNode;
    }) => {
      return (
        <>
          {children}
          {JSX_SHELL_STREAM_END_MARK}
        </>
      );
    };

    let rootElement = wrapRuntimeContextProvider(
      serverRoot,
      Object.assign(runtimeContext, { ssr: true }),
    );

    rootElement = (
      <StreamServerRootWrapper>{rootElement}</StreamServerRootWrapper>
    );

    const stream = await createReadableStreamFromElement(request, rootElement, {
      config,
      htmlTemplate,
      runtimeContext,
      ssrConfig,
      entryName,
      resource,
      rscClientManifest: options.rscClientManifest,
      rscSSRManifest: options.rscSSRManifest,
      rscServerManifest: options.rscServerManifest,
      rscManifest: (options as typeof options & { rscManifest?: RscManifest })
        .rscManifest,
      rscRoot: options.rscRoot,
      onShellReady() {
        const cost = end();
        onTiming(SSRTimings.RENDER_SHELL, cost);
      },
      onAllReady() {
        const cost = end();
        onTiming(SSRTimings.RENDER_HTML, cost);
      },
      onShellError(error) {
        onError(error, SSRErrors.RENDER_SHELL);
      },
      onError(error) {
        onError(error, SSRErrors.RENDER_STREAM);
      },
    });

    return stream;
  };
}
