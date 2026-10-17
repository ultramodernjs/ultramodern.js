import type { WorkerFederationTransport } from '@modern-js/renderer-core/worker-federation';
import { createContext, createElement } from 'octane';
import {
  FederationApplication,
  type OctaneFederationScope,
} from './federation-context';

export interface OctaneWorkerFederationScope {
  readonly transport: WorkerFederationTransport;
  /** Compiled entry fallback; localized providers supply their live language. */
  readonly locale: string;
  /** Own document disposal; each lazy admission also owns its waiter deadline. */
  readonly signal?: AbortSignal;
}

export type OctaneWorkerFederationFactory = (
  signal: AbortSignal,
) => OctaneWorkerFederationScope;

/** Each native document owns its transport and captured publisher authorities. */
export const WorkerFederationContext =
  createContext<OctaneWorkerFederationScope | null>(null);

export function WorkerFederationRoot(props: {
  readonly scope: OctaneWorkerFederationScope;
  readonly children?: unknown;
}) {
  return createElement(WorkerFederationContext, {
    value: props.scope,
    children: props.children,
  });
}

/** Stable native root used for startup and application updates alike. */
export function WorkerFederationApplication(props: {
  readonly scope: OctaneWorkerFederationScope;
  readonly federation?: OctaneFederationScope;
  readonly application: Parameters<
    typeof FederationApplication
  >[0]['application'];
}) {
  return createElement(WorkerFederationRoot, {
    scope: props.scope,
    children: props.federation
      ? createElement(FederationApplication, {
          scope: props.federation,
          application: props.application,
        })
      : createElement(props.application.default, props.application.props),
  });
}
