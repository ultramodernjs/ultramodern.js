/** Authored fixture sources for normal generated Solid and Octane apps. */
export function localizedNavigationFixture(renderer) {
  if (!['solid', 'octane'].includes(renderer))
    throw new Error(`Unknown native renderer: ${renderer}`);
  const adapter = `@modern-js/renderer-${renderer}`;
  const location = renderer === 'solid' ? 'location()' : 'location';
  const language = renderer === 'solid' ? 'language()' : 'language';
  const blocker = renderer === 'solid' ? 'blocker()' : 'blocker';
  const data = renderer === 'solid' ? 'data()' : 'data';
  return {
    'modern.config.ts': `import { defineConfig, i18nPlugin } from '@modern-js/ultramodern-app-tools';
export default defineConfig({
  renderer: '${renderer}',
  server: { ssr: true },
  plugins: [i18nPlugin({ localeDetection: {
    languages: ['en', 'cs'], fallbackLanguage: 'en',
    localisedUrls: {
      '/about': { en: '/about', cs: '/about' },
      '/blocked': { en: '/blocked', cs: '/blocked' },
      '/items': { en: '/items', cs: '/polozky' },
      '/items/:id': { en: '/items/:id', cs: '/polozky/:id' },
    },
  } })],
});
`,
    'locales/en/translation.json': '{"title":"English"}\n',
    'locales/cs/translation.json': '{"title":"Česky"}\n',
    'src/routes/layout.tsx': `import { type HistoryState, Outlet, useLocation } from '${adapter}/router';
import { LocalizedLink, useI18n } from '${adapter}/i18n';

export default function Layout() {
  const location = useLocation();
  const { language } = useI18n();
  return <main data-testid="navigation-layout">
    <nav>
      <LocalizedLink data-testid="localized-product" to="/items/$id" params={{ id: 'red' }} language="cs"
        search={(previous: Record<string, unknown>) => ({ ...previous, sort: 'price' })} hash="details"
        state={(previous: HistoryState) => ({ ...previous, cart: 'tractor' })} preload="intent"
        activeProps={{ 'data-selected': 'yes' }} inactiveProps={{ 'data-selected': 'no' }}>Red</LocalizedLink>
      <LocalizedLink data-testid="localized-replace" to="/items/$id" params={{ id: 'blue' }} language="cs"
        replace preload={false}>Blue</LocalizedLink>
      <LocalizedLink data-testid="localized-document" to="/about" language="cs" search={{ sort: 'document' }}
        hash="document" reloadDocument preload={false}>Document</LocalizedLink>
      <LocalizedLink data-testid="localized-relative" to="../items/$id" from="/about" params={{ id: 'relative' }} language="cs"
        preload={false}>Relative</LocalizedLink>
      <LocalizedLink data-testid="localized-bypass" to="/about" language="cs" ignoreBlocker preload={false}>Bypass</LocalizedLink>
      <LocalizedLink data-testid="localized-disabled" to="/about" language="cs" disabled>Disabled</LocalizedLink>
      <LocalizedLink data-testid="localized-external" to="https://example.invalid/outside" target="_blank">Outside</LocalizedLink>
    </nav>
    <output data-testid="navigation-language">{${language}}</output>
    <output data-testid="navigation-location">{JSON.stringify({ pathname: ${location}.pathname, search: ${location}.search, hash: ${location}.hash, state: ${location}.state })}</output>
    <Outlet />
  </main>;
}
`,
    'src/routes/page.tsx':
      'export default function Home() { return <h1>Navigation home</h1>; }\n',
    'src/routes/about/page.tsx':
      'export default function About() { return <h1 data-testid="navigation-about">About</h1>; }\n',
    'src/routes/items/[id]/page.tsx': `import { useLoaderData } from '${adapter}/router';
export default function Item() {
  const data = useLoaderData({ strict: false });
  return <pre data-testid="navigation-item">{JSON.stringify(${data})}</pre>;
}
`,
    'src/routes/items/[id]/page.data.ts': `import type { DataHandlerInput } from '@modern-js/renderer-core/data';
export function loader({ params, request }: DataHandlerInput) {
  return { id: params['id'], sort: new URL(request.url).searchParams.get('sort') };
}
`,
    'src/routes/blocked/page.tsx': `import { useBlocker } from '${adapter}/router';
export default function Blocked() {
  const blocker = useBlocker({ shouldBlockFn: async () => true, withResolver: true, enableBeforeUnload: false });
  return <section>
    <output data-testid="navigation-blocker">{${blocker}.status}</output>
    <button type="button" data-testid="navigation-reject" onClick={() => ${blocker}.reset?.()}>Stay</button>
    <button type="button" data-testid="navigation-accept" onClick={() => ${blocker}.proceed?.()}>Leave</button>
  </section>;
}
`,
  };
}
