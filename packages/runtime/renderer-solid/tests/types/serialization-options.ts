import {
  createApplicationRouter,
  createRootRoute,
  createRouter,
  type RouterOptions,
  type RouterProps,
} from '../../src/router';

const routeTree = createRootRoute();
const router = createRouter({ routeTree });
const configured = { routeTree, serializationAdapters: [] };

// @ts-expect-error Native constructors do not implement custom serialization adapters.
createRouter({ routeTree, serializationAdapters: [] });
// @ts-expect-error Managed application constructors use the same public-data contract.
createApplicationRouter({ routeTree, serializationAdapters: [] });
// @ts-expect-error Upstream update excludes the unsupported option too.
router.update({ serializationAdapters: [] });
// @ts-expect-error Named public options reject structurally typed variables too.
const options: RouterOptions<typeof routeTree, 'never'> = configured;
// @ts-expect-error Providers cannot introduce a serializer absent from the public-data protocol.
const props: RouterProps<typeof router> = { router, ...configured };
void options;
void props;
