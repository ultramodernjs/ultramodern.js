import type { ReactElement } from 'react';
import { injectCSS, injectRSCPayload } from '../../rsc-html-stream/server';

// Rslib emits this as the application-owned global without parsing it as its own runtime.
declare const RSPACK_RSC_MANIFEST: typeof __rspack_rsc_manifest__;

type RenderRsc = (options: { element: ReactElement }) => ReadableStream;

export const createRenderCSRWithRSC =
  (renderRsc: RenderRsc) =>
  async (options: {
    html: string;
    rscRoot: ReactElement;
  }): Promise<Response> => {
    // Collect CSS files from entryCssFiles
    const entryCssFiles = RSPACK_RSC_MANIFEST?.entryCssFiles;
    const cssFiles = entryCssFiles ? Object.values(entryCssFiles).flat() : [];

    // Render RSC stream
    const rscPayloadStream = renderRsc({ element: options.rscRoot });

    // Create HTML stream
    const htmlStream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(options.html));
        controller.close();
      },
    });

    // Create a pipeline: HTML -> CSS injection -> RSC payload injection
    const stream = htmlStream
      .pipeThrough(injectCSS(cssFiles, { injectClosingTags: false }))
      .pipeThrough(
        injectRSCPayload(rscPayloadStream, { injectClosingTags: true }),
      );

    return new Response(stream, {
      status: 200,
      headers: new Headers({
        'content-type': 'text/html; charset=UTF-8',
      }),
    });
  };
