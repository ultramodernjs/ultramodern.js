import path from 'node:path';
import { resolveRendererAdapter } from '@modern-js/ultramodern-app-tools';
import {
  appEmitsBrowserUi,
  remoteDependencyAlias,
  resolveRemoteRefs,
} from './descriptors';
import { createNativeModuleFederationConfig } from './module-federation';
import {
  resolveAppGenerationProfile,
  resolveWorkspaceRenderer,
} from './renderer-profile';
import type { WorkspaceApp } from './types';

type NativeArtifact = { path: string; content: string };

/** Native source templates for the same-renderer host and remote topology. */
export function createNativeFederationArtifacts(
  scope: string,
  app: WorkspaceApp,
  remotes: WorkspaceApp[] = [],
): NativeArtifact[] {
  const generation = resolveAppGenerationProfile(app)!;
  if (!generation.capabilities.federation) {
    if (
      (app.verticalRefs?.length ?? 0) ||
      Object.keys(app.exposes ?? {}).length
    )
      throw new Error(
        `Renderer ${generation.renderer} has no admitted federation template for ${app.id}.`,
      );
    return [];
  }
  const adapter = resolveRendererAdapter(generation.renderer);
  if (adapter.kind !== 'native')
    throw new Error(
      `Renderer ${generation.renderer} has no native federation template.`,
    );
  const uiRemotes = resolveRemoteRefs(app, remotes);
  for (const remote of uiRemotes) {
    if (!appEmitsBrowserUi(remote))
      throw new Error(
        `Headless unit ${remote.id} cannot join native UI federation in ${app.id}.`,
      );
    if (resolveWorkspaceRenderer(remote) !== generation.renderer)
      throw new Error(
        `Native ${generation.renderer} host ${app.id} cannot compose the ${remote.renderer} renderer in ${remote.id}.`,
      );
  }
  const endpoint = `${adapter.runtime.bootstrap}/federation`;
  const artifacts: NativeArtifact[] = [
    {
      path: 'module-federation.config.ts',
      content: createNativeModuleFederationConfig(scope, app, remotes),
    },
  ];
  const exposedSources = new Set<string>();
  for (const [expose, source] of Object.entries(app.exposes ?? {})) {
    if (
      !source.startsWith('./src/') ||
      !source.endsWith('.tsx') ||
      source.split(/[\\/]/u).includes('..')
    )
      throw new Error(
        `Native federation expose ${app.id}${expose} requires an app-local .tsx component source.`,
      );
    const relativePath = source.slice(2);
    if (exposedSources.has(relativePath)) continue;
    exposedSources.add(relativePath);
    const counterPath = path.posix
      .relative(
        path.posix.dirname(relativePath),
        generation.renderer === 'octane'
          ? 'src/components/counter'
          : 'src/components/Counter',
      )
      .replace(/^(?!\.)/u, './');
    artifacts.push({
      path: relativePath,
      content: `import { Link } from ${JSON.stringify(adapter.runtime.router)};
import Counter from ${JSON.stringify(counterPath)};

export default function FederatedSurface(props: { label?: string }) {
  return (
    <section data-testid="native-remote" data-remote-id={${JSON.stringify(app.id)}}>
      <h2>{${JSON.stringify(app.displayName)}}</h2>
      <p>{props.label}</p>
      <Counter />
      <Link to="/">Home</Link>
    </section>
  );
}
`,
    });
  }
  const widgets = uiRemotes.filter(remote => remote.exposes?.['./Widget']);
  const routes = uiRemotes.filter(remote => remote.exposes?.['./Route']);
  const declarations = widgets
    .map(
      (remote, index) =>
        `const Remote${index} = federatedComponent<{ label: string }>(${JSON.stringify(`${remoteDependencyAlias(remote)}/Widget`)}, { fallback: () => <p>{${JSON.stringify(`Loading ${remote.displayName}`)}}</p> });`,
    )
    .join('\n');
  artifacts.push({
    path: 'src/routes/remotes/page.tsx',
    content: `${widgets.length ? `import { federatedComponent } from ${JSON.stringify(endpoint)};\n` : ''}${routes.length ? `import { Link } from ${JSON.stringify(adapter.runtime.router)};\n` : ''}

${declarations}

export default function FederatedRemotes() {
  return (
    <section data-testid="native-remotes">
      <h1>Federated applications</h1>
${widgets.map((_remote, index) => `      <Remote${index} label={${JSON.stringify(app.displayName)}} />`).join('\n')}
${routes
  .map(
    remote =>
      `      <Link to={${JSON.stringify(`/remotes/${remote.id}`)}}>{${JSON.stringify(remote.displayName)}}</Link>`,
  )
  .join('\n')}
    </section>
  );
}
`,
  });
  for (const remote of routes) {
    artifacts.push({
      path: `src/routes/remotes/${remote.id}/page.tsx`,
      content: `import { federatedComponent } from ${JSON.stringify(endpoint)};

const RemoteRoute = federatedComponent<{ label: string }>(${JSON.stringify(`${remoteDependencyAlias(remote)}/Route`)}, {
  fallback: () => <p>Loading remote application</p>,
});

export default function FederatedRoute() {
  return <RemoteRoute label={${JSON.stringify(app.displayName)}} />;
}
`,
    });
  }
  return artifacts;
}
