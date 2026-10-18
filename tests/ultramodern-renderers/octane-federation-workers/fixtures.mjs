import assert from 'node:assert/strict';
import path from 'node:path';

const json = value => `${JSON.stringify(value, null, 2)}\n`;

/** A named test Worker sits on the real service path; pass mode forwards unchanged. */
export function createWorkerFederationFaultHandler() {
  let mode = 'pass';
  const evidence = { requests: [], cancellations: 0, active: 0 };
  let diagnostics = 0;
  // Observe rejected native responses without consuming or delaying the body
  // returned to the transport. This independent budget affects logging only.
  const inspectFailure = async (response, request, record) => {
    const limit = 1024;
    const bytes = new Uint8Array(limit);
    let length = 0;
    let reader;
    let interrupted;
    let rejectInterrupted;
    const interruption = new Promise((_resolve, reject) => {
      rejectInterrupted = reject;
    });
    void interruption.catch(() => {});
    const stop = reason => {
      interrupted ??= reason;
      rejectInterrupted(interrupted);
    };
    const onAbort = () =>
      stop(request.signal.reason ?? new Error('Diagnostic request aborted'));
    const expires = performance.now() + 200;
    const timer = setTimeout(
      () => stop(new Error('Diagnostic read budget exceeded')),
      200,
    );
    request.signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (request.signal.aborted) onAbort();
      reader = response.clone().body?.getReader();
      while (reader && length < limit) {
        if (interrupted) throw interrupted;
        if (performance.now() >= expires)
          throw new Error('Diagnostic read budget exceeded');
        const chunk = await Promise.race([reader.read(), interruption]);
        if (chunk.done) break;
        const selected = chunk.value.subarray(0, limit - length);
        bytes.set(selected, length);
        length += selected.byteLength;
      }
    } catch (error) {
      record.diagnosticError = String(error?.message ?? error).slice(0, 160);
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
      if (reader) {
        void reader.cancel().catch(() => {});
        try {
          reader.releaseLock();
        } catch {}
      }
      record.diagnostic = new TextDecoder().decode(bytes.subarray(0, length));
      record.diagnosticTruncated = length === limit;
      console.error(
        'Worker native response diagnostic:',
        JSON.stringify({
          method: record.method.slice(0, 16),
          path: record.path.slice(0, 256),
          status: record.status,
          body: record.diagnostic,
          truncated: record.diagnosticTruncated,
          ...(record.diagnosticError
            ? { interrupted: record.diagnosticError }
            : {}),
        }),
      );
    }
  };
  const modes = new Set([
    'pass',
    'unavailable',
    'headers-hang',
    'body-hang',
    'manifest-unavailable',
    'manifest-headers-hang',
    'manifest-body-hang',
    'foreign-manifest',
    'foreign-renderer',
    'foreign-request-authority',
    'foreign-response-authority',
    'foreign-native-publisher',
    'foreign-native-abi',
    'foreign-native-document',
    'foreign-native-boundary',
    'foreign-native-echo',
  ]);
  return {
    async fetch(request, env, context) {
      const url = new URL(request.url);
      if (url.pathname === '/__proof/control') {
        if (request.method === 'POST') {
          const next = await request.json();
          if (!modes.has(next.mode))
            return new Response('Unknown fault mode', { status: 400 });
          mode = next.mode;
        }
        return Response.json({ mode, ...evidence });
      }
      const selected = mode;
      const record = {
        method: request.method,
        path: url.pathname,
        mode: selected,
      };
      evidence.requests.push(record);
      if (request.method === 'POST') {
        const digest = await crypto.subtle.digest(
          'SHA-256',
          await request.clone().arrayBuffer(),
        );
        record.requestSha256 = Array.from(new Uint8Array(digest), value =>
          value.toString(16).padStart(2, '0'),
        ).join('');
      }
      const manifest = request.method === 'GET';
      const fault = manifest ? selected.replace(/^manifest-/, '') : selected;
      const networkFault = manifest
        ? selected.startsWith('manifest-')
        : !selected.startsWith('manifest-');
      if (networkFault && fault === 'unavailable') {
        record.status = 503;
        return new Response('Unavailable under test', { status: 503 });
      }
      const waitForAbort = reject => {
        let finished = false;
        evidence.active++;
        const abort = () => {
          if (finished) return;
          finished = true;
          evidence.active--;
          evidence.cancellations++;
          request.signal.removeEventListener('abort', abort);
          reject(request.signal.reason ?? new Error('Service request aborted'));
        };
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
        return abort;
      };
      if (networkFault && fault === 'headers-hang')
        return new Promise((_resolve, reject) => waitForAbort(reject));
      const nativeRequestFault =
        selected.startsWith('foreign-native-') &&
        selected !== 'foreign-native-echo';
      if (
        request.method === 'POST' &&
        (selected === 'foreign-request-authority' || nativeRequestFault)
      ) {
        const envelope = await request.json();
        if (selected === 'foreign-request-authority') {
          envelope.authority.origin = 'https://foreign.invalid';
          record.mutation = 'request-authority';
        } else {
          const native = JSON.parse(envelope.payload);
          if (selected === 'foreign-native-publisher')
            native.authority.publisherBuildId = 'foreign-publisher';
          else if (selected === 'foreign-native-abi')
            native.authority.runtimeABI = 2;
          else if (selected === 'foreign-native-document')
            native.documentId = 'foreign-document';
          else native.boundaryId = 'foreign-boundary';
          envelope.payload = JSON.stringify(native);
          record.mutation = selected;
        }
        const headers = new Headers(request.headers);
        headers.delete('content-length');
        request = new Request(request, {
          body: JSON.stringify(envelope),
          headers,
        });
      }
      const response = await env.TARGET.fetch(request);
      record.status = response.status;
      if (selected === 'pass' && !response.ok && diagnostics++ < 8) {
        const diagnostic = inspectFailure(response, request, record);
        if (context?.waitUntil) context.waitUntil(diagnostic);
        else void diagnostic;
      }
      if (networkFault && fault === 'body-hang') {
        const reader = response.body.getReader();
        const first = await reader.read();
        let abort;
        const stream = new ReadableStream({
          start(controller) {
            abort = waitForAbort(error => {
              void reader.cancel(error).catch(() => {});
              controller.error(error);
            });
            if (!first.done) controller.enqueue(first.value);
          },
          cancel() {
            abort();
          },
        });
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        return new Response(stream, { status: response.status, headers });
      }
      const manifestFault =
        request.method === 'GET' &&
        ['foreign-manifest', 'foreign-renderer'].includes(selected);
      const responseFault =
        request.method === 'POST' &&
        ['foreign-response-authority', 'foreign-native-echo'].includes(
          selected,
        );
      if (manifestFault || responseFault) {
        const envelope = await response.json();
        if (selected === 'foreign-manifest')
          envelope.metaData.ultramodernWorkerFederation.remote =
            'foreign-remote';
        else if (selected === 'foreign-renderer')
          envelope.metaData.ultramodernRenderer.runtime.version =
            '0.0.0-foreign';
        else if (selected === 'foreign-native-echo') {
          const native = JSON.parse(envelope.payload);
          native.request.authority.publisherBuildId = 'foreign-publisher';
          envelope.payload = JSON.stringify(native);
        } else envelope.authority.origin = 'https://foreign.invalid';
        record.mutation = selected;
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        return new Response(JSON.stringify(envelope), {
          status: response.status,
          headers,
        });
      }
      return response;
    },
  };
}

export const workerFederationFaultSource = `export default (${createWorkerFederationFaultHandler.toString()})();\n`;

// All three apps compile the same native signal call site. Namespaces belong
// to the renderer; the apps never supply or rewrite signal identifiers.
const counter = `import { useSignal$ } from 'octane/signals/client';
import { signal$ } from 'octane/signals';
const global$ = signal$(3);
export default function Counter(props: { id: string; initial: number }) {
  const count$ = useSignal$(props.initial);
  return <><button type="button" data-counter={props.id} onClick={() => count$.set(value => value + 1)}>{count$.get()}</button><button type="button" data-global-counter={props.id} onClick={() => global$.set(value => value + 1)}>{global$.get()}</button></>;
}
`;

const layout =
  host => `import { Outlet } from '@modern-js/renderer-octane/router';
${host ? "import Shell from '../components/Shell';" : ''}
export default function Layout() {
  return <main>${host ? '<Shell />' : ''}<Outlet /></main>;
}
`;

const widget = (
  counterImport,
  nestedRemote,
) => `import { useEffect } from 'octane';
import { useApplicationIdentity, useMatch, useRouterState } from '@modern-js/renderer-octane/router';
import { useI18n } from '@modern-js/renderer-octane/i18n';
${nestedRemote ? "import { federatedComponent } from '@modern-js/renderer-octane/federation';" : ''}
import Counter from '${counterImport}';
import './Widget.css';
${nestedRemote ? `const Nested = federatedComponent<RemoteProps>(${JSON.stringify(`${nestedRemote.id}/Widget`)}, { timeout: 1000, fallback: () => <p data-fallback="b-hop">Nested remote unavailable</p> });` : ''}
type RemoteProps = { id: string; initial: number; hostAppId: string; label: string; nested?: boolean };
export default function Widget(props: RemoteProps) {
  const identity = useApplicationIdentity();
  const pathname = useRouterState({ select: state => state.location.pathname });
  const match = useMatch({ strict: false, select: value => ({ id: value.id, routeId: value.routeId, params: value.params, search: value.search }) });
  const matches = useRouterState({ select: state => state.matches.map(value => value.id) });
  const publicHref = useRouterState({ select: state => state.location.publicHref });
  const i18n = useI18n();
  useEffect(() => {
    const observations = (globalThis.__octaneWorkerProof ??= { mounts: {}, cleanups: {} });
    observations.mounts[props.id] = (observations.mounts[props.id] ?? 0) + 1;
    return () => { observations.cleanups[props.id] = (observations.cleanups[props.id] ?? 0) + 1; };
  }, []);
  return <section data-worker-remote={props.id} data-app-id={identity.appId} data-owner={identity.appId === props.hostAppId ? 'host' : 'detached'} data-path={pathname} data-public-href={publicHref} data-match-id={match.id} data-match-route-id={match.routeId} data-match-params={JSON.stringify(match.params)} data-match-search={JSON.stringify(match.search)} data-match-current={matches.includes(match.id)} data-language={i18n.language}>
    <p data-remote-label={props.id}>{props.label}</p>
    <p data-remote-greeting={props.id}>{i18n.t('greeting')}</p>
    <input data-remote-input={props.id} defaultValue="server draft" />
    <Counter id={props.id} initial={props.initial} />
    ${nestedRemote ? '<>{props.nested && <Nested id="b-hop" initial={37} hostAppId={props.hostAppId} label={props.label} />}</>' : ''}
  </section>;
}
`;

/** Ordinary authored applications; deployment coordinates come from the real compiler plan. */
export function createOctaneWorkerFederationFixtures({
  remoteOrigins,
  services,
  remoteServices,
  hostServiceSource = 'authored',
  deploymentSource = 'topology',
  sharedCounterPackage,
  dependencies,
  host,
  remotes,
}) {
  assert(['authored', 'topology'].includes(hostServiceSource));
  assert(['authored', 'topology'].includes(deploymentSource));
  if (deploymentSource === 'authored')
    assert.equal(hostServiceSource, 'authored');
  if (sharedCounterPackage !== undefined) {
    assert.match(sharedCounterPackage, /^@[a-z0-9-]+\/[a-z0-9-]+$/u);
    assert.equal(dependencies[sharedCounterPackage], 'workspace:*');
  }
  assert.equal(
    remoteOrigins.length,
    2,
    'The proof requires two independent remotes.',
  );
  assert(
    Array.isArray(services) && services.length >= 2,
    'Use real Worker service coordinates.',
  );
  for (const origin of remoteOrigins) {
    const url = new URL(origin);
    assert.equal(url.origin, origin, 'Supply exact remote origins.');
  }
  assert(
    host && remotes?.length === 2,
    'Use the public generator app descriptors.',
  );
  assert(
    Array.isArray(remoteServices?.[remotes[0].id]) &&
      remoteServices[remotes[0].id].length > 0,
    'The first remote must have an ordinary Worker service binding to the second remote.',
  );
  for (const app of [host, ...remotes]) {
    assert.equal(app.renderer, 'octane');
    assert(app.id && app.directory && app.moduleFederationName);
    assert.equal(app.manifest.name, app.packageName);
    assert.equal(app.manifest.modernjs?.appId, app.id);
  }
  for (const name of [
    '@modern-js/ultramodern-app-tools',
    '@modern-js/renderer-octane',
    '@modern-js/renderer-core',
    '@modern-js/i18n-runtime-extensions',
    '@tsrx/oxc',
    'octane',
    'i18next',
  ])
    assert(dependencies[name], `Missing native fixture dependency ${name}.`);
  const counterImport = app =>
    sharedCounterPackage ??
    path.posix.relative(
      path.posix.join(app.directory, 'src/components'),
      'shared/Counter',
    );
  const config = (app, origin, bindings, isHost) => {
    const authored = deploymentSource === 'authored';
    const preset = authored
      ? 'presetUltramodern'
      : 'presetUltramodernWorkspace';
    if (authored) {
      assert.match(
        app.deployment?.workerName ?? '',
        /^[a-z0-9][a-z0-9-]{0,62}$/u,
      );
      assert.equal(
        app.deliveryUnit?.packageName,
        app.packageName,
        'Authored Worker requires its original deliveryUnit package identity.',
      );
      for (const field of [
        'unitId',
        'buildMarker',
        'version',
        'sourceRevision',
      ])
        assert.equal(typeof app.deliveryUnit[field], 'string');
    }
    const settings = {
      renderer: 'octane',
      server: {
        ssr: true,
        ...(authored ? { publicDir: ['./locales', './assets'] } : {}),
      },
      ...(authored ? { html: { outputStructure: 'flat' } } : {}),
      source: { mainEntryName: 'main' },
      output: {
        assetPrefix: origin ? `${origin}/` : '/',
        ...(authored
          ? {
              distPath: { html: './', root: 'dist-cloudflare' },
              polyfill: 'off',
              splitRouteChunks: true,
            }
          : {}),
      },
      deploy: {
        ...(authored ? { target: 'cloudflare' } : {}),
        worker: {
          ssr: true,
          ...(authored ? { name: app.deployment.workerName } : {}),
          ...(isHost && hostServiceSource === 'topology'
            ? {}
            : { services: bindings }),
        },
      },
    };
    const options = authored
      ? {
          appId: app.id,
          deliveryUnit: Object.fromEntries(
            ['unitId', 'buildMarker', 'version', 'sourceRevision'].map(
              field => [field, app.deliveryUnit[field]],
            ),
          ),
        }
      : undefined;
    const optionsSource = authored
      ? `{ ...${JSON.stringify(options)}, deliveryUnit: { ...${JSON.stringify(options.deliveryUnit)}, workspaceRoot: fileURLToPath(new URL(${JSON.stringify(`${path.posix.relative(app.directory, '.')}/`)}, import.meta.url)) } }`
      : `{ appId: ${JSON.stringify(app.id)}, from: import.meta.url, deployTarget: 'cloudflare' }`;
    const toolsSource = authored
      ? `, tools: { bundlerChain(chain) { chain.output.uniqueName(${JSON.stringify(app.moduleFederationName)}).chunkLoadingGlobal(${JSON.stringify(`__ULTRAMODERN_${app.moduleFederationName.replace(/[^a-zA-Z0-9]/gu, '_').toUpperCase()}_LOADED_CHUNKS__`)}); } }`
      : '';
    return `${authored ? "import { fileURLToPath } from 'node:url';\n" : ''}import { defineConfig, i18nPlugin, ${preset} } from '@modern-js/ultramodern-app-tools';\nexport default defineConfig(${preset}({ ...${JSON.stringify(settings)}, plugins: [i18nPlugin({ localeDetection: { languages: ['en', 'cs'], fallbackLanguage: 'en' } })]${toolsSource} }, ${optionsSource}));\n`;
  };
  const application = (app, origin, bindings, isHost) => ({
    'package.json': json({
      ...app.manifest,
      dependencies: { ...app.manifest.dependencies, ...dependencies },
    }),
    'tsconfig.json': json({
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
        'src',
        ...(sharedCounterPackage
          ? []
          : [`${path.posix.relative(app.directory, 'shared')}/Counter.tsx`]),
        '*.config.ts',
        'node_modules/.modern-js',
      ],
    }),
    'modern.config.ts': config(app, origin, bindings, isHost),
    'src/routes/layout.tsx': layout(isHost),
    'locales/en/translation.json': json({
      greeting: isHost ? 'Hello from host' : `Hello from ${app.id}`,
    }),
    'locales/cs/translation.json': json({
      greeting: isHost ? 'Ahoj od hostitele' : `Ahoj od ${app.id}`,
    }),
    'src/modern-app-env.d.ts': `export {};\ndeclare global { var __octaneWorkerProof: { mounts: Record<string, number>; cleanups: Record<string, number> } | undefined; }\n`,
  });
  const remote = (app, origin, index) => ({
    ...application(app, origin, remoteServices[app.id] ?? [], false),
    'module-federation.config.ts': `export default ${JSON.stringify({ name: app.moduleFederationName, exposes: app.exposes, ...(index === 0 ? { remotes: { [remotes[1].id]: `${remotes[1].moduleFederationName}@${remoteOrigins[1]}/mf-manifest.json` } } : {}) })};\n`,
    [app.exposes['./Widget'].replace(/^\.\//, '')]: widget(
      counterImport(app),
      index === 0 ? remotes[1] : undefined,
    ),
    'src/components/Widget.css':
      '[data-worker-remote] { border: 3px solid rgb(13, 117, 83); padding: 7px; }\n',
    'src/routes/page.tsx': `export default function Home() { return <p>Independent ${app.id} Worker</p>; }\n`,
  });
  const expected = (remote, id, contextSelector) => ({
    remote: remote.id,
    expose: './Widget',
    selector: `[data-worker-remote="${id}"]`,
    contextSelector,
  });
  const siblings = [
    expected(remotes[0], 'a', '[data-worker-host]'),
    expected(remotes[1], 'b', '[data-worker-host]'),
  ];
  const nested = [
    expected(remotes[0], 'a-hop', '[data-host-nested]'),
    expected(remotes[1], 'b-hop', '[data-host-nested]'),
  ];
  const nestedRoutes = ['/en/nested', '/cs/nested'];
  return {
    shared: { 'Counter.tsx': counter },
    routes: [
      {
        path: '/en/',
        context: {
          pathname: '/',
          publicHref: '/en',
          language: 'en',
          greeting: 'Hello from host',
        },
        expected: siblings,
      },
      ...nestedRoutes.map((route, index) => ({
        path: route,
        context: {
          pathname: '/nested',
          publicHref: route,
          language: index === 0 ? 'en' : 'cs',
          greeting: index === 0 ? 'Hello from host' : 'Ahoj od hostitele',
        },
        expected: [...siblings, ...nested],
      })),
    ],
    hops: [
      {
        from: remotes[0].id,
        to: remotes[1].id,
        expose: './Widget',
        selector: '[data-worker-remote="b-hop"]',
        routes: nestedRoutes,
      },
    ],
    applications: [
      {
        app: host,
        files: {
          ...application(host, undefined, services, true),
          'module-federation.config.ts': `export default ${JSON.stringify({ name: host.moduleFederationName, remotes: Object.fromEntries(remoteOrigins.map((origin, index) => [remotes[index].id, `${remotes[index].moduleFederationName}@${origin}/mf-manifest.json`])) })};\n`,
          'src/routes/page.tsx': `export default function Home() { return <p data-host-home>Native Worker host</p>; }\n`,
          'src/components/Shell.tsx': `import { useState } from 'octane';
import { federatedComponent } from '@modern-js/renderer-octane/federation';
import { Link, useApplicationIdentity, useMatch, useRouterState } from '@modern-js/renderer-octane/router';
import { useI18n } from '@modern-js/renderer-octane/i18n';
import Counter from '${counterImport(host)}';
type RemoteProps = { id: string; initial: number; hostAppId: string; label: string };
const A = federatedComponent<RemoteProps>(${JSON.stringify(`${remotes[0].id}/Widget`)}, { timeout: 1000, fallback: () => <p data-fallback="a">Remote A unavailable</p> });
const B = federatedComponent<RemoteProps>(${JSON.stringify(`${remotes[1].id}/Widget`)}, { timeout: 1000, fallback: () => <p data-fallback="b">Remote B unavailable</p> });
export default function Home() {
  const identity = useApplicationIdentity();
  const match = useMatch({ strict: false, select: value => ({ id: value.id, routeId: value.routeId, params: value.params, search: value.search }) });
  const matches = useRouterState({ select: state => state.matches.map(value => value.id) });
  const publicHref = useRouterState({ select: state => state.location.publicHref });
  const pathname = useRouterState({ select: state => state.location.pathname });
  const i18n = useI18n();
  const [visibleA, setVisibleA] = useState(true);
  const [visibleB, setVisibleB] = useState(true);
  const [label, setLabel] = useState('from host');
  return <section data-worker-host="true" data-host-app-id={identity.appId} data-app-id={identity.appId} data-match-id={match.id} data-match-route-id={match.routeId} data-match-params={JSON.stringify(match.params)} data-match-search={JSON.stringify(match.search)} data-match-current={matches.includes(match.id)} data-path={pathname} data-public-href={publicHref} data-language={i18n.language}>
    <p data-host-greeting>{i18n.t('greeting')}</p>
    <Counter id="host" initial={5} />
    <button data-host-relabel onClick={() => setLabel('updated by host')}>Relabel</button>
    <button data-host-language onClick={() => void i18n.changeLanguage('cs')}>Czech</button>
    <button data-host-toggle="a" onClick={() => setVisibleA(value => !value)}>Toggle A</button>
    <button data-host-toggle="b" onClick={() => setVisibleB(value => !value)}>Toggle B</button>
    {visibleA && <A id="a" initial={11} hostAppId={identity.appId} label={label} />}
    {visibleB && <B id="b" initial={19} hostAppId={identity.appId} label={label} />}
    <Link to="/about" data-host-navigation>About</Link>
    <Link to="/nested" data-host-nested-navigation>Nested Workers</Link>
  </section>;
}
`,
          'src/routes/about/page.tsx': `import { Link } from '@modern-js/renderer-octane/router';\nexport default function About() { return <section data-host-about><Link to="/">Home</Link></section>; }\n`,
          'src/routes/nested/page.tsx': `import { federatedComponent } from '@modern-js/renderer-octane/federation';
import { Link, useApplicationIdentity, useMatch, useRouterState } from '@modern-js/renderer-octane/router';
import { useI18n } from '@modern-js/renderer-octane/i18n';
const Nested = federatedComponent<{ id: string; initial: number; hostAppId: string; label: string; nested: boolean }>(${JSON.stringify(`${remotes[0].id}/Widget`)}, { timeout: 1000, fallback: () => <p data-fallback="a-hop">Remote A unavailable</p> });
export default function NestedPage() {
  const identity = useApplicationIdentity();
  const match = useMatch({ strict: false, select: value => ({ id: value.id, routeId: value.routeId, params: value.params, search: value.search }) });
  const matches = useRouterState({ select: state => state.matches.map(value => value.id) });
  const publicHref = useRouterState({ select: state => state.location.publicHref });
  const pathname = useRouterState({ select: state => state.location.pathname });
  const i18n = useI18n();
  return <section data-host-nested data-app-id={identity.appId} data-match-id={match.id} data-match-route-id={match.routeId} data-match-params={JSON.stringify(match.params)} data-match-search={JSON.stringify(match.search)} data-match-current={matches.includes(match.id)} data-path={pathname} data-public-href={publicHref} data-language={i18n.language}><p data-host-greeting>{i18n.t('greeting')}</p><Nested id="a-hop" initial={29} hostAppId={identity.appId} label="through remote A" nested={true} /><Link to="/" data-host-nested-home>Home</Link></section>;
}
`,
        },
      },
      ...remotes.map((app, index) => ({
        app,
        files: remote(app, remoteOrigins[index], index),
      })),
    ],
  };
}
