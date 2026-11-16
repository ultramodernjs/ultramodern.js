import {
	Link,
	matchContext as MatchContext,
	routerContext as RouterContext,
	useLoaderData,
	useParams,
	useRouterState,
} from '@octanejs/tanstack-router';
import type { AnyRouter } from '@tanstack/router-core';

function SnapshotContents(props: { to: string }) @{
	const state = useRouterState();
	const params = useParams({ strict: false });
	const loaderData = useLoaderData({ strict: false });
	const serializedLoaderData = JSON.stringify(loaderData) ?? 'undefined';
	<section data-pathname={state.location.pathname} data-loading={String(state.isLoading)}>
		<output class="snapshot-params">{JSON.stringify(params) as string}</output>
		<output class="snapshot-data">{serializedLoaderData as string}</output>
		<Link to={props.to} class="snapshot-link">
			{'Destination'}
		</Link>
	</section>
}

export function RouterRenderSnapshotSurface(props: { router: AnyRouter; to: string }) @{
	const nearestMatch = props.router.state.matches.at(-1);
	<RouterContext value={props.router}>
		<MatchContext value={nearestMatch?.routeId}>
			<SnapshotContents to={props.to} />
		</MatchContext>
	</RouterContext>
}
