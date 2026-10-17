import type { LocalisedUrlsOption } from '@modern-js/i18n-runtime-extensions/paths';
import {
  collectDataHeaders,
  dataMetadataToDocumentPolicy,
  mergeDataResponseIntoResponse,
  mergeDataResponseMetadata,
  mergeHeaderFields,
} from '@modern-js/renderer-core/data';
import {
  createNativeServerEntry as createServerEntry,
  type NativeI18nInstance,
  type NativeServerEntry,
  type NativeServerEntryOptions,
} from '@modern-js/renderer-core/entry-server';
import { createNativeRouter } from '@modern-js/renderer-core/router';
import type { ResponsePolicy } from '@modern-js/renderer-core/session';
import type { ServerRenderNode } from 'octane/server';
import {
  componentView,
  localizedRouterRoot,
  octaneRouterFactory,
} from './entry-application';
import { validateOctaneModuleManifest } from './manifest';
import {
  createOctaneRequestHandler,
  createSsrStreamResponse,
  getSsrStatus,
  OctaneRouterServer,
} from './router-server';
import { renderOctaneApplication, renderOctaneCSRDocument } from './server';

/** Document-describing fields an Octane route's `headers()` may set. */
const OCTANE_DOCUMENT_FIELDS = new Set([
  'content-language',
  'content-location',
  'content-disposition',
]);

/**
 * The loader projection strips representation fields; the ones an Octane route
 * declares for the document itself are kept, as Solid document headers are.
 */
export function withOctaneDocumentFields(
  policy: ResponsePolicy,
  responseHeaders: Headers,
): ResponsePolicy {
  const fields = collectDataHeaders(responseHeaders).filter(([name]) =>
    OCTANE_DOCUMENT_FIELDS.has(name.toLowerCase()),
  );
  return fields.length
    ? { ...policy, headers: [...policy.headers, ...fields] }
    : policy;
}

export { createNativeWorkerFederationRuntime } from './worker-federation';

export interface OctaneServerEntryOptions
  extends NativeServerEntryOptions<NativeI18nInstance, LocalisedUrlsOption> {
  readonly workerFederationLocale?: string;
}

const LocalizedRouterServer = localizedRouterRoot(OctaneRouterServer);

/** The native transport handlers of a generated Octane server entry. */
export function createNativeServerEntry(
  options: OctaneServerEntryOptions,
): NativeServerEntry {
  return createServerEntry(options, {
    document: (document, nativeManifest, identity) => ({
      ...document,
      nativeHydrationBuildId: validateOctaneModuleManifest(
        nativeManifest,
        identity,
      ).nativeHydrationBuildId,
    }),
    run: (_session, callback) => callback(),
    respond: (_session, response) => response,
    createRouter: (application, routerOptions) =>
      createNativeRouter(application, routerOptions, octaneRouterFactory),
    renderCSR: ({ session }, document) =>
      renderOctaneCSRDocument({ session, document }),
    renderComponent: (
      { session, workerFederation },
      component,
      document,
      i18n,
    ) =>
      renderOctaneApplication({
        session,
        App: componentView(component, i18n) as ServerRenderNode,
        document,
        federation: options.federation,
        workerFederation,
        workerFederationLocale: options.workerFederationLocale,
      }),
    async renderRoutes({
      request,
      context: { session, workerFederation },
      router,
      outcomes,
      document,
      forbiddenValues,
      i18n,
    }) {
      const response = await createOctaneRequestHandler({
        request,
        session,
        createRouter: () => router,
        serialization: { forbiddenValues },
      })(async ({ router, responseHeaders }) => {
        const metadata = mergeDataResponseMetadata(outcomes, {
          status: getSsrStatus(router),
        });
        // Route headers() take precedence over loader singleton fields; list
        // fields keep both.
        const policy = dataMetadataToDocumentPolicy({
          ...metadata,
          headers: mergeHeaderFields(
            collectDataHeaders(responseHeaders),
            metadata.headers,
          ),
        });
        session.resolveResponse(
          withOctaneDocumentFields(policy, responseHeaders),
        );
        const rendered = await renderOctaneApplication({
          session,
          ...(i18n
            ? {
                App: LocalizedRouterServer as ServerRenderNode,
                props: { router, i18n },
              }
            : {
                App: OctaneRouterServer as ServerRenderNode,
                props: { router },
              }),
          document,
          federation: options.federation,
          workerFederation,
          workerFederationLocale: options.workerFederationLocale,
          router,
        });
        return createSsrStreamResponse(router, rendered);
      });
      return session.committedPolicy
        ? response
        : mergeDataResponseIntoResponse(
            response,
            mergeDataResponseMetadata(outcomes, { status: response.status }),
          );
    },
  });
}
