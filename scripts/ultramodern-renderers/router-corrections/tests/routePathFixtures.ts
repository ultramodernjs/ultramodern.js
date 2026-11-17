import { BaseRootRoute, BaseRoute } from '../src';

// Mirrors the route tree @modern-js/plugin-tanstack generates: a flat
// `[lang]/page` leaf beside `[lang]/$` becomes the prefix index `$lang/`.
export function createGeneratedRouteTree() {
  const root = new BaseRootRoute({});
  const index = new BaseRoute({ getParentRoute: () => root, path: '/' });
  const lang = new BaseRoute({
    getParentRoute: () => root,
    path: '$lang/',
    loader: () => ({ home: true as const }),
  });
  const langSplat = new BaseRoute({
    getParentRoute: () => root,
    path: '$lang/$',
  });
  const langSearch = new BaseRoute({
    getParentRoute: () => root,
    path: '$lang/search',
  });
  const docs = new BaseRoute({ getParentRoute: () => root, path: 'docs' });
  const docsIndex = new BaseRoute({ getParentRoute: () => docs, path: '/' });
  const docsSlug = new BaseRoute({ getParentRoute: () => docs, path: '$slug' });
  const docsSplat = new BaseRoute({ getParentRoute: () => docs, path: '$' });
  const auth = new BaseRoute({ getParentRoute: () => root, id: '_auth' });
  const account = new BaseRoute({
    getParentRoute: () => auth,
    path: 'account',
  });
  const shop = new BaseRoute({ getParentRoute: () => root, path: '/shop' });
  const products = new BaseRoute({
    getParentRoute: () => shop,
    path: 'products/',
  });
  const productsSplat = new BaseRoute({
    getParentRoute: () => shop,
    path: 'products/$',
  });
  const routeTree = root.addChildren([
    index,
    lang,
    langSplat,
    langSearch,
    docs.addChildren([docsIndex, docsSlug, docsSplat]),
    auth.addChildren([account]),
    shop.addChildren([products, productsSplat]),
  ]);
  return { routeTree, lang, docsIndex, auth, account, products };
}

// Leading, repeated and trailing slashes plus a literal `__root__` segment.
export function createSlashEdgeRouteTree() {
  const root = new BaseRootRoute({});
  const edge = new BaseRoute({ getParentRoute: () => root, path: '//edge//' });
  const literalRoot = new BaseRoute({
    getParentRoute: () => edge,
    path: '/__root__//x',
  });
  const repeated = new BaseRoute({ getParentRoute: () => root, path: 'b//c' });
  const leading = new BaseRoute({ getParentRoute: () => root, path: '/lead/' });
  const routeTree = root.addChildren([
    edge.addChildren([literalRoot]),
    repeated,
    leading,
  ]);
  return { routeTree, edge, literalRoot, repeated, leading };
}

// Runtime BaseRoute.init values; the type and runtime suites share them.
export const generatedRouteIds = [
  '__root__',
  '/',
  '/$lang/',
  '/$lang/$',
  '/$lang/search',
  '/docs',
  '/docs/',
  '/docs/$slug',
  '/docs/$',
  '/_auth',
  '/_auth/account',
  '/shop',
  '/shop/products/',
  '/shop/products/$',
] as const;
export const generatedFullPaths = [
  '/',
  '/$lang/',
  '/$lang/$',
  '/$lang/search',
  '/docs',
  '/docs/',
  '/docs/$slug',
  '/docs/$',
  '/account',
  '/shop',
  '/shop/products/',
  '/shop/products/$',
] as const;
// Navigation targets per trailingSlash mode, with the route each one matches.
export const neverTargets = {
  '/': '/',
  '/$lang': '/$lang/',
  '/$lang/$': '/$lang/$',
  '/$lang/search': '/$lang/search',
  '/docs': '/docs/',
  '/docs/$slug': '/docs/$slug',
  '/docs/$': '/docs/$',
  '/account': '/_auth/account',
  '/shop': '/shop',
  '/shop/products': '/shop/products/',
  '/shop/products/$': '/shop/products/$',
} as const;
export const alwaysTargets = {
  '/': '/',
  '/$lang/': '/$lang/',
  '/$lang/$/': '/$lang/$',
  '/$lang/search/': '/$lang/search',
  '/docs/': '/docs/',
  '/docs/$slug/': '/docs/$slug',
  '/docs/$/': '/docs/$',
  '/account/': '/_auth/account',
  '/shop/': '/shop',
  '/shop/products/': '/shop/products/',
  '/shop/products/$/': '/shop/products/$',
} as const;
export const slashEdgeRouteIds = [
  '__root__',
  '/edge/',
  '/edge/__root__/x',
  '/b/c',
  '/lead/',
] as const;
export const slashEdgeFullPaths = [
  '/',
  '/edge/',
  '/edge/__root__/x',
  '/b/c',
  '/lead/',
] as const;
export const targetParams = { lang: 'en', slug: 'intro', _splat: 'a/b' };
