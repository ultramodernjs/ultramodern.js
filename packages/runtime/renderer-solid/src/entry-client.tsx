import type { LocalisedUrlsOption } from '@modern-js/i18n-runtime-extensions/paths';
import {
  type NativeClientEntryOptions,
  type NativeI18nInstance,
  startNativeClientEntry,
} from '@modern-js/renderer-core/entry-client';
import { createNativeRouter } from '@modern-js/renderer-core/router';
import {
  hydrateApplication,
  mountApplication,
  readSolidDocumentBootstrap,
} from './client';
import {
  componentView,
  routerView,
  solidRouterFactory,
} from './entry-application';

export type SolidClientEntryOptions = NativeClientEntryOptions<
  NativeI18nInstance,
  LocalisedUrlsOption
>;

/** Start a generated Solid browser entry: mount, or hydrate the server document. */
export function startNativeClient(options: SolidClientEntryOptions): void {
  startNativeClientEntry(options, {
    readBootstrap: readSolidDocumentBootstrap,
    createRouter: (application, routerOptions) =>
      createNativeRouter(application, routerOptions, solidRouterFactory),
    disposeRouter: router => router.history.destroy(),
    async prepareRouter(router, hydrating) {
      // Hydration adopts the server's matches; a fresh mount loads its own.
      if (!hydrating) await router.load();
    },
    async start({ root, bootstrap, load }) {
      const view = await load();
      return (bootstrap?.hydrating ? hydrateApplication : mountApplication)(
        view.kind === 'component'
          ? componentView(view.component, view.i18n)
          : routerView(view.router, view.i18n),
        root,
        {
          ...(bootstrap ? { renderId: bootstrap.documentId } : {}),
          federation: options.federation,
        },
      );
    },
  });
}
