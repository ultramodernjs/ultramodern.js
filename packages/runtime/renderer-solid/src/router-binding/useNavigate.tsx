import type {
  AnyRouter,
  FromPathOption,
  NavigateOptions,
  RegisteredRouter,
  UseNavigateResult,
} from '@tanstack/router-core';
import * as Solid from 'solid-js';
import { useRouter } from './useRouter';

export function useNavigate<
  TRouter extends AnyRouter = RegisteredRouter,
  TDefaultFrom extends string = string,
>(_defaultOpts?: {
  from?: FromPathOption<TRouter, TDefaultFrom>;
}): UseNavigateResult<TDefaultFrom> {
  const router = useRouter();

  const navigate: UseNavigateResult<TDefaultFrom> = options => {
    const from = options.from ?? _defaultOpts?.from;
    return router.navigate({
      ...options,
      ...(from === undefined ? {} : { from }),
    });
  };
  return navigate;
}

export function Navigate<
  TRouter extends AnyRouter = RegisteredRouter,
  const TFrom extends string = string,
  const TTo extends string | undefined = undefined,
  const TMaskFrom extends string = TFrom,
  const TMaskTo extends string = '',
>(props: NavigateOptions<TRouter, TFrom, TTo, TMaskFrom, TMaskTo>): null {
  const { navigate } = useRouter();

  Solid.onSettled(() => {
    navigate({
      ...props,
    });
  });

  return null;
}
