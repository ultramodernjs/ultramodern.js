import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSourceFederationDependencies } from '../../../scripts/ultramodern-renderers/native-federation-source-dependencies.mjs';

const octaneVersion = '0.13.8';
const routerVersion = '0.2.10';

/** Decode only server segments that Octane completed in the same document. */
export function decodeOctaneSSRDocument(html) {
  const segments = Array.from(
    html.matchAll(
      /<div\b(?=[^>]*\bhidden)(?=[^>]*\bdata-oct-s="([^"]+)")[^>]*>\s*<script\b(?=[^>]*\btype="application\/json")(?=[^>]*\bdata-octane-stream\b)[^>]*>([\s\S]*?)<\/script>\s*<\/div>/gu,
    ),
    ([, id, payload]) => {
      const markup = JSON.parse(payload);
      assert.equal(typeof markup, 'string', 'native SSR segment holds HTML');
      const completion = `<script data-octane-stream>$OCTRC(${JSON.stringify(id)})</script>`;
      return { id, markup, completed: html.includes(completion) };
    },
  );
  return {
    markup: [
      html,
      ...segments
        .filter(segment => segment.completed)
        .map(segment => segment.markup),
    ].join('\n'),
    segments,
  };
}

export async function linkOctaneFederationDependencies({
  root,
  directory,
  registerArtifact,
}) {
  const appTools = path.join(root, 'packages/solutions/ultramodern-app-tools');
  const renderer = path.join(root, 'packages/runtime/renderer-octane');
  const real = (from, request) =>
    fs.realpath(path.join(from, 'node_modules', request));
  const federation = await resolveSourceFederationDependencies(root);
  const manifest = JSON.parse(
    await fs.readFile(path.join(directory, 'package.json'), 'utf8'),
  );
  for (const name of ['enhanced', 'node']) {
    const request = `@module-federation/${name}`;
    manifest.dependencies[request] = federation[name].version;
  }
  await fs.writeFile(
    path.join(directory, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await registerArtifact(path.join(directory, 'node_modules'), 'dependencies');
  const links = {
    '@modern-js/ultramodern-app-tools': appTools,
    '@modern-js/renderer-octane': renderer,
    '@modern-js/renderer-core': path.join(
      root,
      'packages/runtime/renderer-core',
    ),
    '@tsrx/oxc': await real(renderer, '@tsrx/oxc'),
    octane: await real(renderer, 'octane'),
    '@octanejs/tanstack-router': await real(
      renderer,
      '@octanejs/tanstack-router',
    ),
    '@octanejs/rspack-plugin': await real(renderer, '@octanejs/rspack-plugin'),
    typescript: await real(appTools, 'typescript'),
    '@types/node': await real(appTools, '@types/node'),
    '@module-federation/enhanced': federation.enhanced.root,
    '@module-federation/node': federation.node.root,
  };
  for (const [name, target] of Object.entries(links)) {
    const link = path.join(directory, 'node_modules', name);
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(target, link, 'dir');
  }
  for (const name of ['enhanced', 'node']) {
    const request = `@module-federation/${name}`;
    const selected = JSON.parse(
      await fs.readFile(
        path.join(directory, 'node_modules', request, 'package.json'),
        'utf8',
      ),
    );
    assert.equal(selected.name, request);
    assert.equal(selected.version, manifest.dependencies[request]);
  }
}

/** Ordinary native apps shared by the production and development MF proofs. */
export function createOctaneFederationFixtures({
  remoteUrl,
  failures = true,
  development = false,
}) {
  const packageJson = name =>
    JSON.stringify({
      name,
      private: true,
      type: 'module',
      dependencies: {
        '@modern-js/ultramodern-app-tools': 'workspace',
        '@modern-js/renderer-octane': 'workspace',
        '@modern-js/renderer-core': 'workspace',
        '@module-federation/enhanced': '2.9.2',
        '@module-federation/node': '2.7.52',
        '@tsrx/oxc': '0.20.0',
        octane: octaneVersion,
        '@octanejs/tanstack-router': routerVersion,
        '@octanejs/rspack-plugin': '0.2.4',
      },
    });
  const tsconfig = JSON.stringify({
    compilerOptions: {
      target: 'ESNext',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      jsx: 'preserve',
      jsxImportSource: 'octane',
      strict: true,
      noEmit: true,
      types: ['node', '@modern-js/ultramodern-app-tools/types'],
    },
    tsrx: { compiler: 'octane/compiler/volar', platform: 'web' },
    include: [
      'modern.config.ts',
      'module-federation.config.ts',
      'src',
      'node_modules/.modern-js',
    ],
  });
  const layout = `import { Outlet } from '@modern-js/renderer-octane/router';
export default function Layout() { return <main><Outlet /></main>; }
`;
  const lifecycle = development
    ? `
  const [hookOwner] = useState<{ id: number | null }>(() => ({ id: null }));
  useEffect(() => {
    const lifecycle = (globalThis.__octaneMFRemoteLifecycle ??= { owners: 0, activations: 0, cleanups: 0, currentOwner: null, effects: [] });
    hookOwner.id ??= ++lifecycle.owners;
    lifecycle.currentOwner = hookOwner.id;
    const activation = { id: ++lifecycle.activations, ownerId: hookOwner.id, cleanups: 0 };
    lifecycle.effects.push(activation);
    return () => { activation.cleanups++; lifecycle.cleanups++; lifecycle.currentOwner = null; };
  }, []);`
    : '';
  const widget = `import { useEffect, useState } from 'octane';
import { useSignal$ } from 'octane/signals/client';
import { useApplicationIdentity, useRouter } from '@modern-js/renderer-octane/router';
import './Widget.css';
export default function Widget(props: { label: string; hostAppId: string }) {
  const count$ = useSignal$(0);
  const [hydrated, setHydrated] = useState(false);
  const identity = useApplicationIdentity();
  const router = useRouter();
  useEffect(() => { setHydrated(true); }, []);${lifecycle}
  // The host's application/router context must cross the remote boundary.
  const owner = identity.appId === props.hostAppId ? 'host-owned' : 'detached';
  return (
    <div className="remote-widget" data-testid="remote-widget" data-owner={owner}
      data-hydrated={hydrated} data-app-id={identity.appId} data-path={router.state.location.pathname}>
      <span data-testid="remote-version">Remote native v1</span>
      <span data-testid="remote-label">{props.label}</span>
      <button type="button" data-testid="remote-increment" onClick={() => count$.set(value => value + 1)}>
        Count {count$.get()}
      </button>
    </div>
  );
}
`;
  const failuresDeclaration = failures
    ? `
const ReactWidget = federatedComponent<{ label: string; hostAppId: string }>('reactremote/Widget');
const SlowWidget = federatedComponent<{ label: string; hostAppId: string }>('slowremote/Widget', {
  timeout: 1000, fallback: () => <p data-testid="slow-fallback">Slow remote</p>,
});`
    : '';
  const failuresMarkup = failures
    ? `
      <ErrorBoundary fallback={(error: unknown) => <p data-testid="react-rejected">{String(error)}</p>}>
        <ReactWidget label="foreign-renderer" hostAppId={identity.appId} />
      </ErrorBoundary>
      <ErrorBoundary fallback={(error: unknown) => <p data-testid="slow-failed">{String(error)}</p>}>
        <SlowWidget label="slow" hostAppId={identity.appId} />
      </ErrorBoundary>`
    : '';
  const hostPage = `import { federatedComponent } from '@modern-js/renderer-octane/federation';
import { useApplicationIdentity } from '@modern-js/renderer-octane/router';
import { ${failures ? 'ErrorBoundary, ' : ''}useState } from 'octane';

const RemoteWidget = federatedComponent<{ label: string; hostAppId: string }>('remote/Widget', {
  fallback: () => <p data-testid="remote-fallback">Loading remote</p>,
});${failuresDeclaration}

export default function Home() {
  const [label, setLabel] = useState('from host');
  const identity = useApplicationIdentity();${
    development
      ? `
  const [hostCount, setHostCount] = useState(0);
  const [visible, setVisible] = useState(true);`
      : ''
  }
  return (
    <section>
      <h1 data-testid="host-title">Octane host</h1>
      <button type="button" data-testid="host-relabel" onClick={() => setLabel('relabelled')}>Relabel</button>${
        development
          ? `
      <button type="button" data-testid="host-increment" onClick={() => setHostCount(value => value + 1)}>Host count {hostCount}</button>
      <button type="button" data-testid="host-toggle" onClick={() => setVisible(value => !value)}>Toggle remote</button>
      {visible && <RemoteWidget label={label} hostAppId={identity.appId} />}`
          : `
      <RemoteWidget label={label} hostAppId={identity.appId} />`
      }${failuresMarkup}
    </section>
  );
}
`;
  const hostConfig = JSON.stringify({
    name: 'host',
    remotes: {
      remote: `remote@${remoteUrl}/mf-manifest.json`,
      ...(failures
        ? {
            reactremote: `reactremote@${remoteUrl}/react/mf-manifest.json`,
            slowremote: `slowremote@${remoteUrl}/hang/mf-manifest.json`,
          }
        : {}),
    },
  });
  const host = (name, ssr) => ({
    'package.json': packageJson(name),
    'tsconfig.json': tsconfig,
    'modern.config.ts': `import { defineConfig } from '@modern-js/ultramodern-app-tools';
export default defineConfig({ renderer: 'octane', server: { ssr: ${ssr} }, output: { assetPrefix: '/' } });
`,
    'module-federation.config.ts': `export default ${hostConfig};\n`,
    'src/routes/layout.tsx': layout,
    'src/routes/page.tsx': hostPage,
  });
  return {
    remote: {
      'package.json': packageJson('octane-mf-proof-remote'),
      'tsconfig.json': tsconfig,
      'modern.config.ts': `import { defineConfig } from '@modern-js/ultramodern-app-tools';
export default defineConfig({ renderer: 'octane', server: { ssr: true }, output: { assetPrefix: '${remoteUrl}/' } });
`,
      'module-federation.config.ts': `export default { name: 'remote', exposes: { './Widget': './src/components/Widget.tsx' } };\n`,
      'src/routes/layout.tsx': layout,
      'src/routes/page.tsx': `import Widget from '../components/Widget';
import { useApplicationIdentity } from '@modern-js/renderer-octane/router';
export default function Page() {
  const identity = useApplicationIdentity();
  return <Widget label="standalone" hostAppId={identity.appId} />;
}
`,
      'src/components/Widget.css': `.remote-widget { color: rgb(1, 2, 3); }\n`,
      'src/env.d.ts': `declare module '*.css';\n${development ? 'declare var __octaneMFRemoteLifecycle: { owners: number; activations: number; cleanups: number; currentOwner: number | null; effects: { id: number; ownerId: number; cleanups: number }[] } | undefined;\n' : ''}`,
      'src/components/Widget.tsx': widget,
    },
    host: host('octane-mf-proof-host', true),
    csr: host('octane-mf-proof-host-csr', false),
  };
}
