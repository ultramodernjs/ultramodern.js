import type { DecodedDataOutcome } from '@modern-js/renderer-core/data';
import { createDataClient } from '@modern-js/renderer-core/data';
import type { RendererIdentity } from '@modern-js/renderer-core/identity';
import {
  assertRendererIdentity,
  identityCacheKey,
} from '@modern-js/renderer-core/identity';
import type { JSX } from '@solidjs/web';
import { getRequestEvent } from '@solidjs/web';
import type { Accessor } from 'solid-js';
import { createSignal, getOwner, omit, onCleanup, untrack } from 'solid-js';
import type { AnyRouter } from './router-binding/index';
import { redirect, useMatch, useRouter } from './router-binding/index';
import type {
  PublicMatchError,
  PublicSnapshotOwner,
} from './router-binding/publicMatchData';
import {
  preparePublicLoaderData,
  preparePublicMatchError,
} from './router-binding/publicMatchData';

export interface RouteActionOptions {
  router: AnyRouter;
  routeId: string;
  rendererIdentity: RendererIdentity;
  url?: string | URL;
  fetch?: typeof globalThis.fetch;
}

export interface RouteAction {
  readonly routeId: string;
  readonly pending: Accessor<boolean>;
  readonly outcome: Accessor<DecodedDataOutcome | undefined>;
  readonly error: Accessor<Error | undefined>;
  readonly url: Accessor<string>;
  /** Cancellation and superseded submissions resolve without publishing stale data. */
  submit(request: Request): Promise<DecodedDataOutcome | undefined>;
  submitForm(
    form: HTMLFormElement,
    submitter?: HTMLElement | null,
  ): Promise<DecodedDataOutcome | undefined>;
  cancel(): void;
  dispose(): void;
}

/** An asynchronous action exposes its public failure to the form's owner. */
export class RouteActionError extends Error {
  readonly routeId: string;
  readonly status: number;
  readonly data: unknown;
  readonly outcome: Extract<
    DecodedDataOutcome,
    { kind: 'error' | 'not-found' }
  >;

  constructor(
    routeId: string,
    outcome: Extract<DecodedDataOutcome, { kind: 'error' | 'not-found' }>,
  ) {
    super(
      outcome.kind === 'error'
        ? outcome.error.message
        : 'Action route not found',
    );
    this.name = outcome.kind === 'error' ? outcome.error.name : 'RouteNotFound';
    this.routeId = routeId;
    this.status = outcome.status;
    this.data = outcome.kind === 'error' ? outcome.data : outcome.value;
    this.outcome = outcome;
    Reflect.deleteProperty(this, 'stack');
    const stack =
      outcome.kind === 'error'
        ? Object.getOwnPropertyDescriptor(outcome.error, 'stack')?.value
        : undefined;
    if (typeof stack === 'string') this.stack = stack;
    Object.freeze(this);
  }
}

function actionFailure(
  cause: unknown,
  owner?: PublicSnapshotOwner,
  privateContexts: readonly unknown[] = [],
): Error {
  let projection: ReturnType<typeof preparePublicMatchError>;
  try {
    projection = preparePublicMatchError(
      cause instanceof Error
        ? cause
        : new Error('The Solid route action failed', { cause }),
      owner,
      privateContexts,
    );
  } catch {
    projection = Object.freeze({
      name: 'DataProtocolError',
      message: 'Invalid public Solid action error',
    });
  }
  const nested = 'error' in projection ? projection.error : undefined;
  const diagnostic = (
    nested && typeof nested === 'object' ? nested : projection
  ) as PublicMatchError;
  const failure = new Error(
    typeof diagnostic.message === 'string' &&
      diagnostic.message !== 'Unexpected Server Error'
      ? diagnostic.message
      : 'The Solid route action failed',
    Object.hasOwn(diagnostic, 'cause')
      ? { cause: diagnostic.cause }
      : undefined,
  );
  failure.name =
    typeof diagnostic.name === 'string' ? diagnostic.name : 'Error';
  // Only the helper's checked diagnostic stack enters the public error.
  Reflect.deleteProperty(failure, 'stack');
  if (typeof diagnostic.stack === 'string') failure.stack = diagnostic.stack;
  return Object.freeze(failure);
}

function actionOutcome(
  result: DecodedDataOutcome,
  owner: PublicSnapshotOwner,
  privateContexts: readonly unknown[],
): DecodedDataOutcome {
  if (result.kind !== 'success')
    return preparePublicLoaderData(
      result,
      owner,
      privateContexts,
    ) as DecodedDataOutcome;
  // Deferred slots belong to the public value. Framing completion stays private
  // and submit()/pending represent its lifecycle to the action owner.
  return Object.freeze({
    kind: 'success',
    value: preparePublicLoaderData(result.value, owner, privateContexts),
    status: result.status,
  });
}

function routerIdentity(router: AnyRouter): RendererIdentity | undefined {
  const context = router.options.context as
    | { ultramodern?: { rendererIdentity?: RendererIdentity } }
    | undefined;
  if (context?.ultramodern === undefined) return undefined;
  const identity = context.ultramodern?.rendererIdentity;
  if (!identity) {
    throw new Error('Solid router context requires its renderer identity');
  }
  identityCacheKey(identity);
  return identity;
}

export function createRouteAction(options: RouteActionOptions): RouteAction {
  const { router, routeId } = options;
  if (!routeId)
    throw new Error('A Solid action requires its filesystem route ID');
  identityCacheKey(options.rendererIdentity);
  if (options.rendererIdentity.renderer !== 'solid') {
    throw new Error('A Solid action requires the Solid renderer identity');
  }
  const configuredIdentity = routerIdentity(router);
  if (configuredIdentity) {
    assertRendererIdentity(options.rendererIdentity, configuredIdentity);
  }
  const identity = Object.freeze({ ...options.rendererIdentity });
  const client = createDataClient(
    routeId,
    identity,
    options.fetch ? { fetch: options.fetch } : {},
  );
  // Capture the request while the native SSR request scope is active.
  const requestURL = getRequestEvent()?.request.url;
  const url = () => {
    const base =
      typeof window === 'undefined' ? requestURL : window.location.href;
    const location = options.url ?? router.state.location.publicHref;
    if (!base && !URL.canParse(String(location))) {
      throw new Error('A server Solid action requires its native request URL');
    }
    return new URL(location, base).href;
  };
  const [pending, setPending] = createSignal(false);
  const [outcome, setOutcome] = createSignal<DecodedDataOutcome>();
  const [error, setError] = createSignal<Error>();
  let active: AbortController | undefined;
  let disposed = false;

  function cancel() {
    const current = active;
    if (!current) return;
    active = undefined;
    current.abort(new DOMException('The action was cancelled', 'AbortError'));
    setPending(false);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancel();
  }

  function submit(request: Request): Promise<DecodedDataOutcome | undefined> {
    if (disposed) throw new Error('The Solid action owner has been disposed');
    if (request.method === 'GET' || request.method === 'HEAD') {
      throw new Error('A Solid action requires a mutation Request');
    }
    cancel();
    const controller = new AbortController();
    active = controller;
    const signal = controller.signal;
    const abortRequest = () => controller.abort(request.signal.reason);
    if (request.signal.aborted) abortRequest();
    else request.signal.addEventListener('abort', abortRequest, { once: true });
    const current = () => active === controller && !signal.aborted && !disposed;
    const privateContexts = [router.options.context, request];
    const owner: PublicSnapshotOwner = {
      signal,
      fail(failure) {
        if (!current()) return;
        setError(actionFailure(failure, owner, privateContexts));
        controller.abort(failure);
      },
    };
    setOutcome(undefined);
    setError(undefined);
    setPending(true);
    const cancelled = Symbol('cancelled action');
    let resolveCancellation!: (value: typeof cancelled) => void;
    const cancellation = new Promise<typeof cancelled>(resolve => {
      resolveCancellation = resolve;
    });
    const abort = () => {
      if (active === controller) {
        active = undefined;
        setPending(false);
      }
      resolveCancellation(cancelled);
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });

    return (async () => {
      try {
        if (!current()) return undefined;
        const result = await Promise.race([
          client.action({ request: new Request(request, { signal }) }),
          cancellation,
        ]);
        if (result === cancelled || !current()) return undefined;
        const publicResult = actionOutcome(result, owner, privateContexts);
        setOutcome(publicResult);
        // The core promises remain intact; terminal framing owns action completion.
        if (
          (await Promise.race([
            Promise.resolve(result.completion),
            cancellation,
          ])) === cancelled ||
          !current()
        )
          return undefined;
        if (
          publicResult.kind === 'error' ||
          publicResult.kind === 'not-found'
        ) {
          setError(new RouteActionError(routeId, publicResult));
        } else if (result.kind === 'redirect') {
          // A navigation is a GET. HTTP allows that for 303, and for 301/302
          // only after POST; other redirects keep the method and body.
          if (
            result.status === 307 ||
            result.status === 308 ||
            ((result.status === 301 || result.status === 302) &&
              request.method !== 'POST')
          )
            throw new Error(
              `A native action redirect must not preserve the method (HTTP ${result.status} after ${request.method}); redirect with 303 to navigate after the mutation`,
            );
          // HTTP Location is relative to the mutation URL. Native resolution
          // retains protocol policy and chooses document versus route navigation.
          const resolved = router.resolveRedirect(
            redirect({
              href: new URL(result.location, request.url).href,
              statusCode: result.status,
            }),
          );
          // Native navigation commits the destination synchronously. Invalidate
          // immediately so cached matches refresh there, before the old owner
          // can be disposed; the abandoned page does not load again.
          const navigation = router.navigate({
            ...resolved.options,
            replace: true,
          });
          const refresh = resolved.options.reloadDocument
            ? Promise.resolve()
            : router.invalidate({ sync: true });
          await Promise.race([
            Promise.all([navigation, refresh]),
            cancellation,
          ]);
        } else if (result.status < 400) {
          await Promise.race([router.invalidate({ sync: true }), cancellation]);
        }
        return current() ? publicResult : undefined;
      } catch (failure) {
        owner.fail(failure);
        return undefined;
      } finally {
        request.signal.removeEventListener('abort', abortRequest);
        signal.removeEventListener('abort', abort);
        if (active === controller) {
          active = undefined;
          setPending(false);
        }
      }
    })();
  }

  async function submitForm(
    form: HTMLFormElement,
    submitter?: HTMLElement | null,
  ) {
    try {
      const button =
        submitter instanceof HTMLButtonElement ||
        submitter instanceof HTMLInputElement
          ? submitter
          : undefined;
      const method = button?.hasAttribute('formmethod')
        ? button.formMethod
        : form.method;
      if (method.toLowerCase() !== 'post') {
        throw new Error('A Solid action form requires method="post"');
      }
      const target = button?.hasAttribute('formtarget')
        ? button.formTarget
        : form.target;
      if (target && target.toLowerCase() !== '_self') {
        throw new Error(
          'A Solid action form requires the current browsing context',
        );
      }
      const destination = button?.hasAttribute('formaction')
        ? button.formAction
        : form.action;
      const formData = new FormData(form, button);
      const encoding = button?.hasAttribute('formenctype')
        ? button.formEnctype
        : form.enctype;
      let body: BodyInit;
      if (encoding === 'multipart/form-data') {
        body = formData;
      } else if (encoding === 'application/x-www-form-urlencoded') {
        const encoded = new URLSearchParams();
        for (const [name, value] of formData) {
          encoded.append(name, typeof value === 'string' ? value : value.name);
        }
        body = encoded;
      } else {
        throw new Error(`Unsupported Solid action form encoding: ${encoding}`);
      }
      return await submit(
        new Request(new URL(destination || url(), url()), {
          method: 'POST',
          body,
          credentials: 'same-origin',
        }),
      );
    } catch (failure) {
      if (!disposed)
        setError(actionFailure(failure, undefined, [router.options.context]));
      return undefined;
    }
  }

  if (getOwner()) onCleanup(dispose);
  return Object.freeze({
    routeId,
    pending,
    outcome,
    error,
    url,
    submit,
    submitForm,
    cancel,
    dispose,
  });
}

/** Bind a form to the closest native route without a second route-ID authority. */
export function useRouteAction(): RouteAction {
  const router = useRouter();
  if (!router) throw new Error('useRouteAction requires a native Solid router');
  const identity = routerIdentity(router);
  if (!identity) {
    throw new Error(
      'useRouteAction requires the application renderer identity',
    );
  }
  const match = useMatch({ strict: false });
  // One-time snapshot: this hook identifies the filesystem route it was
  // called from, which is fixed for the component instance's lifetime (a
  // route component is not reused across matches). Reading the accessor
  // here is intentionally non-reactive, so `untrack` is the correct escape
  // hatch rather than a tracking scope.
  const routeMatch = untrack(match);
  const route = router.routesById[routeMatch.routeId];
  const routeId = (
    route?.options.staticData as { ultramodernRouteId?: string } | undefined
  )?.ultramodernRouteId;
  if (!routeId) {
    throw new Error('useRouteAction requires a native filesystem route');
  }
  return createRouteAction({ router, routeId, rendererIdentity: identity });
}

export type ActionFormProps = Omit<
  JSX.FormHTMLAttributes<HTMLFormElement>,
  'action' | 'method' | 'onSubmit' | 'onSubmitCapture'
> & {
  action: RouteAction;
  children?: JSX.Element;
};

/** Native controls produce the request body; the renderer owns data transport. */
export function ActionForm(props: ActionFormProps): JSX.Element {
  const submit: JSX.EventHandler<HTMLFormElement, SubmitEvent> = event => {
    event.preventDefault();
    void props.action.submitForm(event.currentTarget, event.submitter);
  };
  return (
    <form
      {...omit(props, 'action')}
      action={props.action.url()}
      method="post"
      enctype={props.enctype ?? 'application/x-www-form-urlencoded'}
      onSubmit={submit}
    />
  );
}
