import type {
  AnyRouter,
  RegisteredRouter,
  ResolveUseLoaderData,
  StrictOrFrom,
  UseLoaderDataResult,
} from '@tanstack/router-core';
import type { Accessor } from 'solid-js';
import { useMatch } from './useMatch';

export interface UseLoaderDataBaseOptions<
  TRouter extends AnyRouter,
  TFrom,
  TStrict extends boolean,
  TSelected,
> {
  select?: (match: ResolveUseLoaderData<TRouter, TFrom, TStrict>) => TSelected;
}

export type UseLoaderDataOptions<
  TRouter extends AnyRouter,
  TFrom extends string | undefined,
  TStrict extends boolean,
  TSelected,
> = StrictOrFrom<TRouter, TFrom, TStrict> &
  UseLoaderDataBaseOptions<TRouter, TFrom, TStrict, TSelected>;

export type UseLoaderDataRoute<out TId> = <
  TRouter extends AnyRouter = RegisteredRouter,
  TSelected = unknown,
>(
  opts?: UseLoaderDataBaseOptions<TRouter, TId, true, TSelected>,
) => Accessor<UseLoaderDataResult<TRouter, TId, true, TSelected>>;

export function useLoaderData<
  TRouter extends AnyRouter = RegisteredRouter,
  const TFrom extends string | undefined = undefined,
  TStrict extends boolean = true,
  TSelected = unknown,
>(
  opts: UseLoaderDataOptions<TRouter, TFrom, TStrict, TSelected>,
): Accessor<UseLoaderDataResult<TRouter, TFrom, TStrict, TSelected>> {
  return useMatch({
    ...opts,
    select: match => {
      // The hook reads the rendered match; router-core also types pending
      // matches, where loaderData is optional, in this shared match shape.
      return opts.select ? opts.select(match.loaderData!) : match.loaderData;
    },
  }) as any;
}
