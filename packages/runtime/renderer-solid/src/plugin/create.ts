export type SolidAppSourceOptions = {
  appId: string;
  title: string;
  entryName?: string;
  appRole?: 'shell' | 'vertical';
  capabilities: {
    ssr: boolean;
    federation: boolean;
  };
};

export type SolidAppSourceArtifact = {
  path: string;
  content: string;
};

export type SolidAppSources = {
  sourceExtension: '.tsx';
  jsxImportSource: '@solidjs/web';
  artifacts: SolidAppSourceArtifact[];
};

/** The adapter owns the entry, route tree, document and hydration bootstrap. */
export function generateSolidAppSources(
  options: SolidAppSourceOptions,
): SolidAppSources {
  const entryName = options.entryName ?? 'main';
  if (entryName !== 'main') {
    throw new Error(
      'The Solid app template supports the main entry only. The create-time workspace writer places src/modern-app-env.d.ts, src/routes/index.css and the package manifest at the app root regardless of entryName, so it cannot yet route a second entry into src/<entryName>/. Add that entry by hand after generation (mirror src/routes under src/<entryName>/routes) until an admitted native multi-entry create template exists; the native entry generator itself already supports arbitrary entry names.',
    );
  }
  if (!options.appId.trim() || !options.title.trim()) {
    throw new Error('The Solid app template requires an appId and title.');
  }
  if (
    typeof options.capabilities.ssr !== 'boolean' ||
    typeof options.capabilities.federation !== 'boolean'
  ) {
    throw new Error('The Solid app template requires admitted capabilities.');
  }
  const title = JSON.stringify(options.title);
  const aboutTitle = JSON.stringify(`${options.title} - About`);
  const appId = JSON.stringify(options.appId);
  return {
    sourceExtension: '.tsx',
    jsxImportSource: '@solidjs/web',
    artifacts: [
      {
        path: 'src/routes/layout.tsx',
        content: `import type { JSX } from '@solidjs/web';
import { Link, Outlet } from '@modern-js/renderer-solid/router';
import Stable from '../components/Stable';
import './index.css';

const appTitle = ${title};

export default function Layout(): JSX.Element {
  return (
    <main data-testid="native-layout">
      <header>
        <p>{appTitle}</p>
        <nav aria-label="Application">
          <Link to="/">Home</Link>
          <Link to="/about">About</Link>
${options.capabilities.federation ? '          <Link to="/remotes">Federated applications</Link>\n' : ''}
        </nav>
      </header>
      <Stable />
      <Outlet />
    </main>
  );
}
`,
      },
      {
        path: 'src/routes/page.tsx',
        content: `import type { JSX } from '@solidjs/web';
import {
  ActionForm,
  Link,
  useLoaderData,
  useRouteAction,
} from '@modern-js/renderer-solid/router';
import Counter from '../components/Counter';

const appId = ${appId};
const appTitle = ${title};

export default function HomePage(): JSX.Element {
  const data = useLoaderData({ strict: false });
  const action = useRouteAction();
  return (
    <section data-app-id={appId} data-testid="native-route" data-renderer="solid">
      <h1>{appTitle}</h1>
      <Counter />
      <pre data-testid="native-loader-value">{JSON.stringify(data())}</pre>
      <ActionForm action={action}>
        <label>
          Name <input name="name" />
        </label>
        <button type="submit" disabled={action.pending()}>
          Save
        </button>
        <button type="submit" name="intent" value="redirect">
          Save and redirect
        </button>
      </ActionForm>
      <pre data-testid="native-action-value">
        {JSON.stringify(action.outcome())}
      </pre>
      <output data-testid="native-action-error">
        {action.error()?.message}
      </output>
      <Link to="/about">Open native about route</Link>
    </section>
  );
}
`,
      },
      {
        path: 'src/routes/page.head.ts',
        content: `import type { FileSystemRouteModule } from '@modern-js/renderer-solid/router';

export const head: NonNullable<FileSystemRouteModule['head']> = () => ({
  meta: [
    { title: ${title} },
    { name: 'description', content: 'Built with the native Solid renderer' },
  ],
});
`,
      },
      {
        path: 'src/routes/about/page.tsx',
        content: `import type { JSX } from '@solidjs/web';
import { Link } from '@modern-js/renderer-solid/router';

export default function AboutPage(): JSX.Element {
  return (
    <section data-testid="native-about">
      <h1>Native Solid navigation</h1>
      <Link to="/">Home</Link>
    </section>
  );
}
`,
      },
      {
        path: 'src/routes/about/page.head.ts',
        content: `import type { FileSystemRouteModule } from '@modern-js/renderer-solid/router';

export const head: NonNullable<FileSystemRouteModule['head']> = () => ({
  meta: [
    { title: ${aboutTitle} },
    { name: 'description', content: 'Built with the native Solid renderer' },
  ],
});
`,
      },
      {
        path: 'src/routes/page.data.ts',
        content: `import type { DataHandlerInput } from '@modern-js/renderer-core/data';

export function loader({ request }: DataHandlerInput) {
  const url = new URL(request.url);
  if (url.searchParams.get('case') === 'not-found')
    throw new Response('Native route not found', { status: 404 });
  if (url.searchParams.get('case') === 'error')
    throw new Error('Native loader failure');
  if (url.searchParams.get('case') === 'redirect')
    return new Response(null, { status: 302, headers: { location: '/about' } });
  return {
    message: 'Native loader value',
    privateValue: request.headers.get('x-conformance-private'),
  };
}

export function action({ request }: DataHandlerInput) {
  return request.formData().then(form => {
    const name = form.get('name');
    if (typeof name !== 'string' || name.trim().length === 0)
      return Response.json(
        { fieldErrors: { name: 'Name required' } },
        { status: 422 },
      );
    if (form.get('intent') === 'redirect')
      return new Response(null, {
        status: 303,
        headers: {
          location: '/about',
          'set-cookie': 'conformance-saved=1; Path=/; SameSite=Lax',
        },
      });
    if (form.get('intent') === 'throw') throw new Error('Native action failure');
    return {
      saved: name,
      privateValue: request.headers.get('x-conformance-private'),
    };
  });
}
`,
      },
      {
        path: 'src/routes/error.tsx',
        content: `import type { ErrorRouteComponent } from '@modern-js/renderer-solid/router';

const ErrorBoundary: ErrorRouteComponent = props => (
  <section data-testid="native-error">
    <h1>Something went wrong</h1>
    <output>
      {props.error instanceof Error ? props.error.message : String(props.error)}
    </output>
  </section>
);

export default ErrorBoundary;
`,
      },
      {
        path: 'src/routes/not-found.tsx',
        content: `import type { NotFoundRouteComponent } from '@modern-js/renderer-solid/router';

const NotFound: NotFoundRouteComponent = () => (
  <section data-testid="native-not-found">
    <h1>Page not found</h1>
  </section>
);

export default NotFound;
`,
      },
      {
        path: 'src/components/Counter.tsx',
        content: `import type { JSX } from '@solidjs/web';
import { createSignal } from 'solid-js';

export default function Counter(): JSX.Element {
  const [count, setCount] = createSignal(0);
  return (
    <section data-testid="native-edited-component">
      <span data-testid="native-hmr-marker">Counter before native edit</span>
      <button type="button" onClick={() => setCount(count() + 1)}>
        Increment
      </button>
      <output data-testid="native-count">{count()}</output>
    </section>
  );
}
`,
      },
      {
        path: 'src/components/Stable.tsx',
        content: `import type { JSX } from '@solidjs/web';
import { createSignal } from 'solid-js';

export default function Stable(): JSX.Element {
  const [count, setCount] = createSignal(0);
  return (
    <section data-testid="native-unaffected-component">
      <button type="button" onClick={() => setCount(count() + 1)}>
        Increment stable state
      </button>
      <output data-testid="native-unaffected-count">{count()}</output>
    </section>
  );
}
`,
      },
    ],
  };
}
