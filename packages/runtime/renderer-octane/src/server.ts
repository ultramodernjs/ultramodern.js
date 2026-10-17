import {
  type DocumentAsset,
  type DocumentInlineData,
  prepareDocument,
} from '@modern-js/renderer-core/document';
import type { NativeFederationBinding } from '@modern-js/renderer-core/federation';
import {
  type RequestSession,
  type ResponsePolicy,
  untilAborted,
} from '@modern-js/renderer-core/session';
import type { WorkerFederationTransport } from '@modern-js/renderer-core/worker-federation';
import type { AnyRouter } from '@octanejs/tanstack-router';
import { transformReadableStreamWithRouter } from '@octanejs/tanstack-router/ssr/server';
import {
  createElement,
  earlySignalBootstrapScript,
  renderToReadableStream,
  type ServerRenderNode,
  type StreamOptions,
} from 'octane/server';
import {
  assertNativeHydrationBuildId,
  assertOctaneIdentity,
} from './bootstrap';
import { createFederationScope, FederationRoot } from './federation-context';
import { WorkerFederationRoot } from './worker-federation-context';

export interface OctaneDocumentOptions {
  /** One identity for this response, shared with the client's signal receiver. */
  readonly documentId: string;
  /** Actual native client compilation hash, separate from application identity. */
  readonly nativeHydrationBuildId: string;
  readonly rootId?: string;
  readonly lang?: string;
  readonly nonce?: string;
  readonly assets?: readonly DocumentAsset[];
  /** Placed after the renderer bootstrap and before the entry scripts. */
  readonly inlineData?: readonly DocumentInlineData[];
}

export type { DocumentInlineData as OctaneDocumentInlineData };

export interface OctaneDocumentResponseOptions<
  Bindings extends object = object,
> {
  readonly session: RequestSession<Bindings>;
  readonly document: OctaneDocumentOptions;
  readonly responsePolicy?: ResponsePolicy;
  /** Native route loading finishes its blocking HTTP work before rendering. */
  readonly resolveResponse?: (
    session: RequestSession<Bindings>,
  ) => ResponsePolicy | Promise<ResponsePolicy>;
}

export interface RenderOctaneApplicationOptions<
  Bindings extends object = object,
> extends OctaneDocumentResponseOptions<Bindings> {
  readonly App: ServerRenderNode;
  readonly props?: unknown;
  /** Native router serialization, owned by this request's router SSR context. */
  readonly injection?: StreamOptions['injection'];
  readonly router?: AnyRouter;
  readonly routerSerializationTimeoutMs?: number;
  /** This server compilation's native Module Federation runtime. */
  readonly federation?: NativeFederationBinding;
  readonly workerFederation?: WorkerFederationTransport;
  readonly workerFederationLocale?: string;
}

function prepareOctaneDocument<Bindings extends object>(
  session: RequestSession<Bindings>,
  document: OctaneDocumentOptions,
  hydrating: boolean,
) {
  assertOctaneIdentity(session.identity);
  if (session.platform.kind !== 'node' && session.platform.kind !== 'worker') {
    throw new Error(
      'An Octane document requires a Node or worker request platform.',
    );
  }
  assertNativeHydrationBuildId(document.nativeHydrationBuildId);
  const nonce = document.nonce;
  return prepareDocument(
    {
      identity: session.identity,
      documentId: document.documentId,
      hydrating,
      nativeHydrationBuildId: document.nativeHydrationBuildId,
    },
    {
      rootId: document.rootId,
      lang: document.lang,
      nonce: { script: nonce, style: nonce },
      assets: document.assets,
      inlineData: document.inlineData,
    },
  );
}

async function resolveDocumentResponse<Bindings extends object>(
  input: OctaneDocumentResponseOptions<Bindings>,
): Promise<void> {
  const { session } = input;
  if (input.responsePolicy && input.resolveResponse) {
    throw new Error('Choose one blocking Octane response policy resolver.');
  }
  if (input.resolveResponse) {
    // A resolver that ignores cancellation must not hold the request.
    session.resolveResponse(
      await untilAborted(input.resolveResponse(session), session.signal),
    );
  } else if (input.responsePolicy) {
    session.resolveResponse(input.responsePolicy);
  } else if (!session.responsePolicy) {
    session.resolveResponse({
      kind: 'document',
      status: 200,
      headers: [['content-type', 'text/html; charset=utf-8']],
      cache: { mode: 'no-store' },
    });
  }
}

/** Deliver the CSR document; native browser mounting owns the empty root. */
export async function renderOctaneCSRDocument<Bindings extends object>(
  input: OctaneDocumentResponseOptions<Bindings>,
): Promise<Response> {
  const { session } = input;
  try {
    const { rootId, lang, bootstrap, headAssets, entryScripts } =
      prepareOctaneDocument(session, input.document, false);
    await resolveDocumentResponse(input);
    if (session.responsePolicy?.kind === 'terminal')
      return session.respond(null);
    session.startRendering();
    const bytes = new TextEncoder().encode(
      `<!doctype html><html lang="${lang}"><head>${headAssets}</head><body><div id="${rootId}"></div>${bootstrap}${entryScripts}</body></html>`,
    );
    return session.respond(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    );
  } catch (error) {
    await session.fail(error);
    throw error;
  }
}

/**
 * Render a native Octane application into one request-owned HTML document.
 * The dispatcher owns the session; this adapter owns native stream consumption
 * and document placement. A late native error fails the body without changing
 * the status and headers already sent to the client.
 */
export async function renderOctaneApplication<Bindings extends object>(
  input: RenderOctaneApplicationOptions<Bindings>,
): Promise<Response> {
  const { session, document } = input;
  try {
    const { rootId, lang, bootstrap, headAssets, entryScripts } =
      prepareOctaneDocument(session, document, true);
    const earlyBootstrap = earlySignalBootstrapScript(
      document.nonce === undefined ? {} : { nonce: document.nonce },
    );

    await resolveDocumentResponse(input);
    if (session.responsePolicy?.kind === 'terminal')
      return session.respond(null);
    session.startRendering();

    let head = '';
    const federation = input.federation
      ? createFederationScope(input.federation, true, document.nonce)
      : undefined;
    const App = federation
      ? () =>
          createElement(FederationRoot, {
            scope: federation,
            children:
              typeof input.App === 'function'
                ? createElement(input.App, input.props)
                : input.App,
          })
      : input.App;
    const workerFederation = input.workerFederation;
    const NativeApp = workerFederation
      ? () =>
          createElement(WorkerFederationRoot, {
            scope: {
              transport: workerFederation,
              locale: input.workerFederationLocale ?? 'default',
              signal: session.signal,
            },
            children:
              typeof App === 'function' ? createElement(App, input.props) : App,
          })
      : App;
    const nativeStream = await renderToReadableStream(NativeApp, input.props, {
      signal: session.signal,
      ...(document.nonce === undefined ? {} : { nonce: document.nonce }),
      earlySignalBootstrap: 'external',
      ...(input.injection === undefined ? {} : { injection: input.injection }),
      streamedSignals: {
        buildId: document.nativeHydrationBuildId,
        documentId: document.documentId,
      },
      externalSnapshots: { documentId: document.documentId },
      headChannel: 'separate',
      onHeadReady(value) {
        head = value;
      },
      onError(error) {
        // Octane reports recoverable Suspense-boundary errors here as well as
        // fatal ones. A recoverable error streams the boundary's client
        // fallback into an otherwise valid document, so it must not terminate
        // the request. Fatal errors reject the shell or allReady instead.
        if (session.signal.aborted) return;
        // A document carrying an errored boundary must not enter a shared cache.
        session.markFallback();
        console.error('Octane render error:', error);
      },
    });
    // Observe rejection immediately, but consume concurrently: native allReady
    // requires downstream demand and cannot be awaited before reading the body.
    const ready = nativeStream.allReady.then(
      () => ({ ok: true as const }),
      error => ({ ok: false as const, error }),
    );
    const reader = nativeStream.getReader();
    const encoder = new TextEncoder();
    const prefix = encoder.encode(
      `<!doctype html><html lang="${lang}"><head>${head}${headAssets}</head><body>${earlyBootstrap}<div id="${rootId}">`,
    );
    const shellBootstrap = encoder.encode(`</div>${bootstrap}${entryScripts}`);
    const suffix = encoder.encode('</body></html>');
    let phase: 'prefix' | 'shell' | 'bootstrap' | 'native' | 'done' = 'prefix';
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      reader.releaseLock();
    };
    let cancellation: Promise<void> | undefined;
    const cancelNative = (reason: unknown): Promise<void> => {
      if (cancellation) return cancellation;
      if (released) return Promise.resolve();
      cancellation = reader.cancel(reason).finally(release);
      return cancellation;
    };
    // Cleanup starts native cancellation without waiting for it: a native
    // stream that never finishes cancelling must not hold the session.
    const releaseNative = (reason: unknown) => {
      void cancelNative(reason).catch(() => {});
    };
    try {
      session.registerCleanup(() => releaseNative(session.signal.reason));
    } catch (error) {
      // The request can abort between native shell readiness and registration.
      releaseNative(error);
      throw error;
    }
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            if (phase === 'prefix') {
              phase = 'shell';
              controller.enqueue(prefix);
              return;
            }
            if (phase === 'bootstrap') {
              phase = 'native';
              controller.enqueue(shellBootstrap);
              return;
            }
            const next = await reader.read();
            if (!next.done) {
              // Octane 0.7.1 writes its complete initial shell as the first
              // chunk, including initial signal selections. Close only our
              // root after it, then start the browser before deferred segments.
              // Later native carriers find their targets in the whole document.
              if (phase === 'shell') phase = 'bootstrap';
              controller.enqueue(next.value);
              return;
            }
            if (phase === 'shell') {
              throw new Error(
                'Octane ended before publishing its initial shell.',
              );
            }
            const completion = await ready;
            release();
            if (!completion.ok) throw completion.error;
            phase = 'done';
            controller.enqueue(suffix);
            controller.close();
          } catch (error) {
            phase = 'done';
            // An errored ReadableStream does not invoke its cancel callback.
            // Release the native owner here as well as on consumer cancellation.
            releaseNative(error);
            controller.error(error);
          }
        },
        cancel(reason) {
          phase = 'done';
          releaseNative(reason);
        },
      },
      { highWaterMark: 0 },
    );
    return session.respond(
      input.router
        ? transformReadableStreamWithRouter(input.router, body, {
            signal: session.signal,
            rendererSafePoint: 'script-close',
            timeoutMs: input.routerSerializationTimeoutMs,
            onAbort: reason => {
              void session.fail(reason);
            },
          })
        : body,
    );
  } catch (error) {
    await session.fail(error);
    throw error;
  }
}
