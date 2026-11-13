import type { ClientManifest } from '@modern-js/types/server';
import { SSR_HYDRATION_ID_PREFIX } from '@modern-js/utils/universal/constants';
import React, { type ReactNode } from 'react';
import type { ReactDOMServerReadableStream } from 'react-dom/server';
import { renderToReadableStream } from 'react-dom/server.edge';
import { ServerElementsProvider } from '../../client/serverElements';

function CSSLinks({ cssFiles }: { cssFiles: string[] }) {
  if (cssFiles.length === 0) {
    return null;
  }
  return (
    <>
      {cssFiles.map(css => (
        <link key={css} href={css} rel="stylesheet" />
      ))}
    </>
  );
}

type Options = {
  request: Request;
  routes?: unknown[];
  /** Wrap only the HTML render tree, never the input serialized by Flight. */
  wrapHtmlRoot?: (root: ReactNode) => ReactNode;
  rscManifest?: {
    clientManifest?: ClientManifest;
    serverConsumerModuleMap?: unknown;
    serverManifest?: unknown;
    entryCssFiles?: Record<string, string[]>;
  };
} & Parameters<typeof renderToReadableStream>[1];

function wrapStream(
  stream: ReadableStream,
  originalStream: ReactDOMServerReadableStream,
): ReactDOMServerReadableStream {
  return Object.assign(stream, {
    allReady: originalStream.allReady,
  });
}

export const renderSSRStream = async (
  children: React.ReactNode,
  options: Options & { rscRoot: React.ReactElement },
): Promise<ReturnType<typeof renderToReadableStream>> => {
  const { rscManifest, rscRoot, routes, wrapHtmlRoot, ...reactOptions } =
    options;
  const clientManifest = rscManifest?.clientManifest;
  const serverConsumerModuleMap = rscManifest?.serverConsumerModuleMap;
  const entryCssFiles = rscManifest?.entryCssFiles;

  const hasRoutes = Boolean(routes && routes.length > 0);

  if (!clientManifest || !serverConsumerModuleMap) {
    return renderToReadableStream(
      wrapHtmlRoot ? wrapHtmlRoot(children) : children,
      {
        ...reactOptions,
        identifierPrefix: SSR_HYDRATION_ID_PREFIX,
      },
    );
  }

  try {
    const [{ renderRsc }, { createFromReadableStream }, { injectRSCPayload }] =
      await Promise.all([
        import('@modern-js/render/rsc'),
        import('react-server-dom-rspack/client.edge'),
        import('../../rsc-html-stream/server'),
      ]);

    // Allow render rsc stream from rscRoot, or from element
    const rscStream = await renderRsc({
      element: rscRoot || children,
    });

    const [rscElementStream, rscPayloadStream] = rscStream.tee();

    const elements: Promise<ReactNode[]> =
      createFromReadableStream(rscElementStream);

    // Collect all CSS files from entryCssFiles when there are no routes
    let cssFiles: string[] = [];
    if (!hasRoutes && entryCssFiles) {
      cssFiles = Object.values(entryCssFiles).flat();
    }

    const htmlRoot = (
      <ServerElementsProvider elements={elements}>
        <CSSLinks cssFiles={cssFiles} />
        {children}
      </ServerElementsProvider>
    );
    const htmlStream = await renderToReadableStream(
      wrapHtmlRoot ? wrapHtmlRoot(htmlRoot) : htmlRoot,
      {
        ...reactOptions,
        identifierPrefix: SSR_HYDRATION_ID_PREFIX,
      },
    );

    // Create a pipeline that injects RSC payload
    const stream = htmlStream.pipeThrough(
      injectRSCPayload(rscPayloadStream, {
        injectClosingTags: true,
      }),
    );

    return wrapStream(stream, htmlStream);
  } catch (error) {
    console.error(error);
    throw error;
  }
};
