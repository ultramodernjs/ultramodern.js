import type { StreamSSRExtender } from '@modern-js/plugin/runtime';
import type { AnyRouter } from '@tanstack/react-router';
import { transformReadableStreamWithRouter } from '@tanstack/router-core/ssr/server';
import { routerManagedTagsToHtml } from './ssrManagedTags';

const streamBoundaries = new WeakMap<AnyRouter, string>();

export function takeRouterHydrationScripts(
  router: AnyRouter,
  streaming: boolean,
) {
  const tags = router.serverSsr?.takeInitialHydrationScriptTags();
  if (!tags) return [];
  if (!streaming)
    return routerManagedTagsToHtml([...tags.before, tags.boundary]);
  streamBoundaries.set(router, routerManagedTagsToHtml(tags.boundary).join(''));
  return routerManagedTagsToHtml(tags.before);
}

export function createTanstackSsrStreamExtender(
  router: AnyRouter | undefined,
  request: Request,
): StreamSSRExtender {
  const boundary = router && streamBoundaries.get(router);
  if (!router?.serverSsr || !boundary) return {};
  let boundaryWritten = false;
  return {
    completedBody(html) {
      if (boundaryWritten) return html;
      boundaryWritten = true;
      // The native merger lifts its serialization barrier in body, after the
      // renderer's shell, never at the bootstrap scripts in document.head.
      return html + boundary;
    },
    processResponseStream(stream) {
      return transformReadableStreamWithRouter(router, stream, {
        signal: request.signal,
        // Both Fizz and Redact close their reveal script after the complete
        // hidden segment, so a router record cannot split renderer markup.
        rendererSafePoint: 'script-close',
      });
    },
  };
}
