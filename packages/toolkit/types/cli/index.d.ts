import type * as React from 'react';
import type {
  NestedRoute as BaseNestedRoute,
  PageRoute as BasePageRoute,
  Route as BaseRoute,
} from './base';

export type {
  Entrypoint,
  HtmlPartials,
  HtmlTemplates,
  Merge,
  RouteLegacy,
  SSGConfig,
  SSGMultiEntryOptions,
  SSGRouteOptions,
  SSGSingleEntryOptions,
  SSGSingleEntryOptionsFactory,
} from './base';

export interface Route extends BaseRoute<React.ReactNode> {
  children?: Route[] | undefined;
}

export type NestedRouteForCli = NestedRoute<string>;

export interface NestedRoute<T = string | (() => React.ReactElement)>
  extends Route,
    Omit<
      BaseNestedRoute<T, React.ReactNode>,
      keyof BaseRoute<React.ReactNode>
    > {
  type: 'nested';
  children?: NestedRoute<T>[];
}

export interface PageRoute
  extends Route,
    Omit<BasePageRoute<React.ReactNode>, keyof BaseRoute<React.ReactNode>> {
  type: 'page';
  parent?: PageRoute;
  children?: PageRoute[];
}
