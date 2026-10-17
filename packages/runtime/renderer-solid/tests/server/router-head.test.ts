import type { FileSystemRouteIR } from '@modern-js/renderer-core/data';
import { createRequestSession } from '@modern-js/renderer-core/session';
import { ssr } from '@solidjs/web';
import { createComponent } from 'solid-js';
import {
  ApplicationRouter,
  createApplicationRouter,
  createFileSystemRouteTree,
  createMemoryHistory,
} from '../../src/router';
import { Asset } from '../../src/router-binding/Asset';
import { renderApplication, renderDocumentApplication } from '../../src/server';

const nonce = 'route-head-nonce';
const routes: FileSystemRouteIR[] = [
  {
    id: 'layout',
    isRoot: true,
    children: [
      { id: 'item', path: 'items/:itemId', children: [] },
      { id: 'other', path: 'other', children: [] },
    ],
  },
];

function sessionAt(path: string) {
  const session = createRequestSession({
    request: new Request(`https://shop.test${path}`),
    identity: {
      renderer: 'solid',
      appId: 'router-head',
      entryName: 'main',
      buildId: 'head-build',
      protocolVersion: 1,
    },
    platform: { kind: 'node', bindings: {} },
  });
  session.resolveResponse({
    kind: 'document',
    status: 200,
    headers: [['content-type', 'text/html; charset=utf-8']],
    cache: { mode: 'private' },
  });
  return session;
}

async function routerAt(path: string) {
  const router = createApplicationRouter({
    routeTree: createFileSystemRouteTree(routes, {
      layout: {
        head: () => ({
          meta: [
            { title: 'Root title' },
            { name: 'description', content: 'Root description' },
            { name: 'layout-only', content: 'Layout persists' },
          ],
        }),
      },
      item: {
        component: () => ssr('<main>native item view</main>'),
        head: ({ params }) => ({
          meta: [
            { title: `Item ${params.itemId}` },
            { name: 'description', content: `Description ${params.itemId}` },
          ],
          styles: [
            { 'data-head-number': '', children: 42 },
            { 'data-head-array': '', children: ['a', 'b'] },
          ],
          scripts: [
            { src: '/route-head.js', type: 'module' },
            { type: 'application/json', 'data-head-number': '', children: 42 },
            {
              type: 'application/json',
              'data-head-array': '',
              children: ['a', 'b'],
            },
          ],
        }),
      },
      other: {
        component: () => ssr('<main>native other view</main>'),
        head: () => ({ meta: [{ title: 'Other route' }] }),
      },
    }),
    history: createMemoryHistory({ initialEntries: [path] }),
    ssr: { nonce },
    isServer: true,
  });
  await router.load();
  return router;
}

describe('native router document head', () => {
  test('native child metadata overrides its layout inside the full document with one hydration bootstrap', async () => {
    const router = await routerAt('/items/42');
    const session = sessionAt('/items/42');
    const html = await (
      await renderDocumentApplication({
        session,
        document: { nonce, renderId: 'native-head:' },
        view: () => createComponent(ApplicationRouter, { router }),
      })
    ).text();
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('native item view');
    expect(head).toMatch(/<title\b[^>]*>Item 42<\/title>/);
    expect(head.match(/<title\b/g)).toHaveLength(1);
    expect(head.match(/name="description"/g)).toHaveLength(1);
    expect(head).toContain('content="Description 42"');
    expect(head).toContain('content="Layout persists"');
    expect(head).not.toContain('Root description');
    expect(head).not.toContain('Root title');
    expect(head).toMatch(
      /<script\b(?=[^>]*src="\/route-head\.js")(?=[^>]*nonce="route-head-nonce")[^>]*>/,
    );
    expect(html.match(/window\._\$HY\|\|/g)).toHaveLength(1);
    expect(html.match(/id="__ULTRAMODERN_RENDERER__"/g)).toHaveLength(1);
    expect((await session.completion).state).toBe('completed');
  });

  test('native head registry preserves numeric and array style and script children', async () => {
    const router = await routerAt('/items/42');
    const html = await (
      await renderDocumentApplication({
        session: sessionAt('/items/42'),
        document: { nonce, renderId: 'head-values:' },
        view: () => createComponent(ApplicationRouter, { router }),
      })
    ).text();
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
    expect(head).toMatch(/<style\b[^>]*data-head-number[^>]*>42<\/style>/);
    expect(head).toMatch(/<style\b[^>]*data-head-array[^>]*>a,b<\/style>/);
    expect(head).toMatch(/<script\b[^>]*data-head-number[^>]*>42<\/script>/);
    expect(head).toMatch(/<script\b[^>]*data-head-array[^>]*>a,b<\/script>/);
  });

  test('managed Asset style children override an incoming innerHTML attribute when absent', async () => {
    const html = await (
      await renderApplication({
        session: sessionAt('/asset'),
        view: () =>
          createComponent(Asset, {
            tag: 'style',
            attrs: { innerHTML: 'unmanaged-style-text' },
          }),
      })
    ).text();
    expect(html).toContain('<style');
    expect(html).not.toContain('unmanaged-style-text');
  });

  test('native fragment rendering forwards route metadata through its own onHead callback', async () => {
    const router = await routerAt('/items/7');
    const session = sessionAt('/items/7');
    const heads: string[] = [];
    const html = await (
      await renderApplication({
        session,
        document: { nonce, onHead: head => heads.push(head) },
        view: () => createComponent(ApplicationRouter, { router }),
      })
    ).text();
    expect(html).toContain('native item view');
    expect(heads).toHaveLength(1);
    expect(heads[0]).toContain('Item 7');
    expect(heads[0]).toContain('content="Description 7"');
    expect(heads[0]).toContain('src="/route-head.js"');
    expect(heads[0]).toContain('nonce="route-head-nonce"');
    expect(heads[0]).not.toContain('Root description');
    expect((await session.completion).state).toBe('completed');
  });

  test('concurrent native requests keep route titles and descriptions separate', async () => {
    const [first, second] = await Promise.all([
      routerAt('/items/first'),
      routerAt('/items/second'),
    ]);
    const render = async (
      router: typeof first,
      path: string,
      renderId: string,
    ) =>
      (
        await renderDocumentApplication({
          session: sessionAt(path),
          document: { nonce, renderId },
          view: () => createComponent(ApplicationRouter, { router }),
        })
      ).text();
    const [firstHTML, secondHTML] = await Promise.all([
      render(first, '/items/first', 'head-first:'),
      render(second, '/items/second', 'head-second:'),
    ]);
    expect(firstHTML).toContain('Item first');
    expect(firstHTML).toContain('Description first');
    expect(firstHTML).not.toContain('Description second');
    expect(secondHTML).toContain('Item second');
    expect(secondHTML).toContain('Description second');
    expect(secondHTML).not.toContain('Description first');
  });
});
