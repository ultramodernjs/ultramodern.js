import type { RouterHistory } from '@tanstack/history';
import type {
  AnyRoute,
  RouterOptions as CoreRouterOptions,
  TrailingSlashOption,
} from '@tanstack/router-core';

/** Native managed hydration transfers immutable public data only. */
export type RouterOptions<
  TRouteTree extends AnyRoute,
  TTrailingSlashOption extends TrailingSlashOption,
  TDefaultStructuralSharingOption extends boolean = false,
  TRouterHistory extends RouterHistory = RouterHistory,
  TDehydrated = undefined,
> = Omit<
  CoreRouterOptions<
    TRouteTree,
    TTrailingSlashOption,
    TDefaultStructuralSharingOption,
    TRouterHistory,
    TDehydrated
  >,
  'serializationAdapters'
> & {
  serializationAdapters?: never;
};
