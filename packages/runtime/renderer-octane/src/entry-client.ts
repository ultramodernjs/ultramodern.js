import type { LocalisedUrlsOption } from '@modern-js/i18n-runtime-extensions/paths';
import {
  type NativeClientEntryOptions,
  type NativeI18nInstance,
  startNativeClientEntry,
} from '@modern-js/renderer-core/entry-client';
import { createNativeRouter } from '@modern-js/renderer-core/router';
import type { ComponentBody } from 'octane';
import {
  hydrateOctaneApplication,
  mountOctaneApplication,
  type OctaneApplicationModule,
  readOctaneDocumentBootstrap,
} from './client';
import {
  componentView,
  localizedRouterRoot,
  octaneRouterFactory,
} from './entry-application';
import {
  OctaneRouterRoot,
  prepareOctaneRouterHydration,
} from './router-client';
import type {
  OctaneWorkerFederationFactory,
  OctaneWorkerFederationScope,
} from './worker-federation-context';

export interface OctaneClientEntryOptions
  extends NativeClientEntryOptions<NativeI18nInstance, LocalisedUrlsOption> {
  /** The native client compilation hash, `__webpack_hash__`. */
  readonly nativeHydrationBuildId: string;
  readonly workerFederation?:
    | OctaneWorkerFederationScope
    | OctaneWorkerFederationFactory;
}

const LocalizedRouterRoot = localizedRouterRoot(OctaneRouterRoot);

/** Start a generated Octane browser entry: mount, or hydrate the server document. */
export function startNativeClient(options: OctaneClientEntryOptions): void {
  const { nativeHydrationBuildId } = options;
  startNativeClientEntry(options, {
    readBootstrap: (document, identity) =>
      readOctaneDocumentBootstrap(document, identity, nativeHydrationBuildId),
    createRouter: (application, routerOptions) =>
      createNativeRouter(application, routerOptions, octaneRouterFactory),
    async prepareRouter(router, hydrating, signal) {
      // Hydration adopts the server's matches; a fresh mount loads its own.
      if (hydrating) await prepareOctaneRouterHydration(router, { signal });
      else await router.load();
    },
    async start({ root, identity, bootstrap, signal, load }) {
      const application = {
        container: root,
        identity,
        nativeHydrationBuildId,
        federation: options.federation,
        workerFederation: options.workerFederation,
        documentId: bootstrap?.documentId,
        signal,
        // Hydration installs the native signal bridge before this importer runs.
        load: async (): Promise<OctaneApplicationModule> => {
          const view = await load();
          if (view.kind === 'component')
            return { default: componentView(view.component, view.i18n) };
          return view.i18n
            ? {
                default: LocalizedRouterRoot as ComponentBody,
                props: { router: view.router, i18n: view.i18n },
              }
            : {
                default: OctaneRouterRoot as ComponentBody,
                props: { router: view.router },
              };
        },
      };
      const handle = bootstrap?.hydrating
        ? await hydrateOctaneApplication({
            ...application,
            documentIdentity: bootstrap.identity,
            documentId: bootstrap.documentId,
            documentNativeHydrationBuildId: bootstrap.nativeHydrationBuildId,
          })
        : await mountOctaneApplication(application);
      return () => handle.dispose();
    },
  });
}
